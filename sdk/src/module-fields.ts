/* Module field maps + profile data model — vendored from OpenFlow.
 *
 * PROVENANCE: the tables below are ported as knowledge from the OpenFlow
 * backend (Apache-2.0) — device/module_field_map.json (live probe captures,
 * 2026-09-02..2026-09-18) + device/module_fields.py. Verbatim source copies
 * ride next to this file as module-field-map.source.json and
 * stock-module-profiles.source.json (pure reference, never imported — the
 * host-table pattern). Nothing here is guessed: every mask/category/field
 * index is a vendor-captured, hardware-proved fact; keep the notes.
 *
 * Stale-source flag: module_fields.py's half_selector docstring claims "on
 * the Tune scroll axes the half that fires on a right swipe is the one
 * holding selector -1", but its own AXIS_HALVES table + the field-map JSON
 * say otherwise (0x0a=-1 up, 0x0b=+1 down, 0x0c=-1 left, 0x0d=+1 right —
 * ordinary signs; hardware-proved 2026-09-04). We vendor the table, not the
 * docstring; halfSelector() keeps the selectors-override seam so a future
 * capture can pin a per-half selector without reshaping the table.
 *
 * Facts that shape everything downstream:
 *   - A category is NOT unique within a module (a Touch carries two cat-4
 *     pairs) — axis halves are mapped per gesture, never per category.
 *   - The selector belongs to the HALF, not the sign: which field fires on
 *     which swipe is measured, not derived from field order (Track rotate
 *     is 0x0A(-)/0x09(+) — reversed vs field order).
 *   - Empty (type 0x07) IS the default on the wire for the firmware-driven
 *     Touch gestures — they are always written empty and never count as
 *     drift.
 *   - Tune 0x05 is degrees-per-detent, not detents (SCRUM-50): the app
 *     stores detents/turn, the wire byte is round(360/detents). */

export const MODULE_TYPES = ['TOUCH', 'TRACK', 'TUNE', 'FLOAT'] as const;
export type ModuleType = (typeof MODULE_TYPES)[number];

/** What a field currently holds (the record TYPE decides what a field
 * means — the same field accepts keypress or mask; proven twice on
 * hardware). 'unbound' = slot exists, no binding seen. */
export type FieldKind =
  | 'speed'
  | 'setting'
  | 'flag'
  | 'keypress'
  | 'axis'
  | 'mouse_button'
  | 'unbound';

export interface FieldSpec {
  kind: FieldKind;
  /** Gesture behavior string ('tap:touch:3_fingers'); '' when the vendor
   * map names none (axis halves get theirs from AXIS_HALVES). */
  gesture: string;
  /** Motion category for kind 'axis' (4 = vertical scroll, 6 = horizontal,
   * 8 = zoom, 0/1 = pointer). */
  axis?: number;
  /** Signed selector captured in this field's record. */
  direction?: -1 | 1;
  /** Mouse-button bitmask for kind 'mouse_button' (1=M1 2=M2 4=M3 8=M4). */
  mask?: number;
  /** Vendor value label ('M1', 'M1 (firmware default when empty)'). */
  value?: string;
  /** Vendor-measured default byte for a speed/setting/flag field. */
  defaultValue?: number;
  /** Vendor-captured fact — keep verbatim; these are the knowledge. */
  note?: string;
}

const unbound = (note = 'none - slot exists, no binding'): FieldSpec => ({
  kind: 'unbound',
  gesture: '',
  note,
});

/** Field index → spec, per module type. FLOAT has no device read yet — an
 * empty map on purpose (module_fields.py: "no field map — read one when the
 * module is connected"). */
export const FIELD_MAP: Record<ModuleType, Record<number, FieldSpec>> = {
  TOUCH: {
    0x00: { kind: 'speed', gesture: '', defaultValue: 10 },
    0x01: { kind: 'speed', gesture: '', defaultValue: 50 },
    0x02: { kind: 'speed', gesture: '', defaultValue: 50 },
    0x03: { kind: 'flag', gesture: '', defaultValue: 1 },
    0x04: { kind: 'flag', gesture: '', defaultValue: 0 },
    0x05: {
      kind: 'axis', gesture: '', axis: 1, direction: -1,
      note: '1-finger cursor half. EMPTY on every NayaFlow-written board and the module firmware drives the cursor itself; an explicit cat 1/0 record here gives only the coarse motion the Tune experiments measured. Written empty at the default (2026-09-09).',
    },
    0x06: {
      kind: 'axis', gesture: '', axis: 1, direction: 1,
      note: '1-finger cursor half. EMPTY on every NayaFlow-written board; written empty at the default (2026-09-09).',
    },
    0x07: {
      kind: 'axis', gesture: '', axis: 0, direction: -1,
      note: '1-finger cursor half. EMPTY on every NayaFlow-written board; written empty at the default (2026-09-09).',
    },
    0x08: {
      kind: 'axis', gesture: '', axis: 0, direction: 1,
      note: '1-finger cursor half. EMPTY on every NayaFlow-written board; written empty at the default (2026-09-09).',
    },
    0x09: { kind: 'axis', gesture: '', axis: 4, direction: 1, note: 'scroll/pointer routing' },
    0x0a: { kind: 'axis', gesture: '', axis: 4, direction: -1, note: 'scroll/pointer routing' },
    0x0b: {
      kind: 'mouse_button', gesture: 'tap:touch:1_finger', mask: 1, value: 'M1 (firmware default when empty)',
      note: 'EMPTY = left click, done by the module firmware; NayaFlow never writes this field. Written empty at the default M1; a key or other button is written explicitly.',
    },
    0x0c: {
      kind: 'mouse_button', gesture: 'tap:touch:2_fingers', mask: 2, value: 'M2 (firmware default when empty)',
      note: 'EMPTY = right click, done by the module firmware; NayaFlow never writes this field. Written empty at the default M2; anything else is written explicitly.',
    },
    0x0d: { kind: 'axis', gesture: '', axis: 4, direction: -1, note: 'scroll/pointer routing (2-finger vertical scroll, cat 4 — measured 2026-09-10)' },
    0x0e: { kind: 'axis', gesture: '', axis: 4, direction: 1, note: 'scroll/pointer routing (2-finger vertical scroll, cat 4)' },
    0x0f: { kind: 'axis', gesture: '', axis: 6, direction: -1, note: 'scroll/pointer routing (2-finger horizontal scroll, cat 6 — measured 2026-09-10)' },
    0x10: { kind: 'axis', gesture: '', axis: 6, direction: 1, note: 'scroll/pointer routing (2-finger horizontal scroll, cat 6)' },
    0x11: {
      kind: 'axis', gesture: 'pinch&spread:touch:2_fingers', axis: 8, direction: -1,
      note: 'pinch half of the 2-finger zoom axis (NayaCore PINCH_IN_2, STATIC_ZOOM). Proved on hardware 2026-09-18; empty on every NayaFlow-written board because NayaFlow never writes it.',
    },
    0x12: {
      kind: 'axis', gesture: 'pinch&spread:touch:2_fingers', axis: 8, direction: 1,
      note: 'spread half of the 2-finger zoom axis (NayaCore PINCH_OUT_2). Proved on hardware 2026-09-18.',
    },
    0x13: {
      kind: 'mouse_button', gesture: 'tap:touch:3_fingers', mask: 4, value: 'M3',
      note: 'tap-to-click; category-3 record, same shape as a Track button',
    },
    0x14: unbound(),
    0x15: { kind: 'keypress', gesture: 'swipe_up:touch:3_fingers', value: 'LALT + LSHIFT + ESC' },
    0x16: { kind: 'keypress', gesture: 'swipe_down:touch:3_fingers', value: 'LALT + ESC' },
    0x17: { kind: 'keypress', gesture: 'swipe_left:touch:3_fingers', value: 'LCTRL + LSHIFT + TAB' },
    0x18: { kind: 'keypress', gesture: 'swipe_right:touch:3_fingers', value: 'LCTRL + TAB' },
    0x19: { kind: 'keypress', gesture: 'tap:touch:4_fingers', value: 'LGUI + TAB' },
    0x1a: unbound(),
    0x1b: { kind: 'keypress', gesture: 'swipe_up:touch:4_fingers', value: 'LALT + PG_UP' },
    0x1c: { kind: 'keypress', gesture: 'swipe_down:touch:4_fingers', value: 'LALT + PG_DN' },
    0x1d: { kind: 'keypress', gesture: 'swipe_left:touch:4_fingers', value: 'LGUI + LCTRL + LEFT' },
    0x1e: { kind: 'keypress', gesture: 'swipe_right:touch:4_fingers', value: 'LGUI + LCTRL + RIGHT' },
    0x1f: unbound(),
    0x20: unbound(),
    0x21: unbound(),
    0x22: { kind: 'keypress', gesture: '', note: 'on-device keypress, no default-map match (C_VOL_UP)' },
    0x23: { kind: 'keypress', gesture: '', note: 'on-device keypress, no default-map match (C_VOL_DOWN)' },
  },
  TRACK: {
    0x00: { kind: 'speed', gesture: '', defaultValue: 10 },
    0x01: { kind: 'speed', gesture: '', defaultValue: 10 },
    0x02: { kind: 'speed', gesture: '', defaultValue: 50 },
    0x03: { kind: 'setting', gesture: '', defaultValue: 1 },
    0x04: { kind: 'setting', gesture: '', defaultValue: 0 },
    0x05: { kind: 'axis', gesture: '', axis: 1, direction: -1, note: 'pointer/scroll routing (ball Y)' },
    0x06: { kind: 'axis', gesture: '', axis: 1, direction: 1, note: 'pointer/scroll routing (ball Y)' },
    0x07: { kind: 'axis', gesture: '', axis: 0, direction: -1, note: 'pointer/scroll routing (ball X)' },
    0x08: { kind: 'axis', gesture: '', axis: 0, direction: 1, note: 'pointer/scroll routing (ball X)' },
    0x09: { kind: 'axis', gesture: '', axis: 4, direction: 1, note: 'pointer/scroll routing (rotate, + half)' },
    0x0a: { kind: 'axis', gesture: '', axis: 4, direction: -1, note: 'pointer/scroll routing (rotate, - half; field order reversed vs sign)' },
    0x0b: {
      kind: 'mouse_button', gesture: 'tap:track:button_1', mask: 1, value: 'M1',
      note: 'button 1; value is a mouse-button bitmask (1=M1 2=M2 4=M3 8=M4); the same field later took 4-byte keypresses (D/R/S/T) — the record TYPE decides what it holds',
    },
    0x0c: { kind: 'mouse_button', gesture: 'tap:track:button_2', mask: 4, value: 'M3', note: 'button 2' },
    0x0d: { kind: 'mouse_button', gesture: 'tap:track:button_3', mask: 2, value: 'M2', note: 'button 3' },
    0x0e: { kind: 'mouse_button', gesture: 'tap:track:button_4', mask: 8, value: 'M4', note: 'button 4' },
  },
  TUNE: {
    0x00: { kind: 'speed', gesture: '' },
    0x01: { kind: 'speed', gesture: '' },
    0x02: { kind: 'speed', gesture: '' },
    0x03: { kind: 'flag', gesture: '', defaultValue: 1 },
    0x04: { kind: 'flag', gesture: '', defaultValue: 0 },
    0x05: {
      kind: 'setting', gesture: '', defaultValue: 5,
      note: 'DEGREES PER DETENT: the dial gives 360 / byte detents per turn, so the stock 5 is NayaFlow\'s default of 72 and the slider minimum of 5 detents is the byte 72. Measured live 2026-09-16 (SCRUM-50): 36 -> about 10 detents, 10 -> about 33, 90 -> exactly 4.',
    },
    0x06: { kind: 'setting', gesture: '', defaultValue: 75, note: 'tick_strength (matches the schema DEFAULT on a stock module)' },
    0x07: { kind: 'setting', gesture: '', defaultValue: 1, note: 'toggle_ticks' },
    0x08: {
      kind: 'keypress', gesture: 'tap:tune:1_finger', value: '(user-set: Backspace)',
      note: 'the 1-finger tap captured flashing; the probe shows it EMPTY again, so a later flash rewrote the whole slot',
    },
    0x09: unbound(),
    0x0a: {
      kind: 'axis', gesture: 'vertical:tune:1_finger', axis: 4, direction: -1,
      note: 'scroll L/R axis Directions inverted on this device 2026-09-03 (deliberate fix: scroll ran backwards). Hardware 2026-09-04: UP fires 0x0a, DOWN 0x0b — 0x0a/0x0b are VERTICAL despite the field map reading like L/R.',
    },
    0x0b: {
      kind: 'axis', gesture: 'vertical:tune:1_finger', axis: 4, direction: 1,
      note: 'vertical scroll + half (down swipe).',
    },
    0x0c: {
      kind: 'axis', gesture: 'horizontal:tune:1_finger', axis: 6, direction: -1,
      note: 'horizontal scroll - half (left swipe; hardware 2026-09-04).',
    },
    0x0d: {
      kind: 'axis', gesture: 'horizontal:tune:1_finger', axis: 6, direction: 1,
      note: 'horizontal scroll + half (right swipe).',
    },
    0x0e: { kind: 'keypress', gesture: 'tap:tune:2_fingers', value: 'C_PLAY_PAUSE' },
    0x0f: unbound(),
    0x10: { kind: 'keypress', gesture: 'swipe_up:tune:2_fingers', value: 'C_BRIGHTNESS_INC' },
    0x11: { kind: 'keypress', gesture: 'swipe_down:tune:2_fingers', value: 'C_BRIGHTNESS_DEC' },
    0x12: { kind: 'keypress', gesture: 'swipe_left:tune:2_fingers', value: 'C_REWIND' },
    0x13: { kind: 'keypress', gesture: 'swipe_right:tune:2_fingers', value: 'C_FAST_FORWARD' },
    0x14: {
      kind: 'axis', gesture: 'pinch&spread:tune:2_fingers', axis: 8, direction: -1,
      note: 'pinch half of the 2-finger zoom axis (NayaCore PINCH_IN_2, STATIC_ZOOM). Proved on hardware 2026-09-18; empty on every NayaFlow-written board because NayaFlow never writes it.',
    },
    0x15: {
      kind: 'axis', gesture: 'pinch&spread:tune:2_fingers', axis: 8, direction: 1,
      note: 'spread half of the 2-finger zoom axis (NayaCore PINCH_OUT_2). Proved on hardware 2026-09-18.',
    },
    0x16: { kind: 'keypress', gesture: 'tap:tune:3_fingers', value: 'C_MUTE' },
    0x17: unbound(),
    0x18: { kind: 'keypress', gesture: 'swipe_up:tune:3_fingers', note: 'LED action (brightness up) - keypress slot empty' },
    0x19: { kind: 'keypress', gesture: 'swipe_down:tune:3_fingers', note: 'LED action (brightness down) - keypress slot empty' },
    0x1a: { kind: 'keypress', gesture: 'swipe_left:tune:3_fingers', value: 'C_PREVIOUS' },
    0x1b: { kind: 'keypress', gesture: 'swipe_right:tune:3_fingers', value: 'C_NEXT' },
    0x1c: unbound(),
    0x1d: unbound(),
    0x1e: unbound(),
    0x1f: unbound(),
    0x20: unbound(),
    0x21: unbound(),
    0x22: { kind: 'keypress', gesture: 'clockwise_rotate:tune:dial', note: 'dial clockwise; holds C_VOL_UP in the stock profile' },
    0x23: { kind: 'keypress', gesture: 'counter_clockwise_rotate:tune:dial', note: 'dial counter-clockwise; holds C_VOL_DOWN in the stock profile' },
  },
  FLOAT: {},
};

/** One physical motion = TWO fields, mapped per gesture (a category is not
 * unique within a module). minus/plus name the field that fires on the
 * minus/plus DIRECTION (up/left vs down/right) — which is measured, not
 * derived from field order: Track rotate is 0x0A(-)/0x09(+), reversed vs
 * field order, and the Tune's 0x0a/0x0b are VERTICAL even though the field
 * map reads like an L/R pair. `default` is the pair the stock profiles
 * ship, minus-first; `selectors` is the per-half wire-selector override
 * seam (see the header note — nothing vendored needs it today). */
export interface AxisHalf {
  minus: number;
  plus: number;
  category: number;
  default: string;
  selectors?: { '-': number; '+': number };
}

export const AXIS_HALVES: Record<ModuleType, Record<string, AxisHalf>> = {
  TOUCH: {
    'vertical:touch:1_finger': {
      minus: 0x05, plus: 0x06, category: 1,
      default: 'mouse - MOUSE_DOWN - MOUSE_UP',
    },
    'horizontal:touch:1_finger': {
      minus: 0x07, plus: 0x08, category: 0,
      default: 'mouse - MOUSE_LEFT - MOUSE_RIGHT',
    },
    'vertical:touch:2_fingers': {
      minus: 0x0d, plus: 0x0e, category: 4,
      default: 'mouse - SCROLL_UP - SCROLL_DOWN',
    },
    'horizontal:touch:2_fingers': {
      minus: 0x0f, plus: 0x10, category: 6,
      default: 'mouse - SCROLL_LEFT - SCROLL_RIGHT',
    },
    'pinch&spread:touch:2_fingers': {
      minus: 0x11, plus: 0x12, category: 8,
      default: 'mouse - ZOOM_OUT - ZOOM_IN',
    },
  },
  TRACK: {
    'vertical:track': {
      minus: 0x05, plus: 0x06, category: 1,
      default: 'mouse - MOUSE_DOWN - MOUSE_UP',
    },
    'horizontal:track': {
      minus: 0x07, plus: 0x08, category: 0,
      default: 'mouse - MOUSE_LEFT - MOUSE_RIGHT',
    },
    'rotate:track': {
      minus: 0x0a, plus: 0x09, category: 4,
      default: 'mouse - SCROLL_UP - SCROLL_DOWN',
    },
  },
  TUNE: {
    'vertical:tune:1_finger': {
      minus: 0x0a, plus: 0x0b, category: 4,
      default: 'mouse - SCROLL_UP - SCROLL_DOWN',
    },
    'horizontal:tune:1_finger': {
      minus: 0x0c, plus: 0x0d, category: 6,
      default: 'mouse - SCROLL_LEFT - SCROLL_RIGHT',
    },
    'pinch&spread:tune:2_fingers': {
      minus: 0x14, plus: 0x15, category: 8,
      default: 'mouse - ZOOM_OUT - ZOOM_IN',
    },
  },
  FLOAT: {},
};

/** The wire selector one half stores: the sign itself, unless the half's
 * `selectors` override says otherwise (the seam that keeps a direction-
 * label correction from changing a single flashed byte — see the header
 * note on the stale half_selector docstring). */
export function halfSelector(half: AxisHalf, sign: '-' | '+'): number {
  return half.selectors?.[sign] ?? (sign === '-' ? -1 : 1);
}

/** Settings that reach the device, as {setting id: field index}. Only the
 * correlations that are actually established are here (a settings field is
 * written blind). 0x04 is deliberately absent — an unmapped flag, probe
 * don't guess. Tune-only extras: ticks_per_rotation (DEGREES per detent on
 * the wire — ticksToWire/ticksFromWire), tick_strength, toggle_ticks. */
export const SETTING_FIELDS: Record<ModuleType, Record<string, number>> = {
  TOUCH: { pointer_speed: 0x00, scroll_speed: 0x01, pointer_accel: 0x02, pointer_accel_on: 0x03 },
  TRACK: { pointer_speed: 0x00, scroll_speed: 0x01, pointer_accel: 0x02, pointer_accel_on: 0x03 },
  TUNE: {
    pointer_speed: 0x00,
    scroll_speed: 0x01,
    pointer_accel: 0x02,
    pointer_accel_on: 0x03,
    ticks_per_rotation: 0x05,
    tick_strength: 0x06,
    toggle_ticks: 0x07,
  },
  FLOAT: {},
};

/** Settings whose app value and wire byte differ in unit: app stores
 * detents per turn (NayaFlow's slider), the module stores degrees per
 * detent. */
export const DEGREES_PER_TURN: Record<string, number> = { ticks_per_rotation: 360 };

/** Wire byte for a detent count: degrees per detent = round(360/n),
 * clamped to the one-byte field (SCRUM-50: 5 detents → 72, 10 → 36,
 * 4 → 90). */
export function ticksToWire(detents: number): number {
  return Math.max(1, Math.min(255, Math.round(360 / detents)));
}

/** App value for a wire byte: detents per turn; null when the byte cannot
 * mean anything (0 degrees). */
export function ticksFromWire(byte: number): number | null {
  return byte > 0 ? Math.round(360 / byte) : null;
}

/** App value → wire byte for any setting id: identity except the
 * degrees-per-detent ones. null = refuse (overlay leaves the board's byte
 * alone), for a value that is not a usable positive number. */
export function settingToWire(settingId: string, value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (settingId in DEGREES_PER_TURN) {
    if (value <= 0) return null;
    return ticksToWire(value);
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Gestures the MODULE FIRMWARE drives on its own when the field is EMPTY
 * (type 0x07) — and what it does then. On the wire, empty IS the default
 * for these four, not "unbound" (Touch, established 2026-09-09; NayaFlow
 * writes all four empty on every flash and everything still works). */
export const FIRMWARE_DEFAULTS: Partial<Record<ModuleType, Record<string, string>>> = {
  TOUCH: {
    'tap:touch:1_finger': 'M1',
    'tap:touch:2_fingers': 'M2',
    'vertical:touch:1_finger': 'mouse - MOUSE_DOWN - MOUSE_UP',
    'horizontal:touch:1_finger': 'mouse - MOUSE_LEFT - MOUSE_RIGHT',
  },
};

/** The firmware-driven gestures are LOCKED (as NayaFlow's own editor locks
 * them): the field is always written empty and the compare never counts
 * them as drift. Probed on hardware 2026-09-10: a keypress written into a
 * tap field reads back fine and is IGNORED — the locks are the firmware's,
 * not a UI convention. */
export const LOCKED_GESTURES: Record<ModuleType, ReadonlySet<string>> = {
  TOUCH: new Set(Object.keys(FIRMWARE_DEFAULTS.TOUCH ?? {})),
  TRACK: new Set(),
  TUNE: new Set(),
  FLOAT: new Set(),
};

/** True when a gesture is firmware-driven for this module type (always
 * written empty; never drift). */
export function gestureLocked(type: ModuleType, gesture: string): boolean {
  return LOCKED_GESTURES[type]?.has(gesture) ?? false;
}

/** Gestures made of a PAIR of keypress fields rather than motion records:
 * the combined binding is 'A - B' (minus first) and the two values sit in
 * the two half fields (Tune dial: 0x23 counter-clockwise, 0x22 clockwise). */
export const PAIRED_GESTURES: Partial<Record<ModuleType, Record<string, { minus: string; plus: string }>>> = {
  TUNE: {
    'rotate:tune:dial': {
      minus: 'counter_clockwise_rotate:tune:dial',
      plus: 'clockwise_rotate:tune:dial',
    },
  },
};

/** The two direction values of a combined binding, minus-first.
 * Takes the LAST TWO ' - '-separated parts, so both spellings parse:
 * 'mouse - A - B' (motion axis) and 'C_VOL_DOWN - C_VOL_UP' (dial, no
 * leading kind). Dropping the FIRST part instead would read the dial's
 * minus value as its plus. No pair → [null, null]. */
export function splitPair(code: string): [string, string] | [null, null] {
  if (!code || !code.includes(' - ')) return [null, null];
  const parts = code.split(' - ').map((p) => p.trim());
  return parts.length >= 2 ? [parts[parts.length - 2], parts[parts.length - 1]] : [null, null];
}

/** Scroll direction convention (SCRUM-62). NayaFlow's direction names are
 * finger directions under macOS natural scrolling: the record it calls
 * "Scroll up" is (category 4, selector -1), and on a Windows host that
 * record is wheel-DOWN (measured 2026-09-16). Only category 4 flips until
 * a measurement says more — pointer motion is not inverted by natural
 * scrolling and category 8 (zoom) is measured unflipped. */
export type ScrollConvention = 'mac' | 'windows';
export const FLIPPED_ON_WINDOWS: ReadonlySet<number> = new Set([4]);
export const SCROLL_CONVENTION_ID = 'scroll_convention';

/** The selector under a convention: the DEVICE sign for a named direction
 * when encoding, the named sign for a device record when decoding — the
 * same flip serves both ways. */
export function conventionSign(
  category: number,
  selector: number,
  convention: ScrollConvention | null,
): number {
  if (convention === 'windows' && FLIPPED_ON_WINDOWS.has(category)) return -selector;
  return selector;
}

/** A profile's convention from its settings rows: 1 (or an OF-style
 * 'windows…' string) = windows, absent/0 = mac. Never a device field; the
 * flash overlay reads it, the device ignores it. App profiles store the
 * number (settings are Record<string, number>); file io maps the string
 * form. */
export function conventionOf(settings: Readonly<Record<string, unknown>> | undefined): ScrollConvention {
  const raw = settings?.[SCROLL_CONVENTION_ID];
  if (raw === 1) return 'windows';
  if (typeof raw === 'string' && raw.trim().toLowerCase().startsWith('windows')) return 'windows';
  return 'mac';
}

function typeClaims(type: ModuleType, gesture: string): boolean {
  if (gesture in AXIS_HALVES[type]) return true;
  if (gesture in (PAIRED_GESTURES[type] ?? {})) return true;
  for (const spec of Object.values(FIELD_MAP[type])) {
    if (spec.gesture === gesture) return true;
  }
  return false;
}

/** Which module type a gesture belongs to, or null when no type claims it
 * (unknown gesture). Gestures are unique per type in the vendor tables. */
export function moduleTypeOfGesture(gesture: string): ModuleType | null {
  for (const t of MODULE_TYPES) {
    if (typeClaims(t, gesture)) return t;
  }
  return null;
}

/** Whether a gesture has a device field / axis / pair on this module type
 * (import keeps these, skips everything else). */
export function isModuleGesture(type: ModuleType, gesture: string): boolean {
  return typeClaims(type, gesture);
}

/** The keypress/mouse-button field a gesture binds to, or undefined when
 * the gesture has no single field (axis halves go through AXIS_HALVES;
 * combined pairs through PAIRED_GESTURES + this). */
export function gestureField(type: ModuleType, gesture: string): number | undefined {
  for (const [f, spec] of Object.entries(FIELD_MAP[type])) {
    if ((spec.kind === 'keypress' || spec.kind === 'mouse_button') && spec.gesture === gesture) {
      return Number(f);
    }
  }
  return undefined;
}
