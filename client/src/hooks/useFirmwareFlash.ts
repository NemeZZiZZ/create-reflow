/* Firmware procedure lifecycle — the safety + observability shell the flash
 * procedures drive (startKeyboard/startModule land in later tasks on top of
 * these internals):
 *
 * - ONE run at a time: a module-level lock (firmwareRunActive) refuses a
 *   second beginRun while one is in flight — this is also the freeze flag
 *   useSessions consults to hold back auto-connect/hot-plug teardown while
 *   a half is dark.
 * - busyRef held for the WHOLE run (useFlash.ts:170 precedent) so every
 *   other device op refuses while a run owns the halves.
 * - beforeunload + pagehide guards registered on begin, removed on end, so
 *   a stray tab close cannot park a half in its bootloader unnoticed. The
 *   handler sets returnValue and calls preventDefault (the beforeunload
 *   contract); the window is injectable (win) so node smoke records the
 *   add/remove pairs — default is globalThis, guarded by typeof.
 *
 * The React-free core (beginFirmwareRun/endFirmwareRun/capturePreflight/
 * verifyPreflight) is exported for the smoke and for the later procedures;
 * useFirmwareFlash is the thin mirror: status/log/events state + exportLog.
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
 * stays honest about what was and wasn't readable. */

import { useCallback, useState } from 'react';
import type { RefObject } from 'react';
import {
  bleGetAddress, bleGetAllPairs, bleGetPairAddress, fwVersionText, modPresence, toHex,
} from '@create-reflow/sdk';
import type { NayaSession, Side } from '@create-reflow/sdk';
import { saveText } from '../lib/save';
import { FirmwareRunLog, sha256Hex, stableStringify } from '../lib/firmware-run-log';
import type { RunEvent } from '../lib/firmware-run-log';

export type FlashRunStatus = 'idle' | 'running' | 'done' | 'failed';

export interface FlashWindowLike {
  addEventListener(t: string, l: unknown): void;
  removeEventListener(t: string, l: unknown): void;
}

export interface FlashDeps {
  sesRef: RefObject<Map<Side, NayaSession>>;
  busyRef: RefObject<boolean>;
  win?: FlashWindowLike; // default globalThis — injectable for node smoke
}

/* ---- React-free lifecycle core ------------------------------------------ */

interface ActiveRun {
  log: FirmwareRunLog;
  deps: FlashDeps;
  removeGuards: () => void;
}

let activeRun: ActiveRun | null = null;

/** True from beginRun to endRun — the freeze flag: useSessions holds back
 * auto-connect/hot-plug teardown while a firmware run owns the halves. */
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

/** Open a firmware run. Refuses (null) when one is already active — one run
 * at a time, never two procedures racing for the halves — or when the app is
 * otherwise busy (busyRef held by a keymap flash/dump). Otherwise: freeze
 * flag on, busyRef held, unload guards registered, fresh log returned with
 * its run.start meta already written. */
export function beginFirmwareRun(
  deps: FlashDeps,
  kind: 'keyboard' | 'module',
): FirmwareRunLog | null {
  if (activeRun !== null) return null;
  if (deps.busyRef.current) return null;
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
  return log;
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

/** Capture the preflight artifact for the requested sides (left first).
 * Reads go through the live sessions; missing sessions record null halves.
 * When `log` is omitted, the artifact note lands in the active run's log
 * (and nowhere when no run is active). */
export async function capturePreflight(
  sessions: Map<Side, NayaSession>,
  sides: Side[],
  log?: FirmwareRunLog | null,
): Promise<PreflightCapture> {
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

/* ---- React mirror --------------------------------------------------------- */

/** Thin reactive shell over the core: status/log/events state for the UI
 * timeline + exportLog (JSONL download). The procedures themselves compose
 * the core functions; later tasks add startKeyboard/startModule on top. */
export function useFirmwareFlash(deps: FlashDeps): {
  status: FlashRunStatus;
  log: FirmwareRunLog | null;
  events: readonly RunEvent[];
  exportLog: () => void;
  beginRun: (kind: 'keyboard' | 'module') => FirmwareRunLog | null;
  endRun: (ok: boolean, summary?: string, failures?: string[], advisories?: string[]) => void;
} {
  const { sesRef, busyRef, win } = deps;
  const [status, setStatus] = useState<FlashRunStatus>('idle');
  const [log, setLog] = useState<FirmwareRunLog | null>(null);
  const [events, setEvents] = useState<readonly RunEvent[]>([]);

  const beginRun = useCallback(
    (kind: 'keyboard' | 'module'): FirmwareRunLog | null => {
      const l = beginFirmwareRun({ sesRef, busyRef, win }, kind);
      if (l !== null) {
        setLog(l);
        setEvents(l.events);
        l.subscribe(() => {
          setEvents([...l.events]);
        });
        setStatus('running');
      }
      return l;
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

  const exportLog = useCallback((): void => {
    if (log !== null) saveText(`${log.id}.log.jsonl`, log.lines());
  }, [log]);

  return { status, log, events, exportLog, beginRun, endRun };
}
