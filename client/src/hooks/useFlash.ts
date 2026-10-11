/* Flash: write the whole draft queue to the device. Handshake once, then
 * every op in order, then a full re-dump (which reconciles the queue).
 * No fe/100a commit — writes apply instantly and persist. */

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { saveAutoBackup, listAutoBackups } from '@create-reflow/sdk';
import { opSummary, probeDraft } from '@create-reflow/sdk';
import type { Draft, DraftDrop, Op } from '@create-reflow/sdk';
import { concat, encodeRestorePayload, isWriteAck, sleep, toHex } from '@create-reflow/sdk';
import type { KeyRec, LayerEntry, LedRec, NayaSession, Side } from '@create-reflow/sdk';
import { parseCmdPath } from '@create-reflow/sdk';
import { readInventory } from './useLayers';
import type { LayerDump } from './useLayers';
import type { LogFn } from './useLog';

export type FlashResult = 'ok' | 'cannot-verify' | 'partial' | 'fail';
export interface FlashState {
  phase: 'idle' | 'running' | FlashResult;
  done: number;
  total: number;
  message: string | null;
  /** Refusals snapshot from the draft at flash start (queue ledger +
   * probeDraft merge) — the dialog's verdict area re-renders this exact
   * list after the run, when reconcile has already removed the flagged
   * ops from the live queue. */
  drops?: DraftDrop[];
}

const IDLE: FlashState = { phase: 'idle', done: 0, total: 0, message: null };

/** Layer-list ACK gate (30/1002): accepted when payload[0] is 00 (the
 * measured ack opens `00 00` — flag byte + index echo, same prefix every
 * 30/1002 exchange uses) or echoes a layer idx (the app's 0..7 window).
 * 0xEA = value rejected; an empty payload or any other byte is not an
 * ACK. */
function isLayerListAck(payload: Uint8Array): boolean {
  if (payload.length === 0) return false;
  const p0 = payload[0];
  return p0 === 0x00 || (p0 >= 0x01 && p0 <= 0x07);
}

/** Structured NACK abort message (flash capability model): the op summary
 * names WHAT was refused, the tail states the honest outcome. 0xEA = the
 * device refused the VALUE — nothing was stored; any other non-ack reply
 * is a bad or missing ack. Thrown → 'fail' phase; the layers op's
 * layersNack→partial path stays the only non-throwing case (idempotent
 * write, the restore echo re-sends the full table). */
function nackMessage(o: Op, ack: Uint8Array): string {
  return ack[0] === 0xea
    ? `${opSummary(o)} — device refused the value (0xEA): nothing was stored`
    : `${opSummary(o)} — bad or missing ack (${toHex(ack)})`;
}

/** Which board layer a queued op writes to, for the cannot-verify check —
 * null when the op is not layer-addressed (device-global settings like
 * fe/100a timeouts, inventory ops). ed/1011 addresses its layer in
 * payload[0] (same byte the App's anim promotion reads). */
function queuedOpLayer(o: Op): number | null {
  if (o.kind === 'settings')
    return o.path === 'ed/1011' ? (o.payload[0] ?? null) : null;
  // layers/moduleCfg/moduleList are device-global writes — no board layer.
  if (o.kind === 'layers' || o.kind === 'moduleCfg' || o.kind === 'moduleList')
    return null;
  return o.layer;
}

/** Merge the draft's refusal ledger with a fresh pure probe of the queued
 * ops — the flash dialog's drop list. probeDraft output is NOT deduped (a
 * layers payload can flag the same reason once per bad entry) and the
 * ledger dedups by reason+layer+kk only, so the merge dedups on the full
 * signature to keep one row per distinct refusal. */
export function collectDrops(d: Draft): DraftDrop[] {
  const out: DraftDrop[] = [];
  const seen = new Set<string>();
  for (const drop of [...d.drops, ...probeDraft(d)]) {
    const sig = `${drop.reason}|${drop.layer === undefined ? 'u' : drop.layer}|${drop.kk === undefined ? 'u' : drop.kk}|${drop.opKey ?? 'u'}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(drop);
  }
  return out;
}

export function useFlash({
  sesRef,
  busyRef,
  draftRef,
  layers,
  notes,
  anims,
  dumpAll,
  bumpDraft,
  log,
}: {
  sesRef: React.RefObject<Map<Side, NayaSession>>;
  busyRef: React.RefObject<boolean>;
  draftRef: React.RefObject<Draft>;
  /** live caches — the pre-flash auto-backup snapshots these */
  layers: {
    keys: KeyRec[][];
    leds: LedRec[][];
    blobKeys: number[];
    blobLeds: number[];
  };
  /** per-key notes ("L:kk") carried into the auto-backup */
  notes?: Record<string, string>;
  /** last-known per-layer animations (lowercase animationId) read at flash
   * time — getter so the freshest ref value lands in the backup */
  anims?: () => Record<number, string>;
  dumpAll: (ses: NayaSession) => Promise<LayerDump | null>;
  bumpDraft: () => void;
  log: LogFn;
}) {
  const [flashing, setFlashing] = useState(false);
  const [flashState, setFlashState] = useState<FlashState>(IDLE);
  // Double-dispatch guard: a confirm click can reach us twice (automation
  // double-events, radix re-dispatch) — two concurrent write loops interleave
  // their multipart reads on the same port and wedge the stream. Second and
  // later callers await the SAME in-flight promise.
  const inFlight = useRef<Promise<FlashResult> | null>(null);

  const runFlashQueue = useCallback(async (): Promise<FlashResult> => {
    const ses = sesRef.current.get('left') ?? null;
    const d = draftRef.current;
    if (!ses) {
      const msg = 'left half not connected';
      toast.error('Flash failed', { description: msg });
      log('err', `flash queue: ${msg}`);
      setFlashState({ phase: 'fail', done: 0, total: d.size, message: msg });
      return 'fail';
    }
    if (d.size === 0) return 'fail';
    busyRef.current = true;
    setFlashing(true);
    // Refusal snapshot at flash start: the dialog's verdict area re-renders
    // this exact list after the run — by then self-removals and reconcile
    // have pulled the flagged ops out of the live queue, so a post-flash
    // re-probe would under-report what this flash carried.
    const drops = collectDrops(d);
    setFlashState({ phase: 'running', done: 0, total: d.size, message: null, drops });
    const total = d.size;
    let done = 0;
    let layersNack = false;
    try {
      log('inf', `flash queue: ${total} op(s)`);
      // Pre-flash auto-backup (UHK compensation pattern): the device has
      // no staging buffer, so park a restore point of the live caches
      // first. Failures degrade to a log line — they must never block
      // the write the user asked for.
      const bk = saveAutoBackup(
        layers.keys,
        layers.leds,
        layers.blobKeys,
        layers.blobLeds,
        notes,
        undefined, // storage — default localStorage
        anims?.(),
      );
      if (bk.status === 'saved')
        log(
          'inf',
          `auto-backup saved (${bk.meta.bytes}B, ${listAutoBackups().length} kept) — "Restore auto-backup…" in the Save menu`,
        );
      else if (bk.reason === 'unchanged')
        log('inf', 'auto-backup: unchanged since last flash (deduped)');
      else if (bk.reason === 'storage')
        log('err', 'auto-backup: storage unavailable/full — continuing without');
      await ses.handshake();
      // Snapshot iteration: settings ops self-remove from d.ops on ACK.
      for (const o of [...d.ops]) {
        log('inf', `flash ${done + 1}/${total}: ${opSummary(o)}`);
        if (o.kind === 'key') {
          const ack = await ses.writeKey(o.record, o.layer);
          if (!isWriteAck(ack, o.layer)) throw new Error(nackMessage(o, ack));
        } else if (o.kind === 'led') {
          const ack = await ses.writeLed(o.kk, o.h, o.s, o.layer);
          if (!isWriteAck(ack, o.layer)) throw new Error(nackMessage(o, ack));
        } else if (o.kind === 'keyset') {
          for (const rec of o.records) {
            const ack = await ses.writeKey(rec, o.layer);
            if (!isWriteAck(ack, o.layer)) throw new Error(nackMessage(o, ack));
          }
        } else if (o.kind === 'settings') {
          const { t, c0, c1 } = parseCmdPath(o.path);
          const f = await ses.cmd(t, c0, c1, o.payload);
          if (f.payload.length === 0 || f.payload[0] !== 0x00)
            throw new Error(nackMessage(o, f.payload));
          d.removeAt(d.ops.indexOf(o)); // no GET — ACK is the only verification
        } else if (o.kind === 'module') {
          // S2-proven write: 30/100c (c1=0x0c), params [00, LAYER] + full
          // record, ACK = 00 <layer>. c1=0x0b parse-ACKs WITHOUT applying —
          // never use it here.
          const f = await ses.cmd(
            0x30,
            0x10,
            0x0c,
            concat([new Uint8Array([0, o.layer]), o.payload]),
          );
          if (!isWriteAck(f.payload, o.layer))
            throw new Error(nackMessage(o, f.payload));
          d.removeAt(d.ops.indexOf(o)); // no GET — ACK is the only verification
        } else if (o.kind === 'layers') {
          // Layer-list write (30/1002). ACK gate: 00 or an echoed layer
          // idx; 0xEA = value rejected. A NACK marks the flash partial but
          // the loop CONTINUES — layer-list writes are idempotent and the
          // tail restore-echo re-sends the full table below.
          const ack = await ses.writeLayerList(o.payload);
          if (!isLayerListAck(ack.payload)) {
            layersNack = true;
            log(
              'err',
              `layer-list write NACK (${toHex(ack.payload)}) — continuing (idempotent)`,
            );
          }
          d.removeAt(d.ops.indexOf(o)); // self-remove like settings/module
        } else {
          throw new Error('unknown op kind');
        }
        done++;
        setFlashState({ phase: 'running', done, total, message: null, drops });
      }
      bumpDraft(); // settings/module/layers ops removed themselves above
      log('inf', `flash queue: ${done}/${total} written, re-reading…`);
      // The device drops or reorders frames right after a write burst
      // (ED animation writes spin the LED engine up; immediate reads and
      // re-dumps came back truncated or with spliced parts). Settle FIRST,
      // then read — the inventory read below is as exposed as the dump.
      await sleep(600);
      // Layer-list restore echo (flash tail): re-read the inventory FRESH
      // post-write — never a cached copy, this flash may have changed the
      // table — then send the full table back so the board's stored
      // lighting is restored on both halves.
      let inv: LayerEntry[] = [];
      try {
        inv = await readInventory(ses);
      } catch {
        inv = [];
      }
      if (inv.length === 0) {
        log('cdc', 'flash: layer list unreadable — skipping lighting restore');
      } else {
        const ack = await ses.writeLayerList(encodeRestorePayload(inv));
        if (!isLayerListAck(ack.payload))
          log('err', `layer-list restore NACK (${toHex(ack.payload)}) — continuing`);
        else
          log(
            'inf',
            `layer-list echo: ${inv.length} entries — stored lighting restored (both halves)`,
          );
      }
      const fresh = await dumpAll(ses);
      if (fresh) {
        d.reconcile(fresh.keys, fresh.leds);
        bumpDraft();
      }
      // Confirmed = ops no longer queued: reconcile-dropped key/led ops plus
      // ACK-self-removed settings/module ops. (dropped alone undercounts when
      // the queue held self-removing ops alongside.)
      const confirmed = total - d.size;
      // 'Cannot verify' (strictly between ok and partial): a still-queued op
      // targets a layer whose post-flash read came back 'unsupported' or
      // 'unknown:…' — the write may have landed, the readback just cannot
      // tell. Never fails the flash for it; 'empty' (a legitimate empty
      // slot) stays a plain partial via reconcile. status[L] is only
      // populated for layers the inventory visited — undefined (layer
      // absent from the dump, e.g. a same-flash delete + edit on that
      // layer) means unreadable, not a crash: guard it and let it fall
      // through to the plain partial below.
      const unverified = new Map<number, string>();
      if (fresh) {
        for (const o of d.ops) {
          const L = queuedOpLayer(o);
          if (L === null) continue;
          const s = fresh.status[L];
          if (s && (s === 'unsupported' || s.startsWith('unknown:')))
            unverified.set(L, s);
        }
      }
      if (fresh && d.size === 0 && !layersNack) {
        toast.success('Flash complete', {
          description: `${total} change(s) verified on device`,
        });
        log('inf', 'flash queue: all changes verified on device');
        setFlashState({ phase: 'ok', done: total, total, message: null, drops });
        return 'ok';
      } else if (unverified.size > 0) {
        const n = d.ops.filter((o) => {
          const L = queuedOpLayer(o);
          return L !== null && unverified.has(L);
        }).length;
        const detail = [...unverified.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([L, s]) => `layer ${L} read returned ${s}`)
          .join(', ');
        // Fold T3: the layersNack + unverified combo is reachable now that
        // non-'ok' statuses survive the dump — surface the same note the
        // partial branch uses instead of dropping it.
        const note = layersNack ? ' — layer-list write not acked' : '';
        const msg = `Flash complete — ${n} op(s) could not be verified (${detail})${note}`;
        toast.warning('Flash could not be fully verified', {
          description: msg,
        });
        log('err', `flash queue: ${msg}`);
        setFlashState({
          phase: 'cannot-verify', done: confirmed, total, message: msg, drops,
        });
        return 'cannot-verify';
      } else {
        const note = layersNack ? ' — layer-list write not acked' : '';
        toast.error('Flash partially verified', {
          description: `${confirmed}/${total} confirmed — ${d.size} still queued${note}`,
        });
        log('err', `flash queue: ${d.size} op(s) not reflected${note}`);
        setFlashState({
          phase: 'partial', done: confirmed, total,
          message: `${confirmed}/${total} confirmed — ${d.size} still queued${note}`,
          drops,
        });
        return 'partial';
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.debug((e as Error).stack);
      toast.error('Flash failed', { description: msg });
      log('err', `flash queue: ${msg}`);
      bumpDraft(); // settings/module ops may have self-removed before the throw
      setFlashState({
        phase: 'fail', done, total,
        message: `${msg} — ${done}/${total} written before the error`,
        drops,
      });
      return 'fail';
    } finally {
      busyRef.current = false;
      setFlashing(false);
    }
  }, [sesRef, busyRef, draftRef, layers, notes, anims, dumpAll, bumpDraft, log]);

  const doFlashQueue = useCallback((): Promise<FlashResult> => {
    if (inFlight.current) return inFlight.current;
    const p = runFlashQueue().finally(() => {
      if (inFlight.current === p) inFlight.current = null;
    });
    inFlight.current = p;
    return p;
  }, [runFlashQueue]);

  return { flashing, flashState, doFlashQueue };
}
