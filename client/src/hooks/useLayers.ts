/* Layer caches: every layer the board reports in its inventory (keymap +
 * LED map) is fetched at once on connect / Refresh, tabs then switch the
 * view instantly with no device traffic. Owns the dumpAll() full-read core
 * and the fresh-inventory readInventory() used by the flash tail. */

import { useCallback, useState } from 'react';
import {
  parseInventory,
  parseLayer,
  parseLedmap,
  sleep,
} from '@create-reflow/sdk';
import type {
  KeyRec,
  LayerEntry,
  LedRec,
  NayaSession,
} from '@create-reflow/sdk';
import type { LogFn } from './useLog';

export interface LayerDump {
  keys: KeyRec[][];
  leds: LedRec[][];
  /** Read-status taxonomy per layer idx (only layers the inventory loop
   * visited): 'ok' | 'empty' | 'unsupported' | 'unknown:0x..' (two hex
   * digits). 'empty' = nothing stored on that layer — a legitimate empty
   * slot, NOT a broken read; the first non-'ok' classification across that
   * layer's keymap / LED map read wins so the anomaly stays visible. A
   * non-'ok' layer reads as sparse (keys/leds [] at that idx) and never
   * fails the dump — the status map is how callers (flash verdict) see
   * it. */
  status: Record<number, string>;
}

/** Fresh layer-list inventory: one handshake — its Frame payload IS the
 * inventory (status + index echo + 20-byte entries; parseInventory skips
 * the two leading bytes). Single frame, so no settle or retry. Callers
 * that must not serve stale data (flash tail) always read fresh;
 * dumpAll parses the same handshake it already performs. */
export async function readInventory(
  ses: NayaSession,
): Promise<LayerEntry[]> {
  const f = await ses.handshake();
  return parseInventory(f.payload);
}

/** Wall-clock watchdog for a full dump (ms): a wedged transport — a write
 * that never resolves — must not hold busyRef forever. runDumpAll races
 * the read body against this timer; on fire it reports the timeout,
 * releases busyRef, and returns null. Closing + dropping the dead session
 * is the caller's job. */
export const DUMP_WATCHDOG_MS = 120_000;

/** State setters runDumpAll needs. The hook passes its own; the smoke
 * harness passes recorders so the timeout report is pinnable without
 * React. */
export interface DumpSink {
  setLayerList: (v: LayerEntry[]) => void;
  setKeysByLayer: (v: KeyRec[][]) => void;
  setLedsByLayer: (v: LedRec[][]) => void;
  setBlobTotals: (v: { keys: number[]; leds: number[] }) => void;
  setHasRead: (v: boolean) => void;
  setDumpStat: (s: string) => void;
  setLedDumpStat: (s: string) => void;
}

// Single core for full reads: one handshake (whose payload parses the
// layer inventory), then keymap+LED for every inventory layer. Used by
// auto-fetch on connect and by the Refresh button.
// Returns the freshly read layers so callers can reconcile the draft
// against real device state (setState alone would leave closures stale).
// Hook-agnostic (exported) so the smoke harness can pin the watchdog
// report without React; the hook's dumpAll delegates with its setters.
export async function runDumpAll(
  ses: NayaSession,
  busyRef: { current: boolean },
  log: LogFn,
  sink: DumpSink,
  // Injectably short in the smoke harness (a real 120 s wait would stall
  // the suite); production callers use the default.
  watchdogMs: number = DUMP_WATCHDOG_MS,
): Promise<LayerDump | null> {
  const {
    setLayerList,
    setKeysByLayer,
    setLedsByLayer,
    setBlobTotals,
    setHasRead,
    setDumpStat,
    setLedDumpStat,
  } = sink;
  busyRef.current = true;
  try {
    // A wedged transport (a write that never resolves) must not hold
    // busyRef forever: race the read body against the wall-clock
    // watchdog. On fire the body keeps pending in the background (its
    // late settlement is harmless); we report the timeout, release
    // busyRef via the finally below, and return null — closing +
    // dropping the dead session is the caller's job.
    const winner = await Promise.race([
      (async (): Promise<LayerDump | null> => {
        try {
          log('inf', 'dump: keymap + LED for every inventory layer under one handshake…');
          setDumpStat('handshake…');
          setLedDumpStat('handshake…');
          // The handshake Frame payload IS the layer inventory — parse it
          // FIRST, then read keymap+LED for exactly those indices (not a
          // hardcoded 0..2; the board stores 8 layer slots). Caches grow to
          // max idx+1; indices missing from the inventory stay empty slots
          // (consumers use ?? []).
          const inv = await readInventory(ses);
          setLayerList(inv);
          const width = inv.reduce((m, e) => Math.max(m, e.idx), -1) + 1;
          const keys: KeyRec[][] = Array.from({ length: width }, () => []);
          const leds: LedRec[][] = Array.from({ length: width }, () => []);
          // Read-status per layer (see LayerDump.status): the keymap read
          // seeds it, the LED map read only overwrites an 'ok' so the first
          // non-'ok' classification wins.
          const statusByLayer: Record<number, string> = {};
          const keyTotals = new Array<number>(width).fill(0);
          const ledTotals = new Array<number>(width).fill(0);
          let nKeys = 0;
          let nLeds = 0;
          for (const L of inv.map((e) => e.idx)) {
            // Multipart reads can desync on a lost frame (parts share the same
            // cmd id): a short blob ends mid-record. parseLayer's invariant is
            // consumed === total, parseLedmap's is a fixed 544B/layer. Anything
            // else → one full re-read of that layer (retry ladder below).
            // Non-'ok' read statuses never reach those tripwires: the status
            // IS the layer's answer (blob is 0B), so it is recorded and the
            // parse is skipped — keys[L]/leds[L] stay [] (sparse) and the
            // loop CONTINUES, keeping the dump and its status map alive so
            // the flash verdict can act on it (cannot-verify taxonomy).
            const readKeyLayer = async ():
              Promise<ReturnType<typeof parseLayer> | null> => {
              const read = await ses.readLayer(L);
              statusByLayer[L] = read.status;
              if (read.status !== 'ok') {
                log(
                  'inf',
                  `layer ${L}: keymap read '${read.status}' — parse skipped, slot stays empty`,
                );
                return null;
              }
              const p = parseLayer(read.blob);
              if (p.consumed !== p.total)
                throw new Error(`keymap ${L} truncated (${p.consumed}/${p.total}B)`);
              // Resume-tail tripwire: an aborted multipart read can later be
              // answered with the pending tail of the SAME stream — internally
              // consistent (consumed==total) but only a slice of the layer.
              // Healthy layers always carry 156 records (74 keys + tail slots).
              if (p.recs.length !== 156)
                throw new Error(
                  `keymap ${L} bad shape (${p.recs.length} records, want 156)`,
                );
              return p;
            };
            const readLedLayer = async ():
              Promise<ReturnType<typeof parseLedmap> | null> => {
              const lread = await ses.readLedmap(L);
              // Seeding rule: the LED map read only overwrites an 'ok', so
              // the FIRST non-'ok' classification across the layer's two
              // reads wins and the anomaly stays visible.
              if (statusByLayer[L] === 'ok') statusByLayer[L] = lread.status;
              if (lread.status !== 'ok') {
                log(
                  'inf',
                  `ledmap ${L}: read '${lread.status}' — parse skipped, LEDs stay empty`,
                );
                return null;
              }
              const lp = parseLedmap(lread.blob);
              if (lp.total !== 544 || lp.total % 4 !== 0)
                throw new Error(`ledmap ${L} bad size (${lp.total}B, want 544)`);
              return lp;
            };
            const withRetry = async <T,>(
              what: string,
              op: () => Promise<T>,
            ): Promise<T> => {
              let lastErr: unknown;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  return await op();
                } catch (e) {
                  lastErr = e;
                  if (attempt < 3) {
                    // The device's multipart cursor can wedge after a burst of
                    // writes (parts served out of order). Settle, re-handshake
                    // to reset its reader state, then re-read from part 0.
                    log(
                      'inf',
                      `${what}: ${(e as Error).message}, settle + re-handshake, retry ${attempt}/2`,
                    );
                    await sleep(700);
                    try {
                      await ses.handshake();
                    } catch {
                      /* best effort reset */
                    }
                  }
                }
              }
              throw lastErr;
            };
            const p = await withRetry(`layer ${L}`, readKeyLayer);
            // null = non-'ok' taxonomy (recorded in statusByLayer, parse
            // skipped): leave keys[L] sparse and continue with the LED read.
            if (p) {
              const { recs, consumed, total } = p;
              keys[L] = recs;
              keyTotals[L] = total;
              nKeys += recs.length;
              log(
                'inf',
                `layer ${L}: ${total}B, ${recs.length} records (${consumed}/${total})`,
              );
            }
            const lparsed = await withRetry(`ledmap ${L}`, readLedLayer);
            if (lparsed) {
              leds[L] = lparsed.recs;
              ledTotals[L] = lparsed.total;
              nLeds += lparsed.recs.length;
              log('inf', `ledmap ${L}: ${lparsed.total}B, ${lparsed.recs.length} LEDs`);
            }
          }
          setKeysByLayer(keys);
          setLedsByLayer(leds);
          setBlobTotals({ keys: keyTotals, leds: ledTotals });
          setHasRead(true);
          setDumpStat(`${inv.length} layers, ${nKeys} key records`);
          setLedDumpStat(`${inv.length} layers, ${nLeds} LEDs`);
          log('inf', `dump done: ${inv.length} layers, ${nKeys} keys, ${nLeds} LEDs`);
          return { keys, leds, status: statusByLayer };
        } catch (e) {
          setDumpStat('FAILED: ' + (e as Error).message);
          setLedDumpStat('FAILED: ' + (e as Error).message);
          log('err', 'dump: ' + ((e as Error).stack ?? (e as Error).message));
          return null;
        }
      })(),
      sleep(watchdogMs).then((): 'dump-timeout' => 'dump-timeout'),
    ]);
    if (winner === 'dump-timeout') {
      const msg = 'dump timed out — replug the half and retry';
      setDumpStat('FAILED: ' + msg);
      setLedDumpStat('FAILED: ' + msg);
      log('err', 'dump: ' + msg);
      return null;
    }
    return winner;
  } finally {
    busyRef.current = false;
  }
}

export function useLayers({
  busyRef,
  log,
}: {
  busyRef: React.RefObject<boolean>;
  log: LogFn;
}) {
  const [keysByLayer, setKeysByLayer] = useState<KeyRec[][]>([[], [], []]);
  const [ledsByLayer, setLedsByLayer] = useState<LedRec[][]>([[], [], []]);
  const [layerList, setLayerList] = useState<LayerEntry[]>([]);
  // True once a full read succeeded: import/restore diff against live
  // caches, so gating on "every slot non-empty" would deadlock with sparse
  // layer caches (a missing inventory idx is a legitimate empty slot).
  const [hasRead, setHasRead] = useState(false);
  const [blobTotals, setBlobTotals] = useState<{
    keys: number[];
    leds: number[];
  }>({ keys: [0, 0, 0], leds: [0, 0, 0] });
  const [dumpStat, setDumpStat] = useState('');
  const [ledDumpStat, setLedDumpStat] = useState('');

  // Hook entry: the dump core with this hook's state setters. Owns no
  // timeout itself — the watchdog lives in runDumpAll.
  const dumpAll = useCallback(
    (ses: NayaSession): Promise<LayerDump | null> =>
      runDumpAll(ses, busyRef, log, {
        setLayerList,
        setKeysByLayer,
        setLedsByLayer,
        setBlobTotals,
        setHasRead,
        setDumpStat,
        setLedDumpStat,
      }),
    [busyRef, log],
  );

  const clearLayers = useCallback(() => {
    setKeysByLayer([[], [], []]);
    setLedsByLayer([[], [], []]);
    setLayerList([]);
    setHasRead(false);
    setDumpStat('');
    setLedDumpStat('');
  }, []);

  return {
    keysByLayer,
    ledsByLayer,
    layerList,
    hasRead,
    blobTotals,
    dumpStat,
    ledDumpStat,
    dumpAll,
    clearLayers,
  };
}
