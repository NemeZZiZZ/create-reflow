/* Firmware procedure lifecycle — the safety + observability shell the flash
 * procedures drive (startKeyboard landed here; startModule follows in a
 * later task):
 *
 * - ONE run at a time: a module-level lock (firmwareRunActive) refuses a
 *   second beginRun while one is in flight — the freeze flag useSessions'
 *   shared sweep consults to hold back auto-connect/hot-plug while a half
 *   is dark.
 * - busyRef held for the WHOLE run (useFlash.ts:170 precedent) so every
 *   other device op refuses while a run owns the halves.
 * - beforeunload + pagehide guards registered on begin, removed on end, so
 *   a stray tab close cannot park a half in its bootloader unnoticed. The
 *   handler sets returnValue and calls preventDefault (the beforeunload
 *   contract); the window is injectable (win) so node smoke records the
 *   add/remove pairs — default is globalThis, guarded by typeof.
 *
 * The React-free core (beginFirmwareRun/endFirmwareRun/capturePreflight/
 * verifyPreflight/startKeyboardRun) is exported for the smoke and for the
 * UI mirror; useFirmwareFlash is the thin mirror: status/log/events state +
 * exportLog + startKeyboard.
 *
 * Preflight capture reads the live world through the app's existing seams,
 * per side (left first): fw via fe/1002 (the readAux path, aux.ts:124-130),
 * BLE identity via the SDK be/ helpers (bleGetAddress/bleGetPairAddress/
 * bleGetAllPairs — the bleSplitReads set), module presence via de/1001 on
 * BOTH halves (the undock-gate input). Left only: keymap+LED banks 0+1 via
 * the 30/1003 + 30/100d multipart reads — the same read family whose caches
 * useFlash's auto-backup (useFlash.ts:189-206) serializes; the left half
 * owns dest 0x50. The doc is serialized with stableStringify (key-sorted),
 * digested with WebCrypto sha256, and logged as a `preflight` artifact note;
 * verifyPreflight re-serializes and refuses on any byte difference. A dead
 * read never throws the capture — it records null/'error' so the artifact
 * stays honest about what was and wasn't readable.
 *
 * The keyboard procedure (startKeyboardRun, spec §5 steps 1-11) runs over an
 * injectable SerialWorld (lib/serial-world.ts): after `enterMcuboot()` it
 * polls getPorts for the re-enumerated MCUboot PID of the side, probes
 * every candidate CDC port with image-state (first answer wins; a silent
 * port's console text surfaces as a `bootloader.console` note), identifies
 * the running image by slot-0 hash against the catalog's plaintextSha256
 * values, re-checks the interlock gate with live values, uploads through
 * SmpDevice.uploadImage (slot.erase ok = first chunk ack), observes the
 * swap, os-resets the answering port (mcuboot.exit — the silent twin never
 * sees an SMP write; a throwing reset on a stale answer-port is read as
 * "already rebooted", never an abort), confirms the flashed version on a
 * procedure-owned app session (mismatch refuses; non-versioned target is
 * advisory-only), settles BOTH halves (fail-and-continue on timeout), then
 * the tail: brightness.restore (ed/1013 max brightness 100 per flashed
 * side) and lighting.restore (read the left layer list, echo it straight
 * back — cosmetic, never fatal), verify.compare (postflight re-capture on
 * the settled sessions; strict: BLE/pair/bond identity + primary keymap
 * bank with the `07 00`-NONE-equals-absent rule; advisories: LED map +
 * second bank across a version change), the stranded-half rescue (every
 * entered half not proven back in app mode: answering port → os reset →
 * await app ≤ rescueMs with re-resets; back-running / power-cycle /
 * unplug-replug outcomes — on the failure tail this runs BEFORE the
 * verdict), and the verdict `finish` with failures/advisories. Run end
 * hands the ports back: owned sessions closed, dead pre-flash sessions
 * disconnected (entered + settle-dead halves), flag cleared, rescan().
 * Every wait is an injected `timeouts` value — the core never sleeps on
 * raw constants (the smoke runs millisecond-scale). */

import { useCallback, useState } from 'react';
import type { RefObject } from 'react';
import {
  bleGetAddress, bleGetAllPairs, bleGetPairAddress, buildFrame, DST_LEFT, DST_RIGHT,
  encodeRestorePayload, fwVersionText, hexToBytes, maxBrtOp, modFwText, modPresence, NayaSession,
  parseCmdPath, parseInventory, parseLayer, sleep, SmpDevice,
  SmpLink, SMP_DEFAULT_TIMEOUTS, toHex,
} from '@create-reflow/sdk';
import type { ImageSlot, Side } from '@create-reflow/sdk';
import { saveText } from '../lib/save';
import { FirmwareRunLog, sha256Hex, stableStringify } from '../lib/firmware-run-log';
import type { RunEvent } from '../lib/firmware-run-log';
import { loadFirmwareCatalog } from '../lib/firmware-catalog';
import type { FwEntry } from '../lib/firmware-catalog';
import { resolveKeyboardPlan, resolveModulePlan, stripNayaLeadingZero } from '../lib/firmware-plan';
import type { HalfPlan, ModulePlan } from '../lib/firmware-plan';
import { checkFlashGate } from '../lib/firmware-interlocks';
import type { KeyboardGateInput, ModuleGateInput } from '../lib/firmware-interlocks';
import { newVault } from '../lib/firmware-fetch';
import type { Vault } from '../lib/firmware-fetch';
import { NAYA_VID, RECOVERY_PIDS, pidInfo } from '../lib/firmware-plat';
import { defaultSerialWorld } from '../lib/serial-world';
import type { GrantFilter, PortWithInfo, SerialWorld } from '../lib/serial-world';

export type FlashRunStatus = 'idle' | 'running' | 'done' | 'failed';

export interface FlashWindowLike {
  addEventListener(t: string, l: unknown): void;
  removeEventListener(t: string, l: unknown): void;
}

export interface FlashDeps {
  sesRef: RefObject<Map<Side, NayaSession>>;
  busyRef: RefObject<boolean>;
  win?: FlashWindowLike; // default globalThis — injectable for node smoke
  world?: SerialWorld; // default defaultSerialWorld() — injectable for node smoke
  vault?: Vault; // default the module-shared vault (firmwareVault())
  timeouts?: FlashTimeouts; // defaults = FLASH_TIMEOUT_DEFAULTS (spec values)
  /* The user-gesture grant path: the core emits an `action` event and awaits
   * this; the UI resolves it by calling world.requestPort(...) and handing
   * back the picked port. The core passes side-specific bootloader PID
   * filters (grantFiltersForSide) — absent filters mean vendor-only.
   * The injector itself stays optional-arg, so existing zero-arg injectors
   * keep compiling. Absent → no grant is possible and a missing port
   * fails with replug copy. */
  grantPort?: (filters?: GrantFilter[]) => Promise<PortWithInfo>;
  /* The run-end handover (useSessions.rescan): called after the freeze flag
   * cleared — the sweep re-lists the granted ports and reconnects the
   * unclaimed app-mode halves. Absent (raw smoke runs) → no handover sweep. */
  rescan?: () => Promise<void>;
  /* UI-only mirror hook: called synchronously when a procedure's run log
   * opens (before the first await), so the mirror can subscribe to the live
   * event stream while the run is in flight. The core never needs it; the
   * smoke drives the core directly and leaves it unset. */
  onBegin?: (log: FirmwareRunLog) => void;
  /* The module-fw client cache invalidation (App wires useModuleProfiles'
   * clearLive): a module reprogram wipes the module's config slots, so the
   * per-slot match verdicts cached from before the run are stale. Called
   * from startModuleRun's teardown — success AND failure (finally
   * semantics: every exit path funnels through finishRun). */
  onModuleCacheStale?: () => void;
}

/* ---- React-free lifecycle core ------------------------------------------ */

interface ActiveRun {
  log: FirmwareRunLog;
  deps: FlashDeps;
  removeGuards: () => void;
}

let activeRun: ActiveRun | null = null;

/** True from beginRun to endRun — the freeze flag. useSessions consults it
 * to hold back auto-connect and hot-plug sweeps while a firmware run owns
 * the halves (its shared rescanSweep core checks it first); the run's own
 * handover clears the flag BEFORE calling rescan(). */
export function firmwareRunActive(): boolean {
  return activeRun !== null;
}

function guardTarget(deps: FlashDeps): FlashWindowLike | null {
  if (deps.win) return deps.win;
  const g = globalThis as unknown as {
    addEventListener?: unknown;
    removeEventListener?: unknown;
  };
  if (typeof g.addEventListener === 'function' && typeof g.removeEventListener === 'function') {
    return globalThis as unknown as FlashWindowLike;
  }
  return null;
}

function unloadHandler(ev: unknown): void {
  const e = ev as { preventDefault?: () => void; returnValue?: unknown };
  if (typeof e.preventDefault === 'function') e.preventDefault();
  e.returnValue = true; // beforeunload contract: truthy → the tab asks first
}

/* Refusal reasons: beginFirmwareRun never returns a silent null — a
 * refused open names its cause so the procedures (resolve, never throw)
 * and the dialogs (toast) can say why instead of going silent. */
export type FirmwareRunRefusal = 'run-active' | 'device-busy';

/** The open-run outcome: ok carries the fresh run log, refused carries
 * the reason. startKeyboardRun/startModuleRun propagate it unchanged. */
export type FirmwareRunOutcome =
  | { ok: true; log: FirmwareRunLog }
  | { ok: false; reason: FirmwareRunRefusal };

/** Refusal reason → the exact user-facing line the dialogs toast.
 * Exported (not DOM) so the smoke pins the copy verbatim. */
export function firmwareRunRefusalText(reason: FirmwareRunRefusal): string {
  return reason === 'run-active'
    ? 'A firmware run is already active'
    : 'Device busy — wait for the current operation to finish';
}

/** Open a firmware run. Refuses ({ ok: false } + reason) when one is
 * already active — one run at a time, never two procedures racing for
 * the halves — or when the app is otherwise busy (busyRef held by a
 * keymap flash/dump). Otherwise: freeze flag on, busyRef held, unload
 * guards registered, { ok: true } with the fresh log whose run.start
 * meta is already written. */
export function beginFirmwareRun(
  deps: FlashDeps,
  kind: 'keyboard' | 'module',
): FirmwareRunOutcome {
  if (activeRun !== null) return { ok: false, reason: 'run-active' };
  if (deps.busyRef.current) return { ok: false, reason: 'device-busy' };
  deps.busyRef.current = true;
  const win = guardTarget(deps);
  if (win) {
    win.addEventListener('beforeunload', unloadHandler);
    win.addEventListener('pagehide', unloadHandler);
  }
  const log = new FirmwareRunLog(kind);
  activeRun = {
    log,
    deps,
    removeGuards: () => {
      if (win) {
        win.removeEventListener('beforeunload', unloadHandler);
        win.removeEventListener('pagehide', unloadHandler);
      }
    },
  };
  return { ok: true, log };
}

/** Close the active run: guards removed, flag + busyRef released, run.end
 * verdict written. No active run → no-op (null). */
export function endFirmwareRun(
  ok: boolean,
  summary?: string,
  failures?: string[],
  advisories?: string[],
): FirmwareRunLog | null {
  const run = activeRun;
  if (run === null) return null;
  activeRun = null;
  run.removeGuards();
  run.deps.busyRef.current = false;
  run.log.finish(ok, summary ?? (ok ? 'finished' : 'failed'), failures, advisories);
  return run.log;
}

/* ---- Preflight capture / verify ------------------------------------------ */

export interface PreflightHalf {
  fwHex: string | null; // fe/1002 raw payload
  fwText: string | null; // fwVersionText of the same payload
  bleAddress: string | null; // be/1008
  pairAddress: string | null; // be/1002
  bondedPeers: string[] | null; // be/1005 (null = no/invalid answer)
  modulePresent: boolean | null; // de/1001 — the undock-gate input
  moduleType: string | null; // readAux convention: absent → 'none'
  moduleHalfBit: number | null;
}

export interface PreflightBank {
  keysStatus: string;
  keysHex: string | null; // blob hex when status === 'ok'
  ledsStatus: string;
  ledsHex: string | null;
}

export interface PreflightDoc {
  halves: { left: PreflightHalf | null; right: PreflightHalf | null };
  keymapBanks: Record<'0' | '1', PreflightBank> | null; // left-only capture
}

export interface PreflightCapture {
  kind: 'preflight';
  capturedAt: number; // side-band — NOT part of the serialized doc
  data: PreflightDoc;
  serialized: string; // stableStringify(data)
  sha256: string;
}

/* One half's identity + presence. Every read is independently guarded: a
 * dead verb records null (or 'error') and the capture continues. */
async function readHalfPreflight(ses: NayaSession): Promise<PreflightHalf> {
  const half: PreflightHalf = {
    fwHex: null,
    fwText: null,
    bleAddress: null,
    pairAddress: null,
    bondedPeers: null,
    modulePresent: null,
    moduleType: null,
    moduleHalfBit: null,
  };
  try {
    const f = await ses.cmd(0xfe, 0x10, 0x02, new Uint8Array([0]));
    half.fwHex = toHex(f.payload);
    half.fwText = fwVersionText(f.payload);
  } catch {
    /* recorded as null — one dead read never sinks the capture */
  }
  const addr = await bleGetAddress(ses);
  half.bleAddress = addr ? toHex(addr) : null;
  const pair = await bleGetPairAddress(ses);
  half.pairAddress = pair ? toHex(pair) : null;
  const pairs = await bleGetAllPairs(ses);
  half.bondedPeers = pairs ? pairs.macs.map((m) => toHex(m)) : null;
  try {
    const d = await ses.cmd(0xde, 0x10, 0x01, new Uint8Array([0]));
    const m = modPresence(d.payload);
    if (m) {
      half.modulePresent = m.present;
      half.moduleType = m.present ? m.type : 'none';
      half.moduleHalfBit = m.halfBit;
    }
  } catch {
    /* null */
  }
  return half;
}

/* One keymap/LED bank via the same multipart reads the dump machinery (and
 * thus the auto-backup caches) uses. Non-'ok' statuses are the layer's
 * answer (useLayers precedent): recorded verbatim, no parse. */
async function readBankPreflight(ses: NayaSession, layer: number): Promise<PreflightBank> {
  const bank: PreflightBank = {
    keysStatus: 'error',
    keysHex: null,
    ledsStatus: 'error',
    ledsHex: null,
  };
  try {
    const kr = await ses.readLayer(layer);
    bank.keysStatus = kr.status;
    bank.keysHex = kr.status === 'ok' ? toHex(kr.blob) : null;
  } catch {
    /* 'error' */
  }
  try {
    const lr = await ses.readLedmap(layer);
    bank.ledsStatus = lr.status;
    bank.ledsHex = lr.status === 'ok' ? toHex(lr.blob) : null;
  } catch {
    /* 'error' */
  }
  return bank;
}

/* Capture the world doc for the requested sides (left first). Reads go
 * through the live sessions; missing sessions record null halves. Shared by
 * capturePreflight (pre-run, logs a 'preflight.capture' artifact note) and
 * the verify.compare tail (post-run, logged under 'verify.compare'). */
async function captureDoc(
  sessions: Map<Side, NayaSession>,
  sides: Side[],
): Promise<PreflightDoc> {
  const wantLeft = sides.includes('left');
  const wantRight = sides.includes('right');
  const left = wantLeft ? sessions.get('left') : undefined;
  const right = wantRight ? sessions.get('right') : undefined;
  const doc: PreflightDoc = {
    halves: {
      left: left ? await readHalfPreflight(left) : null,
      right: right ? await readHalfPreflight(right) : null,
    },
    keymapBanks: null,
  };
  if (left) {
    // Left only: the left half owns keymap/LED dest 0x50.
    doc.keymapBanks = {
      '0': await readBankPreflight(left, 0),
      '1': await readBankPreflight(left, 1),
    };
  }
  return doc;
}

/** Capture the preflight artifact for the requested sides (left first).
 * Reads go through the live sessions; missing sessions record null halves.
 * When `log` is omitted, the artifact note lands in the active run's log
 * (and nowhere when no run is active). */
export async function capturePreflight(
  sessions: Map<Side, NayaSession>,
  sides: Side[],
  log?: FirmwareRunLog | null,
): Promise<PreflightCapture> {
  const doc = await captureDoc(sessions, sides);
  const serialized = stableStringify(doc);
  const sha256 = await sha256Hex(serialized);
  const sink = log ?? activeRun?.log ?? null;
  sink?.note(
    'preflight.capture',
    undefined,
    `preflight artifact ${sha256.slice(0, 16)}… (${serialized.length} chars)`,
    { artifact: 'preflight', sha256, bytes: serialized.length },
  );
  return { kind: 'preflight', capturedAt: Date.now(), data: doc, serialized, sha256 };
}

/** Re-serialize the captured doc and refuse unless byte-identical (and the
 * digest still matches). Catches any post-capture mutation of the artifact. */
export async function verifyPreflight(
  cap: PreflightCapture,
): Promise<{ ok: boolean; reason?: string }> {
  const reserialized = stableStringify(cap.data);
  if (reserialized !== cap.serialized) {
    return {
      ok: false,
      reason: 'preflight artifact re-serialize mismatch — data changed since capture',
    };
  }
  if ((await sha256Hex(reserialized)) !== cap.sha256) {
    return { ok: false, reason: 'preflight artifact sha256 mismatch' };
  }
  return { ok: true };
}

/* ---- verify.compare (spec §5 step 14) ------------------------------------- */

/* The restore brightness value. There is no app-saved brightness cache to
 * read (BehaviorTab holds a UI-local default-100 state; nothing is
 * persisted), so the OF constant it is — maxBrtOp refuses 0..100 violations,
 * and a 0 here could black out the LEDs. */
const BRIGHTNESS_RESTORE_VALUE = 100;

/* One keymap bank's records, NONE-normalized: the stored blob hex parsed
 * into per-position records (parseLayer's universal [KK, T, LEN, …] rule).
 * A `07 00` NONE filler at a position EQUALS that position being absent —
 * the device compacts fillers away, so both shapes are the same "nothing
 * bound here". Values are the record hex minus the KK byte (the position).
 * Null = the bank was not readable (status ≠ 'ok'). */
function keyBankMap(status: string, hex: string | null): Map<number, string> | null {
  if (status !== 'ok' || hex === null) return null;
  const bytes = hexToBytes(hex);
  if (bytes === null) return null;
  const out = new Map<number, string>();
  for (const r of parseLayer(bytes).recs) {
    if (r.rec.length === 3 && r.rec[1] === 0x07 && r.rec[2] === 0x00) continue; // NONE == absent
    out.set(r.kk, toHex(r.rec.slice(1)));
  }
  return out;
}

/* Compare one keymap bank; null = equal, string = the first difference. */
function compareKeyBanks(a: PreflightBank, b: PreflightBank): string | null {
  const ma = keyBankMap(a.keysStatus, a.keysHex);
  const mb = keyBankMap(b.keysStatus, b.keysHex);
  if (ma === null || mb === null) {
    // Unreadable banks: equal only when BOTH sides failed the same way.
    return a.keysStatus === b.keysStatus && ma === mb ? null : `read status ${a.keysStatus} → ${b.keysStatus}`;
  }
  for (const [kk, rec] of ma) {
    const other = mb.get(kk);
    if (other === undefined) return `KK 0x${kk.toString(16)} record removed (${rec})`;
    if (other !== rec) return `KK 0x${kk.toString(16)} record changed (${rec} → ${other})`;
  }
  for (const [kk, rec] of mb) {
    if (!ma.has(kk)) return `KK 0x${kk.toString(16)} record added (${rec})`;
  }
  return null;
}

/* Compare one LED-map bank (advisory tier — never strict); null = equal. */
function compareLedBanks(a: PreflightBank, b: PreflightBank): string | null {
  const ba = hexToBytes(a.ledsHex ?? '');
  const bb = hexToBytes(b.ledsHex ?? '');
  if (ba !== null && bb !== null && a.ledsStatus === 'ok' && b.ledsStatus === 'ok') {
    if (toHex(ba) === toHex(bb)) return null;
    return `blob ${ba.length} B → ${bb.length} B`;
  }
  return a.ledsStatus === b.ledsStatus ? null : `read status ${a.ledsStatus} → ${b.ledsStatus}`;
}

/* One lighting.restore attempt on the left half (step 13): read the left
 * half's layer list (30/1001 handshake payload — the same read the app's
 * readInventory uses) and echo it straight back with one 30/1002 restore
 * frame, which clears runtime lighting effects on both halves (OF
 * service.py:1189-1207). Returns the echoed entry count; throws on
 * anything — the caller notes, never fatal. */
async function echoLayerListOnce(left: NayaSession): Promise<number> {
  const inv = parseInventory((await left.handshake()).payload);
  if (inv.length === 0) {
    throw new Error('layer list unreadable (0 entries) — nothing to echo back');
  }
  const ack = await left.writeLayerList(encodeRestorePayload(inv));
  // ACK gate: the settings/module write convention (00 …) or a layer-idx
  // echo 1..7; 0xEA = value rejected (useFlash isLayerListAck precedent).
  const ackOk = ack.payload.length > 0 &&
    (ack.payload[0] === 0x00 || (ack.payload[0] >= 0x01 && ack.payload[0] <= 0x07));
  if (!ackOk) throw new Error(`NACK ${toHex(ack.payload)}`);
  return inv.length;
}

/* Compare the postflight world doc against the preflight artifact. Strict
 * failures: per-half BLE address / pair address / bond table + the primary
 * (bank 0) keymap. LED map + second bank differences are advisories — and
 * only when the left half's firmware version changed across the flash (the
 * expected reason for them; an identical version must not invent findings).
 * The doc comparison is done on PARSED records with the NONE/absent
 * normalization (not raw hex equality): the choice that respects the
 * device's filler compaction. */
function comparePreflightDocs(
  pre: PreflightDoc,
  post: PreflightDoc,
): { strict: string[]; advisories: string[] } {
  const strict: string[] = [];
  const advisories: string[] = [];
  for (const side of ['left', 'right'] as const) {
    const a = pre.halves[side];
    const b = post.halves[side];
    if (a === null || b === null) {
      if (a !== null && b === null) {
        advisories.push(`${side}: postflight identity unreadable (half not on a live session)`);
      }
      continue;
    }
    if (a.bleAddress !== b.bleAddress) {
      strict.push(`${side}: BLE address changed (${a.bleAddress ?? 'unreadable'} → ${b.bleAddress ?? 'unreadable'})`);
    }
    if (a.pairAddress !== b.pairAddress) {
      strict.push(`${side}: pair address changed (${a.pairAddress ?? 'unreadable'} → ${b.pairAddress ?? 'unreadable'})`);
    }
    const bondA = a.bondedPeers === null ? null : a.bondedPeers.join(' ');
    const bondB = b.bondedPeers === null ? null : b.bondedPeers.join(' ');
    if (bondA !== bondB) {
      strict.push(`${side}: bond table changed (${bondA ?? 'unreadable'} → ${bondB ?? 'unreadable'})`);
    }
  }
  const versionChanged =
    pre.halves.left !== null && post.halves.left !== null &&
    pre.halves.left.fwText !== post.halves.left.fwText;
  const pb = pre.keymapBanks;
  const qb = post.keymapBanks;
  if (pb !== null && qb !== null) {
    const k0 = compareKeyBanks(pb['0'], qb['0']);
    if (k0 !== null) strict.push(`left: primary keymap bank changed across the flash (${k0})`);
    const k1 = compareKeyBanks(pb['1'], qb['1']);
    if (k1 !== null && versionChanged) {
      advisories.push(`left: second keymap bank differs across the version change (${k1})`);
    }
    for (const bank of ['0', '1'] as const) {
      const l = compareLedBanks(pb[bank], qb[bank]);
      if (l !== null && versionChanged) {
        advisories.push(`left: LED map bank ${bank} differs across the version change (${l})`);
      }
    }
  } else if (pb !== null || qb !== null) {
    advisories.push('left: postflight keymap banks unreadable (no live left session)');
  }
  return { strict, advisories };
}

/* ---- Keyboard flash-one-side core (spec §5 steps 1-8) --------------------- */

export interface FlashTimeouts {
  pollMs?: number; // getPorts poll cadence while the bootloader re-enumerates
  enterMs?: number; // window for the bootloader port to appear after enter
  swapMs?: number; // swap.verify observation window
  rePollMs?: number; // swap.verify re-poll cadence
  probeMs?: number; // per-probe image-state timeout (port probing + settle identity probes)
  resetMs?: number; // os reset bounded wait (SmpDevice chunkMs class)
  confirmMs?: number; // version.confirm window for the app PID to (re)appear
  reResetMs?: number; // version.confirm re-reset cadence while the app port is missing
  settleMs?: number; // halves.settle window for BOTH halves to answer again
  rescueMs?: number; // stranded-half rescue window (spec §5 failure path)
  /* ---- module procedure (spec §6 constants) ---- */
  replugMs?: number; // bundle.restart: half unseen before the replug prompt (30 s)
  reappearMs?: number; // bundle.restart / module.restart await-left total window (600 s)
  dropMs?: number; // module.restart: window for the keyboard to drop after MOD_FWUP (120 s)
  modFindMs?: number; // module.verify: module fw+type confirm window (90 s)
  reBootResetMs?: number; // boot reset re-send cadence while a bootloader port shows (60 s)
  fwupMs?: number; // MOD_FWUP write-and-forget bounded wait (2 s)
  /* ---- upload (SDK stall guard) ---- */
  uploadTotalMs?: number; // whole-upload wall-clock bound — a non-advancing `off` throws (600 s)
}

/* Spec defaults — the ONLY sleeps the procedure does; smoke injects
 * millisecond-scale values over these. */
export const FLASH_TIMEOUT_DEFAULTS = {
  pollMs: 500,
  enterMs: 60_000,
  swapMs: 300_000,
  rePollMs: 2_000,
  /* First SMP image-state answer after a fresh latch is SLOW: KB measures
   * 4–69 s (create-collective KB, flashing page); our own live board
   * answered os-echo in 1.6 s but image-state stayed silent >30 s. A 5 s
   * probe would abort a healthy booting half at identify. Smoke injects
   * its own per-case probeMs, so this default is production-only. */
  probeMs: 70_000,
  resetMs: 20_000,
  confirmMs: 300_000,
  reResetMs: 30_000,
  settleMs: 90_000,
  rescueMs: 300_000,
  replugMs: 30_000,
  reappearMs: 600_000,
  dropMs: 120_000,
  modFindMs: 90_000,
  reBootResetMs: 60_000,
  fwupMs: 2_000,
  uploadTotalMs: 600_000,
} as const;

export interface StartKeyboardTarget {
  side: Side;
  label: string;
}

export interface StartKeyboardOpts {
  targets: StartKeyboardTarget[];
  allowOlder: boolean;
  acceptUnknown: boolean;
  consentedUnknown: boolean;
}

/* ---- module procedure (spec §6) ------------------------------------------- */

/* MOD_FWUP type codes (OF module_procedure.py FWUP_TYPES). These EXACT
 * codes — NOT nayactl's MODULE_TYPES order: the historical mismatch gave a
 * Tune the Track app. forceType values are exactly these keys, never ''
 * (T4 gate contract). */
export const FWUP_TYPES = { Touch: 1, Tune: 2, Track: 3 } as const;
export type ModuleForceType = keyof typeof FWUP_TYPES;

/* The bundle.restart replug prompt (spec §6) — emitted ONCE, 30 s after
 * the half went unseen, cleared by the return. */
export const MODULE_REPLUG_TEXT =
  "Unplug the left half's USB cable, count to ten, and plug it back in — " +
  'not a power cycle, nothing being written is interrupted';

export interface StartModuleOpts {
  /** Target bundle version (moduleFirmware ?? versionLabel). Absent = the
   * newest flashable bundle this keyboard firmware can take. */
  label?: string;
  /** Re-upload the bundle even when the stored version already matches. */
  forceUpload?: boolean;
  /** Program the module even when the dock decodes its type fine — the
   * ONLY lift of the unknown-type precondition (never bay/right/flashable). */
  forceType?: ModuleForceType;
  allowOlder: boolean;
}

/* Module-fw client cache: the pre-run reads (stored bundle version,
 * dock-reported fw, dock type) the precondition step produced — the module
 * dialog shows them as "last read" without re-asking a possibly-busy half.
 * startModuleRun's teardown clears it (finally semantics): firmware changed
 * under the run, so anything cached from before it is a lie. */
export interface ModuleFwSnapshot {
  stored: string | null;
  running: string | null;
  type: string | null;
  at: number;
}
let moduleFwCache: ModuleFwSnapshot | null = null;

/** The last module-fw precondition read, or null (never read / invalidated
 * by a finished run). */
export function moduleFwSnapshot(): ModuleFwSnapshot | null {
  return moduleFwCache;
}

/* Module-shared blob vault: fetchVersion primes it, the flash consumes it.
 * The vault contract (lib/firmware-fetch) guarantees bytes are stored only
 * under a VERIFIED digest, so the gate's heldSha256 = the vault key is
 * honest without re-digesting. Persisted across reloads via
 * lib/firmware-vault-store (write-through + FirmwareTab-mount hydrate). */
const sharedVault: Vault = newVault();

export function firmwareVault(): Vault {
  return sharedVault;
}

const hexCompact = (u8: Uint8Array): string => toHex(u8).replace(/ /g, '');

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/* Read the USB identity off a world port; a missing/throwing getInfo (fake
 * ports, odd drivers) just means "unidentifiable". */
function usbOf(p: PortWithInfo): { vid?: number; pid?: number } {
  try {
    const i = p.getInfo?.();
    return { vid: i?.usbVendorId, pid: i?.usbProductId };
  } catch {
    return {};
  }
}

/* Mode/side match from the PID table — the ONLY way a port is trusted. A
 * foreign VID (when reported) never matches, and an unknown PID never
 * matches (pidInfo answers null; reported as unknown, never guessed). */
function portMatches(p: PortWithInfo, side: Side, mode: 'app' | 'mcuboot'): boolean {
  const { vid, pid } = usbOf(p);
  if (pid === undefined) return false;
  if (vid !== undefined && vid !== NAYA_VID) return false;
  const info = pidInfo(pid);
  return info !== null && info.side === side && info.mode === mode;
}

/* Side-specific bootloader grant filters: the enter step passes these to
 * the grant mechanism so the browser picker offers only this side's
 * MCUboot PIDs (gen A + gen B from RECOVERY_PIDS) — a stale grant of the
 * other half must never satisfy the pick. App PIDs never appear:
 * RECOVERY_PIDS holds mcuboot PIDs only, and the side comes from pidInfo. */
export function grantFiltersForSide(side: Side): GrantFilter[] {
  return RECOVERY_PIDS.filter((pid) => pidInfo(pid)?.side === side)
    .map((pid) => ({ usbVendorId: NAYA_VID, usbProductId: pid }));
}

interface SideConsole {
  text: string;
}

/* Wrap a world port so every byte that crosses it also lands (decoded, as
 * complete non-SMP lines) in a console sink. This is the log-port tap: a
 * half in MCUboot exposes TWO CDC interfaces — one speaks SMP, the other
 * only babbles — and the babble is evidence (spec §2). The wrapper owns the
 * lazy open (real WebSerial ports have null streams until open() and again
 * once closed, so a port can be re-opened for each probe); SMP frame lines
 * are filtered out of the sink — the console is device noise, not our own
 * traffic. */
function tappedPort(port: PortWithInfo, sink: SideConsole): PortWithInfo {
  const dec = new TextDecoder();
  let lineBuf = '';
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  const ensureOpen = async (): Promise<void> => {
    if (reader !== null && writer !== null) return;
    if (!port.readable || !port.writable) await port.open?.({ baudRate: 115200 });
    const readable = port.readable;
    const writable = port.writable;
    if (!readable || !writable) throw new Error('port has no streams');
    reader = readable.getReader();
    writer = writable.getWriter();
  };
  const pushText = (s: string): void => {
    lineBuf += s;
    for (;;) {
      const i = lineBuf.indexOf('\n');
      if (i < 0) break;
      const line = lineBuf.slice(0, i + 1);
      lineBuf = lineBuf.slice(i + 1);
      if (!line.startsWith('\x06\x09') && !line.startsWith('\x04\x14')) sink.text += line;
    }
  };
  const readable = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        await ensureOpen();
        const { done, value } = await reader!.read();
        if (done) {
          c.close();
          return;
        }
        if (value) {
          pushText(dec.decode(value, { stream: true }));
          c.enqueue(value);
        }
      } catch (e) {
        c.error(e instanceof Error ? e : new Error(String(e)));
      }
    },
    async cancel() {
      try {
        await reader?.cancel();
      } catch {
        /* ignore */
      }
    },
  });
  const writable = new WritableStream<Uint8Array>({
    async write(b) {
      await ensureOpen();
      await writer!.write(b);
    },
  });
  return {
    open: (o) => port.open?.(o),
    get readable() {
      return readable;
    },
    get writable() {
      return writable;
    },
    close: () => port.close?.(),
    getInfo: port.getInfo !== undefined ? () => port.getInfo!() : undefined,
  };
}

interface ProbeOutcome {
  winner: { link: SmpLink; device: SmpDevice; slots: ImageSlot[]; port: PortWithInfo; console: SideConsole } | null;
  consoleText: string;
}

/* Probe ONE candidate port with an image-state read. First answer wins
 * (spec §2: keep the answering port for the whole visit); a silent port
 * times out on probeMs, closes, and its console text rides back. SmpLink's
 * default 250 ms open-settle applies (spec §1: bootloader settle window).
 * resetMs feeds the device's chunkMs class — os reset (mcuboot.exit) uses
 * that timeout, so it must be injectable wherever a probe device exists. */
async function probeOnce(port: PortWithInfo, probeMs: number, resetMs: number): Promise<ProbeOutcome> {
  const con: SideConsole = { text: '' };
  let link: SmpLink | null = null;
  try {
    link = await SmpLink.open(tappedPort(port, con));
    /* The injected probe timeout is genuinely dynamic, but SmpDevice's
     * override type pins the as-const defaults (SDK wart) — thread it
     * through a cast instead of narrowing the SDK's own API from here. */
    const device = new SmpDevice(
      link,
      { transceiveMs: probeMs, chunkMs: resetMs } as unknown as Partial<typeof SMP_DEFAULT_TIMEOUTS>,
    );
    const slots = await device.imageState();
    return { winner: { link, device, slots, port, console: con }, consoleText: con.text };
  } catch {
    if (link !== null) await link.close();
    return { winner: null, consoleText: con.text };
  }
}

/* Race EVERY candidate port in parallel — the sequential first-answer loop
 * starved the answering port of SMP traffic while a silent twin burned the
 * whole per-silent-port probe budget against the ~30s MCUboot latch window.
 * Here all probes START at once (every parked half sees an SMP frame
 * immediately, so its latch holds), the first winner in candidate order is
 * kept, every extra answerer's link is closed (never leaked), and the
 * console text of ALL settled results is concatenated (a silent port's
 * babble is evidence — never dropped). Same-side ports only; callers pass
 * an already-filtered candidate list. */
async function probeFirst(ports: PortWithInfo[], probeMs: number, resetMs: number): Promise<ProbeOutcome> {
  const uniq = [...new Set(ports)];
  const results = await Promise.all(uniq.map((p) => probeOnce(p, probeMs, resetMs)));
  let winner: ProbeOutcome['winner'] = null;
  let consoleText = '';
  for (const r of results) {
    consoleText += r.consoleText;
    if (r.winner === null) continue;
    if (winner === null) winner = r.winner;
    else await r.winner.link.close(); // a second answerer — its link must not leak
  }
  return { winner, consoleText };
}

/* ---- return-to-app helpers (spec §5 steps 9-11) --------------------------- */

/* fe/1002 payload → the declared version string the catalog labels use:
 * the aux text convention ('v3.41.0.0  [hex]' → '3.41.0.0', v-prefix
 * stripped). */
function fwTextOf(payload: Uint8Array): string {
  const t = fwVersionText(payload).split('  [')[0] ?? '';
  return t.startsWith('v') ? t.slice(1) : t;
}

/* Strict dot-version tuple ('3.41.0' → [3, 41, 0], Naya '0.3.41.0' →
 * [3, 41, 0]); null when the string is not one (non-versioned labels
 * like 'NayaFlow 1.14.3' never compare). */
function dotTupleOf(v: string): number[] | null {
  const s = stripNayaLeadingZero(v);
  if (!/^\d+(\.\d+)*$/.test(s)) return null;
  return s.split('.').map((p) => Number.parseInt(p, 10));
}

/* The device reports four components ('3.41.0.0'), the catalog labels three
 * ('3.41.0') — trailing all-zero dot components compare equal. Anything
 * non-numeric on either side refuses to match (never a false mismatch). */
function versionsMatch(device: string, label: string): boolean {
  const a = dotTupleOf(device);
  const b = dotTupleOf(label);
  if (a === null || b === null) return false;
  while (a.length > 1 && a[a.length - 1] === 0) a.pop();
  while (b.length > 1 && b[b.length - 1] === 0) b.pop();
  return a.join('.') === b.join('.');
}

/* os reset against ONE known bootloader port (step 9). The reset reply
 * usually never comes — the device reboots mid-reply — so the bounded wait
 * resolving either way IS success. */
async function resetPort(port: PortWithInfo, resetMs: number): Promise<void> {
  let link: SmpLink | null = null;
  try {
    link = await SmpLink.open(tappedPort(port, { text: '' }));
    const device = new SmpDevice(
      link,
      { chunkMs: resetMs } as unknown as Partial<typeof SMP_DEFAULT_TIMEOUTS>,
    );
    await device.osReset();
  } finally {
    if (link !== null) await link.close();
  }
}

/* mcuboot.exit: os reset on the SMP-answering bootloader port of the side —
 * the swap-verify answerer when we have it (a silent twin never sees an SMP
 * write), else a fresh probe across the side's bootloader ports. Answers
 * false when no bootloader port responds: the half already rebooted. */
async function exitBootloader(
  world: SerialWorld,
  side: Side,
  answerPort: PortWithInfo | null,
  probeMs: number,
  resetMs: number,
): Promise<boolean> {
  if (answerPort !== null) {
    await resetPort(answerPort, resetMs);
    return true;
  }
  const boots = [...new Set((await world.getPorts()).filter((p) => portMatches(p, side, 'mcuboot')))];
  const first = await probeFirst(boots, probeMs, resetMs);
  if (first.winner === null) return false;
  await first.winner.device.osReset();
  await first.winner.link.close();
  return true;
}

/* Open a procedure-owned app-mode session with the SAME connect+identify
 * discipline as useSessions.connectPort: NayaSession.connect (2.5 s settle
 * + drain + wake), fa/1001 wire identify (payload ≥27 B = left — the PID
 * said the side, the wire must agree), dst + left-only handshake. Null on
 * any failure — the port may be mid-enumeration; callers keep polling. */
async function openOwnedSession(port: PortWithInfo, side: Side): Promise<NayaSession | null> {
  let ses: NayaSession | null = null;
  try {
    ses = await NayaSession.connect(port as unknown as SerialPort, side === 'left' ? DST_LEFT : DST_RIGHT);
    const dev = await ses.cmd(0xfa, 0x10, 0x01, new Uint8Array([0]));
    const idSide: Side = dev.payload.length >= 27 ? 'left' : 'right';
    if (idSide !== side) {
      await ses.close();
      return null;
    }
    ses.dst = side === 'left' ? DST_LEFT : DST_RIGHT;
    if (side === 'left') await ses.handshake();
    return ses;
  } catch {
    if (ses !== null) {
      try {
        await ses.close();
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}

/** The keyboard flash procedure (spec §5 steps 1-11): preflight → per target
 * side, left first — mcuboot enter → bootloader port discovery (poll +
 * optional user grant) → probe/identify (arm token = slot-0 hash, running
 * image classified by catalog plaintextSha256) → live gate → upload (erase
 * ok on first chunk ack) → swap.verify observation → mcuboot.exit (os reset
 * on the answering port only) → version.confirm (procedure-owned app
 * session on the re-enumerated port; mismatch refuses — the write is
 * hash-verified and the half re-flashable; a non-versioned target is
 * advisory-only) — then globally halves.settle (BOTH known halves answering
 * again; timeout fails the verdict but never aborts) and the run-end
 * handover: owned sessions closed, dead pre-flash sessions disconnected,
 * freeze flag cleared, rescan() handed the ports back.
 *
 * Returns { ok: true } with the finished run log, or { ok: false } with
 * the refusal reason when the run could not begin (another run active /
 * busyRef held) — resolved, never thrown. */
export async function startKeyboardRun(
  deps: FlashDeps,
  opts: StartKeyboardOpts,
): Promise<FirmwareRunOutcome> {
  const world = deps.world ?? defaultSerialWorld();
  const vault = deps.vault ?? sharedVault;
  const T = { ...FLASH_TIMEOUT_DEFAULTS, ...deps.timeouts };
  const begun = beginFirmwareRun(deps, 'keyboard');
  if (!begun.ok) return begun;
  const log = begun.log;
  deps.onBegin?.(log);

  const failures: string[] = [];
  const advisories: string[] = [];
  /* Procedure-owned app sessions (version.confirm → settle) — NEVER stored
   * in sesRef; they live and die with the run. */
  const owned = new Map<Side, NayaSession>();
  /* Sides whose app session is dead (the half rebooted and its port
   * re-enumerated): at handover those sesRef entries get closed + removed;
   * a pre-run session of a half we never touched stays untouched. */
  const entered = new Set<Side>();
  /* Sides that version.confirm brought back to app mode — proof the half
   * left its bootloader, so the rescue pass never touches them. */
  const confirmed = new Set<Side>();
  /* Sides whose settle probe failed (dead sessions): their sesRef entries
   * are dropped at handover too — a stale dead session must not block the
   * post-run rescan/connectPort from rebuilding the half (T7 review). */
  const deadSides = new Set<Side>();
  /* The run-end handover: close owned sessions, disconnect the dead
   * pre-flash sessions, clear the freeze flag, then hand the ports back to
   * rescan() — it rebuilds the live sessions on the re-enumerated app
   * ports. */
  const finishRun = async (ok: boolean, summary: string): Promise<FirmwareRunOutcome> => {
    for (const s of owned.values()) {
      try {
        await s.close();
      } catch {
        /* ignore */
      }
    }
    owned.clear();
    for (const side of new Set([...entered, ...deadSides])) {
      const ses = deps.sesRef.current.get(side);
      if (ses !== undefined) {
        try {
          await ses.close();
        } catch {
          /* ignore */
        }
        deps.sesRef.current.delete(side);
      }
    }
    endFirmwareRun(ok, summary, failures, advisories);
    if (deps.rescan !== undefined) {
      try {
        await deps.rescan();
      } catch {
        /* best-effort handover — the user can always reconnect manually */
      }
    }
    return { ok: true, log };
  };

  /* ---- stranded-half rescue (spec §5 failure path) ------------------------
   * For each entered half not proven back in app mode (and not visibly on
   * an app port): find the answering bootloader port, os-reset it, then
   * await the app PID within rescueMs — re-resetting on the reResetMs
   * cadence. Three logged outcomes, none of which softens the original
   * failure (rescue success logs its own recovery outcome; the verdict
   * keeps what failed): back running X / still parked → power-cycle note /
   * left the bootloader but not on USB → unplug-replug note. */
  const rescueSide = async (side: Side): Promise<void> => {
    log.start('rescue', side);
    const ports0 = await world.getPorts();
    if (ports0.some((p) => portMatches(p, side, 'app'))) {
      // The half is visibly in app mode — nothing stranded (candidate-filter
      // race); the settle/compare tail covers the session side.
      log.ok('rescue', side, { detail: `the ${side} half is back in app mode` });
      return;
    }
    const boots = [...new Set(ports0.filter((p) => portMatches(p, side, 'mcuboot')))];
    if (boots.length === 0) {
      const d = `the ${side} half left the bootloader but is not on USB — unplug and replug it`;
      log.fail('rescue', side, d);
      failures.push(`rescue: ${d}`);
      return;
    }
    // Find the ANSWERING bootloader port (the silent twin never sees an SMP
    // write), and os-reset it — raced in parallel so a silent-first listing
    // cannot burn the probe budget before the answerer is tried.
    let answer: PortWithInfo | null = null;
    const first = await probeFirst(boots, T.probeMs, T.resetMs);
    if (first.winner !== null) {
      answer = first.winner.port;
      await first.winner.link.close();
    }
    if (answer !== null) {
      try {
        await resetPort(answer, T.resetMs);
      } catch {
        /* the reset may still land — the window below keeps polling */
      }
    } else {
      log.note('rescue', side, `no ${side} bootloader port answers SMP — waiting out the window in case it recovers on its own`);
    }
    const rescueDeadline = Date.now() + T.rescueMs;
    let lastReset = Date.now();
    for (;;) {
      if ((await world.getPorts()).some((p) => portMatches(p, side, 'app'))) break;
      const now = Date.now();
      if (now >= rescueDeadline) {
        const stillParked = (await world.getPorts()).some((p) => portMatches(p, side, 'mcuboot'));
        const d = stillParked
          ? `the ${side} half is still parked in its bootloader — a power cycle brings it back (nothing written is lost)`
          : `the ${side} half left the bootloader but is not on USB — unplug and replug it`;
        log.fail('rescue', side, d);
        failures.push(`rescue: ${d}`);
        return;
      }
      if (now - lastReset >= T.reResetMs) {
        // Re-reset with a FRESH probe (exitBootloader with no kept port):
        // the original answerer may have vanished mid-swap while its twin
        // now answers.
        try {
          await exitBootloader(world, side, null, T.probeMs, T.resetMs);
        } catch {
          /* best-effort — keep polling */
        }
        lastReset = Date.now();
      }
      await sleep(Math.min(T.pollMs, Math.max(0, rescueDeadline - Date.now())));
    }
    // Back in app: read the version for the outcome line (garnish — a dead
    // read just means "back in app mode").
    let ver = '';
    const appPort = (await world.getPorts()).find((p) => portMatches(p, side, 'app')) ?? null;
    if (appPort !== null) {
      const ses = await openOwnedSession(appPort, side);
      if (ses !== null) {
        try {
          const f = await ses.cmd(0xfe, 0x10, 0x02, new Uint8Array([0]));
          ver = fwTextOf(f.payload);
        } catch {
          /* version is garnish */
        }
        try {
          await ses.close();
        } catch {
          /* ignore */
        }
      }
    }
    log.ok('rescue', side, {
      detail: ver !== '' ? `the ${side} half is back running ${ver}` : `the ${side} half is back in app mode`,
    });
  };
  const rescueStranded = async (): Promise<void> => {
    for (const side of entered) {
      if (confirmed.has(side)) continue; // proven out of its bootloader
      const ports = await world.getPorts();
      if (ports.some((p) => portMatches(p, side, 'app'))) continue; // visible in app — settle handles the session
      await rescueSide(side);
    }
  };

  /* Failure tail: rescue any stranded half, then the failing verdict. EVERY
   * failure exit funnels through here — a half left in its bootloader is
   * put back into the application before the run reports failure. */
  const failTail = async (detail: string): Promise<FirmwareRunOutcome> => {
    try {
      await rescueStranded();
    } catch (e) {
      failures.push(`rescue: ${msgOf(e)}`);
    }
    return finishRun(false, `keyboard flash failed — ${detail}`);
  };
  const abort = (step: string, side: Side | undefined, detail: string): Promise<FirmwareRunOutcome> => {
    failures.push(`${step}: ${detail}`);
    log.fail(step, side, detail);
    return failTail(detail);
  };

  /* Per-side console bookkeeping: probed-port text accumulates across the
   * whole side visit; the winning SMP port's tap lives only while its link
   * does (upload window). Dumped as a `bootloader.console` note on success
   * AND failure — never lost. */
  const dumpConsole = (side: Side, probeConsole: string, live: SideConsole | null): void => {
    const text = (probeConsole + (live?.text ?? '')).trim();
    if (text === '') return;
    const capped = text.length > 2000
      ? `${text.slice(0, 2000)}… (+${text.length - 2000} more chars)`
      : text;
    log.note('bootloader.console', side, capped);
  };

  try {
    /* Dedupe sides, LEFT first (spec §5: left half first when both). */
    const seen = new Set<Side>();
    const targets: StartKeyboardTarget[] = [];
    for (const t of opts.targets) {
      if (seen.has(t.side)) continue;
      seen.add(t.side);
      targets.push(t);
    }
    targets.sort((a, b) => (a.side === b.side ? 0 : a.side === 'left' ? -1 : 1));
    if (targets.length === 0) return abort('run.start', undefined, 'no target sides requested');

    /* Every target side needs a live app session before anything moves. */
    for (const t of targets) {
      if (!deps.sesRef.current.get(t.side)) {
        return abort('mcuboot.enter', t.side, `no app session for the ${t.side} half — connect it first`);
      }
    }

    /* ---- preflight: capture, undock refusal, verify (steps 1-2) ---------- */
    log.start('preflight.capture');
    const cap = await capturePreflight(deps.sesRef.current, ['left', 'right'], log);
    log.ok('preflight.capture');
    const docked = (['left', 'right'] as const).some((s) => cap.data.halves[s]?.modulePresent === true);
    if (docked) {
      return abort('preflight.capture', undefined, 'modules are docked — undock them before flashing the keyboard');
    }
    log.start('preflight.verify');
    const pv = await verifyPreflight(cap);
    if (!pv.ok) return abort('preflight.verify', undefined, pv.reason ?? 'preflight verify failed');
    log.ok('preflight.verify');

    /* ---- pre-boot plan: never park a half without bytes in hand ----------
     * Generation comes from the app port's PID while it still speaks app
     * mode. Ruling: an entry that does not resolve CLEANLY fails here with
     * the plan reason — never a gate input that silently passes. */
    const cat = await loadFirmwareCatalog();
    const ports0 = await world.getPorts();
    const plans = new Map<Side, HalfPlan>();
    for (const t of targets) {
      const appPort = ports0.find((p) => portMatches(p, t.side, 'app'));
      const pid = appPort !== undefined ? usbOf(appPort).pid ?? null : null;
      const [plan] = resolveKeyboardPlan(cat, [{ side: t.side, pid, fw: null }], vault, t.label).halves;
      plans.set(t.side, plan);
      if (plan.image === null || plan.reason !== undefined) {
        return abort('gate.check', t.side, plan.reason ?? 'no image for this half+generation');
      }
      if (!vault.has(plan.image.blobSha256)) {
        return abort('gate.check', t.side, `the ${t.label} image is not in the vault — download the version first`);
      }
    }

    /* ---- per side: enter → identify → gate → upload → swap.verify -------- */
    for (const t of targets) {
      const side = t.side;
      const plan = plans.get(side)!;
      const entry: FwEntry = plan.image!;
      const gen = plan.generation!;

      /* Step 3: mcuboot enter. After this the session is DEAD (the half
       * reboots mid-exchange and its port re-enumerates) — it is never
       * touched again this run; lifecycle/backfill is the later tasks'. */
      log.start('mcuboot.enter', side);
      const ses = deps.sesRef.current.get(side)!;
      await ses.enterMcuboot();
      entered.add(side); // the half is rebooting — its app session is dead now

      /* Step 4 (port discovery): find the re-enumerated MCUboot port of this
       * side. With a grant mechanism the action fires IMMEDIATELY — a half
       * the browser never granted is INVISIBLE to getPorts, so polling
       * first would burn the whole ~30s MCUboot latch window dead (live
       * 2026-10-13: the window opens at enter, a valid SMP frame inside
       * it latches parking; the owner's picker click IS that frame's ride).
       * The scan keeps racing the grant so an already-granted port (a
       * second run) still wins on its own. */
      const scan = async (): Promise<PortWithInfo | null> => {
        const ports = await world.getPorts();
        return ports.find((p) => portMatches(p, side, 'mcuboot')) ?? null;
      };
      let bootPort: PortWithInfo | null = null;
      if (deps.grantPort !== undefined) {
        log.action('mcuboot.enter', side, 'grant the bootloader port — pick the Naya device in the browser prompt');
        let granted: PortWithInfo | null | undefined; // undefined = pending, null = cancelled
        /* PID-scoped picker: only this side's bootloader PIDs are offered —
         * a stale grant of the other half cannot satisfy the pick. */
        const grantP: Promise<PortWithInfo | null> = deps.grantPort(grantFiltersForSide(side)).then(
          (p) => {
            granted = p;
            return p;
          },
          () => {
            granted = null;
            return null;
          },
        );
        const grantDeadline = Date.now() + T.enterMs;
        while (bootPort === null && granted === undefined && Date.now() < grantDeadline) {
          bootPort = await scan();
          if (bootPort !== null) break;
          const remain = grantDeadline - Date.now();
          if (remain <= 0) break;
          const stepped = await Promise.race([
            grantP,
            sleep(Math.min(T.pollMs, remain)).then(() => null),
          ]);
          if (stepped !== null) {
            bootPort = stepped;
            break;
          }
        }
        /* Late-grant cleanup: the scan may have won while the picker was
         * still open (or the deadline passed first) — the late pick is then
         * unused and must not linger as a held grant shadowing the next
         * run's picker. Best-effort: fakes may lack forget entirely. */
        void grantP.then((p) => {
          if (p === null || p === bootPort) return;
          if (typeof p.forget === 'function') void p.forget();
        });
        if (bootPort !== null && !portMatches(bootPort, side, 'mcuboot')) {
          return abort('mcuboot.enter', side, 'the granted port is not the expected bootloader — replug the half and retry');
        }
        if (bootPort === null && granted === null) {
          return abort('mcuboot.enter', side, 'the port grant was cancelled — replug the half and retry');
        }
      } else {
        const enterDeadline = Date.now() + T.enterMs;
        while (bootPort === null && Date.now() < enterDeadline) {
          bootPort = await scan();
          if (bootPort !== null) break;
          const remain = enterDeadline - Date.now();
          if (remain <= 0) break;
          await sleep(Math.min(T.pollMs, remain));
        }
      }
      if (bootPort === null) {
        return abort(
          'mcuboot.enter',
          side,
          deps.grantPort !== undefined
            ? 'the bootloader port was never granted — replug the half and retry'
            : 'no bootloader port appeared — replug the half and retry',
        );
      }
      log.ok('mcuboot.enter', side);

      /* Identify: race EVERY mcuboot candidate of the side in parallel —
       * first imageState answer wins, silent ports close and ride the
       * console. Sequential order here burned the latch window when the
       * silent twin listed first. */
      log.start('identify', side);
      const allBoot = [...new Set((await world.getPorts()).filter((p) => portMatches(p, side, 'mcuboot')))];
      const first = await probeFirst(allBoot, T.probeMs, T.resetMs);
      const win = first.winner;
      let probeConsole = first.consoleText;
      if (win === null) {
        dumpConsole(side, probeConsole, null);
        return abort('identify', side, 'no bootloader port answered SMP image-state — replug the half and retry');
      }
      const { link, device, slots, console: liveConsole } = win;

      /* Arm token + running-image classification: slot-0 hash IS the arm
       * token (gate rule: same-run device hash, never cached); matching it
       * against the catalog's plaintextSha256 values classifies the running
       * version. The fw string in fe/1002 is gone — the hash is the truth
       * while parked. */
      const slot0 = slots.find((s) => s.slot === 0) ?? null;
      if (slot0 === null || slot0.hash.length === 0) {
        await link.close();
        dumpConsole(side, probeConsole, liveConsole);
        return abort('identify', side, 'the bootloader reported no slot-0 hash');
      }
      const slot0Hex = hexCompact(slot0.hash);
      const running = cat.images.find(
        (e) => typeof e.plaintextSha256 === 'string' && e.plaintextSha256.toLowerCase() === slot0Hex.toLowerCase(),
      );
      const runningFw = running !== undefined ? running.createFirmware ?? running.versionLabel ?? null : null;
      const unknownCurrent = running === undefined;
      log.note(
        'identify',
        side,
        running !== undefined
          ? `running image is ${runningFw ?? 'unlabeled'} (slot-0 ${slot0Hex.slice(0, 16)}…)`
          : `running image is unknown to the catalog (slot-0 ${slot0Hex.slice(0, 16)}…)`,
        { sha256: slot0Hex },
      );
      log.ok('identify', side);

      /* Upload-target numbering: KB-measured — keyboard images upload to
       * direct slot id 2 (slot 1) on this firmware family; the vendor
       * procedure never queries slot-info. Live 2026-10-13: a slot-info
       * READ on fw 3.41.0 answered once (alien shape, no "0,1" key) and
       * the bootloader's SMP service then went fully silent — identify had
       * answered seconds earlier, rescue never got another reply. The
       * numbering is a routing choice, not a safety input: never sending
       * slot-info removes the wedge trigger and matches the KB path. The
       * gate's uploadImageId === 2 check is therefore a standing
       * tautology — INTENTIONAL defense-in-depth (SDK resolveUploadImageId
       * stays the numbering-rule reference; fixtures cover both). */
      log.start('slot.map', side);
      const imageId = 2;
      log.ok('slot.map', side, { detail: 'image id 2 (KB-measured; slot-info not queried)' });

      /* Step 5: the interlock gate on live values. */
      log.start('gate.check', side);
      const bytes = vault.get(entry.blobSha256);
      if (bytes === undefined) {
        await link.close();
        dumpConsole(side, probeConsole, liveConsole);
        return abort('gate.check', side, 'image bytes missing from the vault');
      }
      const [livePlan] = resolveKeyboardPlan(
        cat,
        [{ side, pid: usbOf(win.port).pid ?? null, fw: runningFw }],
        vault,
        t.label,
      ).halves;
      const gateInput: KeyboardGateInput = {
        kind: 'keyboard',
        entry,
        heldSha256: entry.blobSha256,
        arm: slot0Hex,
        slot0Hash: slot0Hex,
        pidSide: side,
        pidGeneration: gen,
        fileSize: bytes.length,
        downgrade: livePlan.downgrade,
        allowOlder: opts.allowOlder,
        unknownCurrent,
        consented: opts.acceptUnknown && opts.consentedUnknown,
        modulesDocked: docked,
        uploadImageId: imageId,
      };
      const refusals = checkFlashGate(gateInput);
      if (refusals.length > 0) {
        await link.close();
        dumpConsole(side, probeConsole, liveConsole);
        return abort('gate.check', side, refusals.join('; ')); // NO upload bytes written
      }
      log.ok('gate.check', side);
      if (unknownCurrent && opts.consentedUnknown) {
        log.note('gate.check', side, 'unknown running firmware — consent given (there is no way back)');
      }
      if (livePlan.unchanged) {
        log.note('gate.check', side, `target ${t.label} is already running — re-flashing anyway`);
        advisories.push(`${side}: target version is already running`);
      }

      /* Steps 6-7: upload. slot.erase starts with the first chunk (the
       * erase IS that chunk's stall) and turns ok when the bootloader
       * accepts it; progress lands at 5% steps. The device-reported offset
       * is authoritative (SDK upload loop). Two hashes, never swapped:
       * the WIRE sha (the first chunk's sha field) is computed inside the
       * SDK as the digest of the uploaded bytes themselves; verify-sha
       * below is what the device reports for the DECRYPTED running image
       * (plaintextSha256) — swap.verify compares the post-swap slot-0
       * readback against IT. */
      const shaHex = (entry.plaintextSha256 ?? '').toLowerCase();
      const shaBytes = hexToBytes(shaHex);
      if (shaBytes === null) {
        await link.close();
        dumpConsole(side, probeConsole, liveConsole);
        return abort('upload', side, 'the catalog carries no verifiable plaintext hash for this image');
      }
      log.start('slot.erase', side);
      log.start('upload', side);
      let eraseOk = false;
      let lastPct = -1;
      try {
        await device.uploadImage(
          { bytes, verifySha256: shaBytes, imageId },
          {
            maxTotalMs: T.uploadTotalMs,
            onProgress: (p) => {
              const pct = Math.floor((p.sent / p.total) * 100);
              if (pct >= lastPct + 5 || p.sent >= p.total) {
                lastPct = pct;
                log.progress('upload', side, pct, p.sent, p.total);
              }
            },
            onFirstChunkAck: () => {
              if (!eraseOk) {
                eraseOk = true;
                log.ok('slot.erase', side);
              }
            },
          },
        );
      } catch (e) {
        const m = msgOf(e);
        if (!eraseOk) log.fail('slot.erase', side, m);
        log.fail('upload', side, m);
        await link.close();
        dumpConsole(side, probeConsole, liveConsole);
        failures.push(`upload: ${m}`);
        return failTail(m); // the half may sit parked in its bootloader — rescue before the verdict
      }
      log.ok('upload', side);
      /* The winning link's job is done — the port may vanish the moment the
       * swap runs; swap.verify opens fresh probes. */
      await link.close();

      /* Step 8: swap.verify — observation only: re-read image state on ANY
       * mcuboot port of the side until slot-0 is the uploaded hash; early
       * success when the side's app PID reappears. The answering port that
       * proves the swap is kept for mcuboot.exit — the reset must go to IT
       * only (a silent twin never sees an SMP write). */
      log.start('swap.verify', side);
      const swapDeadline = Date.now() + T.swapMs;
      let swapped = false;
      let swapDetail = '';
      let swapAnswerPort: PortWithInfo | null = null;
      while (!swapped && Date.now() < swapDeadline) {
        const ports = await world.getPorts();
        if (ports.some((p) => portMatches(p, side, 'app'))) {
          swapped = true;
          swapDetail = `the ${side} app port re-appeared (swap ran)`;
          break;
        }
        const boots = [...new Set(ports.filter((p) => portMatches(p, side, 'mcuboot')))];
        if (boots.length > 0) {
          const results = await Promise.all(boots.map((c) => probeOnce(c, T.probeMs, T.resetMs)));
          for (const r of results) {
            probeConsole += r.consoleText;
            if (r.winner === null) continue;
            const s0 = r.winner.slots.find((s) => s.slot === 0);
            if (s0 !== undefined && hexCompact(s0.hash).toLowerCase() === shaHex) {
              swapped = true;
              swapDetail = `slot-0 is the uploaded image (${shaHex.slice(0, 16)}…)`;
              swapAnswerPort = r.winner.port;
            }
            await r.winner.link.close();
          }
        }
        if (swapped) break;
        const remain = swapDeadline - Date.now();
        if (remain <= 0) break;
        await sleep(Math.min(T.rePollMs, remain));
      }
      dumpConsole(side, probeConsole, liveConsole);
      if (!swapped) {
        return abort('swap.verify', side, `the swap did not appear within ${Math.round(T.swapMs / 1000)} s`);
      }
      log.ok('swap.verify', side, { detail: swapDetail, sha256: shaHex });

      /* ---- step 9: mcuboot.exit — os reset on the answering port ---------- */
      log.start('mcuboot.exit', side);
      try {
        const exited = await exitBootloader(world, side, swapAnswerPort, T.probeMs, T.resetMs);
        if (exited) {
          log.ok('mcuboot.exit', side);
        } else {
          log.note('mcuboot.exit', side, 'no bootloader port answers — the half already rebooted');
          log.ok('mcuboot.exit', side);
        }
      } catch (e) {
        /* A throwing reset on a STALE answer-port (the half rebooted under
         * us between swap.verify and this reset) is not a refusal: fall
         * through to the probe-fallback reading — the half already
         * rebooted; version.confirm below re-checks it comes back. */
        log.note('mcuboot.exit', side, `the reset on the answering port failed (${msgOf(e)}) — treating it as already rebooted`);
        log.ok('mcuboot.exit', side);
      }

      /* ---- step 10: version.confirm — the half must come back running the
       * flashed image: poll for the app PID (re-sending the reset every
       * reResetMs to the answering bootloader port), open a procedure-owned
       * session with the connectPort discipline and read fe/1002. A proven
       * mismatch REFUSES — the write itself is hash-verified, so the half
       * can simply be re-flashed. A non-versioned target (or a device
       * string that is not a version) cannot be confirmed on-device:
       * advisory note only, never a false refusal. */
      log.start('version.confirm', side);
      const confirmDeadline = Date.now() + T.confirmMs;
      let lastReset = Date.now();
      let versionSes = owned.get(side) ?? null;
      let confirmedDetail: string | null = null;
      let versionAdvisory: string | null = null;
      for (;;) {
        const appPort = (await world.getPorts()).find((p) => portMatches(p, side, 'app')) ?? null;
        if (appPort !== null && versionSes === null) {
          versionSes = await openOwnedSession(appPort, side);
          if (versionSes !== null) owned.set(side, versionSes);
        }
        if (versionSes !== null) {
          try {
            const f = await versionSes.cmd(0xfe, 0x10, 0x02, new Uint8Array([0]));
            const got = fwTextOf(f.payload);
            if (versionsMatch(got, t.label)) {
              confirmedDetail = `the ${side} half is back on app mode running ${got} — matches ${t.label}`;
            } else if (dotTupleOf(t.label) === null) {
              versionAdvisory = `target ${t.label} carries no device version — cannot confirm on-device (the half reports ${got})`;
              confirmedDetail = versionAdvisory;
            } else if (dotTupleOf(got) === null) {
              versionAdvisory = `the ${side} half reports "${got}" — not a comparable device version (target was ${t.label})`;
              confirmedDetail = versionAdvisory;
            } else {
              return abort(
                'version.confirm',
                side,
                `the ${side} half reports ${got} but ${t.label} was flashed — ` +
                  'the write itself is hash-verified, so this half can be re-flashed',
              );
            }
            break;
          } catch {
            /* connect/read died mid-exchange (the half may still be coming
             * up): drop the session and keep polling for the port. */
            if (owned.get(side) === versionSes) owned.delete(side);
            try {
              await versionSes.close();
            } catch {
              /* ignore */
            }
            versionSes = null;
          }
        }
        if (confirmedDetail !== null) break;
        const now = Date.now();
        if (now >= confirmDeadline) break;
        if (now - lastReset >= T.reResetMs) {
          /* The swap ran but the half is not back: re-send the reset to the
           * answering bootloader port (it may have missed the first one). */
          try {
            await exitBootloader(world, side, swapAnswerPort, T.probeMs, T.resetMs);
          } catch {
            /* best-effort — keep polling */
          }
          lastReset = Date.now();
        }
        await sleep(Math.min(T.pollMs, Math.max(0, confirmDeadline - Date.now())));
      }
      if (confirmedDetail === null) {
        return abort(
          'version.confirm',
          side,
          `the ${side} half never returned to app mode within ${Math.round(T.confirmMs / 1000)} s`,
        );
      }
      confirmed.add(side); // proof the half left its bootloader — rescue skips it
      if (versionAdvisory !== null) log.note('version.confirm', side, versionAdvisory);
      else log.note('version.confirm', side, confirmedDetail);
      log.ok('version.confirm', side);
    }

    /* ---- step 11: halves.settle — BOTH known halves answering again ------ */
    /* The central drops off USB during the halves' re-link (known hardware
     * behavior): re-probe the sessions we hold — owned first, then any
     * pre-run session of a half we never rebooted — and poll the world for
     * a re-appeared app port otherwise. Timeout fails the verdict but the
     * run CONTINUES (the restores compare re-check later). The identity
     * probe is fr.readFrame with an INJECTED deadline — never cmd(), whose
     * 6-try ladder would stall ~30 s on a dead port. */
    log.start('halves.settle');
    const settleSides = new Set<Side>(targets.map((t2) => t2.side));
    for (const s of ['left', 'right'] as const) {
      if (deps.sesRef.current.has(s)) settleSides.add(s);
    }
    const probeIdentity = async (ses: NayaSession): Promise<boolean> => {
      try {
        ses.fr.clear();
        await ses.writeFn(buildFrame(ses.dst, 0xfa, 0x10, 0x01, new Uint8Array([0])));
        const f = await ses.fr.readFrame(T.probeMs);
        return f.type === 0xfa;
      } catch {
        return false;
      }
    };
    const settled = new Set<Side>();
    const settleDeadline = Date.now() + T.settleMs;
    while (settled.size < settleSides.size && Date.now() < settleDeadline) {
      for (const side of settleSides) {
        if (settled.has(side)) continue;
        let ses = owned.get(side) ?? null;
        if (ses !== null && (await probeIdentity(ses))) {
          settled.add(side);
          continue;
        }
        if (ses !== null) {
          try {
            await ses.close();
          } catch {
            /* ignore */
          }
          owned.delete(side);
        }
        ses = deps.sesRef.current.get(side) ?? null;
        if (ses !== null && (await probeIdentity(ses))) {
          settled.add(side);
          continue;
        }
        const appPort = (await world.getPorts()).find((p) => portMatches(p, side, 'app')) ?? null;
        if (appPort !== null) {
          const fresh = await openOwnedSession(appPort, side);
          if (fresh !== null) {
            owned.set(side, fresh);
            settled.add(side);
            continue;
          }
        }
      }
      if (settled.size < settleSides.size) {
        const remain = settleDeadline - Date.now();
        if (remain <= 0) break;
        await sleep(Math.min(T.pollMs, remain));
      }
    }
    for (const side of settleSides) {
      if (settled.has(side)) continue;
      const detail = `the ${side} half never answered identity again within ${Math.round(T.settleMs / 1000)} s — power-cycle it if it stays dark`;
      log.fail('halves.settle', side, detail);
      failures.push(`halves.settle: ${detail}`);
      deadSides.add(side); // its session is dead — the handover must drop it
    }
    if (settled.size === settleSides.size) {
      log.ok('halves.settle', undefined, { detail: `${settled.size} half${settled.size === 1 ? '' : 'ves'} answered identity again` });
    }

    /* ---- steps 12-13: restores (cosmetic, never fatal) -------------------- */
    /* brightness.restore: LED max brightness 100 through each flashed
     * half's settled session (ed/1013 settings-path write). Lighting
     * restore: read the LEFT half's layer list and echo it straight back —
     * one frame to the left clears runtime lighting effects on both halves
     * (the useFlash flash-tail echo / App rewriteLayerList precedent).
     * A throwing restore lands as a note; it never enters the verdict. */
    for (const t of targets) {
      const side = t.side;
      const ses = owned.get(side) ?? null;
      log.start('brightness.restore', side);
      if (ses === null) {
        log.note('brightness.restore', side, `no live session for the ${side} half — skipped (cosmetic)`);
        continue;
      }
      try {
        const op = maxBrtOp(BRIGHTNESS_RESTORE_VALUE);
        const { t: ty, c0, c1 } = parseCmdPath(op.path);
        const f = await ses.cmd(ty, c0, c1, op.payload);
        if (f.payload.length === 0 || f.payload[0] !== 0x00) {
          throw new Error(`NACK ${toHex(f.payload)}`);
        }
        log.ok('brightness.restore', side, { detail: `max brightness ${BRIGHTNESS_RESTORE_VALUE}` });
      } catch (e) {
        log.note('brightness.restore', side, `not restored (${msgOf(e)}) — cosmetic, the run continues`);
      }
    }
    log.start('lighting.restore', 'left');
    {
      const left = owned.get('left') ?? deps.sesRef.current.get('left') ?? null;
      if (left === null) {
        log.note('lighting.restore', 'left', 'no live session for the left half — skipped (cosmetic)');
      } else {
        try {
          const n = await echoLayerListOnce(left);
          log.ok('lighting.restore', 'left', {
            detail: `${n} entr${n === 1 ? 'y' : 'ies'} echoed back — stored lighting restored on both halves`,
          });
        } catch (e) {
          log.note('lighting.restore', 'left', `not restored (${msgOf(e)}) — cosmetic, the run continues`);
        }
      }
    }

    /* ---- step 14: verify.compare — re-capture on the settled sessions ----- */
    log.start('verify.compare');
    try {
      const postSessions = new Map<Side, NayaSession>();
      for (const side of settleSides) {
        if (!settled.has(side)) continue; // a dark half's reads would only stall — settle failed it already
        const ses = owned.get(side) ?? deps.sesRef.current.get(side);
        if (ses !== undefined) postSessions.set(side, ses);
      }
      const postDoc = await captureDoc(postSessions, ['left', 'right']);
      const postSerialized = stableStringify(postDoc);
      const postSha = await sha256Hex(postSerialized);
      log.note(
        'verify.compare',
        undefined,
        `postflight artifact ${postSha.slice(0, 16)}… (${postSerialized.length} chars)`,
        { artifact: 'postflight', sha256: postSha, bytes: postSerialized.length },
      );
      const { strict, advisories: cmpAdvisories } = comparePreflightDocs(cap.data, postDoc);
      for (const a of cmpAdvisories) {
        advisories.push(`verify.compare: ${a}`);
        log.note('verify.compare', undefined, a);
      }
      if (strict.length > 0) {
        for (const s of strict) failures.push(`verify.compare: ${s}`);
        log.fail('verify.compare', undefined, strict.join('; '));
      } else {
        log.ok('verify.compare', undefined, {
          detail: 'identities + primary keymap match the preflight snapshot',
        });
      }
    } catch (e) {
      /* The compare itself must never sink the run harder than a note: a
       * dead port mid-capture is recorded as nulls by the readers, so this
       * is a belt+braces for unexpected world throws. */
      log.note('verify.compare', undefined, `compare skipped (${msgOf(e)}) — cosmetic`);
    }

    /* ---- belt: no half left parked before the verdict --------------------- */
    try {
      await rescueStranded();
    } catch (e) {
      failures.push(`rescue: ${msgOf(e)}`);
    }

    /* ---- run end: hand the ports back ------------------------------------- */
    const ok = failures.length === 0;
    return finishRun(
      ok,
      ok
        ? `keyboard flash finished — ${targets.length} half${targets.length === 1 ? '' : 's'} updated`
        : `keyboard flash finished with failures — ${targets.length} half${targets.length === 1 ? '' : 's'} updated`,
    );
  } catch (e) {
    /* Belt+braces: an unexpected throw (world rejection, dead port) fails
     * the run honestly instead of leaking the lock — and still rescues any
     * half we left parked before reporting. */
    const m = msgOf(e);
    failures.push(`unexpected: ${m}`);
    return failTail(m);
  }
}

/* ---- Module flash procedure (spec §6) ------------------------------------- */

/* The dock's decoded type vs the programmed want. Touch/Track dock bytes
 * are live-proven (the de-family decoder); Tune's byte is not, so an
 * 'unknown' decode is accepted when programming a Tune — there the
 * firmware match is the authority. A WRONG type that decodes cleanly
 * (Touch reported, Track wanted) still refuses. */
function typeMatches(decoded: string | null, want: ModuleForceType): boolean {
  return decoded === want || (decoded === 'unknown' && want === 'Tune');
}

/* 'v3.41.0.0  [hex]' → '3.41.0.0' when it is a clean dot-version, else
 * null ('—', 'NayaFlow 1.14.3', unreadable — never compared). The Naya
 * leading-zero form ('v0.3.41.0', live-proven 2026-10-13) normalizes to
 * the catalog form ('3.41.0'). */
function labelOfFwText(t: string | null): string | null {
  if (t === null) return null;
  const s = (t.split('  [')[0] ?? '').trim();
  if (s === '' || s === '—') return null;
  const raw = s.startsWith('v') ? s.slice(1) : s;
  if (dotTupleOf(raw) === null) return null;
  return stripNayaLeadingZero(raw);
}

/* de/1008 — the dock-reported module firmware ('v2.3.3.0'), null when the
 * read dies or the dock is empty. de/1001 — the dock type decode. */
async function readModuleFw(ses: NayaSession): Promise<string | null> {
  try {
    const d = await ses.cmd(0xde, 0x10, 0x08, new Uint8Array([0]));
    return modFwText(d.payload);
  } catch {
    return null;
  }
}

async function readDockType(ses: NayaSession): Promise<string | null> {
  try {
    const d = await ses.cmd(0xde, 0x10, 0x01, new Uint8Array([0]));
    return modPresence(d.payload)?.type ?? null;
  } catch {
    return null;
  }
}

/** The module flash procedure (spec §6): preconditions on the live left
 * half only (right unplugged; module docked LEFT; type known unless
 * forceType; newest flashable bundle the keyboard firmware can take;
 * stored/running read from the dock) → the already-runs shortcut (no
 * bootloader entry) → ONE SMP link conversation (identify = slot-0 arm
 * token, slot map retried 3×, image id 4 — unmapped allowed only for an
 * exactly-1 MiB bundle) → upload → deliberately NO post-upload reset (the
 * half self-restarts ~1 s) → bundle.restart (replug `action` prompt once
 * after replugMs unseen; boot reset re-sent on the cadence while a
 * bootloader port shows; ≤ reappearMs) → bundle.verify (stored == target)
 * → module.program (MOD_FWUP de/1005, one FWUP_TYPES byte, no reply) →
 * module.restart (await the keyboard drop, then await the half back) →
 * module.verify (module fw == target AND type == want ≤ modFindMs; a clean
 * wrong-type decode refuses, pointing at Force Update) → verify.compare
 * (left identity + keymap vs preflight) → verdict. The failure tail
 * recovers a parked left half; run teardown invalidates the module-fw
 * client cache and hands the ports back (both verdicts — finally
 * semantics). Every wait is an injected `timeouts` value. Resolves
 * { ok: true } with the finished run log, or { ok: false } with the
 * refusal reason when the run could not begin — never thrown. */
export async function startModuleRun(
  deps: FlashDeps,
  opts: StartModuleOpts,
): Promise<FirmwareRunOutcome> {
  const world = deps.world ?? defaultSerialWorld();
  const vault = deps.vault ?? sharedVault;
  const T = { ...FLASH_TIMEOUT_DEFAULTS, ...deps.timeouts };
  const begun = beginFirmwareRun(deps, 'module');
  if (!begun.ok) return begun;
  const log = begun.log;
  deps.onBegin?.(log);

  const failures: string[] = [];
  const advisories: string[] = [];
  /* Procedure-owned app sessions on the re-enumerated left port (bundle
   * restart / module restart) — never stored in sesRef. */
  const owned = new Map<Side, NayaSession>();
  /* Set when the enter frame landed: the pre-flash left session is dead
   * from that moment (the half reboots), so the handover must drop it. */
  let leftRebooted = false;
  let cacheDone = false;
  const invalidateModuleCache = (): void => {
    if (cacheDone) return;
    cacheDone = true;
    moduleFwCache = null; // the module-fw snapshot cache — finally semantics
    try {
      deps.onModuleCacheStale?.();
    } catch {
      /* best-effort — the sweep rebuilds the verdicts anyway */
    }
  };

  const finishRun = async (ok: boolean, summary: string): Promise<FirmwareRunOutcome> => {
    for (const s of owned.values()) {
      try {
        await s.close();
      } catch {
        /* ignore */
      }
    }
    owned.clear();
    if (leftRebooted) {
      const ses = deps.sesRef.current.get('left');
      if (ses !== undefined) {
        try {
          await ses.close();
        } catch {
          /* ignore */
        }
        deps.sesRef.current.delete('left');
      }
    }
    endFirmwareRun(ok, summary, failures, advisories);
    invalidateModuleCache();
    if (deps.rescan !== undefined) {
      try {
        await deps.rescan();
      } catch {
        /* best-effort handover — the user can always reconnect manually */
      }
    }
    return { ok: true, log };
  };

  /* Failure tail: a parked left half is put back into the application
   * before the run reports failure (os reset to the answering bootloader
   * port, then the app PID awaited within rescueMs, re-resets on the
   * cadence). */
  const failTail = async (detail: string): Promise<FirmwareRunOutcome> => {
    if (leftRebooted) {
      try {
        const ports0 = await world.getPorts();
        if (!ports0.some((p) => portMatches(p, 'left', 'app'))) {
          try {
            await exitBootloader(world, 'left', null, T.probeMs, T.resetMs);
          } catch {
            /* the reset may still land — the window below keeps polling */
          }
          const deadline = Date.now() + T.rescueMs;
          let lastReset = Date.now();
          for (;;) {
            if ((await world.getPorts()).some((p) => portMatches(p, 'left', 'app'))) break;
            const now = Date.now();
            if (now >= deadline) {
              const d = 'the left half never returned to app mode — unplug and replug it';
              log.fail('rescue', 'left', d);
              failures.push(`rescue: ${d}`);
              break;
            }
            if (now - lastReset >= T.reBootResetMs) {
              try {
                await exitBootloader(world, 'left', null, T.probeMs, T.resetMs);
              } catch {
                /* best-effort — keep polling */
              }
              lastReset = now;
            }
            await sleep(Math.min(T.pollMs, Math.max(0, deadline - Date.now())));
          }
          if ((await world.getPorts()).some((p) => portMatches(p, 'left', 'app'))) {
            log.ok('rescue', 'left', { detail: 'the left half is back in app mode' });
          }
        }
      } catch (e) {
        failures.push(`rescue: ${msgOf(e)}`);
      }
    }
    return finishRun(false, `module flash failed — ${detail}`);
  };
  const abort = (step: string, detail: string): Promise<FirmwareRunOutcome> => {
    failures.push(`${step}: ${detail}`);
    log.fail(step, 'left', detail);
    return failTail(detail);
  };

  /* Await the left half's app port and open a procedure-owned session on
   * it (the openOwnedSession connect+identify discipline). The replug
   * prompt (bundle.restart only) fires ONCE after replugMs unseen; a
   * visible bootloader port gets the boot reset re-sent on the cadence. */
  const awaitLeftApp = async (o: {
    windowMs: number;
    replugAfterMs: number | null;
    step: string;
  }): Promise<NayaSession> => {
    const t0 = Date.now();
    const deadline = t0 + o.windowMs;
    let actionSent = false;
    let lastBootReset = Date.now();
    for (;;) {
      const ports = await world.getPorts();
      const appPort = ports.find((p) => portMatches(p, 'left', 'app')) ?? null;
      if (appPort !== null) {
        const s = await openOwnedSession(appPort, 'left');
        if (s !== null) return s;
      }
      const now = Date.now();
      if (now >= deadline) {
        throw new Error(`the left half never came back within ${Math.round(o.windowMs / 1000)} s`);
      }
      if (o.replugAfterMs !== null && !actionSent && now - t0 >= o.replugAfterMs) {
        actionSent = true;
        log.action(o.step, 'left', MODULE_REPLUG_TEXT);
      }
      if (
        now - lastBootReset >= T.reBootResetMs &&
        ports.some((p) => portMatches(p, 'left', 'mcuboot'))
      ) {
        try {
          await exitBootloader(world, 'left', null, T.probeMs, T.resetMs);
        } catch {
          /* best-effort — keep polling */
        }
        lastBootReset = now;
      }
      await sleep(Math.min(T.pollMs, Math.max(0, deadline - Date.now())));
    }
  };

  /* fr-based identity probe with an INJECTED deadline — never cmd(), whose
   * 6-try ladder would stall on a dead port (halves.settle precedent). */
  const probeIdentityOwned = async (ses: NayaSession): Promise<boolean> => {
    try {
      ses.fr.clear();
      await ses.writeFn(buildFrame(ses.dst, 0xfa, 0x10, 0x01, new Uint8Array([0])));
      const f = await ses.fr.readFrame(T.probeMs);
      return f.type === 0xfa;
    } catch {
      return false;
    }
  };

  try {
    /* ---- preflight: capture (left only — the right half must be gone) ---- */
    if (!deps.sesRef.current.get('left')) {
      return abort('bundle.check', 'no app session for the left half — connect it first');
    }
    log.start('preflight.capture');
    const cap = await capturePreflight(deps.sesRef.current, ['left'], log);
    log.ok('preflight.capture');
    log.start('preflight.verify');
    const pv = await verifyPreflight(cap);
    if (!pv.ok) return abort('preflight.verify', pv.reason ?? 'preflight verify failed');
    log.ok('preflight.verify');

    /* ---- bundle.check: the §6 preconditions, left-half values only ------ */
    log.start('bundle.check');
    const left = deps.sesRef.current.get('left')!;
    const ports0 = await world.getPorts();
    const rightConnected =
      deps.sesRef.current.has('right') ||
      ports0.some((p) => portMatches(p, 'right', 'app') || portMatches(p, 'right', 'mcuboot'));
    if (rightConnected) {
      return abort('bundle.check', 'the right half is connected — unplug it before flashing modules');
    }
    const preLeft = cap.data.halves.left;
    const dockedSide: 'left' | 'right' | null =
      preLeft?.modulePresent === true ? ((preLeft.moduleHalfBit ?? 0) & 1) === 0 ? 'left' : 'right' : null;
    if (dockedSide === 'right') {
      return abort('bundle.check', 'the module is docked in the right bay — move it to the left bay');
    }
    if (dockedSide === null) {
      return abort('bundle.check', 'no module is docked — dock it in the left bay first');
    }
    /* The bundle's keyboardRange is checked against the RUNNING keyboard
     * firmware (fe/1002 via the preflight capture) — the pairing guard. */
    const kbFw = labelOfFwText(preLeft?.fwText ?? null);
    const cat = await loadFirmwareCatalog();
    const want: ModuleForceType | null =
      opts.forceType ??
      (preLeft?.moduleType === 'Touch' || preLeft?.moduleType === 'Track' || preLeft?.moduleType === 'Tune'
        ? preLeft.moduleType
        : null);
    if (want === null) {
      return abort(
        'bundle.check',
        'the module type is unknown — use Force Update to pick the type (the wrong type gives it the wrong app)',
      );
    }
    /* The stored bundle version + the dock-reported running fw (the
     * upload/program decisions), then the client-cache snapshot. */
    const stored = await left.moduleFileFwVersion();
    const runningRaw = await readModuleFw(left);
    const running = runningRaw !== null ? (runningRaw.startsWith('v') ? runningRaw.slice(1) : runningRaw) : null;
    moduleFwCache = { stored, running, type: preLeft?.moduleType ?? null, at: Date.now() };

    const plan: ModulePlan = resolveModulePlan(cat, kbFw, running, opts.label);
    if (plan.entry === null || plan.target === null) {
      return abort('bundle.check', plan.reason ?? 'no module bundle resolved for this keyboard');
    }
    const entry: FwEntry = plan.entry;
    const target = plan.target;
    if (plan.bundleNewerThanKeyboard) {
      return abort(
        'bundle.check',
        `the ${target} bundle is newer than the keyboard firmware (${kbFw ?? 'unreadable'}) — update the keyboard first`,
      );
    }
    const bytes = vault.get(entry.blobSha256);
    if (bytes === undefined) {
      return abort('bundle.check', `the ${target} bundle is not in the vault — download the version first`);
    }
    log.note(
      'bundle.check',
      'left',
      `keyboard ${kbFw ?? 'unreadable'} · module type ${preLeft?.moduleType ?? 'unknown'}` +
        ` · stored ${stored ?? 'unreadable'} · running ${running ?? 'unreadable'} → ${target}`,
      { sha256: entry.blobSha256 },
    );

    /* upload = forceUpload || stored !== target; program = forceType != null
     * || running !== target. Neither → the module is already on target:
     * finish ok WITHOUT touching its bootloader. */
    const uploadNeeded = opts.forceUpload === true || !versionsMatch(stored ?? '', target);
    const programNeeded = opts.forceType !== undefined || !versionsMatch(running ?? '', target);
    if (!uploadNeeded && !programNeeded) {
      log.ok('bundle.check', 'left');
      return finishRun(true, `the module already runs ${target} — nothing to do`);
    }
    if (!uploadNeeded) {
      log.note('bundle.check', 'left', `the ${target} bundle is already stored — skipping the upload`);
    }
    log.ok('bundle.check', 'left');

    /* ---- enter the left half's bootloader -------------------------------- */
    if (uploadNeeded) {
      log.start('mcuboot.enter', 'left');
      try {
        await left.enterMcuboot();
      } catch (e) {
        return abort('mcuboot.enter', `the enter write failed (${msgOf(e)})`);
      }
      leftRebooted = true; // the half is rebooting — its app session is dead now
      let bootPort: PortWithInfo | null = null;
      const enterDeadline = Date.now() + T.enterMs;
      while (bootPort === null && Date.now() < enterDeadline) {
        bootPort = (await world.getPorts()).find((p) => portMatches(p, 'left', 'mcuboot')) ?? null;
        if (bootPort !== null) break;
        const remain = enterDeadline - Date.now();
        if (remain <= 0) break;
        await sleep(Math.min(T.pollMs, remain));
      }
      if (bootPort === null) {
        return abort('mcuboot.enter', 'no bootloader port appeared — replug the left half and retry');
      }
      log.ok('mcuboot.enter', 'left');

      /* ---- ONE link conversation: identify → slot map → chunks ------------
       * Candidates raced in parallel (probeFirst) — same latch-window reason
       * as the keyboard identify: a silent-first listing must not burn the
       * probe budget before the answerer is tried. */
      log.start('identify', 'left');
      const candidates = [...new Set((await world.getPorts()).filter((p) => portMatches(p, 'left', 'mcuboot')))];
      const first = await probeFirst(candidates, T.probeMs, T.resetMs);
      const winner = first.winner;
      const probeConsole = first.consoleText;
      if (winner === null) {
        const text = probeConsole.trim();
        if (text !== '') log.note('bootloader.console', 'left', text.length > 2000 ? `${text.slice(0, 2000)}…` : text);
        return abort('identify', 'no bootloader port answered SMP image-state — replug the left half and retry');
      }
      const { link, device, slots, console: liveConsole } = winner;
      const slot0 = slots.find((s) => s.slot === 0) ?? null;
      if (slot0 === null || slot0.hash.length === 0) {
        await link.close();
        return abort('identify', 'the bootloader reported no slot-0 hash');
      }
      const slot0Hex = hexCompact(slot0.hash);
      log.note('identify', 'left', `bundle slot-0 ${slot0Hex.slice(0, 16)}… (arm token)`, { sha256: slot0Hex });
      log.ok('identify', 'left');

      /* Upload-target numbering: KB-measured — the module bundle (exactly
       * 1 MiB LittleFS) uploads to direct slot id 4 (slot3_partition),
       * which the KB notes is NOT listed in slot-info at all. Live
       * 2026-10-13 (keyboard run): a slot-info READ preceded total SMP
       * silence on fw 3.41.0, so the procedures never query it; the
       * exact-1-MiB gate rule already pins the bundle shape. As on the
       * keyboard path, the gate's uploadImageId === 4 check is a standing
       * tautology — INTENTIONAL defense-in-depth, same rationale. */
      log.start('slot.map', 'left');
      const imageId = 4;
      log.ok('slot.map', 'left', { detail: 'image id 4 (KB-measured; slot-info not queried)' });

      /* The interlock gate on live values (forceType lifts ONLY the type
       * rule — inside the gate; bay/right/arm/flashable always hold). */
      log.start('gate.check', 'left');
      const ports1 = await world.getPorts();
      const gateInput: ModuleGateInput = {
        kind: 'module',
        entry,
        heldSha256: entry.blobSha256,
        arm: slot0Hex,
        slot0Hash: slot0Hex,
        fileSize: bytes.length,
        bundleNewerThanKeyboard: plan.bundleNewerThanKeyboard,
        downgrade: plan.downgrade,
        allowOlder: opts.allowOlder,
        rightConnected:
          deps.sesRef.current.has('right') ||
          ports1.some((p) => portMatches(p, 'right', 'app') || portMatches(p, 'right', 'mcuboot')),
        moduleDockedSide: dockedSide,
        uploadImageId: imageId,
        forceType: opts.forceType ?? null,
      };
      const refusals = checkFlashGate(gateInput);
      if (refusals.length > 0) {
        await link.close();
        return abort('gate.check', refusals.join('; ')); // NO upload bytes written
      }
      log.ok('gate.check', 'left');
      if (plan.downgrade) {
        log.note('gate.check', 'left', `target ${target} is older than the running module firmware — re-flashing anyway`);
        advisories.push(`module: target version ${target} is a downgrade`);
      }

      /* Upload. The erase IS the first chunk's stall (slot.erase turns ok
       * on its ack); progress lands at 5% steps. NO reset after the last
       * chunk — the half self-restarts ~1 s later, and a reset here would
       * go into a closing port (§75(b) asserts zero post-upload resets).
       * The wire sha (first chunk) is the SDK-computed digest of the
       * uploaded bundle bytes; a littlefs bundle carries no plaintext
       * hash, so the verify target rides along as the entry's own blob
       * digest (bundle.verify checks the stored VERSION, not a readback
       * hash). */
      const shaBytes = hexToBytes(entry.blobSha256.toLowerCase());
      if (shaBytes === null) {
        await link.close();
        return abort('upload', 'catalog hash is not valid hex');
      }
      log.start('slot.erase', 'left');
      log.start('upload', 'left');
      let eraseOk = false;
      let lastPct = -1;
      try {
        await device.uploadImage(
          { bytes, verifySha256: shaBytes, imageId },
          {
            maxTotalMs: T.uploadTotalMs,
            onProgress: (p) => {
              const pct = Math.floor((p.sent / p.total) * 100);
              if (pct >= lastPct + 5 || p.sent >= p.total) {
                lastPct = pct;
                log.progress('upload', 'left', pct, p.sent, p.total);
              }
            },
            onFirstChunkAck: () => {
              if (!eraseOk) {
                eraseOk = true;
                log.ok('slot.erase', 'left');
              }
            },
          },
        );
      } catch (e) {
        const m = msgOf(e);
        if (!eraseOk) log.fail('slot.erase', 'left', m);
        log.fail('upload', 'left', m);
        await link.close();
        failures.push(`upload: ${m}`);
        return failTail(m); // the half may sit parked — rescue before the verdict
      }
      log.ok('upload', 'left');
      const conText = (probeConsole + liveConsole.text).trim();
      if (conText !== '') {
        log.note('bootloader.console', 'left', conText.length > 2000 ? `${conText.slice(0, 2000)}…` : conText);
      }
      await link.close(); // the conversation is over — the port may vanish any second
    } else {
      /* Bundle already stored: the conversation rides the LIVE app session
       * — but the half still reboots during module.restart below, so the
       * reboot bookkeeping applies from the program step on. */
      log.note('mcuboot.enter', 'left', 'skipped — the bundle is already stored, nothing enters the bootloader');
    }

    /* ---- bundle.restart: await the half back (upload path only) ---------- */
    let ses = owned.get('left') ?? left;
    if (uploadNeeded) {
      log.start('bundle.restart', 'left');
      try {
        ses = await awaitLeftApp({ windowMs: T.reappearMs, replugAfterMs: T.replugMs, step: 'bundle.restart' });
      } catch (e) {
        return abort('bundle.restart', msgOf(e));
      }
      owned.set('left', ses);
      log.ok('bundle.restart', 'left', { detail: 'the left half is back in app mode' });
    }

    /* ---- bundle.verify: stored == target ---------------------------------- */
    log.start('bundle.verify', 'left');
    const storedNow = await ses.moduleFileFwVersion();
    if (!versionsMatch(storedNow ?? '', target)) {
      return abort('bundle.verify', `the stored bundle version is ${storedNow ?? 'unreadable'} but ${target} was uploaded`);
    }
    log.ok('bundle.verify', 'left', { detail: `the stored bundle is ${target}` });

    /* ---- module.program: MOD_FWUP, one FWUP_TYPES byte, no reply ---------- */
    log.start('module.program', 'left');
    const typeCode = FWUP_TYPES[want];
    await ses.modFwup(typeCode, T.fwupMs);
    log.ok('module.program', 'left', { detail: `MOD_FWUP ${want} (code ${typeCode}) — the module programs itself next` });

    /* ---- module.restart: await the keyboard drop, then await it back ------ */
    log.start('module.restart', 'left');
    leftRebooted = true; // the keyboard restarts under us from here on
    const dropDeadline = Date.now() + T.dropMs;
    let dropped = false;
    while (Date.now() < dropDeadline) {
      if (!(await probeIdentityOwned(ses))) {
        dropped = true;
        break;
      }
      const remain = dropDeadline - Date.now();
      if (remain <= 0) break;
      await sleep(Math.min(T.pollMs, remain));
    }
    if (!dropped) {
      return abort('module.restart', 'the keyboard never restarted after module programming — the module may still be programming');
    }
    try {
      ses = await awaitLeftApp({ windowMs: T.reappearMs, replugAfterMs: null, step: 'module.restart' });
    } catch (e) {
      return abort('module.restart', msgOf(e));
    }
    owned.set('left', ses);
    log.ok('module.restart', 'left', { detail: 'the keyboard is back in app mode after the module restart' });

    /* ---- module.verify: fw == target AND type == want ≤ modFindMs -------- */
    log.start('module.verify', 'left');
    const vDeadline = Date.now() + T.modFindMs;
    let verified = false;
    for (;;) {
      const runningNow = await readModuleFw(ses);
      const dockType = await readDockType(ses);
      const fwOk = runningNow !== null && versionsMatch(runningNow.startsWith('v') ? runningNow.slice(1) : runningNow, target);
      if (fwOk && typeMatches(dockType, want)) {
        verified = true;
        log.ok('module.verify', 'left', { detail: `the module runs ${target} as ${want}` });
        break;
      }
      /* A CLEAN wrong-type decode refuses immediately — the wrong app is
       * on the module and Force Update is the way back. */
      if (dockType !== null && dockType !== 'unknown' && dockType !== 'none' && dockType !== want) {
        return abort(
          'module.verify',
          `the module reports type ${dockType} but ${want} was programmed — re-run with Force Update (the wrong type gives it the wrong app)`,
        );
      }
      const now = Date.now();
      if (now >= vDeadline) break;
      await sleep(Math.min(T.pollMs, Math.max(0, vDeadline - Date.now())));
    }
    if (!verified) {
      const got = await readModuleFw(ses);
      return abort(
        'module.verify',
        `the module never confirmed ${target} as ${want} within ${Math.round(T.modFindMs / 1000)} s (last read: ${got ?? 'unreadable'})`,
      );
    }

    /* ---- verify.compare: left identity + keymap vs preflight -------------- */
    log.start('verify.compare');
    try {
      const postSessions = new Map<Side, NayaSession>();
      postSessions.set('left', ses);
      const postDoc = await captureDoc(postSessions, ['left']);
      const postSerialized = stableStringify(postDoc);
      const postSha = await sha256Hex(postSerialized);
      log.note(
        'verify.compare',
        undefined,
        `postflight artifact ${postSha.slice(0, 16)}… (${postSerialized.length} chars)`,
        { artifact: 'postflight', sha256: postSha, bytes: postSerialized.length },
      );
      const { strict, advisories: cmpAdvisories } = comparePreflightDocs(cap.data, postDoc);
      for (const a of cmpAdvisories) {
        advisories.push(`verify.compare: ${a}`);
        log.note('verify.compare', undefined, a);
      }
      if (strict.length > 0) {
        for (const s of strict) failures.push(`verify.compare: ${s}`);
        log.fail('verify.compare', undefined, strict.join('; '));
      } else {
        log.ok('verify.compare', undefined, {
          detail: 'left identity + primary keymap match the preflight snapshot',
        });
      }
    } catch (e) {
      log.note('verify.compare', undefined, `compare skipped (${msgOf(e)}) — cosmetic`);
    }

    /* ---- run end ----------------------------------------------------------- */
    const ok = failures.length === 0;
    return finishRun(
      ok,
      ok ? `module flash finished — the module runs ${target}` : 'module flash finished with failures',
    );
  } catch (e) {
    /* Belt+braces: an unexpected throw fails the run honestly instead of
     * leaking the lock — and still recovers the left half first. */
    const m = msgOf(e);
    failures.push(`unexpected: ${m}`);
    return failTail(m);
  } finally {
    invalidateModuleCache();
  }
}

/* ---- React mirror --------------------------------------------------------- */

/** Thin reactive shell over the core: status/log/events state for the UI
 * timeline + exportLog (JSONL download). startKeyboard/startModule run the
 * whole procedure through startKeyboardRun/startModuleRun and mirror the
 * finished verdict into status; the run's own log/events land in state
 * when it completes. A refused start resolves with the reason (the dialog
 * toasts it) and leaves status idle. */
export function useFirmwareFlash(deps: FlashDeps): {
  status: FlashRunStatus;
  log: FirmwareRunLog | null;
  events: readonly RunEvent[];
  exportLog: () => void;
  beginRun: (kind: 'keyboard' | 'module') => FirmwareRunOutcome;
  endRun: (ok: boolean, summary?: string, failures?: string[], advisories?: string[]) => void;
  startKeyboard: (opts: StartKeyboardOpts) => Promise<FirmwareRunRefusal | null>;
  startModule: (opts: StartModuleOpts) => Promise<FirmwareRunRefusal | null>;
} {
  const { sesRef, busyRef, win } = deps;
  const [status, setStatus] = useState<FlashRunStatus>('idle');
  const [log, setLog] = useState<FirmwareRunLog | null>(null);
  const [events, setEvents] = useState<readonly RunEvent[]>([]);

  const beginRun = useCallback(
    (kind: 'keyboard' | 'module'): FirmwareRunOutcome => {
      const begun = beginFirmwareRun({ sesRef, busyRef, win }, kind);
      if (begun.ok) {
        const l = begun.log;
        setLog(l);
        setEvents(l.events);
        l.subscribe(() => {
          setEvents([...l.events]);
        });
        setStatus('running');
      }
      return begun;
    },
    [sesRef, busyRef, win],
  );

  const endRun = useCallback(
    (ok: boolean, summary?: string, failures?: string[], advisories?: string[]): void => {
      endFirmwareRun(ok, summary, failures, advisories);
      setStatus(ok ? 'done' : 'failed');
    },
    [],
  );

  const startKeyboard = useCallback(
    async (opts: StartKeyboardOpts): Promise<FirmwareRunRefusal | null> => {
      setStatus('running');
      /* The mirror subscribes through onBegin (the log opens synchronously
       * inside startKeyboardRun, before its first await) so the UI timeline
       * streams live — the same subscription beginRun makes; the final
       * setLog/setEvents below re-syncs to the finished log. A refused
       * start resolves with the reason (the dialog toasts it) — never throws. */
      const started = await startKeyboardRun(
        {
          ...deps,
          onBegin: (run) => {
            setLog(run);
            setEvents([...run.events]);
            run.subscribe(() => {
              setEvents([...run.events]);
            });
          },
        },
        opts,
      );
      if (!started.ok) {
        setStatus('idle'); // refused — the reason goes back for the dialog toast
        return started.reason;
      }
      const l = started.log;
      setLog(l);
      setEvents([...l.events]);
      const last = l.events[l.events.length - 1];
      setStatus(last !== undefined && last.step === 'run.end' && last.ok === false ? 'failed' : 'done');
      return null;
    },
    [deps],
  );

  const exportLog = useCallback((): void => {
    if (log !== null) saveText(`${log.id}.log.jsonl`, log.lines());
  }, [log]);

  const startModule = useCallback(
    async (opts: StartModuleOpts): Promise<FirmwareRunRefusal | null> => {
      setStatus('running');
      const started = await startModuleRun(
        {
          ...deps,
          onBegin: (run) => {
            setLog(run);
            setEvents([...run.events]);
            run.subscribe(() => {
              setEvents([...run.events]);
            });
          },
        },
        opts,
      );
      if (!started.ok) {
        setStatus('idle'); // refused — the reason goes back for the dialog toast
        return started.reason;
      }
      const l = started.log;
      setLog(l);
      setEvents([...l.events]);
      const last = l.events[l.events.length - 1];
      setStatus(last !== undefined && last.step === 'run.end' && last.ok === false ? 'failed' : 'done');
      return null;
    },
    [deps],
  );

  return { status, log, events, exportLog, beginRun, endRun, startKeyboard, startModule };
}
