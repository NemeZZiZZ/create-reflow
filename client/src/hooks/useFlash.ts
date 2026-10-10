/* Flash: write the whole draft queue to the device. Handshake once, then
 * every op in order, then a full re-dump (which reconciles the queue).
 * No fe/100a commit — writes apply instantly and persist. */

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { saveAutoBackup, listAutoBackups } from '@create-reflow/sdk';
import { opSummary } from '@create-reflow/sdk';
import type { Draft } from '@create-reflow/sdk';
import { concat, describeStatus, encodeRestorePayload, isWriteAck, sleep, toHex } from '@create-reflow/sdk';
import type { KeyRec, LayerEntry, LedRec, NayaSession, Side } from '@create-reflow/sdk';
import { parseCmdPath } from '@create-reflow/sdk';
import { readInventory } from './useLayers';
import type { LayerDump } from './useLayers';
import type { LogFn } from './useLog';

export type FlashResult = 'ok' | 'partial' | 'fail';
export interface FlashState {
  phase: 'idle' | 'running' | FlashResult;
  done: number;
  total: number;
  message: string | null;
}

const IDLE: FlashState = { phase: 'idle', done: 0, total: 0, message: null };

/** Layer-list ACK gate (30/1002): accepted when payload[0] is 00 or echoes
 * a layer idx (the app's 0..7 window). 0xEA = value rejected; an empty
 * payload or any other byte is not an ACK. */
function isLayerListAck(payload: Uint8Array): boolean {
  if (payload.length === 0) return false;
  const p0 = payload[0];
  return p0 === 0x00 || (p0 >= 0x01 && p0 <= 0x07);
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
    setFlashState({ phase: 'running', done: 0, total: d.size, message: null });
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
          if (!isWriteAck(ack, o.layer))
            throw new Error(
              `key write NACK (${describeStatus(ack[0] ?? 0)}): ${toHex(ack)}`,
            );
        } else if (o.kind === 'led') {
          const ack = await ses.writeLed(o.kk, o.h, o.s, o.layer);
          if (!isWriteAck(ack, o.layer))
            throw new Error(
              `led write NACK (${describeStatus(ack[0] ?? 0)}): ${toHex(ack)}`,
            );
        } else if (o.kind === 'keyset') {
          for (const rec of o.records) {
            const ack = await ses.writeKey(rec, o.layer);
            if (!isWriteAck(ack, o.layer))
              throw new Error(
                `keyset write NACK @0x${rec[0].toString(16)} (${describeStatus(ack[0] ?? 0)}): ${toHex(ack)}`,
              );
          }
        } else if (o.kind === 'settings') {
          const { t, c0, c1 } = parseCmdPath(o.path);
          const f = await ses.cmd(t, c0, c1, o.payload);
          if (f.payload.length === 0 || f.payload[0] !== 0x00)
            throw new Error(`${o.path} write NACK: ${toHex(f.payload)}`);
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
            throw new Error(
              `module write NACK (${describeStatus(f.payload[0] ?? 0)}): ${toHex(f.payload)}`,
            );
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
        setFlashState({ phase: 'running', done, total, message: null });
      }
      bumpDraft(); // settings/module/layers ops removed themselves above
      log('inf', `flash queue: ${done}/${total} written, re-reading…`);
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
      // ED writes (animations) spin the LED engine up and the device drops
      // or reorders multipart replies right after — immediate re-dumps came
      // back with spliced parts ("truncated"). Let it settle first.
      await sleep(600);
      const fresh = await dumpAll(ses);
      if (fresh) {
        d.reconcile(fresh.keys, fresh.leds);
        bumpDraft();
      }
      // Confirmed = ops no longer queued: reconcile-dropped key/led ops plus
      // ACK-self-removed settings/module ops. (dropped alone undercounts when
      // the queue held self-removing ops alongside.)
      const confirmed = total - d.size;
      if (fresh && d.size === 0 && !layersNack) {
        toast.success('Flash complete', {
          description: `${total} change(s) verified on device`,
        });
        log('inf', 'flash queue: all changes verified on device');
        setFlashState({ phase: 'ok', done: total, total, message: null });
        return 'ok';
      } else {
        const note = layersNack ? ' — layer-list write not acked' : '';
        toast.error('Flash partially verified', {
          description: `${confirmed}/${total} confirmed — ${d.size} still queued${note}`,
        });
        log('err', `flash queue: ${d.size} op(s) not reflected${note}`);
        setFlashState({
          phase: 'partial', done: confirmed, total,
          message: `${confirmed}/${total} confirmed — ${d.size} still queued${note}`,
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
