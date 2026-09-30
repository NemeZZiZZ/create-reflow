/* T10/T03 multi-behavior records. Byte formats are live-proven
 * (docs/cdc-protocol.md §T10, S1 SPIKE OK 2026-09-18):
 * T03 24B:  [KK, 03, 15, 01,01,FL, termLE, HOLD quad, pad4, TAP quad, pad4]
 * T10 27B:  [KK, 10, 18, termHoldLE, 03, 01,01,FL, termDoubleLE,
 *            HOLD quad, pad4, TAP quad, pad4]      (primary @KK)
 * mini 10B: [KK+0x52, 10, 07, termDoubleLE, 01, DOUBLE triple]
 * full 27B: same as T10 with A=TAP_HOLD, B=DOUBLE_TAP  (shadow @KK+0x52)
 * quad = [hid, 0x00, 0x07, flags] (HID + page 0x0007 + per-quad flag byte).
 * FL = body flags: the hold-tap flavor byte (0 hold-preferred, 1 balanced,
 * 2 tap-preferred, 3 tap-unless-interrupted) per Create-knowledge-base's
 * cross-source measurement; NayaFlow "Balanced" writes 00. The 4th byte of
 * the HOLD quad (2 on our NayaFlow-written Z record) is unknown — preserved
 * verbatim via behaviorMetaOf, never synthesized.
 * Pure logic — no device access, no React — fully smoke-testable. */

import type { KeyRec } from './naya';
import type { KeySetOp } from './draft';

const PAD4 = [0, 0, 0, 0];
const quad = (hid: number, flags = 0) => [hid & 0xff, 0x00, 0x07, flags & 0xff];
const triple = (hid: number) => quad(hid);
const le = (v: number) => [v & 0xff, (v >> 8) & 0xff];

/** Tail index triplet: rewritten to 02 once ANY T10 exists on the layer. */
export const TAIL_T10 = new Uint8Array([0x4b, 0x02, 0x00]);

/** Shadow slot offset: shadow record lives at primary KK + 0x52. */
export const SHADOW_OFF = 0x52;

export type Slot = 'tap' | 'hold' | 'double' | 'taphold';
export interface BehaviorSet {
  tap: number | null; // HID usage ids
  hold: number | null;
  double: number | null;
  taphold: number | null;
}

/** Explicit overrides for the non-HID bytes of a behavior set. Every field
 * defaults to PRESERVING whatever the device record already carries
 * (behaviorMetaOf), falling back to the stock shapes (200 ms / 0 flags). */
export interface BehaviorOpts {
  termHold?: number;
  termDouble?: number;
  /** Body flags = hold-tap flavor byte (see file header). */
  bodyFlags?: number;
  /** 4th byte of the HOLD quad — meaning unknown, preserve by default. */
  holdFlags?: number;
}

/** Extract the preserved meta bytes (terms + flag bytes) from the live
 * record set so edits keep them instead of silently zeroing. */
export function behaviorMetaOf(
  recs: KeyRec[] | undefined,
  kk: number,
): BehaviorOpts | null {
  const prim = recs?.find((r) => r.kk === kk);
  if (!prim) return null;
  const r = prim.rec;
  if (r.length === 24 && r[1] === 0x03)
    return { termHold: r[6] | (r[7] << 8), bodyFlags: r[5], holdFlags: r[11] };
  if (r.length === 27 && r[1] === 0x10)
    return {
      termHold: r[3] | (r[4] << 8),
      termDouble: r[9] | (r[10] << 8),
      bodyFlags: r[8],
      holdFlags: r[14],
    };
  return null;
}

export function t03Record(
  kk: number,
  holdHid: number,
  tapHid: number,
  term = 200,
  opts: BehaviorOpts = {},
): Uint8Array {
  return new Uint8Array([
    kk & 0xff, 0x03, 0x15, 0x01, 0x01, opts.bodyFlags ?? 0,
    ...le(opts.termHold ?? term),
    ...quad(holdHid, opts.holdFlags), ...PAD4, ...triple(tapHid), ...PAD4,
  ]);
}

export function t10Primary(
  kk: number,
  holdHid: number,
  tapHid: number,
  termHold = 200,
  termDouble = 200,
  opts: BehaviorOpts = {},
): Uint8Array {
  return new Uint8Array([
    kk & 0xff, 0x10, 0x18, ...le(opts.termHold ?? termHold), 0x03, 0x01,
    0x01, opts.bodyFlags ?? 0, ...le(opts.termDouble ?? termDouble),
    ...quad(holdHid, opts.holdFlags), ...PAD4, ...triple(tapHid), ...PAD4,
  ]);
}

export function t10ShadowMini(
  kk: number,
  doubleHid: number,
  termDouble = 200,
): Uint8Array {
  return new Uint8Array([
    (kk + SHADOW_OFF) & 0xff, 0x10, 0x07, ...le(termDouble), 0x01,
    ...triple(doubleHid),
  ]);
}

export function t10ShadowFull(
  kk: number,
  tapHoldHid: number,
  doubleHid: number,
  termHold = 200,
  termDouble = 200,
): Uint8Array {
  return new Uint8Array([
    (kk + SHADOW_OFF) & 0xff, 0x10, 0x18, ...le(termHold), 0x03, 0x01,
    0x01, 0x00, ...le(termDouble),
    ...triple(tapHoldHid), ...PAD4, ...triple(doubleHid), ...PAD4,
  ]);
}

export function behaviorSetOf(recs: KeyRec[], kk: number): BehaviorSet | null {
  const prim = recs.find((r) => r.kk === kk);
  if (!prim) return null;
  const r = prim.rec;
  const set: BehaviorSet = { tap: null, hold: null, double: null, taphold: null };
  if (r.length === 7 && r[5] === 0x07) {
    set.tap = r[3];
    return set; // plain key
  }
  if (r.length === 24 && r[1] === 0x03) {
    set.hold = r[8];
    set.tap = r[16];
    return set;
  }
  if (r.length === 27 && r[1] === 0x10) {
    set.hold = r[11];
    set.tap = r[19];
    const sh = recs.find((x) => x.kk === kk + SHADOW_OFF);
    if (sh && sh.rec[1] === 0x10) {
      if (sh.rec.length === 10) set.double = sh.rec[6];
      else if (sh.rec.length === 27) {
        set.taphold = sh.rec[11];
        set.double = sh.rec[19];
      }
    }
    return set;
  }
  return null; // non-key family (layer switch, special, …)
}

/** Plain T01 7B key record (S1 restore-proven downgraded shape). */
export function plainRecord(kk: number, hid: number): Uint8Array {
  return new Uint8Array([kk & 0xff, 0x01, 0x04, hid & 0xff, 0x00, 0x07, 0x00]);
}

/** NONE filler record (type 07) — the resting shape of unused slots.
 * Type 07 is unambiguous; the legacy 00 shape is a zero-length BLUETOOTH
 * record and decodes as BT_CLEAR. Device compacts both to absent. */
export function fillerRecord(kk: number): Uint8Array {
  return new Uint8Array([kk & 0xff, 0x07, 0x00]);
}

/** True if the layer cache still holds a T10 shadow record at KK+0x52. */
export function hasT10Shadow(prevRecs: KeyRec[] | undefined, kk: number): boolean {
  const sh = prevRecs?.find((x) => x.kk === kk + SHADOW_OFF);
  return sh != null && sh.rec[1] === 0x10;
}

export function behaviorSetOps(
  kk: number,
  set: BehaviorSet,
  layer: number,
  label: string,
  prevRecs?: KeyRec[],
  opts: BehaviorOpts = {},
): KeySetOp | null {
  if (set.tap == null) {
    if (set.hold != null || set.double != null || set.taphold != null)
      throw new Error('behavior chain: Tap is required first');
    return null;
  }
  if (set.taphold != null && set.double == null)
    throw new Error('behavior chain: Double Tap required before Tap+Hold');
  if (set.double != null && set.hold == null)
    throw new Error('behavior chain: Hold required before Double Tap');
  if (set.hold == null) return null; // tap-only → queueBehaviorSet downgrades
  // Preserve the live record's meta bytes (terms, flavor, hold-quad flag)
  // unless the caller overrides them explicitly.
  const meta = behaviorMetaOf(prevRecs, kk);
  const merged: BehaviorOpts = {
    termHold: opts.termHold ?? meta?.termHold ?? 200,
    termDouble: opts.termDouble ?? meta?.termDouble ?? 200,
    bodyFlags: opts.bodyFlags ?? meta?.bodyFlags ?? 0,
    holdFlags: opts.holdFlags ?? meta?.holdFlags ?? 0,
  };
  // Downgrade from a T10 set: the shadow slot must go back to its filler
  // shape or behaviorSetOf would keep reporting the stale double/taphold.
  const staleShadow =
    set.double == null && set.taphold == null && hasT10Shadow(prevRecs, kk)
      ? [fillerRecord(kk + SHADOW_OFF)]
      : [];
  const records =
    set.taphold != null
      ? [t10Primary(kk, set.hold, set.tap, 200, 200, merged), t10ShadowFull(kk, set.taphold, set.double!), TAIL_T10]
      : set.double != null
        ? [t10Primary(kk, set.hold, set.tap, 200, 200, merged), t10ShadowMini(kk, set.double), TAIL_T10]
        : [t03Record(kk, set.hold, set.tap, 200, merged), ...staleShadow];
  return { kind: 'keyset', layer, kk, records, label };
}

/* Plain unmodded HID T01 record → its usage id. Modded records return null:
 * T10 triples carry no MODMASK, so behavior slots are HID-only by wire. */
export function hidPairOf(
  rec: Uint8Array | number[],
): { hid: number; mod: number } | null {
  if (rec.length === 7 && rec[5] === 0x07 && rec[6] === 0x00)
    return { hid: rec[3], mod: rec[6] };
  return null;
}

export function withSlot(
  set: BehaviorSet,
  slot: Slot,
  hid: number | null,
): BehaviorSet {
  return { ...set, [slot]: hid };
}

/** Clearing a chain slot also clears the dependents that cannot exist
 * alone on the wire (hold ← double ← taphold). Returns the pruned set
 * plus the human names of the slots dropped alongside the request. */
export function cascadeClear(
  set: BehaviorSet,
  slot: Slot,
): { set: BehaviorSet; dropped: string[] } {
  let next = withSlot(set, slot, null);
  const dropped: string[] = [];
  const drop = (s: Slot, name: string) => {
    if (next[s] == null) return;
    next = withSlot(next, s, null);
    dropped.push(name);
  };
  if (slot === 'hold') {
    drop('double', 'Double Tap');
    drop('taphold', 'Tap+Hold');
  } else if (slot === 'double') {
    drop('taphold', 'Tap+Hold');
  }
  return { set: next, dropped };
}
