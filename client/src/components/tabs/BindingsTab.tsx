// Bindings tab: keyboard and layout views plus the selection panel. Key
// config lives in the reusable KeyActionMenu — embedded in the bottom
// panel for selections and in a right-click context popover for in-place
// editing. Editing any behavior rewrites the whole T10/T03 set via a
// keyset op.
import { useEffect, useMemo, useRef, useState } from "react";
import KeyboardCard from "../KeyboardCard";
import KeyActionMenu from "../KeyActionMenu";
import LayoutTable, { type MergedRow } from "../LayoutTable";
import SelectionPanel from "../SelectionPanel";
import { ACTIONS, buildRecord, type ActionDef } from '@create-reflow/sdk';
import { behaviorSetOf, hidPairOf, type BehaviorSet, type Slot } from '@create-reflow/sdk';
import type { NayaSession, Side } from '@create-reflow/sdk';
import { POS_KEY } from "../../lib/kb-data";
import { shortLabel } from "../../lib/key-icon-map";
import type { KeyRec, LayerEntry } from '@create-reflow/sdk';
import { hex2 } from '@create-reflow/sdk';
import { X } from "lucide-react";
import type { HsColor } from "../../hooks/useCustomColors";
import type { LogFn } from "../../hooks/useLog";
import { useKeyscan } from "../../hooks/useKeyscan";
import type { SelKey } from '@create-reflow/sdk';
import type { EditorView } from "../ViewLayerTabs";
import type { useModuleProfiles } from "../../hooks/useModuleProfiles";
import BayPicker from "./modules/BayPicker";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

// KK-keyed test-press overlay for the Keyboard: stays EMPTY until a
// verified row/col→KK mapping exists (Phase-10 probe) — guessing a matrix
// is forbidden, the raw row/col panel below carries the live truth.
const PRESSED_KKS_EMPTY: ReadonlySet<number> = new Set();

// Mandated hedge copy, verbatim (plan T4 / T3-review carry).
const HEDGE_COPY =
  "Test mode locks other device traffic; keys may still reach your computer.";

/** Wall-clock stamp for one raw keyscan event, ms precision. */
function clockTime(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export default function BindingsTab({
  view,
  onView,
  layer,
  onLayer,
  layerList,
  onAddLayer,
  onDeleteLayer,
  leftOn,
  onDump,
  ledMode,
  onLedMode,
  kbBoxRef,
  kbStageRef,
  kbScale,
  keymap,
  ledmap,
  selKks,
  onSelect,
  dirtyKks,
  showRaw,
  onShowRaw,
  dumpStat,
  ledDumpStat,
  rows,
  sel,
  onRemovePair,
  onClear,
  toggleKk,
  toggleAllRowKks,
  onQueueActionFor,
  keysByLayer,
  onQueueBehaviorSet,
  panelColor,
  onPanelColor,
  customColors,
  onSaveCustomColors,
  onOpenColorDlg,
  onQueueColor,
  onFillLayer,
  notes,
  onSetNote,
  ledCount,
  modules,
  sesRef,
  busyRef,
  draftSize,
  log,
}: {
  view: EditorView;
  onView: (v: EditorView) => void;
  layer: number;
  onLayer: (l: number) => void;
  layerList?: LayerEntry[];
  onAddLayer?: () => void;
  onDeleteLayer?: (idx: number) => void;
  leftOn: boolean;
  onDump: () => void;
  ledMode: boolean;
  onLedMode: (v: boolean) => void;
  kbBoxRef: React.RefObject<HTMLDivElement | null>;
  kbStageRef: React.RefObject<HTMLDivElement | null>;
  kbScale: number;
  keymap: Map<number, Uint8Array>;
  ledmap: Map<number, { h: number; s: number }>;
  selKks: Set<number>;
  onSelect: (
    layer: number,
    kk: number,
    additive: boolean,
    allLayers: boolean,
  ) => void;
  dirtyKks: Set<number>;
  showRaw: boolean;
  onShowRaw: (v: boolean) => void;
  dumpStat: string;
  ledDumpStat: string;
  rows: MergedRow[];
  sel: SelKey[];
  onRemovePair: (layer: number, kk: number) => void;
  onClear: () => void;
  toggleKk: (layer: number, kk: number) => void;
  toggleAllRowKks: (layer: number, kks: number[]) => void;
  onQueueActionFor: (selKeys: SelKey[], a: ActionDef) => void;
  keysByLayer: KeyRec[][];
  onQueueBehaviorSet: (
    layer: number,
    kk: number,
    set: BehaviorSet,
    label: string,
    prevRecs?: KeyRec[],
  ) => void;
  panelColor: HsColor;
  onPanelColor: (c: HsColor) => void;
  customColors: HsColor[];
  onSaveCustomColors: (cs: HsColor[]) => void;
  onOpenColorDlg: () => void;
  onQueueColor: () => void;
  onFillLayer: () => void;
  /** per-key notes, key "L:kk" (host-side only) */
  notes: Record<string, string>;
  onSetNote: (kk: number, v: string) => void;
  ledCount: number;
  /** module-profile store: the per-layer bay picker edits it through
   * setBay (Task 4) — the hook queues the wire ops. */
  modules: ReturnType<typeof useModuleProfiles>;
  /** live keyscan test session (left half) — the hook owns the safety
   * exits and the raw event tail */
  sesRef: React.RefObject<Map<Side, NayaSession>>;
  busyRef: React.RefObject<boolean>;
  draftSize: number;
  log: LogFn;
}) {
  // Right-click context popover target (keymap mode only; LED paint mode
  // keeps its own pointer semantics).
  const [ctx, setCtx] = useState<{ kk: number; x: number; y: number } | null>(
    null,
  );
  const popRef = useRef<HTMLDivElement | null>(null);

  const single =
    sel.length === 1 && sel[0].layer === layer ? sel[0].kk : null;
  // Identity-stable parsed set: KeyActionMenu re-syncs its optimistic copy
  // when this reference changes (cache landing after mount), never otherwise.
  const set: BehaviorSet | null = useMemo(
    () => (single != null ? behaviorSetOf(keysByLayer[layer] ?? [], single) : null),
    [keysByLayer, layer, single],
  );
  // Notes of the viewed layer only, as a KK map for the keyboard markers.
  const layerNotes = useMemo(() => {
    const m = new Map<number, string>();
    for (const [k, v] of Object.entries(notes)) {
      const m2 = /^([0-2]):(\d+)$/.exec(k);
      if (m2 && Number(m2[1]) === layer && v) m.set(Number(m2[2]), v);
    }
    return m;
  }, [notes, layer]);

  // Keyscan live test (phase 7): the hook owns pressed state + safety exits
  // (Escape, unmount, errors all end the session); this component renders
  // the toggle and the raw row/col tail. The keymap editor is the LEFT half.
  const keyscan = useKeyscan({ sesRef, busyRef, draftSize, side: "left", log });
  // busyRef is non-reactive by design — its flips land mid-render only via
  // collateral state changes (flashing, dumpStat …); start() re-checks with
  // a toast, so this gate is UI affordance, not the safety mechanism. While
  // a session runs the hook holds busyRef, so the disabled gate must not
  // apply — unticking the toggle is one of the ways to stop.
  const testKeysDisabled = !keyscan.running && (draftSize > 0 || busyRef.current);
  const testKeysHint = keyscan.running
    ? HEDGE_COPY
    : draftSize > 0
      ? "Flash or discard the queued changes first — test mode locks other device traffic."
      : busyRef.current
        ? "Device busy — wait for the current operation to finish."
        : HEDGE_COPY;

  function hidLabel(hid: number): string {
    const a = ACTIONS.find(
      (x) => hidPairOf(buildRecord(0, x.body()))?.hid === hid,
    );
    if (!a) return `0x${hid.toString(16)}`;
    return shortLabel(buildRecord(0, a.body())) || a.label;
  }

  function wholeLabelOf(kk: number): string {
    const rec = keymap.get(kk);
    return rec
      ? shortLabel(rec) || POS_KEY[String(kk)] || hex2(kk)
      : "no record — transparent";
  }

  // Outside-click / Escape closes the context popover.
  useEffect(() => {
    if (!ctx) return;
    const close = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node))
        setCtx(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtx(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [ctx]);

  // Popover placement clamped to the viewport.
  const px = ctx ? Math.max(8, Math.min(ctx.x, window.innerWidth - 540)) : 0;
  const py = ctx ? Math.max(8, Math.min(ctx.y, window.innerHeight - 480)) : 0;

  const ctxSet = useMemo(
    () => (ctx != null ? behaviorSetOf(keysByLayer[layer] ?? [], ctx.kk) : null),
    [ctx, keysByLayer, layer],
  );

  return (
    <>
      {view === "kb" && (
        <KeyboardCard
          view={view}
          onView={onView}
          layer={layer}
          onLayer={onLayer}
          layerList={layerList}
          onAddLayer={onAddLayer}
          onDeleteLayer={onDeleteLayer}
          leftOn={leftOn}
          onDump={onDump}
          ledMode={ledMode}
          onLedMode={onLedMode}
          testKeys={keyscan.running}
          onTestKeys={(v) => (v ? keyscan.start() : keyscan.stop())}
          testKeysDisabled={testKeysDisabled}
          testKeysHint={testKeysHint}
          pressedKks={PRESSED_KKS_EMPTY}
          kbBoxRef={kbBoxRef}
          kbStageRef={kbStageRef}
          kbScale={kbScale}
          keymap={keymap}
          ledmap={ledmap}
          selKks={selKks}
          onSelect={onSelect}
          dirtyKks={dirtyKks}
          onContext={(kk, x, y) => setCtx({ kk, x, y })}
          keyNotes={layerNotes}
        />
      )}

      {view === "table" && (
        <LayoutTable
          view={view}
          onView={onView}
          layer={layer}
          onLayer={onLayer}
          layerList={layerList}
          onAddLayer={onAddLayer}
          onDeleteLayer={onDeleteLayer}
          leftOn={leftOn}
          onDump={onDump}
          showRaw={showRaw}
          onShowRaw={onShowRaw}
          dumpStat={dumpStat}
          ledDumpStat={ledDumpStat}
          rows={rows}
          sel={sel}
          onToggleKk={(kk) => toggleKk(layer, kk)}
          onToggleAll={() => toggleAllRowKks(layer, rows.map((r) => r.kk))}
        />
      )}

      {/* Raw keyscan tail (phase 7): the wire row/col is the only truth —
          no KK mapping exists, so the caps overlay stays empty. The tail
          stays visible after stop for review; the live badge is the only
          running indicator (no pressed-derived implication once stopped). */}
      {(keyscan.running || keyscan.events.length > 0) && (
        <Card className="mb-3">
          <CardHeader className="flex-wrap">
            <CardTitle>
              Keyscan test — raw rows/columns
              {keyscan.running ? (
                <span className="ml-2 inline-flex items-center gap-1.5 text-xs font-normal text-green-300">
                  <span className="inline-block size-1.5 animate-pulse rounded-full bg-green-400" />
                  live
                </span>
              ) : (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  stopped
                </span>
              )}
            </CardTitle>
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              disabled={!keyscan.running}
              onClick={keyscan.stop}
            >
              Stop
            </Button>
          </CardHeader>
          <CardContent>
            <p className="mb-2 text-xs text-muted-foreground">{HEDGE_COPY}</p>
            {keyscan.events.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Press keys on the keyboard — wire events (row/column,
                press/release) appear here.
              </p>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded-sm border border-border p-2 font-mono text-xs">
                {keyscan.events.map((ev, i) => (
                  <div
                    key={i}
                    className="flex items-baseline gap-3 whitespace-nowrap"
                  >
                    <span className="text-muted-foreground">
                      {clockTime(ev.t)}
                    </span>
                    <span>
                      row {ev.row} · col {ev.col}
                    </span>
                    <span
                      className={
                        ev.pressed ? "text-green-300" : "text-muted-foreground"
                      }
                    >
                      {ev.pressed ? "PRESS" : "RELEASE"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Per-layer bay picker (Task 4): layer context exists here in both
          views; picks queue wire ops through the hook's setBay. */}
      <BayPicker modules={modules} layer={layer} />

      {sel.length > 0 && (
        <SelectionPanel
          sel={sel}
          actionMenu={
            <KeyActionMenu
              key={single != null ? `single-${layer}-${single}` : "multi"}
              set={set}
              wholeLabel={single != null ? wholeLabelOf(single) : "—"}
              count={sel.length}
              hidLabel={hidLabel}
              note={single != null ? layerNotes.get(single) : undefined}
              onNote={single != null ? (v) => onSetNote(single, v) : undefined}
              onPickPlain={(a) => onQueueActionFor(sel, a)}
              onPickSlot={(slot: Slot, a: ActionDef, next: BehaviorSet) =>
                single != null &&
                onQueueBehaviorSet(layer, single, next, `${slot} → ${a.label}`)
              }
              onClearSlot={(
                slot: Slot,
                next: BehaviorSet,
                dropped: string[],
              ) =>
                single != null &&
                onQueueBehaviorSet(
                  layer,
                  single,
                  next,
                  dropped.length
                    ? `clear ${slot} (+ ${dropped.join(", ")})`
                    : `clear ${slot}`,
                  keysByLayer[layer],
                )
              }
            />
          }
          onRemovePair={onRemovePair}
          onClear={onClear}
          panelColor={panelColor}
          onPanelColor={onPanelColor}
          customColors={customColors}
          onSaveCustomColors={onSaveCustomColors}
          onOpenColorDlg={onOpenColorDlg}
          onQueueColor={onQueueColor}
          onFillLayer={onFillLayer}
          ledCount={ledCount}
          layer={layer}
        />
      )}

      {ctx != null && (
        <div
          ref={popRef}
          className="fixed z-50 w-[32rem] rounded-lg border border-border bg-card p-3 shadow-lg"
          style={{ left: px, top: py }}
        >
          <div className="mb-2 flex items-center gap-2">
            <div className="text-xs font-medium text-muted-foreground">
              {POS_KEY[String(ctx.kk)] ?? hex2(ctx.kk)} · KK 0x
              {ctx.kk.toString(16)} · L{layer}
            </div>
            <button
              type="button"
              className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground"
              title="Close"
              onClick={() => setCtx(null)}
            >
              <X className="size-4" />
            </button>
          </div>
          <KeyActionMenu
            key={`ctx-${layer}-${ctx.kk}`}
            set={ctxSet}
            wholeLabel={wholeLabelOf(ctx.kk)}
            count={1}
            hidLabel={hidLabel}
            note={layerNotes.get(ctx.kk)}
            onNote={(v) => onSetNote(ctx.kk, v)}
            onPickPlain={(a) => onQueueActionFor([{ layer, kk: ctx.kk }], a)}
            onPickSlot={(slot: Slot, a: ActionDef, next: BehaviorSet) =>
              onQueueBehaviorSet(
                layer,
                ctx.kk,
                next,
                `${slot} → ${a.label}`,
                keysByLayer[layer],
              )
            }
            onClearSlot={(slot: Slot, next: BehaviorSet, dropped: string[]) =>
              onQueueBehaviorSet(
                layer,
                ctx.kk,
                next,
                dropped.length
                  ? `clear ${slot} (+ ${dropped.join(", ")})`
                  : `clear ${slot}`,
                keysByLayer[layer],
              )
            }
          />
        </div>
      )}
    </>
  );
}
