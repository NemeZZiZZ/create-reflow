/* Module-profile row helpers for the Modules tab (Phase 5b Task 3).
 *
 * Everything here is derived from exported SDK facts (FIELD_MAP /
 * AXIS_HALVES / PAIRED_GESTURES / host-table / module-wire) — client-side
 * mirrors of tables the SDK keeps private (gesturesOfType, the motion-name
 * reverse map), no SDK changes. */

import {
  ACTIONS,
  AXIS_HALVES,
  FIELD_MAP,
  MOUSE_MASK,
  PAIRED_GESTURES,
  gestureLocked,
  halfSelector,
  splitPair,
  toHex,
  usageToName,
} from '@create-reflow/sdk';
import type { ActionDef, DiffRow, ModuleType, ProfileBinding } from '@create-reflow/sdk';

/* --- gesture universe ------------------------------------------------------ */

export interface GestureRowModel {
  gesture: string;
  /** The last ':' segment ('button_1', '2_fingers', 'dial') — null for
   * target-less gestures ('vertical:track'), which render above the tabs. */
  target: string | null;
  kind: 'axis' | 'pair' | 'field' | 'locked' | 'hold';
}

/** The gestures one module type edits, in stable display order: axis pairs,
 * the paired gestures (the Tune dial), every named field-map gesture, and
 * — TRACK only — the hold rows the firmware does not expose (rendered
 * 'not settable'). Firmware-locked gestures (Touch taps + 1-finger cursor
 * pairs) carry kind 'locked' wherever they appear. */
export function gestureRows(type: ModuleType): GestureRowModel[] {
  const rows: GestureRowModel[] = [];
  const seen = new Set<string>();
  const push = (gesture: string, base: GestureRowModel['kind']) => {
    if (seen.has(gesture)) return;
    seen.add(gesture);
    rows.push({
      gesture,
      target: targetOf(gesture),
      kind: gestureLocked(type, gesture) ? 'locked' : base,
    });
  };
  for (const g of Object.keys(AXIS_HALVES[type])) push(g, 'axis');
  for (const g of Object.keys(PAIRED_GESTURES[type] ?? {})) push(g, 'pair');
  const pairedHalves = new Set(
    Object.values(PAIRED_GESTURES[type] ?? {}).flatMap((p) => [p.minus, p.plus]),
  );
  for (const spec of Object.values(FIELD_MAP[type])) {
    if (spec.gesture && !pairedHalves.has(spec.gesture)) push(spec.gesture, 'field');
  }
  if (type === 'TRACK') {
    for (const g of [
      'hold:track:button_1',
      'hold:track:button_2',
      'hold:track:button_3',
      'hold:track:button_4',
    ])
      push(g, 'hold');
  }
  return rows;
}

function targetOf(gesture: string): string | null {
  const parts = gesture.split(':');
  return parts.length >= 3 ? parts[parts.length - 1] : null;
}

/** Stable per-target grouping (first-appearance order, target-less first). */
export function groupByTarget(
  rows: GestureRowModel[],
): { target: string | null; rows: GestureRowModel[] }[] {
  const groups = new Map<string | null, GestureRowModel[]>();
  for (const r of rows) {
    const arr = groups.get(r.target) ?? [];
    arr.push(r);
    groups.set(r.target, arr);
  }
  return [...groups.entries()].map(([target, rs]) => ({ target, rows: rs }));
}

/** Tab label for a target: 'button_1' → 'Button 1', '1_finger' → '1 finger'. */
export function targetLabel(target: string): string {
  return target.charAt(0).toUpperCase() + target.slice(1).replaceAll('_', ' ');
}

/** The device field(s) a gesture lands on — the SDK's private
 * bindingFields rule, rebuilt from the exported tables (axis halves / pair
 * halves / the one named field). */
export function fieldsOfGesture(type: ModuleType, gesture: string): number[] {
  const half = AXIS_HALVES[type][gesture];
  if (half) return [half.minus, half.plus];
  const pair = PAIRED_GESTURES[type]?.[gesture];
  if (pair) {
    const minus = fieldOfNamed(type, pair.minus);
    const plus = fieldOfNamed(type, pair.plus);
    return minus !== undefined && plus !== undefined ? [minus, plus] : [];
  }
  const f = fieldOfNamed(type, gesture);
  return f === undefined ? [] : [f];
}

function fieldOfNamed(type: ModuleType, gesture: string): number | undefined {
  for (const [f, spec] of Object.entries(FIELD_MAP[type])) {
    if ((spec.kind === 'keypress' || spec.kind === 'mouse_button') && spec.gesture === gesture) {
      return Number(f);
    }
  }
  return undefined;
}

/* --- labels ---------------------------------------------------------------- */

/** A stored binding → its display label, plus whether the overlay can
 * actually write it ('shortcut_alias'/'LED' rows have no device field —
 * the APP ONLY badge idiom). */
export function describeBinding(b: ProfileBinding | undefined): {
  label: string;
  writable: boolean;
} {
  if (b === undefined || b.actionType === 'none' || b.actionCode === '') {
    return { label: 'None', writable: true };
  }
  const writable = ['none', 'mouse', 'key', 'modifier', 'value'].includes(b.actionType);
  return { label: b.actionCode, writable };
}

const MASK_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(MOUSE_MASK).map(([name, mask]) => [mask, name]),
);

/** (category, selector) → motion name — the client-side reverse of the
 * MOTION_DIRECTIONS table module-profiles.ts builds privately. */
const MOTION_NAME: Map<number, Map<number, string>> = (() => {
  const out = new Map<number, Map<number, string>>();
  for (const halves of Object.values(AXIS_HALVES)) {
    for (const half of Object.values(halves)) {
      const [minus, plus] = splitPair(half.default);
      const entries: [string | null, number][] = [
        [minus, halfSelector(half, '-')],
        [plus, halfSelector(half, '+')],
      ];
      for (const [name, sel] of entries) {
        if (name === null) continue;
        let bySel = out.get(half.category);
        if (!bySel) {
          bySel = new Map();
          out.set(half.category, bySel);
        }
        if (!bySel.has(sel)) bySel.set(sel, name);
      }
    }
  }
  return out;
})();

function u32le(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}
function i32le(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24);
}

/** One raw device record → a short human label ('C_VOL_UP', 'M2',
 * 'SCROLL_UP', 'value 10', 'empty'); compact hex when nothing decodes.
 * Feeds the gesture rows' 'device: X' drift badges — names are not truth,
 * but they beat raw bytes in a badge. */
export function describeDeviceRecord(rec: Uint8Array | undefined): string {
  if (rec === undefined) return '(absent)';
  if (rec[1] === 0x07) return 'empty';
  if (rec[1] === 0x01 && rec[2] >= 1) return `value ${rec[3]}`;
  if (rec[1] === 0x04 && rec[2] === 6) {
    // body [01][04][usage u16LE][page u16LE] — usage at rec[5], page at rec[7]
    const usage = rec[5] | (rec[6] << 8);
    const page = rec[7] | (rec[8] << 8);
    return usageToName(page, usage) ?? toHex(rec);
  }
  if (rec[1] === 0x0f && rec[2] === 8) {
    if (rec[3] === 3) return MASK_NAME[rec[7]] ?? toHex(rec);
    const cat = u32le(rec, 3);
    const sel = i32le(rec, 7);
    return MOTION_NAME.get(cat)?.get(sel) ?? `axis ${cat}/${sel}`;
  }
  return toHex(rec);
}

/** A diffProfile row's device side ('got' hex) as a short label. */
export function driftDeviceLabel(row: DiffRow): string {
  if (row.got === '(absent)') return '(absent)';
  return describeDeviceRecord(
    Uint8Array.from(row.got.split(' ').map((h) => Number.parseInt(h, 16))),
  );
}

/* --- ActionPalette bridge --------------------------------------------------- */

/** Palette pick → a module binding action. Only family-0x01 bodies (HID /
 * consumer keys) have a proven module keypress byte form; vendor / special
 * records cannot land on a module field, so the palette filters them out. */
export function codeFrom(a: ActionDef): { actionType: string; actionCode: string } | null {
  const b = a.body();
  if (b[0] !== 0x01) return null;
  const usage = b[2] | (b[3] << 8);
  const page = b[4] | (b[5] << 8);
  const name = usageToName(page, usage);
  if (name === null) return null;
  return { actionType: 'key', actionCode: name };
}

export const keyActionFilter = (a: ActionDef): boolean => codeFrom(a) !== null;

/** Binding actionCode ('C_VOL_UP') → the palette action to highlight, or
 * null (mouse buttons / None / motion values highlight in their own UI). */
const CODE_TO_ID: Map<string, string> = new Map();
for (const a of ACTIONS) {
  const c = codeFrom(a);
  if (c !== null && !CODE_TO_ID.has(c.actionCode)) CODE_TO_ID.set(c.actionCode, a.id);
}
export const pickedIdFor = (code: string | undefined): string | null =>
  code !== undefined ? (CODE_TO_ID.get(code) ?? null) : null;
