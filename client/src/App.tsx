// Naya Reflow — WebSerial client (Chromium only). Dual-half: the LEFT half
// holds keymaps/LED maps; the right half is status-only. No fe/100a commit
// is ever sent. Close NayaFlow first: ports open exclusively.
//
// Composition root: all state lives in hooks (useSessions / useLayers /
// useDraft / …), all views in components. This file only wires them.
import { useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import Header from "./components/Header";
import type { AppTab } from "./components/AppTabs";
import Toolbar from "./components/Toolbar";
import BindingsTab from "./components/tabs/BindingsTab";
import LedTab from "./components/tabs/LedTab";
import ModulesTab from "./components/tabs/ModulesTab";
import BehaviorTab from "./components/tabs/BehaviorTab";
import DevicesTab from "./components/tabs/DevicesTab";
import TroubleshootingTab from "./components/tabs/TroubleshootingTab";
import ColorDialog from "./components/ColorDialog";
import LogPanel from "./components/LogPanel";
import DeviceSheet from "./components/DeviceSheet";
import SaveMenu from "./components/SaveMenu";
import BackupsDialog from "./components/BackupsDialog";
import FlashDialog from "./components/FlashDialog";
import { TooltipProvider } from "./components/ui/tooltip";
import { useLog } from "./hooks/useLog";
import { usePersistentFlag } from "./hooks/usePersistentFlag";
import { initialUrlState, useUrlSync } from "./hooks/useUrlSync";
import { useLayers, readInventory } from "./hooks/useLayers";
import { useSessions } from "./hooks/useSessions";
import { useAuxPolling } from "./hooks/useAuxPolling";
import { useSelection } from "./hooks/useSelection";
import { useDraft } from "./hooks/useDraft";
import { useFlash } from "./hooks/useFlash";
import { useCustomColors } from "./hooks/useCustomColors";
import { useKbFit } from "./hooks/useKbFit";
import { queueAction, queueBehaviorSet, queueColor, queueFillLayer, queueLayerAdd, queueLayerDelete, pendingLayerAddIdxs, mintLayerUuid, encodeRestorePayload, Draft, type SelKey } from '@create-reflow/sdk';
import { FLAVOR_BYTES, flavorById, type FlavorId } from '@create-reflow/sdk';
import { buildOpenFlowLayer, animOp, ANIM_NAMES } from '@create-reflow/sdk';
import { saveJson } from './lib/save';
import { diffSnapshotToDraft, parseSnapshotFile } from '@create-reflow/sdk';
import type { ParseFileResult, SnapMaps } from '@create-reflow/sdk';
import { listAutoBackups, loadAutoBackup } from '@create-reflow/sdk';
import type { ActionDef } from '@create-reflow/sdk';
import type { BehaviorSet } from '@create-reflow/sdk';
import {
  assertWireAllowed,
  type TroubleAction,
  type TroubleCtx,
} from '@create-reflow/sdk';
import type { KeyRec, LedRec, Side } from '@create-reflow/sdk';
import { timeoutsMs } from '@create-reflow/sdk';
import type { EditorView } from "./components/ViewLayerTabs";

export default function App() {
  const errMessage = (e: unknown) =>
    e instanceof Error ? e.message : String(e);

  // --- infrastructure ---------------------------------------------------
  const { logs, logRef, logCats, setLogCats, log, onFrame, clearLogs } =
    useLog();
  const busyRef = useRef(false); // user op in flight (polling yields to it)
  const [logOpen, toggleLog] = usePersistentFlag("naya-logopen", false);
  // Per-key free-text notes (UHK #8): host-side only — localStorage, carried
  // through exports and auto-backups, never flashed to the device.
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem("naya-key-notes");
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("naya-key-notes", JSON.stringify(notes));
    } catch {
      /* private mode — notes stay in-memory for this session */
    }
  }, [notes]);

  // --- editor state -----------------------------------------------------
  // tab/view/layer (+ optional single selected key) start from the URL
  // (?tab=led&layer=2&key=48 …) — shareable views, Back closes the panel.
  const urlInit = useMemo(() => initialUrlState(), []);
  const [tab, setTab] = useState<AppTab>(urlInit.tab);
  const [view, setView] = useState<EditorView>(urlInit.view);
  const [layer, setLayer] = useState(urlInit.layer);
  const [showRaw, setShowRaw] = useState(false);
  const [ledMode, setLedMode] = useState(false);
  const [panelColor, setPanelColor] = useState({ h: 180, s: 100 });
  const [tappingTerm, setTappingTerm] = useState(200);
  // Interrupt Flavor: rides inside every hold-tap record (byte 0-3,
  // cross-source measured). Written ONLY after an explicit user pick —
  // before that we preserve whatever the device record carries.
  const [flavorId, setFlavorId] = useState<FlavorId>(() => {
    try {
      const v = window.localStorage.getItem("naya-flavor");
      if (flavorById(v ?? "")) return v as FlavorId;
    } catch {
      /* ignore */
    }
    return "hold-preferred";
  });
  const flavorDirty = useRef(false);
  function pickFlavor(id: FlavorId) {
    flavorDirty.current = true;
    setFlavorId(id);
    try {
      window.localStorage.setItem("naya-flavor", id);
    } catch {
      /* ignore */
    }
  }
  // Last-known per-layer LED animation, as the lowercase OpenFlow
  // animationId ('solid' | 'breathe' | 'swirl' | 'spectrum'). The device
  // has no GET for ed/1011, so this host-side record is all we have:
  // exports and pre-flash backups bake it into the layer doc, imports
  // queue only the diffs. Absent layer → null → builder emits 'solid'.
  const animByLayer = useRef<Record<number, string>>({});
  const [colorDlg, setColorDlg] = useState(false);
  const [dlgColor, setDlgColor] = useState({ h: 180, s: 100 });
  const [flashOpen, setFlashOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState<Side>("left");

  // --- data hooks ---------------------------------------------------------
  const layers = useLayers({ busyRef, log });
  const { keysByLayer, ledsByLayer, layerList, hasRead, blobTotals, dumpStat, ledDumpStat } =
    layers;
  const selection = useSelection(urlInit.selKey ? [urlInit.selKey] : []);
  const { sel, setSel } = selection;
  useUrlSync({
    tab,
    view,
    layer,
    sel,
    setSel,
    clearSelection: selection.clearSelection,
  });
  const sessions = useSessions({
    log,
    onFrame,
    autoFetch: layers.dumpAll,
    onLeftCleared: () => {
      layers.clearLayers();
      selection.clearSelection();
    },
  });
  const { sesRef, halves, connecting, failed, autoConn } = sessions;
  const { refreshAux } = useAuxPolling({
    sesRef,
    busyRef,
    setHalves: sessions.setHalves,
    log,
  });
  const draft = useDraft({ keysByLayer, ledsByLayer, layer });
  const { draftRef, bumpDraft, keymap, ledmap, dirtyKks, draftSize } = draft;

  // Keep the viewed layer inside the board's real inventory: after a dump
  // (or a delete + post-flash refresh) a stale ?layer= or now-removed layer
  // snaps to the closest valid idx below, else the lowest. Empty inventory
  // (pre-read) keeps the URL fallback (0..2).
  useEffect(() => {
    if (layerList.length === 0 || layerList.some((e) => e.idx === layer)) return;
    const idxs = layerList.map((e) => e.idx).sort((a, b) => a - b);
    const below = idxs.filter((i) => i < layer);
    setLayer(below.length > 0 ? below[below.length - 1] : idxs[0]);
  }, [layerList, layer]);

  const { flashing, flashState, doFlashQueue } = useFlash({
    sesRef,
    busyRef,
    draftRef,
    layers: {
      keys: keysByLayer,
      leds: ledsByLayer,
      blobKeys: blobTotals.keys,
      blobLeds: blobTotals.leds,
    },
    notes,
    anims: () => animByLayer.current,
    dumpAll: layers.dumpAll,
    bumpDraft,
    log,
  });
  const { customColors, saveCustomColors } = useCustomColors();
  // 'off' when the Bindings tab is hidden: the keyboard card unmounts on tab
  // switch, and useKbFit must re-attach its observer when it comes back.
  const { kbBoxRef, kbStageRef, kbScale } = useKbFit(
    tab === "bindings" ? view : "off",
  );

  const leftOn = halves.left.connected;
  const rightOn = halves.right.connected;

  // --- derived ------------------------------------------------------------
  // Merged table rows: every keymap record in dump order with its LED color
  // joined by KK, then LED-only rows (KK never present in the keymap dump).
  const mergedRows = useMemo(() => {
    const keyRecs = keysByLayer[layer] ?? [];
    const ledRecs = ledsByLayer[layer] ?? [];
    const ledByKk = new Map(ledRecs.map((r) => [r.kk, r]));
    const rows: { kk: number; key: KeyRec | null; led: LedRec | null }[] =
      keyRecs.map((r) => ({
        kk: r.kk,
        key: r,
        led: ledByKk.get(r.kk) ?? null,
      }));
    const keyKks = new Set(keyRecs.map((r) => r.kk));
    for (const r of ledRecs)
      if (!keyKks.has(r.kk)) rows.push({ kk: r.kk, key: null, led: r });
    return rows;
  }, [keysByLayer, ledsByLayer, layer]);

  // KKs selected on the currently viewed layer (Keyboard highlights these).
  const selKks = useMemo(
    () => new Set(sel.filter((s) => s.layer === layer).map((s) => s.kk)),
    [sel, layer],
  );

  // --- actions ------------------------------------------------------------
  async function dump() {
    const ses = sesRef.current.get("left");
    if (!ses) return;
    // Guard: dumpAll sets busyRef but doesn't re-check it — a second entry
    // (double-clicked Refresh, Refresh during Flash) interleaves two multipart
    // read loops through the cmd mutex and desyncs both. Pollers already
    // yield; user-triggered dumps must too.
    if (busyRef.current) {
      log("inf", "dump: device busy (flash or dump in flight), ignored");
      return;
    }
    const fresh = await layers.dumpAll(ses);
    // Fresh device state may satisfy queued ops (e.g. after NayaFlow edits or
    // a successful flash) — drop those from the queue.
    if (!fresh) return;
    const d = draftRef.current;
    const before = d.size;
    d.reconcile(fresh.keys, fresh.leds);
    if (d.size !== before) {
      bumpDraft();
      log("inf", `queue: ${before - d.size} op(s) already applied on device`);
    }
  }

  // Exports: one OpenFlow layer doc per layer — keys AND colors live in
  // the same file now (the old split keymap/ledmap exports died with the
  // legacy format). The animation rides in as animationId from last-known
  // state; an absent record lets the builder emit 'solid'.
  function exportLayer(L: number) {
    const keys = keysByLayer[L] ?? [];
    const leds = ledsByLayer[L] ?? [];
    if (keys.length === 0 && leds.length === 0) {
      log("err", `export: layer ${L} cache empty — Refresh first`);
      return;
    }
    const r = buildOpenFlowLayer(keys, leds, L, animByLayer.current[L] ?? null);
    saveJson(r.fileName, r.data);
    log(
      "inf",
      `export: ${r.fileName}: ${r.counts.keys} keys, ${r.counts.leds} colors` +
        (r.counts.unknown > 0
          ? `, ${r.counts.unknown} unexportable dropped`
          : ""),
    );
  }

  // Export/save list: every inventory layer; before the first read, the
  // classic 0..2 (same fallback the tabs show pre-read).
  const exportIdxs =
    layerList.length > 0
      ? layerList.map((e) => e.idx).sort((a, b) => a - b)
      : [0, 1, 2];

  function exportAllLayers() {
    for (const L of exportIdxs) exportLayer(L);
  }

  // Add layer: queue an inventory add (30/1002) for the next free slot
  // (max idx + 1, window 0..7) with a fresh uuid and the Solid stored
  // animation. The new tab appears after the flash — the post-flash dump
  // re-reads the inventory.
  function addLayer() {
    const next = layerList.reduce((m, e) => Math.max(m, e.idx), -1) + 1;
    if (next > 7) {
      toast.error('layer window is full (0-7)');
      return;
    }
    // Double-add guard: the inventory only changes after a flash, so a
    // second click before flashing would queue another add at the SAME
    // idx. Refuse — flash to apply the queued one first.
    if (pendingLayerAddIdxs(draftRef.current).includes(next)) {
      toast.error(`Layer ${next + 1} is already queued — flash to apply`);
      return;
    }
    const r = queueLayerAdd(draftRef.current, next, mintLayerUuid(), 'Solid');
    if (!r.queued) {
      toast.error(r.error ?? 'layer add not queued');
      return;
    }
    bumpDraft();
    toast.success(`Layer ${next + 1} added — flash to apply`);
    log('inf', `layers: add layer ${next} queued (Solid, fresh uuid)`);
  }

  // Delete layer: confirm first — naming the layer, with the write-frame
  // estimate from a scratch-draft dry run of queueLayerDelete — then queue
  // the real thing (inventory delete + full keymap blank + LED clear so a
  // re-add can't inherit ghosts). Cancel leaves the queue untouched.
  function deleteLayer(idx: number) {
    const keys = keysByLayer[idx] ?? [];
    const leds = ledsByLayer[idx] ?? [];
    const probe = queueLayerDelete(
      new Draft(), idx, keys, leds, 156, layerList.length,
    );
    if (!probe.queued) {
      toast.error(probe.error ?? 'layer delete not possible');
      return;
    }
    const label = `Layer ${idx + 1}`;
    const est = probe.frames === 1 ? '1 frame' : `~${probe.frames} frames`;
    if (
      !window.confirm(
        `Delete ${label}? Its bindings and colors will be cleared on the device after flash. (${est} will be written)`,
      )
    )
      return;
    const r = queueLayerDelete(
      draftRef.current, idx, keys, leds, 156, layerList.length,
    );
    if (!r.queued) {
      toast.error(r.error ?? 'layer delete not queued');
      return;
    }
    bumpDraft();
    toast.success(`${label} queued for deletion — flash to apply`);
    log('inf', `layers: delete layer ${idx} queued (${r.frames} frames)`);
  }

  // --- troubleshooting actions ----------------------------------------------
  const [troubleRun, setTroubleRun] = useState<string | null>(null);
  async function runTrouble(a: TroubleAction) {
    if (a.confirm && !window.confirm(a.confirm)) return;
    const appSide: Side | null =
      a.side === "left" || a.side === "right" ? a.side : null;
    const ses = appSide ? sesRef.current.get(appSide) : null;
    if (appSide && !ses) {
      toast.error(`Connect the ${appSide} half first`);
      return;
    }
    if (a.steps && busyRef.current) {
      toast.error("Device busy (flash or dump in flight) — try again after");
      return;
    }
    setTroubleRun(a.label);
    const ctx: TroubleCtx = {
      send: async (t, c0, c1, params) => {
        assertWireAllowed(t, c0, c1);
        await ses!.cmd(t, c0, c1, Uint8Array.from(params ?? []));
      },
      confirm: (m) => window.confirm(m),
      toast:
        (m, kind = "info") =>
          kind === "success"
            ? toast.success(m)
            : kind === "error"
              ? toast.error(m)
              : toast.info(m),
      log,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      dump: () => Promise.resolve(dump()),
      refreshAux: () => Promise.resolve(refreshAux()),
      reboot: async () => {
        try {
          await ctx.send(0xee, 0x10, 0xce, [0]);
        } catch {
          // expected: the device reboots mid-reply
        }
        toast.info("Safe reboot sent — reconnects in ~30 s");
        log("cdc", "trouble: ee/10ce safe reboot sent");
      },
      // R5 echo-back: read the layer list fresh, echo the same entries
      // back. Restores wedged runtime lighting on both halves (measured
      // 2026-09, third-party); changes nothing stored. Reuses the same
      // SDK path the flash tail uses — readInventory parses the
      // two-byte-header reply, writeLayerList sends the 00 00-prefixed
      // restore payload. No hand-rolled parse/echo.
      rewriteLayerList: async () => {
        const left = sesRef.current.get("left");
        if (!left) throw new Error("Connect the LEFT half first");
        const inv = await readInventory(left);
        if (inv.length === 0)
          throw new Error(
            "layer list unreadable (0 entries) — nothing to echo back",
          );
        assertWireAllowed(0x30, 0x10, 0x02);
        await left.writeLayerList(encodeRestorePayload(inv));
        log(
          "inf",
          `trouble: layer list rewritten (${inv.length} entr${inv.length === 1 ? "y" : "ies"} echoed back unchanged)`,
        );
      },
    };
    try {
      if (a.steps) {
        busyRef.current = true;
        let ok = 0;
        const total = a.steps.length;
        for (const [i, st] of a.steps.entries()) {
          const name = st.note ?? `step ${i + 1}/${total}`;
          try {
            await ctx.send(st.t, st.c0, st.c1, st.params);
            ok++;
            log("cdc", `trouble ${name}: ACK`);
          } catch (e) {
            if (!st.tolerateNoReply) throw e;
            log("err", `trouble ${name}: no reply (tolerated)`);
          }
          await ctx.sleep(st.delayMs ?? 350);
        }
        if (ok === total) toast.success(`${a.label}: done — watch the board`);
        else
          toast.info(`${a.label}: ${ok}/${total} ACKed — watch the board`);
        log("inf", `trouble ${a.label}: ${ok}/${total} ACKed`);
      } else if (a.run) {
        await a.run(ctx);
      }
    } catch (e) {
      toast.error(`Action failed: ${errMessage(e)}`);
      log("err", `trouble ${a.label}: ${errMessage(e)}`);
    } finally {
      if (a.steps) busyRef.current = false;
      setTroubleRun(null);
    }
  }

  const importRef = useRef<HTMLInputElement>(null);
  const [backupsOpen, setBackupsOpen] = useState(false);

  // Strips (74-87) and module bays (88-96) have no writable device store —
  // the parser reports them as skip-warnings on every layer doc we export
  // ourselves (exactly 2 per layer, always). Purely informational, so the
  // per-layer pair collapses into one counted line instead of spamming.
  const stripBayRe =
    /^(?:layer (\d+): )?skipped \d+ (?:LED strip|module bay) position/;

  // Shared import/restore tail: log the parse warnings, diff the parsed
  // maps against the live caches and queue the difference (latest-op-wins),
  // then queue per-layer animation diffs against last-known. Caller does
  // the log/toast wording around it.
  function applySnap(
    res: Extract<ParseFileResult, { maps: SnapMaps }>,
    name: string,
  ) {
    const stripBays: Record<number, number> = {};
    for (const w of res.warnings) {
      const m = stripBayRe.exec(w);
      if (!m) {
        log("inf", `import '${name}': ${w}`);
        continue;
      }
      const L = m[1] !== undefined ? Number(m[1]) : res.maps.layers[0] ?? 0;
      stripBays[L] = (stripBays[L] ?? 0) + 1;
    }
    for (const [L, n] of Object.entries(stripBays))
      log("inf", `import '${name}': layer ${L}: strips/bays informational ×${n}`);

    const r = diffSnapshotToDraft(draftRef.current, res.maps, keysByLayer, ledsByLayer);
    bumpDraft();
    log(
      "inf",
      `import '${name}': layers [${res.maps.layers.join(",")}] → ` +
        `${r.keysQueued} key(s) + ${r.ledsQueued} LED(s) queued` +
        (r.skippedMissing > 0 ? `, ${r.skippedMissing} skipped (no live counterpart)` : ""),
    );

    // Animation: queue an ed/1011 op only when the file disagrees with
    // last-known — the device has no GET, animByLayer is the only baseline.
    let animsQueued = 0;
    for (const [Ls, anim] of Object.entries(res.anims)) {
      const L = Number(Ls);
      const animName = ANIM_NAMES[anim];
      if (!animName) continue; // parser never emits out of range; guarded anyway
      if (animName.toLowerCase() === (animByLayer.current[L] ?? null)) continue;
      draftRef.current.add(animOp(L, anim));
      animsQueued++;
      log("inf", `import '${name}': layer ${L} animation → ${animName}`);
    }

    if (r.keysQueued + r.ledsQueued + animsQueued > 0)
      log("inf", "import: review the queue, then Flash to apply");
    else log("inf", "import: device already matches the snapshot");
  }

  async function importSnapshotFile(f: File) {
    if (!hasRead) {
      log("err", "import: no device state read yet — Refresh first (diff needs live state)");
      return;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(await f.text());
    } catch {
      log("err", `import: '${f.name}' is not valid JSON`);
      return;
    }
    const snap = parseSnapshotFile(obj);
    if ("error" in snap) {
      log("err", `import: ${snap.error}`);
      return;
    }
    applySnap(snap, f.name);
  }

  function restoreBackup(id: string) {
    if (!hasRead) {
      log("err", "restore: no device state read yet — Refresh first (diff needs live state)");
      return;
    }
    const snap = loadAutoBackup(id);
    if ("error" in snap) {
      log("err", `restore: ${snap.error}`);
      return;
    }
    const meta = listAutoBackups().find((m) => m.id === id);
    applySnap(snap, `backup ${meta ? meta.ts : id}`);
    setBackupsOpen(false);
  }

  // Flash + last-known animation promotion: settings ops self-remove from
  // the queue on ACK, so harvest the queued ed/1011 payloads BEFORE the run
  // and promote them to animByLayer only when every op verified.
  async function handleFlash() {
    const queuedAnims: Record<number, number> = {};
    for (const o of draftRef.current.ops)
      if (o.kind === "settings" && o.path === "ed/1011" && o.payload.length >= 2)
        queuedAnims[o.payload[0]] = o.payload[1];
    const r = await doFlashQueue();
    if (r === "ok")
      for (const [L, a] of Object.entries(queuedAnims)) {
        const animName = ANIM_NAMES[a];
        if (animName) animByLayer.current[Number(L)] = animName.toLowerCase();
      }
    return r;
  }

  // Live timeout read for the Behavior tab (left half only). Failures
  // resolve null — the tab falls back to factory values, never a crash.
  async function loadTimeouts() {
    const ses = sesRef.current.get("left");
    if (!ses) return null;
    try {
      return timeoutsMs(await ses.getTimeouts());
    } catch {
      return null;
    }
  }

  function queueActionFor(selKeys: SelKey[], a: ActionDef) {
    const { queued } = queueAction(draftRef.current, selKeys, a, keysByLayer);
    bumpDraft();
    log("inf", `queued action '${a.label}' for ${queued} key(s)`);
  }

  function queueBehaviorSetForKey(
    layer: number,
    kk: number,
    set: BehaviorSet,
    label: string,
    prevRecs?: KeyRec[],
  ) {
    const flavorByte = flavorDirty.current ? FLAVOR_BYTES[flavorId] : undefined;
    const r = queueBehaviorSet(
      draftRef.current, layer, kk, set, tappingTerm, label, prevRecs, flavorByte,
    );
    bumpDraft();
    if (r.queued)
      log(
        "inf",
        `queued behavior set L${layer} KK ${kk} → ${label}` +
          (flavorByte != null ? ` (flavor byte ${flavorByte})` : ""),
      );
    else {
      log("err", `behavior set not queued: ${r.error}`);
      toast.error(r.error ?? "behavior set not queued");
    }
  }

  function queueColorForSelection() {    const { queued, skipped } = queueColor(draftRef.current, sel, panelColor);
    bumpDraft();
    log(
      "inf",
      `queued color H${panelColor.h}/S${panelColor.s} for ${queued} key(s)` +
        (skipped > 0 ? `, ${skipped} skipped` : ""),
    );
  }

  function fillLayerWithColor() {
    const recs = ledsByLayer[layer] ?? [];
    const n = queueFillLayer(draftRef.current, layer, recs, panelColor);
    bumpDraft();
    log(
      "inf",
      `queued fill: ${n} LEDs L${layer} → H${panelColor.h}/S${panelColor.s}`,
    );
  }

  function addCustomColor() {
    const c = { h: dlgColor.h, s: dlgColor.s };
    if (!customColors.some((x) => x.h === c.h && x.s === c.s))
      saveCustomColors([...customColors, c]);
    setPanelColor(c);
    setColorDlg(false);
  }

  // saveMenu JSX lives in the header tabs only (single Save location) — keep
  // it free of the hidden file input: a second copy would steal the ref
  // and React nulls it when that copy unmounts on tab switch. The input is
  // mounted once below, beside the dialogs.
  const saveMenu = (
    <SaveMenu
      leftOn={leftOn}
      layers={exportIdxs}
      onExportLayer={exportLayer}
      onExportAll={exportAllLayers}
      onImport={() => importRef.current?.click()}
      onBackups={() => setBackupsOpen(true)}
    />
  );

  // --- render -------------------------------------------------------------
  return (
    <TooltipProvider>
      <div className="flex min-h-screen">
        <div className="mx-auto max-w-6xl flex-1 p-6 min-w-80">
          <Header
            logOpen={logOpen}
            onToggleLog={toggleLog}
            tab={tab}
            onTab={setTab}
            draftSize={draftSize}
            flashing={flashing}
            onFlashOpen={() => setFlashOpen(true)}
            saveMenu={saveMenu}
          />

          <Toolbar
            halves={halves}
            connecting={connecting}
            failed={failed}
            onConnect={(side) => void sessions.connectPicked(side)}
            onDisconnect={(side) => void sessions.disconnect(side)}
            leftOn={leftOn}
            rightOn={rightOn}
            autoConn={autoConn}
            onToggleAuto={sessions.toggleAutoConn}
            onRefreshAux={() => void refreshAux()}
            onDeviceInfo={() => setSheetOpen(true)}
          />

          {tab === "bindings" && (
            <BindingsTab
              view={view}
              onView={setView}
              layer={layer}
              onLayer={setLayer}
              layerList={layerList}
              onAddLayer={addLayer}
              onDeleteLayer={deleteLayer}
              leftOn={leftOn}
              onDump={() => void dump()}
              ledMode={ledMode}
              onLedMode={setLedMode}
              kbBoxRef={kbBoxRef}
              kbStageRef={kbStageRef}
              kbScale={kbScale}
              keymap={keymap}
              ledmap={ledmap}
              selKks={selKks}
              onSelect={(_pos, kk, additive, allLayers) =>
                selection.onSelect(layer, kk, additive, allLayers)
              }
              dirtyKks={dirtyKks}
              showRaw={showRaw}
              onShowRaw={setShowRaw}
              dumpStat={dumpStat}
              ledDumpStat={ledDumpStat}
              rows={mergedRows}
              sel={sel}
              onRemovePair={selection.removePair}
              onClear={() => setSel([])}
              toggleKk={selection.toggleKk}
              toggleAllRowKks={selection.toggleAllRowKks}
              onQueueActionFor={queueActionFor}
              keysByLayer={keysByLayer}
              onQueueBehaviorSet={queueBehaviorSetForKey}
              panelColor={panelColor}
              onPanelColor={setPanelColor}
              customColors={customColors}
              onSaveCustomColors={saveCustomColors}
              onOpenColorDlg={() => {
                setDlgColor(panelColor);
                setColorDlg(true);
              }}
              onQueueColor={queueColorForSelection}
              onFillLayer={fillLayerWithColor}
              notes={notes}
              onSetNote={(kk, v) => {
                const key = `${layer}:${kk}`;
                setNotes((prev) => {
                  const next = { ...prev };
                  if (v.trim() === "") delete next[key];
                  else next[key] = v;
                  return next;
                });
              }}
              ledCount={ledsByLayer[layer]?.length ?? 0}
            />
          )}

          {tab === "led" && (
            <LedTab
              layer={layer}
              onLayer={setLayer}
              layers={exportIdxs}
              keymap={keymap}
              ledsByLayer={ledsByLayer}
              ledmap={ledmap}
              dirtyKks={dirtyKks}
              draftRef={draftRef}
              bumpDraft={bumpDraft}
              log={log}
              leftOn={leftOn}
              customColors={customColors}
              onSaveCustomColors={saveCustomColors}
              onAnimQueued={(L, a) => {
                const animName = ANIM_NAMES[a];
                if (animName) animByLayer.current[L] = animName.toLowerCase();
              }}
            />
          )}

          {tab === "modules" && (
            <ModulesTab
              left={sesRef.current.get("left")}
              halves={halves}
              leftOn={leftOn}
              log={log}
              draftRef={draftRef}
              bumpDraft={bumpDraft}
            />
          )}

          {tab === "behavior" && (
            <BehaviorTab
              flavor={flavorId}
              onFlavor={pickFlavor}
              tappingTerm={tappingTerm}
              onTappingTerm={setTappingTerm}
              leftOn={leftOn}
              loadTimeouts={loadTimeouts}
              draftRef={draftRef}
              bumpDraft={bumpDraft}
              log={log}
            />
          )}

          {tab === "devices" && (
            <DevicesTab
              halves={halves}
              draftRef={draftRef}
              onDeviceInfo={() => setSheetOpen(true)}
            />
          )}

          {tab === "trouble" && (
            <TroubleshootingTab
              leftOn={leftOn}
              rightOn={rightOn}
              running={troubleRun}
              onRun={runTrouble}
            />
          )}

          <ColorDialog
            open={colorDlg}
            onOpenChange={setColorDlg}
            color={dlgColor}
            onColor={setDlgColor}
            onAdd={addCustomColor}
          />

          <p className="text-xs text-muted-foreground">
            Scope: dual-half connect, keymap + LED editing via a queued draft
            (click a key → pick an action → Flash), exports, activity timeouts.
            Writes use 30/1004 + 30/100e and apply instantly — no fe/100a commit
            is ever sent. Remap + LED commands answer on the LEFT half only.
          </p>
        </div>

        {logOpen && (
          <LogPanel
            logs={logs}
            logRef={logRef}
            logCats={logCats}
            onToggleCat={(c) => setLogCats((p) => ({ ...p, [c]: !p[c] }))}
            onClear={clearLogs}
            onClose={toggleLog}
          />
        )}

        <DeviceSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          tab={sheetTab}
          onTab={setSheetTab}
          halves={halves}
        />

        <FlashDialog
          open={flashOpen}
          onOpenChange={setFlashOpen}
          draft={draftRef.current}
          onFlash={handleFlash}
          onChanged={bumpDraft}
          busy={flashing}
          state={flashState}
        />
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importSnapshotFile(f);
          }}
        />
        <BackupsDialog
          open={backupsOpen}
          onOpenChange={setBackupsOpen}
          onRestore={restoreBackup}
        />
      </div>
      <Toaster theme="dark" position="bottom-right" />
    </TooltipProvider>
  );
}
