/* Firmware procedure lifecycle — the safety + observability shell the flash
 * procedures drive (startKeyboard landed here; startModule follows in a
 * later task):
 *
 * - ONE run at a time: a module-level lock (firmwareRunActive) refuses a
 *   second beginRun while one is in flight — the freeze flag a later task's
 *   useSessions wiring will consult to hold back auto-connect/hot-plug
 *   teardown while a half is dark.
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
 * The keyboard procedure (startKeyboardRun, spec §5 steps 1-8) runs over an
 * injectable SerialWorld (lib/serial-world.ts): after `enterMcuboot()` it
 * polls getPorts for the re-enumerated MCUboot PID of the side, probes
 * every candidate CDC port with image-state (first answer wins; a silent
 * port's console text surfaces as a `bootloader.console` note), identifies
 * the running image by slot-0 hash against the catalog's plaintextSha256
 * values, re-checks the interlock gate with live values, uploads through
 * SmpDevice.uploadImage (slot.erase ok = first chunk ack), and observes the
 * swap. Every wait is an injected `timeouts` value — the core never sleeps
 * on raw constants (the smoke runs millisecond-scale). */

import { useCallback, useState } from 'react';
import type { RefObject } from 'react';
import {
  bleGetAddress, bleGetAllPairs, bleGetPairAddress, fwVersionText, hexToBytes, modPresence,
  resolveUploadImageId, sleep, SmpDevice, SmpLink, SMP_DEFAULT_TIMEOUTS, toHex,
} from '@create-reflow/sdk';
import type { ImageSlot, NayaSession, Side } from '@create-reflow/sdk';
import { saveText } from '../lib/save';
import { FirmwareRunLog, sha256Hex, stableStringify } from '../lib/firmware-run-log';
import type { RunEvent } from '../lib/firmware-run-log';
import { loadFirmwareCatalog } from '../lib/firmware-catalog';
import type { FwEntry } from '../lib/firmware-catalog';
import { resolveKeyboardPlan } from '../lib/firmware-plan';
import type { HalfPlan } from '../lib/firmware-plan';
import { checkFlashGate } from '../lib/firmware-interlocks';
import type { KeyboardGateInput } from '../lib/firmware-interlocks';
import { newVault } from '../lib/firmware-fetch';
import type { Vault } from '../lib/firmware-fetch';
import { NAYA_VID, pidInfo } from '../lib/firmware-plat';
import { defaultSerialWorld } from '../lib/serial-world';
import type { PortWithInfo, SerialWorld } from '../lib/serial-world';

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
   * back the picked port. Absent → no grant is possible and a missing port
   * fails with replug copy. */
  grantPort?: () => Promise<PortWithInfo>;
}

/* ---- React-free lifecycle core ------------------------------------------ */

interface ActiveRun {
  log: FirmwareRunLog;
  deps: FlashDeps;
  removeGuards: () => void;
}

let activeRun: ActiveRun | null = null;

/** True from beginRun to endRun — the freeze flag. Nothing consults it yet:
 * a later task's useSessions wiring reads it to hold back auto-connect and
 * hot-plug teardown while a firmware run owns the halves. */
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

/* ---- Keyboard flash-one-side core (spec §5 steps 1-8) --------------------- */

export interface FlashTimeouts {
  pollMs?: number; // getPorts poll cadence while the bootloader re-enumerates
  enterMs?: number; // window for the bootloader port to appear after enter
  swapMs?: number; // swap.verify observation window
  rePollMs?: number; // swap.verify re-poll cadence
  probeMs?: number; // per-probe image-state timeout (port probing)
}

/* Spec defaults — the ONLY sleeps the procedure does; smoke injects
 * millisecond-scale values over these. */
export const FLASH_TIMEOUT_DEFAULTS = {
  pollMs: 500,
  enterMs: 60_000,
  swapMs: 300_000,
  rePollMs: 2_000,
  probeMs: 5_000,
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

/* Module-shared blob vault: fetchVersion primes it, the flash consumes it.
 * The vault contract (lib/firmware-fetch) guarantees bytes are stored only
 * under a VERIFIED digest, so the gate's heldSha256 = the vault key is
 * honest without re-digesting. */
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
 * default 250 ms open-settle applies (spec §1: bootloader settle window). */
async function probeOnce(port: PortWithInfo, probeMs: number): Promise<ProbeOutcome> {
  const con: SideConsole = { text: '' };
  let link: SmpLink | null = null;
  try {
    link = await SmpLink.open(tappedPort(port, con));
    /* The injected probe timeout is genuinely dynamic, but SmpDevice's
     * override type pins the as-const defaults (SDK wart) — thread it
     * through a cast instead of narrowing the SDK's own API from here. */
    const device = new SmpDevice(
      link,
      { transceiveMs: probeMs } as unknown as Partial<typeof SMP_DEFAULT_TIMEOUTS>,
    );
    const slots = await device.imageState();
    return { winner: { link, device, slots, port, console: con }, consoleText: con.text };
  } catch {
    if (link !== null) await link.close();
    return { winner: null, consoleText: con.text };
  }
}

/** The keyboard flash procedure (spec §5 steps 1-8): preflight → per target
 * side, left first — mcuboot enter → bootloader port discovery (poll +
 * optional user grant) → probe/identify (arm token = slot-0 hash, running
 * image classified by catalog plaintextSha256) → live gate → upload (erase
 * ok on first chunk ack) → swap.verify observation. Rescue/mcuboot.exit and
 * the app-mode steps (version.confirm, halves.settle, restores) belong to
 * the later tasks; a failure here fails the run and ends it honestly.
 *
 * Returns the finished run log, or null when the run could not begin
 * (another run active / busyRef held). */
export async function startKeyboardRun(
  deps: FlashDeps,
  opts: StartKeyboardOpts,
): Promise<FirmwareRunLog | null> {
  const world = deps.world ?? defaultSerialWorld();
  const vault = deps.vault ?? sharedVault;
  const T = { ...FLASH_TIMEOUT_DEFAULTS, ...deps.timeouts };
  const log = beginFirmwareRun(deps, 'keyboard');
  if (log === null) return null;

  const failures: string[] = [];
  const advisories: string[] = [];
  const abort = (step: string, side: Side | undefined, detail: string): FirmwareRunLog => {
    failures.push(`${step}: ${detail}`);
    log.fail(step, side, detail);
    endFirmwareRun(false, `keyboard flash failed — ${detail}`, failures, advisories);
    return log;
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

      /* Step 4 (port discovery): poll getPorts for the re-enumerated
       * MCUboot PID of this side. */
      const scan = async (): Promise<PortWithInfo | null> => {
        const ports = await world.getPorts();
        return ports.find((p) => portMatches(p, side, 'mcuboot')) ?? null;
      };
      let bootPort: PortWithInfo | null = null;
      const enterDeadline = Date.now() + T.enterMs;
      while (bootPort === null && Date.now() < enterDeadline) {
        bootPort = await scan();
        if (bootPort !== null) break;
        const remain = enterDeadline - Date.now();
        if (remain <= 0) break;
        await sleep(Math.min(T.pollMs, remain));
      }
      /* Grant path: no port appeared and the UI gave us a gesture callback —
       * surface the action and race the grant against continued polling. */
      if (bootPort === null && deps.grantPort !== undefined) {
        log.action('mcuboot.enter', side, 'grant the bootloader port — pick the Naya device in the browser prompt');
        let granted: PortWithInfo | null | undefined; // undefined = pending, null = cancelled
        const grantP: Promise<PortWithInfo | null> = deps.grantPort().then(
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
        if (bootPort !== null && !portMatches(bootPort, side, 'mcuboot')) {
          return abort('mcuboot.enter', side, 'the granted port is not the expected bootloader — replug the half and retry');
        }
        if (bootPort === null && granted === null) {
          return abort('mcuboot.enter', side, 'the port grant was cancelled — replug the half and retry');
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

      /* Identify: probe EVERY mcuboot candidate of the side — first
       * imageState answer wins, silent ports close and ride the console. */
      log.start('identify', side);
      const allBoot = [...new Set((await world.getPorts()).filter((p) => portMatches(p, side, 'mcuboot')))];
      let win: Awaited<ReturnType<typeof probeOnce>>['winner'] = null;
      let probeConsole = '';
      for (const c of allBoot) {
        const r = await probeOnce(c, T.probeMs);
        probeConsole += r.consoleText;
        if (r.winner !== null) {
          win = r.winner;
          break;
        }
      }
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

      /* Upload-target numbering: a device map confirms "0,1" → 2; rc 8 (no
       * map) takes the ASSUMED-2 rule. A map read that fails otherwise is
       * treated as no-map (the numbering is a confirmation, not a safety
       * input); a map that DISAGREES (≠2) throws and fails the run. */
      log.start('slot.map', side);
      let map: Map<string, number> | null = null;
      try {
        map = await device.slotInfoMap();
      } catch {
        log.note('slot.map', side, 'slot-info read failed — continuing with the assumed numbering');
      }
      let imageId: number;
      try {
        imageId = resolveUploadImageId(map, 'keyboard');
      } catch (e) {
        await link.close();
        dumpConsole(side, probeConsole, liveConsole);
        return abort('slot.map', side, msgOf(e));
      }
      log.ok('slot.map', side, { detail: map !== null ? `map "0,1" → ${imageId}` : `no map — assumed image id ${imageId}` });

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
       * is authoritative (SDK upload loop). The upload sha is the hash the
       * device reports for a RUNNING image (plaintextSha256; the blob
       * digest is the file's, and only gates the held bytes). */
      const shaHex = (entry.plaintextSha256 ?? entry.blobSha256).toLowerCase();
      const shaBytes = hexToBytes(shaHex);
      if (shaBytes === null) {
        await link.close();
        dumpConsole(side, probeConsole, liveConsole);
        return abort('upload', side, 'catalog hash is not valid hex');
      }
      log.start('slot.erase', side);
      log.start('upload', side);
      let eraseOk = false;
      let lastPct = -1;
      try {
        await device.uploadImage(
          { bytes, sha256: shaBytes, imageId },
          {
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
        endFirmwareRun(false, `keyboard flash failed — ${m}`, failures, advisories);
        return log;
      }
      log.ok('upload', side);
      /* The winning link's job is done — the port may vanish the moment the
       * swap runs; swap.verify opens fresh probes. */
      await link.close();

      /* Step 8: swap.verify — observation only (os reset / mcuboot.exit is
       * the later task's step): re-read image state on ANY mcuboot port of
       * the side until slot-0 is the uploaded hash; early success when the
       * side's app PID reappears. */
      log.start('swap.verify', side);
      const swapDeadline = Date.now() + T.swapMs;
      let swapped = false;
      let swapDetail = '';
      while (!swapped && Date.now() < swapDeadline) {
        const ports = await world.getPorts();
        if (ports.some((p) => portMatches(p, side, 'app'))) {
          swapped = true;
          swapDetail = `the ${side} app port re-appeared (swap ran)`;
          break;
        }
        const boots = [...new Set(ports.filter((p) => portMatches(p, side, 'mcuboot')))];
        if (boots.length > 0) {
          const results = await Promise.all(boots.map((c) => probeOnce(c, T.probeMs)));
          for (const r of results) {
            probeConsole += r.consoleText;
            if (r.winner === null) continue;
            const s0 = r.winner.slots.find((s) => s.slot === 0);
            if (s0 !== undefined && hexCompact(s0.hash).toLowerCase() === shaHex) {
              swapped = true;
              swapDetail = `slot-0 is the uploaded image (${shaHex.slice(0, 16)}…)`;
            }
            await r.winner.link.close();
          }
        }
        if (swapped) break;
        const remain = swapDeadline - Date.now();
        if (remain <= 0) break;
        await sleep(Math.min(T.rePollMs, remain));
      }
      dumpConsole(side, probeConsole, null);
      if (!swapped) {
        return abort('swap.verify', side, `the swap did not appear within ${Math.round(T.swapMs / 1000)} s`);
      }
      log.ok('swap.verify', side, { detail: swapDetail, sha256: shaHex });
    }

    endFirmwareRun(
      true,
      `keyboard flash finished — ${targets.length} half${targets.length === 1 ? '' : 's'} updated`,
      failures,
      advisories,
    );
    return log;
  } catch (e) {
    /* Belt+braces: an unexpected throw (world rejection, dead port) fails
     * the run honestly instead of leaking the lock. */
    const m = msgOf(e);
    failures.push(`unexpected: ${m}`);
    endFirmwareRun(false, `keyboard flash failed — ${m}`, failures, advisories);
    return log;
  }
}

/* ---- React mirror --------------------------------------------------------- */

/** Thin reactive shell over the core: status/log/events state for the UI
 * timeline + exportLog (JSONL download). startKeyboard runs the whole
 * keyboard procedure (preflight → per-side flash → verdict) through
 * startKeyboardRun and mirrors the finished verdict into status; the run's
 * own log/events land in state when it completes. */
export function useFirmwareFlash(deps: FlashDeps): {
  status: FlashRunStatus;
  log: FirmwareRunLog | null;
  events: readonly RunEvent[];
  exportLog: () => void;
  beginRun: (kind: 'keyboard' | 'module') => FirmwareRunLog | null;
  endRun: (ok: boolean, summary?: string, failures?: string[], advisories?: string[]) => void;
  startKeyboard: (opts: StartKeyboardOpts) => Promise<void>;
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

  const startKeyboard = useCallback(
    async (opts: StartKeyboardOpts): Promise<void> => {
      setStatus('running');
      const l = await startKeyboardRun(deps, opts);
      if (l === null) {
        setStatus('idle'); // refused — a run is already active
        return;
      }
      setLog(l);
      setEvents([...l.events]);
      const last = l.events[l.events.length - 1];
      setStatus(last !== undefined && last.step === 'run.end' && last.ok === false ? 'failed' : 'done');
    },
    [deps],
  );

  const exportLog = useCallback((): void => {
    if (log !== null) saveText(`${log.id}.log.jsonl`, log.lines());
  }, [log]);

  return { status, log, events, exportLog, beginRun, endRun, startKeyboard };
}
