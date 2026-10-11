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
import {
  encodeModuleConfig, fitsChunkBudget, overlay, parseModuleList, planModuleLayout, planModuleOps,
  queueModuleConfig, queueModuleListAdd, queueModuleListDelete, recordsFromModuleBlob,
  uuidToBytes,
} from '@create-reflow/sdk';
import type {
  BayAssignments, ConfigRecords, LiveSlotState, ModuleListEntry, ModulePlan, ModuleProfile,
} from '@create-reflow/sdk';
import { readInventory } from './useLayers';
import type { LayerDump } from './useLayers';
import type { ModuleSlotLive } from './useModuleProfiles';
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

/** Module-write ACK gate (30/100c config, 30/100a list): accepted when
 * the reply opens 00 (the settings/module write convention) or echoes
 * the addressed slot in payload[1]. UNPINNED, CONSERVATIVE — no measured
 * module-write ACK capture exists yet; the shape is inferred from the
 * 30/1002 layer-list gate and the 0xEA-rejection precedent. The Phase-10
 * live probe settles the real byte shape. 0xEA = value rejected; the
 * 0xEA-first-byte guard runs BEFORE the slot-echo branch — a rejection
 * [0xEA, slotEcho] would otherwise pass as an echo (carry [vii]). An
 * empty payload is not an ACK. */
function isModuleAck(payload: Uint8Array, slot: number): boolean {
  if (payload[0] === 0xea) return false;
  if (payload.length === 0) return false;
  return payload[0] === 0x00 || payload[1] === slot;
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
  modules,
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
  /** Module-profile state (Phase 5b): when the queue holds module writes,
   * the pre-flash step plans the slot layout against this state and reads
   * every template source BEFORE the first write. Omitted → no pre-step
   * (there is no live state to plan from). */
  modules?: {
    profiles: ModuleProfile[];
    bays: BayAssignments;
    /** T1's per-slot read verdicts (30/1009 entries as last read) — the
     * planner's live device list. */
    live: Record<number, ModuleSlotLive>;
  };
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
    // `let` — the module producer (below) may inject ops into the draft
    // before the first write; the progress totals must move with it.
    let total = d.size;
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
      // Module pre-step (Phase 5b Task 2, BINDING precondition; the final
      // fix added THE PRODUCER): plan the slot layout against the live
      // device state, GENERATE the structural ops the plan implies
      // (planModuleOps: list deletes for reclaimed slots, list adds where
      // the slot's uuid is not the assigned profile, diff-based config
      // writes) into the draft, and read EVERY template source BEFORE the
      // first write — a new slot's config is seeded from a same-type
      // slot's raw records (overlay's unmodeled passthrough), and reading
      // after the list write would seed from bytes this same flash is
      // about to overwrite (the proven overwrite hazard). A keymap-only
      // flash with an empty profile store must not demand docked modules
      // or spend device reads; without the modules option there is no
      // live state to plan from and the pre-step is skipped, not invented.
      const queuedModuleOps = d.ops.some(
        (o) => o.kind === 'moduleCfg' || o.kind === 'moduleList',
      );
      if (modules !== undefined && (queuedModuleOps || modules.profiles.length > 0)) {
        const { profiles, bays, live } = modules;
        // Carries [v]: an empty live map means the board was never read
        // this session — but 'not read' and 'nothing docked' are different
        // problems with different fixes. One safe list read (before ANY
        // write) tells them apart; with module ops already queued the
        // flash aborts — planning against an unseen board would allocate
        // slots it cannot see. Without queued ops there is nothing to
        // plan against either — skip (never invent); the Modules tab's
        // read flow is the fix.
        if (Object.keys(live).length === 0) {
          if (queuedModuleOps) {
            let entries: ModuleListEntry[] = [];
            try {
              entries = parseModuleList(await ses.readModuleList());
            } catch {
              throw new Error(
                'module writes are queued but the keyboard has not been read this session and the module list could not be read — open the Modules tab and press "Read from keyboard" first; nothing was written',
              );
            }
            if (entries.length === 0) {
              throw new Error(
                'module writes are queued but no module is docked on the board — dock the module first; nothing was written',
              );
            }
            throw new Error(
              `module writes are queued but the keyboard has not been read this session ` +
                `(${entries.length} module slot(s) on board) — open the Modules tab and press ` +
                `"Read from keyboard" first so the plan sees the real slots; nothing was written`,
            );
          } else {
            log(
              'inf',
              'module plan: skipped — the keyboard has not been read this session, so no ' +
                'module writes are planned (open the Modules tab and press "Read from keyboard")',
            );
          }
        }
        // THE PRODUCER (final fix F1): nothing in the UI queues
        // moduleCfg/moduleList ops directly — profile edits live in the
        // store, and this is where they become wire ops. planModuleOps is
        // diff-based (zero diff → zero ops); its ops ride the SAME plan
        // and encoders as the pre-step below, so they pass the drift
        // validator BY CONSTRUCTION — the validator stays for any future
        // producer.
        let plan: ModulePlan | null = null;
        if (Object.keys(live).length !== 0) {
          // Live device list from the T1 read verdicts; bay references from
          // the store's picks (every profile id a bay points at).
          const deviceList = Object.values(live).map((m) => ({
            slot: m.slot,
            uuid: m.uuid,
            type: m.type,
          }));
          const references = Object.values(bays).flatMap((row) => Object.values(row));
          const p = planModuleLayout(profiles, deviceList, references);
          if ('error' in p) {
            // Dock-first / >8 refusals: ABORT before ANY write — the catch
            // below does the toast + log + fail phase with this message.
            throw new Error(p.error);
          }
          plan = p;
          const liveSlots: Record<number, LiveSlotState> = {};
          for (const m of Object.values(live)) {
            liveSlots[m.slot] = { uuid: m.uuid, records: m.records };
          }
          const generated = planModuleOps(plan, profiles, liveSlots);
          let listOps = 0;
          let cfgOps = 0;
          for (const op of generated) {
            if (op.kind === 'listDelete') {
              if (queueModuleListDelete(d, op.slot, op.label).queued) listOps++;
            } else if (op.kind === 'listAdd') {
              if (queueModuleListAdd(d, op.entry, op.label).queued) listOps++;
            } else if (queueModuleConfig(d, op.slot, op.records, op.label).queued) {
              cfgOps++;
            } // else: over budget — queueModuleConfig already ledger-dropped it
          }
          const skipped = plan.assignments.length -
            generated.filter((o) => o.kind === 'config').length;
          log(
            'inf',
            `module plan: ${listOps} list ops, ${cfgOps} cfg ops (${skipped} skipped — no diff)`,
          );
          if (listOps + cfgOps > 0) {
            // The dialog's totals were fixed before the injection — move
            // them so progress never reads done > total (done is still 0).
            total = d.size;
            setFlashState({ phase: 'running', done: 0, total, message: null, drops });
          }
        }
        // Landed tail — drift conformance, template reads, record
        // replacement, plan summary. Reached only when the draft holds
        // module ops (queued before this flash, or injected by the
        // producer above); plan is then non-null by construction.
        const hasModuleOps = d.ops.some(
          (o) => o.kind === 'moduleCfg' || o.kind === 'moduleList',
        );
        if (plan !== null && hasModuleOps) {
          // Carries [vi]: the queued ops were planned when they were queued;
          // the store may have drifted since. A stale module-list add would
          // label one profile's slot with another profile's uuid (the config
          // replace below writes the NEW plan's bytes, so the pair would end
          // up half-A half-B on the board). Compare every queued module op
          // against THIS plan before anything goes out.
          for (const o of d.ops) {
            if (o.kind === 'moduleList') {
              const slot = o.payload[1];
              const a = plan.assignments.find((x) => x.slot === slot);
              if (a === undefined) {
                throw new Error(
                  `module plan drift: a queued module-list op targets slot ${slot}, which this flash's plan does not assign — review the module changes and flash again; nothing was written`,
                );
              }
              if (o.payload.length > 5 && o.payload[4] === 0x10) {
                // Add entry: the profile uuid rides payload[5..20] and must
                // be the one the plan just assigned to this slot.
                const want = uuidToBytes(a.listEntry.uuid16);
                for (let i = 0; i < 16; i++) {
                  if (o.payload[5 + i] !== want[i]) {
                    throw new Error(
                      `module plan drift: the queued module-list add for slot ${slot} carries another profile's uuid than the plan assigns — review the module changes and flash again; nothing was written`,
                    );
                  }
                }
              } else if (o.payload.length === 5 && !plan.reclaimed.includes(slot)) {
                throw new Error(
                  `module plan drift: a queued module-list delete targets slot ${slot}, which this flash's plan keeps — review the module changes and flash again; nothing was written`,
                );
              }
            } else if (o.kind === 'moduleCfg') {
              if (!plan.assignments.some((x) => x.slot === o.slot)) {
                throw new Error(
                  `module plan drift: a queued module config write targets slot ${o.slot}, which this flash's plan does not assign — review the module changes and flash again; nothing was written`,
                );
              }
            }
          }
          // ALL template reads first (deduped per source slot), none after
          // a write has gone out.
          const templates = new Map<string, ConfigRecords>(); // profileId → overlaid
          const readSlots = new Map<number, ConfigRecords>(); // source slot → records
          for (const a of plan.assignments) {
            const src = plan.templateSources[a.profileId];
            if (src === null || src === undefined) continue; // kept slot — records already there
            let template = readSlots.get(src);
            if (template === undefined) {
              const { blob } = await ses.readModuleConfig(src);
              template = recordsFromModuleBlob(blob);
              readSlots.set(src, template);
            }
            const profile = profiles.find((p) => p.id === a.profileId);
            if (profile === undefined) continue; // unreachable: the planner assigns store profiles
            templates.set(a.profileId, overlay(template, profile, profile.type));
            log(
              'inf',
              `module plan: slot ${a.slot} template read from slot ${src} ("${profile.name}")`,
            );
          }
          // REPLACE the queued moduleCfg records with the overlaid ones —
          // payloads re-encoded through the queueModuleConfig encoder
          // (encodeModuleConfig owns 100C addressing; no hand-rolled join).
          for (let i = 0; i < d.ops.length; i++) {
            const o = d.ops[i];
            if (o.kind !== 'moduleCfg') continue;
            const a = plan.assignments.find((x) => x.slot === o.slot);
            const recs = a !== undefined ? templates.get(a.profileId) : undefined;
            if (recs === undefined) continue; // kept/unplanned slot — the queued records stand
            const recArr = [...recs.values()];
            const payload = encodeModuleConfig(o.slot, recArr);
            if (!fitsChunkBudget(payload)) {
              throw new Error(
                `slot ${o.slot} overlaid config exceeds the 483-byte two-frame ceiling — nothing was written`,
              );
            }
            d.ops[i] = { ...o, records: recArr, payload };
          }
          // Plan summary: slots allocated / reclaimed / gaps.
          const assigned = plan.assignments.map((a) => a.slot);
          const gaps = [1, 2, 3, 4, 5, 6, 7].filter((s) => !assigned.includes(s));
          log(
            'inf',
            `module plan: ${assigned.length} slot(s) allocated` +
              (assigned.length > 0 ? ` [${assigned.join(', ')}]` : '') +
              `, ${plan.reclaimed.length} reclaimed` +
              (plan.reclaimed.length > 0 ? ` [${plan.reclaimed.join(', ')}]` : '') +
              `, gaps [${gaps.join(', ')}]`,
          );
        }
      }
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
        } else if (o.kind === 'moduleCfg') {
          // Full module config write (30/100c): params = [slot] + records,
          // pre-encoded at queue time by encodeModuleConfig (the one verb
          // WITHOUT the 00 MODULE_ADDR prefix). ACK gate is conservative/
          // UNPINNED (see isModuleAck — Phase-10 live verification).
          // Self-remove on ACK like settings/module: no GET exists, the
          // ACK is the only verification.
          const f = await ses.cmd(0x30, 0x10, 0x0c, o.payload);
          if (!isModuleAck(f.payload, o.slot))
            throw new Error(nackMessage(o, f.payload));
          d.removeAt(d.ops.indexOf(o)); // no GET — ACK is the only verification
        } else if (o.kind === 'moduleList') {
          // Module-list write (30/100a): add entry or delete, payload from
          // encodeListAdd/encodeListDelete — the addressed slot rides
          // payload[1]. Same conservative ACK gate. NOT the layers
          // continuation: adds/deletes are NOT idempotent (a blind resend
          // after a moved slot hits the wrong entry) — a NACK throws.
          const f = await ses.cmd(0x30, 0x10, 0x0a, o.payload);
          if (!isModuleAck(f.payload, o.payload[1]))
            throw new Error(nackMessage(o, f.payload));
          d.removeAt(d.ops.indexOf(o)); // no GET — ACK is the only verification
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
  }, [sesRef, busyRef, draftRef, layers, notes, anims, modules, dumpAll, bumpDraft, log]);

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
