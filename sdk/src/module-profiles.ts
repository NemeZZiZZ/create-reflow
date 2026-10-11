/* Module profiles — the app-side profile model + pure overlay/compare/io.
 *
 * A ModuleProfile is the SOURCE of truth for one module's config; the
 * device holds raw config field records. overlay() projects a profile onto
 * a template (modeled fields only — it never invents a field the profile
 * cannot express), compareRecords() is byte truth ('names are not truth'),
 * diffProfile() lists the gestures where profile and device disagree, and
 * parse/buildModuleProfileFile() are the openflow.module-profile v1
 * interchange format (docs/reference/module-profiles/module-profile.schema
 * .json in the OF tree).
 *
 * Wire facts used here (all vendored, see module-fields.ts):
 *   - settings are one-byte type-0x01 records; ticks_per_rotation converts
 *     detents → degrees per detent (SCRUM-50).
 *   - an axis pair is two twoWord records (cat u32LE, selector i32LE);
 *     invert is a SELECTOR SWAP — there is no invert flag on the device.
 *   - the convention flip (cat 4 on Windows) applies when a NAMED direction
 *     becomes a selector — so overlay flips, and diffProfile must compare
 *     under the convention the profile is meant for.
 *   - the dial is a PAIRED gesture: two keypress fields (0x23 CCW, 0x22 CW)
 *     reached through one combined 'C_VOL_DOWN - C_VOL_UP' row; a split
 *     binding overrides the halves individually (same rule as axes).
 *   - firmware-locked Touch gestures are ALWAYS written empty (type 0x07)
 *     and never count as drift. */

import {
  AXIS_HALVES,
  MODULE_TYPES,
  PAIRED_GESTURES,
  SCROLL_CONVENTION_ID,
  SETTING_FIELDS,
  conventionOf,
  conventionSign,
  gestureField,
  gestureLocked,
  halfSelector,
  moduleTypeOfGesture,
  settingToWire,
  splitPair,
} from './module-fields';
import type { ModuleType, ScrollConvention } from './module-fields';
import { encodeModuleField, MOUSE_MASK } from './module-wire';
import { nameToUsage } from './host-table';

/** A module config as the device stores it: field index → raw record bytes
 * ([field][type][len][body...], the encodeModuleField shape). Records are
 * treated as immutable — overlay clones the map, never mutates bytes. */
export type ConfigRecords = Map<number, Uint8Array>;

/** One half of a split pair — a plain action (no invert/split nesting). */
export interface SplitHalf {
  actionType: string;
  actionCode: string;
}

export interface ProfileBinding {
  actionType: string;
  actionCode: string;
  /** Swap the pair's two directions. Selector swap on encode — no flag on
   * the device. 0|1 in profiles; boolean in the interchange file. */
  invert?: 0 | 1;
  threshold?: number;
  mode?: number;
  /** Present only when the two halves are bound independently; each half
   * overrides one direction of the combined code. */
  split?: { '-': SplitHalf | undefined; '+': SplitHalf | undefined };
}

export interface ModuleProfile {
  id: string;
  name: string;
  type: ModuleType;
  /** Which stock map this descends from ('TRACK_LEFT', 'TOUCH_WINDOWS'). */
  variant?: string;
  /** Setting id → app value (numbers; scroll_convention 1 = windows). */
  settings: Record<string, number>;
  /** Gesture behavior string → binding. */
  bindings: Record<string, ProfileBinding>;
  /** Slot uuid this profile was captured from ('' — on board). */
  capturedFrom?: string;
}

/* --- stock profiles (ported verbatim from the vendored stock source) ----- */
/* Bindings = db/stock-module-profiles.json values. Settings = the vendor
 * defaults the field map + module_fields.py read off a stock board (every
 * module: speed 10 / accel 50 / accel on; Touch stores scroll 50 where a
 * Track or Tune stores 10; Tune adds strength 75 / ticks on / 5 degrees
 * per detent = 72 detents in app units). */

const STOCK_SETTINGS = {
  TOUCH: { pointer_speed: 10, scroll_speed: 50, pointer_accel: 50, pointer_accel_on: 1 },
  TRACK: { pointer_speed: 10, scroll_speed: 10, pointer_accel: 50, pointer_accel_on: 1 },
  TUNE: {
    pointer_speed: 10,
    scroll_speed: 10,
    pointer_accel: 50,
    pointer_accel_on: 1,
    ticks_per_rotation: 72, // app units — the wire byte is 5 (SCRUM-50)
    tick_strength: 75,
    toggle_ticks: 1,
  },
} as const;

function b(actionType: string, actionCode: string): ProfileBinding {
  return { actionType, actionCode };
}

const TOUCH_WINDOWS_BINDINGS: Record<string, ProfileBinding> = {
  'horizontal:touch:1_finger': b('value', 'mouse - MOUSE_LEFT - MOUSE_RIGHT'),
  'horizontal:touch:2_fingers': b('value', 'mouse - SCROLL_LEFT - SCROLL_RIGHT'),
  'swipe_down:touch:3_fingers': b('shortcut_alias', 'LALT + ESC'),
  'swipe_down:touch:4_fingers': b('shortcut_alias', 'LALT + PG_DN'),
  'swipe_left:touch:3_fingers': b('shortcut_alias', 'LCTRL + LSHIFT + TAB'),
  'swipe_left:touch:4_fingers': b('shortcut_alias', 'LGUI + LCTRL + LEFT'),
  'swipe_right:touch:3_fingers': b('shortcut_alias', 'LCTRL + TAB'),
  'swipe_right:touch:4_fingers': b('shortcut_alias', 'LGUI + LCTRL + RIGHT'),
  'swipe_up:touch:3_fingers': b('shortcut_alias', 'LALT + LSHIFT + ESC'),
  'swipe_up:touch:4_fingers': b('shortcut_alias', 'LALT + PG_UP'),
  'tap:touch:1_finger': b('mouse', 'M1'),
  'tap:touch:2_fingers': b('mouse', 'M2'),
  'tap:touch:3_fingers': b('mouse', 'M3'),
  'tap:touch:4_fingers': b('shortcut_alias', 'LGUI + TAB'),
  'vertical:touch:1_finger': b('value', 'mouse - MOUSE_DOWN - MOUSE_UP'),
  'vertical:touch:2_fingers': b('value', 'mouse - SCROLL_UP - SCROLL_DOWN'),
};

function trackBindings(buttons: [string, string, string, string]): Record<string, ProfileBinding> {
  return {
    'horizontal:track': b('value', 'mouse - MOUSE_LEFT - MOUSE_RIGHT'),
    'rotate:track': b('value', 'mouse - SCROLL_UP - SCROLL_DOWN'),
    'tap:track:button_1': b('mouse', buttons[0]),
    'tap:track:button_2': b('mouse', buttons[1]),
    'tap:track:button_3': b('mouse', buttons[2]),
    'tap:track:button_4': b('mouse', buttons[3]),
    'vertical:track': b('value', 'mouse - MOUSE_DOWN - MOUSE_UP'),
  };
}

const TUNE_BINDINGS: Record<string, ProfileBinding> = {
  'horizontal:tune:1_finger': b('value', 'mouse - SCROLL_LEFT - SCROLL_RIGHT'),
  'rotate:tune:dial': b('value', 'C_VOL_DOWN - C_VOL_UP'),
  'swipe_down:tune:2_fingers': b('key', 'C_BRIGHTNESS_DEC'),
  'swipe_down:tune:3_fingers': b('LED', 'LED_BRIGHTNESS_DOWN'),
  'swipe_left:tune:2_fingers': b('key', 'C_REWIND'),
  'swipe_left:tune:3_fingers': b('key', 'C_PREVIOUS'),
  'swipe_right:tune:2_fingers': b('key', 'C_FAST_FORWARD'),
  'swipe_right:tune:3_fingers': b('key', 'C_NEXT'),
  'swipe_up:tune:2_fingers': b('key', 'C_BRIGHTNESS_INC'),
  'swipe_up:tune:3_fingers': b('LED', 'LED_BRIGHTNESS_UP'),
  'tap:tune:2_fingers': b('key', 'C_PLAY_PAUSE'),
  'tap:tune:3_fingers': b('key', 'C_MUTE'),
  'vertical:tune:1_finger': b('value', 'mouse - SCROLL_UP - SCROLL_DOWN'),
};

/** The 4 stock profiles, seeded from the vendored stock source. Track Left
 * and Right are SEPARATE because the module is asymmetric (flipping it
 * reverses the physical button order) — not a bay choice. */
export const STOCK_PROFILES: readonly ModuleProfile[] = [
  {
    id: 'TOUCH_WINDOWS',
    name: 'Naya Touch Windows',
    type: 'TOUCH',
    variant: 'TOUCH_WINDOWS',
    settings: { ...STOCK_SETTINGS.TOUCH },
    bindings: TOUCH_WINDOWS_BINDINGS,
  },
  {
    id: 'TRACK_LEFT',
    name: 'Naya Track Left',
    type: 'TRACK',
    variant: 'TRACK_LEFT',
    settings: { ...STOCK_SETTINGS.TRACK },
    bindings: trackBindings(['M1', 'M3', 'M2', 'M4']),
  },
  {
    id: 'TRACK_RIGHT',
    name: 'Naya Track Right',
    type: 'TRACK',
    variant: 'TRACK_RIGHT',
    settings: { ...STOCK_SETTINGS.TRACK },
    bindings: trackBindings(['M4', 'M2', 'M3', 'M1']),
  },
  {
    id: 'TUNE',
    name: 'Naya Tune Mac/Win',
    type: 'TUNE',
    variant: 'TUNE',
    settings: { ...STOCK_SETTINGS.TUNE },
    bindings: TUNE_BINDINGS,
  },
];

/** Stock profiles by id. */
export const StockProfiles: Record<string, ModuleProfile> = Object.fromEntries(
  STOCK_PROFILES.map((p) => [p.id, p]),
);

/* --- encode -------------------------------------------------------------- */

/** The 8-byte twoWord VALUE for one axis half: [category u32LE]
 * [selector i32LE]. invert = SELECTOR SWAP — the opposite selector is
 * written, there is no invert flag on the device. Convention flips (cat 4
 * on Windows) happen at the named-direction boundary before this. */
export function encodeAxisBinding(category: number, selector: number, invert: 0 | 1 = 0): Uint8Array {
  const sel = invert ? -selector : selector;
  return Uint8Array.from([
    category & 0xff, (category >> 8) & 0xff, (category >> 16) & 0xff, (category >> 24) & 0xff,
    sel & 0xff, (sel >> 8) & 0xff, (sel >> 16) & 0xff, (sel >> 24) & 0xff,
  ]);
}

/** Action code → the keypress record body a module field carries (the
 * keyboard action record: [01][04][usage u16LE][page u16LE] — the shape
 * captured on the wire, §57). null = no proven byte form here. */
function keypressBody(actionCode: string): Uint8Array | null {
  const u = nameToUsage(actionCode);
  if (!u) return null;
  return Uint8Array.from([
    0x01, 0x04,
    u.usage & 0xff, (u.usage >> 8) & 0xff,
    u.page & 0xff, (u.page >> 8) & 0xff,
  ]);
}

function maskOf(code: string): number | null {
  const m = /^M([1-5])$/.exec(code);
  return m ? MOUSE_MASK[m[0] as 'M1' | 'M2' | 'M3' | 'M4' | 'M5'] : null;
}

/** One plain (non-axis) binding → its record bytes at `field`.
 * mouse → mouseMask, key/modifier → keypress, none/empty → empty.
 * null = unsupported here (shortcut_alias, LED): overlay leaves the
 * template's bytes — never invents a field. */
function bindingRecord(field: number, act: { actionType: string; actionCode: string }): Uint8Array | null {
  if (act.actionType === 'none' || act.actionCode === '') {
    return encodeModuleField(field, 'none');
  }
  if (act.actionType === 'mouse') {
    const mask = maskOf(act.actionCode);
    return mask === null ? null : encodeModuleField(field, 'mouseMask', mask);
  }
  if (act.actionType === 'key' || act.actionType === 'modifier') {
    const body = keypressBody(act.actionCode);
    return body === null ? null : encodeModuleField(field, 'keypress', body);
  }
  return null;
}

/** The fields one gesture binding lands on (axis halves / pair halves /
 * single field), or [] when the gesture has no device backing here. */
function bindingFields(type: ModuleType, gesture: string): number[] {
  const half = AXIS_HALVES[type][gesture];
  if (half) return [half.minus, half.plus];
  const pair = PAIRED_GESTURES[type]?.[gesture];
  if (pair) {
    const minus = gestureField(type, pair.minus);
    const plus = gestureField(type, pair.plus);
    return minus !== undefined && plus !== undefined ? [minus, plus] : [];
  }
  const f = gestureField(type, gesture);
  return f === undefined ? [] : [f];
}

/** Named direction → its device record (category, selector), derived from
 * the axis tables so a name means the same motion everywhere ('SCROLL_UP'
 * is (4, -1) in every table that names it). */
const MOTION_DIRECTIONS: Record<string, { category: number; selector: number }> = (() => {
  const out: Record<string, { category: number; selector: number }> = {};
  for (const t of MODULE_TYPES) {
    for (const half of Object.values(AXIS_HALVES[t])) {
      const [minus, plus] = splitPair(half.default);
      const entries: [string | null, number][] = [
        [minus, halfSelector(half, '-')],
        [plus, halfSelector(half, '+')],
      ];
      for (const [name, selector] of entries) {
        if (name === null || name in out) continue; // one name, one motion
        out[name] = { category: half.category, selector };
      }
    }
  }
  return out;
})();

/** Project a profile onto a template under an explicit convention.
 * Shared by overlay() (convention from the profile's own settings) and
 * diffProfile() (convention from the caller). */
function projectProfile(
  template: ConfigRecords,
  profile: ModuleProfile,
  type: ModuleType,
  convention: ScrollConvention,
): ConfigRecords {
  const out = new Map(template);

  // Settings — modeled ids only, converted to wire bytes (identity except
  // the degrees-per-detent conversion). Unknown ids never reach the board.
  for (const [sid, idx] of Object.entries(SETTING_FIELDS[type])) {
    if (!(sid in profile.settings)) continue;
    const wire = settingToWire(sid, profile.settings[sid]);
    if (wire !== null) out.set(idx, encodeModuleField(idx, 'setting', wire));
  }

  // Firmware-locked gestures — ALWAYS written empty (empty IS the default
  // on the wire); a stock profile still carries their bindings, which the
  // loop below must not write over the empties. bindingFields (not
  // gestureField) so the axis-halved cursor pairs land too.
  for (const gesture of Object.keys(profile.bindings)) {
    if (gestureLocked(type, gesture)) {
      for (const f of bindingFields(type, gesture)) {
        out.set(f, encodeModuleField(f, 'none'));
      }
    }
  }

  for (const [gesture, binding] of Object.entries(profile.bindings)) {
    if (gestureLocked(type, gesture)) continue; // written empty above
    const half = AXIS_HALVES[type][gesture];
    if (half) {
      if (binding.split) {
        // Each half independently: keypress/mask at its own field; an
        // undefined half means unbound → written empty.
        for (const sign of ['-', '+'] as const) {
          const field = sign === '-' ? half.minus : half.plus;
          const sub = binding.split[sign];
          const rec = sub
            ? bindingRecord(field, sub)
            : encodeModuleField(field, 'none');
          if (rec !== null) out.set(field, rec);
        }
        continue;
      }
      // Combined pair: both halves stay motion records. Which name sits on
      // which half decides the selector under the convention (cat 4 flips
      // on Windows); fall back to the half's own sign when the code does
      // not name known motions. invert swaps the two selectors.
      const [minusName, plusName] = splitPair(binding.actionCode);
      for (const sign of ['-', '+'] as const) {
        const field = sign === '-' ? half.minus : half.plus;
        const name = sign === '-' ? minusName : plusName;
        const named = name !== null ? MOTION_DIRECTIONS[name] : undefined;
        const sel = named
          ? conventionSign(named.category, named.selector, convention)
          : halfSelector(half, sign);
        out.set(field, encodeModuleField(field, 'twoWord', encodeAxisBinding(half.category, sel, binding.invert ?? 0)));
      }
      continue;
    }
    const pair = PAIRED_GESTURES[type]?.[gesture];
    if (pair) {
      const minusField = gestureField(type, pair.minus);
      const plusField = gestureField(type, pair.plus);
      if (binding.split) {
        // Split halves override the combined code (same rule as the
        // axis branch): each half projects from its own actionCode
        // through the normal binding path; an undefined half means
        // unbound → written empty.
        for (const sign of ['-', '+'] as const) {
          const field = sign === '-' ? minusField : plusField;
          if (field === undefined) continue;
          const sub = binding.split[sign];
          const rec = sub
            ? bindingRecord(field, sub)
            : encodeModuleField(field, 'none');
          if (rec !== null) out.set(field, rec);
        }
        continue;
      }
      // Keypress pair (the dial): the combined code's two values land on
      // the two half fields — minus value on the minus-half field.
      const [minusCode, plusCode] = splitPair(binding.actionCode);
      if (minusField !== undefined && minusCode !== null) {
        const body = keypressBody(minusCode);
        if (body !== null) out.set(minusField, encodeModuleField(minusField, 'keypress', body));
      }
      if (plusField !== undefined && plusCode !== null) {
        const body = keypressBody(plusCode);
        if (body !== null) out.set(plusField, encodeModuleField(plusField, 'keypress', body));
      }
      continue;
    }
    const fields = bindingFields(type, gesture);
    const field = fields.length === 1 ? fields[0] : undefined;
    if (field === undefined) continue;
    const rec = bindingRecord(field, binding);
    if (rec !== null) out.set(field, rec);
  }
  return out;
}

/** overlay(template, profile, type): template-copy + modeled fields only.
 * Unmodeled template records are carried through unchanged; the overlay
 * never invents fields (an unsupported action simply keeps whatever the
 * template holds). The profile's own settings carry the convention
 * (scroll_convention); the template is NOT written with it — it is not a
 * device field. */
export function overlay(
  template: ConfigRecords,
  profile: ModuleProfile,
  type: ModuleType,
): ConfigRecords {
  return projectProfile(template, profile, type, conventionOf(profile.settings));
}

/* --- compare + diff ------------------------------------------------------- */

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hexOf(rec: Uint8Array): string {
  return Array.from(rec, (v) => v.toString(16).padStart(2, '0')).join(' ');
}

/** Byte-compare two module configs ('names are not truth'): same field set,
 * same record bytes. */
export function compareRecords(a: ConfigRecords, b: ConfigRecords): boolean {
  if (a.size !== b.size) return false;
  for (const [field, ra] of a) {
    const rb = b.get(field);
    if (rb === undefined || !bytesEq(ra, rb)) return false;
  }
  return true;
}

/** One differing gesture: which field, what the profile wants on the wire
 * vs what the slot holds (hex; '(absent)' when the field has no record). */
export interface DiffRow {
  gesture: string;
  field: number;
  want: string;
  got: string;
}

/** Gestures where the profile's expected wire bytes differ from `records`,
 * compared under `convention` (cat-4 selectors flip on Windows). Firmware-
 * locked rows NEVER count — empty is their default, drift is undefined
 * there. Bindings with no proven byte form (shortcut_alias, LED) are not
 * judged. */
export function diffProfile(
  profile: ModuleProfile,
  records: ConfigRecords,
  convention: ScrollConvention,
): DiffRow[] {
  const type = profile.type;
  const expected = projectProfile(new Map(), profile, type, convention);
  const rows: DiffRow[] = [];
  for (const [gesture] of Object.entries(profile.bindings)) {
    if (gestureLocked(type, gesture)) continue;
    const fields = bindingFields(type, gesture);
    for (const field of fields) {
      const want = expected.get(field);
      if (want === undefined) break; // unsupported binding — not judged
      const got = records.get(field);
      if (got === undefined || !bytesEq(want, got)) {
        rows.push({
          gesture,
          field,
          want: hexOf(want),
          got: got === undefined ? '(absent)' : hexOf(got),
        });
        break; // one row per gesture, at its first differing field
      }
    }
  }
  return rows;
}

/* --- openflow.module-profile v1 file io ----------------------------------- */
/* Schema: docs/reference/module-profiles/module-profile.schema.json (OF
 * tree). moduleType is REQUIRED and NEVER inferred from the gestures (a
 * Touch and a Tune share gesture names; guessing would quietly misfile).
 * settings travel as strings; invert travels as boolean; split halves nest
 * under '-'/'+'. Gestures the module does not have are ignored (skipped
 * list); a file whose gestures ALL belong to another module type is
 * refused — moduleType is presumed wrong. */

export interface ModuleProfileFile {
  format: 'openflow.module-profile';
  version: 1;
  moduleType: ModuleType;
  id?: string;
  name?: string;
  variant?: string;
  capturedFrom?: string;
  settings?: Record<string, string>;
  bindings?: Record<string, ProfileFileBinding>;
}

export interface ProfileFileAction {
  actionType: string;
  actionCode: string;
}

export interface ProfileFileBinding extends ProfileFileAction {
  invert?: boolean;
  threshold?: number;
  mode?: number;
  split?: { '-': ProfileFileAction | undefined; '+': ProfileFileAction | undefined };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** File settings are strings ('50', 'true', 'windows') — coerce to the
 * app's numbers. null = not representable, dropped. */
function coerceSetting(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'true') return 1;
  if (s === 'false') return 0;
  if (s.startsWith('windows')) return 1; // scroll_convention string form
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? n : null;
}

function parseSplitHalf(v: unknown): SplitHalf | undefined {
  if (!isObj(v)) return undefined;
  if (typeof v.actionType !== 'string' || typeof v.actionCode !== 'string') return undefined;
  return { actionType: v.actionType, actionCode: v.actionCode };
}

function parseBinding(v: unknown): ProfileBinding | null {
  if (!isObj(v)) return null;
  if (typeof v.actionType !== 'string' || typeof v.actionCode !== 'string') return null;
  const out: ProfileBinding = { actionType: v.actionType, actionCode: v.actionCode };
  if (typeof v.invert === 'boolean') out.invert = v.invert ? 1 : 0;
  else if (v.invert === 0 || v.invert === 1) out.invert = v.invert;
  if (typeof v.threshold === 'number') out.threshold = v.threshold;
  if (typeof v.mode === 'number') out.mode = v.mode;
  if (isObj(v.split)) {
    out.split = {
      '-': parseSplitHalf(v.split['-']),
      '+': parseSplitHalf(v.split['+']),
    };
  }
  return out;
}

export type ParsedModuleProfileFile =
  | { profile: ModuleProfile; skipped: string[] }
  | { error: string };

/** Parse an openflow.module-profile v1 document. Never infers moduleType;
 * never throws. Unknown moduleType → error; gestures of other types mixed
 * with usable ones → kept + skipped list; EVERY gesture foreign → error
 * (moduleType is presumed wrong). */
export function parseModuleProfileFile(obj: unknown): ParsedModuleProfileFile {
  if (!isObj(obj)) return { error: 'not an openflow.module-profile file (no JSON object)' };
  if (obj.format !== undefined && obj.format !== 'openflow.module-profile') {
    return { error: `not an openflow.module-profile file (format '${String(obj.format)}')` };
  }
  if (obj.version !== undefined && obj.version !== 1) {
    return { error: `unsupported module-profile version ${String(obj.version)}` };
  }
  const rawType = obj.moduleType;
  const type =
    typeof rawType === 'string' && (MODULE_TYPES as readonly string[]).includes(rawType)
      ? (rawType as ModuleType)
      : null;
  if (type === null) {
    return { error: 'unknown module type — this app reads TOUCH/TRACK/TUNE/FLOAT' };
  }

  const src = isObj(obj.bindings) ? obj.bindings : {};
  const skipped: string[] = [];
  const kept: Record<string, ProfileBinding> = {};
  let foreign = 0;
  for (const [gesture, raw] of Object.entries(src)) {
    const owner = moduleTypeOfGesture(gesture);
    if (owner !== null && owner !== type) foreign++;
    const binding = owner === type ? parseBinding(raw) : null;
    if (binding === null) {
      skipped.push(gesture);
      continue;
    }
    kept[gesture] = binding;
  }
  if (Object.keys(kept).length === 0 && foreign > 0) {
    return {
      error: `refused: every gesture in this file belongs to another type — this is not a ${type} profile`,
    };
  }

  const settings: Record<string, number> = {};
  if (isObj(obj.settings)) {
    for (const [k, v] of Object.entries(obj.settings)) {
      const n = coerceSetting(v);
      if (n !== null) settings[k] = n;
    }
  }

  const id = typeof obj.id === 'string' && obj.id !== '' ? obj.id : undefined;
  const name = typeof obj.name === 'string' && obj.name !== '' ? obj.name : undefined;
  const profile: ModuleProfile = {
    id: id ?? name ?? 'imported',
    name: name ?? id ?? 'Imported profile',
    type,
    settings,
    bindings: kept,
  };
  if (typeof obj.variant === 'string' && obj.variant !== '') profile.variant = obj.variant;
  if (typeof obj.capturedFrom === 'string' && obj.capturedFrom !== '') {
    profile.capturedFrom = obj.capturedFrom;
  }
  return { profile, skipped };
}

function fileAction(a: { actionType: string; actionCode: string }): ProfileFileAction {
  return { actionType: a.actionType, actionCode: a.actionCode };
}

function fileBinding(b: ProfileBinding): ProfileFileBinding {
  const out: ProfileFileBinding = fileAction(b);
  if (b.invert !== undefined) out.invert = b.invert === 1;
  if (b.threshold !== undefined) out.threshold = b.threshold;
  if (b.mode !== undefined) out.mode = b.mode;
  if (b.split) {
    out.split = {
      '-': b.split['-'] ? fileAction(b.split['-']) : undefined,
      '+': b.split['+'] ? fileAction(b.split['+']) : undefined,
    };
  }
  return out;
}

/** Build the interchange document for a profile: direction pairs keep the
 * minus-first 'A - B' combined form, split halves nest under split,
 * settings travel as strings, invert as boolean. */
export function buildModuleProfileFile(profile: ModuleProfile): ModuleProfileFile {
  const settings: Record<string, string> = {};
  for (const [k, v] of Object.entries(profile.settings)) {
    if (k === SCROLL_CONVENTION_ID) {
      settings[k] = v === 1 ? 'windows' : 'mac';
    } else {
      settings[k] = String(v);
    }
  }
  const bindings: Record<string, ProfileFileBinding> = {};
  for (const [gesture, bnd] of Object.entries(profile.bindings)) {
    bindings[gesture] = fileBinding(bnd);
  }
  const out: ModuleProfileFile = {
    format: 'openflow.module-profile',
    version: 1,
    moduleType: profile.type,
    id: profile.id,
    name: profile.name,
    settings,
    bindings,
  };
  if (profile.variant !== undefined) out.variant = profile.variant;
  if (profile.capturedFrom !== undefined) out.capturedFrom = profile.capturedFrom;
  return out;
}
