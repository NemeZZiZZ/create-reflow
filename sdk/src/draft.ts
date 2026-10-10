/* Draft: local edit queue. All changes (key rebinds, LED colors, settings,
 * module writes) accumulate here and are applied to the device in one
 * explicit batch ("Flash"). Pure logic — no device access, no React — so it
 * is fully smoke-testable. */

import { toHex } from './naya';
import type { KeyRec, LedRec } from './naya';

export interface KeyOp {
  kind: 'key';
  layer: number;
  kk: number;
  record: Uint8Array; // full record incl. KK as byte 0
  label: string; // human description for the flash plan
}

export interface LedOp {
  kind: 'led';
  layer: number;
  kk: number;
  h: number;
  s: number;
}

export type Section = 'bindings' | 'led' | 'modules' | 'behavior' | 'layers';

/** One refused intent, recorded when the queue refused it (flash
 * capability model — the flash dialog renders these verbatim). `reason`
 * is the validator/queue message verbatim; `effect` is the honest domain
 * sentence for what the keyboard does instead. `at: 'queue'` — every drop
 * this phase originates at queue time. */
export interface DraftDrop {
  layer?: number;
  kk?: number;
  opKey?: string;
  reason: string;
  effect: string;
  at: 'queue';
}

export interface KeySetOp {
  kind: 'keyset';
  layer: number;          // 0|1|2
  kk: number;             // primary key
  records: Uint8Array[];  // [primary, shadow?] — full records incl. KK byte 0
  label: string;
}
export interface SettingsOp {
  kind: 'settings';
  path: string;           // 'ed/1011' | 'ed/1012' | 'ed/1013' | 'ed/1014' | 'fe/100a'
  payload: Uint8Array;    // frame params (e.g. [target, value] for ED)
  label: string;
}
export interface ModuleOp {
  kind: 'module';
  layer: number; // 0|1|2 — 30/100c params are [00, LAYER] (S2 addressing trap)
  slot: number; // gesture slot = record byte 0 (S2: slot == gesture index)
  payload: Uint8Array; // full record incl. slot byte
  label: string;
}
export interface LayerListOp {
  kind: 'layers';
  payload: Uint8Array; // frame params from encodeLayerListAdd/encodeLayerListDelete
  label: string; // entry counts ride in the label set at queue time
}
export type Op = KeyOp | LedOp | KeySetOp | SettingsOp | ModuleOp | LayerListOp;

/** Lowercase hex without spaces — compact stable form of a payload for opKey. */
function payloadHex(u8: Uint8Array): string {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function opKey(o: Op): string {
  switch (o.kind) {
    case 'key':
    case 'keyset':
      // Shared key on purpose: a plain pick and a behavior-set edit on the
      // same key replace each other (latest wins) instead of coexisting as
      // two writes the reconcile could never both confirm.
      return `key:${o.layer}:${o.kk}`;
    case 'led':
      return `led:${o.layer}:${o.kk}`;
    case 'settings':
      // Keyed by path + first payload byte (the ED target / 1011 layer):
      // per-layer anims coexist, same-knob values dedup. fe/100a byte 0 is
      // always 0, so timeout payloads still dedup to one op.
      return `settings:${o.path}:${o.payload[0] ?? 0}`;
    case 'module':
      return `module:${o.layer}:${o.slot}:${toHex(o.payload)}`;
    case 'layers':
      // Payload-addressed: an identical wire payload is the same edit
      // (latest wins); different payloads (add vs delete, two adds)
      // coexist as separate frames sent in queue order.
      return `layers:${payloadHex(o.payload)}`;
  }
}

export const SECTIONS: Section[] = ['bindings', 'led', 'modules', 'behavior', 'layers'];
export const SECTION_LABELS: Record<Section, string> = {
  bindings: 'Bindings',
  led: 'LED Map',
  modules: 'Modules',
  behavior: 'Behavior',
  layers: 'Layers',
};

export function opSection(o: Op): Section {
  switch (o.kind) {
    case 'key':
    case 'keyset':
      return 'bindings';
    case 'led':
      return 'led';
    case 'module':
      return 'modules';
    case 'settings':
      return o.path === 'ed/1011' ? 'led' : 'behavior';
    case 'layers':
      return 'layers';
  }
}

export class Draft {
  ops: Op[] = [];
  /** Queue-time refusal ledger (DraftDrop[]). Refusals never queue ops —
   * the ledger only explains them, deduped by reason+layer+kk. */
  drops: DraftDrop[] = [];

  get size(): number {
    return this.ops.length;
  }

  /** Latest op wins for the same opKey. */
  add(o: Op): void {
    const k = opKey(o);
    const i = this.ops.findIndex((x) => opKey(x) === k);
    if (i >= 0) this.ops[i] = o;
    else this.ops.push(o);
  }

  /** Record a refused intent. Dedup by reason+layer+kk: the same refusal
   * twice (e.g. a second click on the same refused target) is ONE entry —
   * the ledger explains capabilities, it doesn't count clicks. */
  addDrop(drop: Omit<DraftDrop, 'at'>): void {
    const sig = (d: Pick<DraftDrop, 'reason' | 'layer' | 'kk'>) =>
      `${d.reason}|${d.layer === undefined ? 'u' : d.layer}|${d.kk === undefined ? 'u' : d.kk}`;
    if (this.drops.some((d) => sig(d) === sig(drop))) return;
    this.drops.push({ ...drop, at: 'queue' });
  }

  removeAt(i: number): void {
    this.ops.splice(i, 1);
  }

  clear(): void {
    this.ops = [];
    this.drops = [];
  }

  has(kind: 'key' | 'led' | 'keyset', layer: number, kk: number): boolean {
    return this.ops.some(
      (o) =>
        o.kind === kind &&
        (o.kind === 'key' || o.kind === 'led' || o.kind === 'keyset') &&
        o.layer === layer &&
        o.kk === kk,
    );
  }

  /** Pending LED override for display, if any. */
  ledFor(layer: number, kk: number): LedOp | undefined {
    return this.ops.find(
      (o): o is LedOp => o.kind === 'led' && o.layer === layer && o.kk === kk,
    );
  }

  keyFor(layer: number, kk: number): KeyOp | undefined {
    return this.ops.find(
      (o): o is KeyOp => o.kind === 'key' && o.layer === layer && o.kk === kk,
    );
  }

  /** Drop ops that the device already satisfies (post-flash readback or a
   * fresh dump). Returns the number of ops dropped. settings/module ops have
   * no GET — the flash executor drops them right after ACK, never reconcile. */
  reconcile(keysByLayer: KeyRec[][], ledsByLayer: LedRec[][]): number {
    const before = this.ops.length;
    this.ops = this.ops.filter((o) => {
      if (o.kind === 'key') {
        const recs = keysByLayer[o.layer] ?? [];
        const cur = recs.find((r) => r.kk === o.kk);
        if (!cur) return true; // unknown state — keep
        return !bytesEqual(cur.rec, o.record);
      }
      if (o.kind === 'keyset') {
        const recs = keysByLayer[o.layer] ?? [];
        // Satisfied only when EVERY record matches the device record whose
        // kk === rec[0] (byte 0 of each record is its KK; the shadow record
        // lives at primary kk + 0x52). A filler record ([kk,07,00] — a
        // cleared slot, NONE type; legacy [kk,00,00] also tolerated) is
        // also satisfied by ABSENCE: the device compacts empty slots out
        // of its dump, so "no record at that KK" means the slot is empty,
        // which is what the filler writes.
        return !o.records.every((rec) => {
          const cur = recs.find((r) => r.kk === rec[0]);
          const filler =
            rec.length === 3 && (rec[1] === 0 || rec[1] === 0x07);
          if (filler) return cur === undefined || bytesEqual(cur.rec, rec);
          return cur !== undefined && bytesEqual(cur.rec, rec);
        });
      }
      if (o.kind === 'led') {
        const leds = ledsByLayer[o.layer] ?? [];
        const cur = leds.find((r) => r.kk === o.kk);
        if (!cur) return true;
        return !(cur.h === o.h && cur.s === o.s);
      }
      return true; // settings/module/layers: no readback — kept until flash ACKs
    });
    return before - this.ops.length;
  }

  /** Frame/byte stats for the flash-plan preview. */
  stats(): { ops: number; frames: number; bytes: number } {
    let bytes = 0;
    let frames = 0;
    for (const o of this.ops) {
      // frame overhead: hdr(6) + c0c1(2) + params + crc(1) + end(1)
      if (o.kind === 'key') {
        bytes += 10 + 2 + o.record.length;
        frames += 1;
      } else if (o.kind === 'led') {
        bytes += 10 + 6;
        frames += 1;
      } else if (o.kind === 'keyset') {
        for (const r of o.records) {
          bytes += 10 + 2 + r.length;
          frames += 1;
        }
      } else if (o.kind === 'settings') {
        bytes += 10 + o.payload.length;
        frames += 1;
      } else if (o.kind === 'layers') {
        bytes += 10 + o.payload.length;
        frames += 1;
      } else {
        bytes += 10 + 2 + o.payload.length;
        frames += 1;
      }
    }
    return { ops: this.ops.length, frames, bytes };
  }
}

export function bytesEqual(a: Uint8Array | number[], b: Uint8Array | number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Human-readable summary of one op for the plan list. */
export function opSummary(o: Op): string {
  switch (o.kind) {
    case 'key':
    case 'led': {
      const pos = `KK ${o.kk} (0x${o.kk.toString(16)})`;
      if (o.kind === 'led') return `L${o.layer} ${pos} → H${o.h} S${o.s}`;
      return `L${o.layer} ${pos} → ${o.label}`;
    }
    case 'keyset':
      return `L${o.layer} KK ${o.kk} → ${o.label} (${o.records.length} rec)`;
    case 'settings':
      return `${o.path} → ${o.label}`;
    case 'module':
      return `L${o.layer} slot ${o.slot} → ${o.label}`;
    case 'layers':
      // Entry counts ride in the label (set at queue time).
      return o.label;
  }
}

/** Pure re-validation walk of a queued draft (flash capability model):
 * re-checks every invariant decidable from the draft ALONE — no live
 * cache parameter this phase, so 'no live record at this key' style
 * findings (they need the device dump) are deferred. Per op kind:
 *   key     — record self-addresses its kk (byte 0 === op kk, min shape);
 *   keyset  — every record non-empty;
 *   led     — kk inside the device LED map 0..0x87 (queueColor's gate);
 *   module  — payload byte 0 re-states the slot (S2 addressing trap);
 *   layers  — every decoded add entry sits in the app window 0..7.
 * Never mutates the draft and never writes its drops ledger: two calls
 * on an unchanged draft return deep-equal arrays. Returns DraftDrop[]
 * (at:'queue') so the flash dialog can render findings with the same
 * shape as queue-time refusals. */
export function probeDraft(d: Draft): DraftDrop[] {
  const out: DraftDrop[] = [];
  const push = (o: Op, reason: string, effect: string): void => {
    const drop: DraftDrop = { reason, effect, at: 'queue', opKey: opKey(o) };
    if (o.kind === 'key' || o.kind === 'keyset' || o.kind === 'led' || o.kind === 'module') {
      drop.layer = o.layer;
      if (o.kind === 'key' || o.kind === 'keyset' || o.kind === 'led') drop.kk = o.kk;
    }
    out.push(drop);
  };
  for (const o of d.ops) {
    if (o.kind === 'key') {
      if (o.record.length < 3 || o.record[0] !== o.kk)
        push(
          o,
          `key record does not address its own kk ${o.kk}`,
          'this key keeps whatever the keyboard already had on it',
        );
    } else if (o.kind === 'keyset') {
      if (o.records.length === 0 || o.records.some((r) => r.length === 0))
        push(
          o,
          'behavior set carries an empty record',
          'this key keeps whatever the keyboard already had on it',
        );
    } else if (o.kind === 'led') {
      if (o.kk < 0 || o.kk > 0x87)
        push(
          o,
          `led kk ${o.kk} is outside the device LED map (0-135)`,
          'this key keeps its current color',
        );
    } else if (o.kind === 'module') {
      if (o.payload.length === 0 || o.payload[0] !== o.slot)
        push(
          o,
          `module payload does not re-state slot ${o.slot}`,
          'the module bay keeps its current gesture',
        );
    } else {
      // Layers window re-check: same add-entry wire signature
      // ([idx][idx][anim][0x10]) pendingLayerAddIdxs decodes.
      const p = o.payload;
      for (let off = 2; off + 20 <= p.length; off += 20) {
        if (p[off] === p[off + 1] && p[off + 3] === 0x10 && p[off] > 7)
          push(
            o,
            `layer index ${p[off]} is outside this app's window (0-7)`,
            'the layer list stays unchanged',
          );
      }
    }
  }
  return out;
}
