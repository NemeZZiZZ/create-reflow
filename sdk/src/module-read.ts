/* Module read path — the 30/1009 module list + per-slot config records →
 * content matching, capture-on-read, bay repoint (Phase 5a Task 4).
 *
 * The read side answers "what is ACTUALLY on the board, and which profile
 * is it?": the module LIST (30/1009, readModuleList in naya.ts) names each
 * slot's uuid and type byte, and each slot's config (30/100b,
 * readModuleConfig) holds the raw field records. matchSlots() ranks every
 * same-type profile by (differs, tie, name) — THE MATCH IS ON CONTENT,
 * never on uuid (every install writes its own uuids, so once another app
 * flashed the board not one slot uuid is known here). A slot nothing
 * matches is CAPTURED as a new profile seeded from the closest candidate
 * and rebuilt from the device bytes, so it inherits no drift rows.
 *
 * Port knowledge from OpenFlow (Apache-2.0 — knowledge, not code):
 * db/module_profiles.py capture_from_device / repoint_bays and
 * api/rest.py _module_diff (ranking, matched-by-content, templateId).
 *
 * Record-shape mapping: a slot's 30/100b blob is a stream of universal
 * records [field][type][len][body]. modules.ts reads the very same bytes
 * as [SLOT, FAMILY, LEN, payload] — its "slot" byte IS the field index
 * (FIELD_MAP 0x00..0x27; modules.ts's GESTURE_NAMES are the HOST side of
 * the same indices). recordsFromModuleBlob() keys those records into a
 * ConfigRecords map verbatim — the shape overlay()/diffProfile() judge —
 * treating records as immutable raw bytes, exactly like modules.ts does.
 *
 * The capture rebuild rule (what makes "no inherited drift rows" true):
 * every gesture whose seed bytes diverge from the device is rebuilt from
 * the device bytes, and every byte form our own encoders produce decodes
 * back (none / keypress with a known usage / mouse mask M1-M5 / axis
 * selector swap → invert / per-half split). A divergent row we cannot
 * express (an unknown usage, an unusual selector) keeps the seed's
 * binding and stays VISIBLE as drift — diffProfile remains byte truth.
 * shortcut_alias and LED rows have no device fields, so nothing there is
 * ever judged or lost. */

import type { ConfigRecords, ModuleProfile, ProfileBinding } from './module-profiles';
import { diffProfile, overlay } from './module-profiles';
import {
  AXIS_HALVES,
  FIELD_MAP,
  PAIRED_GESTURES,
  SETTING_FIELDS,
  conventionOf,
  gestureField,
  gestureLocked,
  ticksFromWire,
  type ModuleType,
} from './module-fields';
import { MODULE_TYPE_CODE, MOUSE_MASK } from './module-wire';
import { bytesToUuid, mintLayerUuid } from './layers';
import { usageToName } from './host-table';

/* --- 30/1009 module list --------------------------------------------------- */

/** One module-list entry (30/1009 read): the two-byte [status][index echo]
 * header stripped, one 20-byte entry [slot][id][flag][0x10][uuid16] each —
 * the read form of encodeListAdd's write payload (minus its 00 flag byte,
 * the layer-list shape). */
export interface ModuleListEntry {
  slot: number;
  /** The id byte — mirrors the slot on the wire (encodeListAdd). */
  id: number;
  /** The raw type flag byte (MODULE_TYPE_CODE on a known board). */
  typeFlag: number;
  /** 32-hex uuid, plain-hex order (bytesToUuid, like the layer list). */
  uuid: string;
  /** MODULE_TYPE_CODE reversed. An unknown flag falls back to FLOAT with
   * the raw byte kept in typeFlag — nothing is silently re-typed. */
  type: ModuleType;
}

const LIST_ENTRY_LEN = 20; // [slot][id][flag][0x10][uuid16]

/** MODULE_TYPE_CODE reversed: flag byte → type. */
const TYPE_OF_FLAG: Record<number, ModuleType> = Object.fromEntries(
  (Object.entries(MODULE_TYPE_CODE) as [ModuleType, number][]).map(([t, f]) => [f, t]),
);

/** Parse the board's module-list inventory (30/1009 reply payload). Skips
 * the leading [status][index echo] header exactly like parseInventory does
 * for 30/1001; entries whose uuid-length byte ≠ 0x10 are skipped; a
 * trailing fragment that cannot form a full 20-byte block is ignored. */
export function parseModuleList(payload: Uint8Array): ModuleListEntry[] {
  const out: ModuleListEntry[] = [];
  for (let off = 2; off + LIST_ENTRY_LEN <= payload.length; off += LIST_ENTRY_LEN) {
    if (payload[off + 3] !== 0x10) continue;
    const typeFlag = payload[off + 2];
    out.push({
      slot: payload[off],
      id: payload[off + 1],
      typeFlag,
      uuid: bytesToUuid(payload.subarray(off + 4, off + 4 + 16)),
      type: TYPE_OF_FLAG[typeFlag] ?? 'FLOAT',
    });
  }
  return out;
}

/* --- slot config records ---------------------------------------------------- */

/** A slot's 30/100b config blob → ConfigRecords. Same record walk as
 * parseModuleConfig (modules.ts) — universal records, the record's SLOT
 * byte being the field index — but keyed instead of listed, which is the
 * shape overlay/diffProfile judge. A truncated header or payload stops the
 * walk (tolerant tail); everything before it is kept. */
export function recordsFromModuleBlob(blob: Uint8Array): ConfigRecords {
  const out: ConfigRecords = new Map();
  let i = 0;
  while (i + 3 <= blob.length) {
    const total = blob[i + 2] + 3;
    if (i + total > blob.length) break; // truncated payload — tolerant tail
    out.set(blob[i], blob.slice(i, i + total));
    i += total;
  }
  return out;
}

/* --- content match ----------------------------------------------------------- */

/** One ranked candidate: how much drift it sees in the slot under its OWN
 * scroll convention, and how it ties to the slot's uuid. */
export interface RankedProfile {
  profile: ModuleProfile;
  /** diffProfile row count under the candidate's own convention. */
  differs: number;
  /** 0 — the profile's id IS the slot's uuid · 1 — captured from it ·
   * 2 — everything else. */
  tie: 0 | 1 | 2;
}

/** One slot's verdict: every same-type candidate ranked, the content
 * match (if any), and the closest candidate (what a capture seeds from). */
export interface SlotMatch {
  slot: number;
  uuid: string;
  typeFlag: number;
  type: ModuleType;
  /** All same-type candidates, best (differs, tie, name) first. */
  ranked: RankedProfile[];
  /** The content match: the top candidate when it sees no drift. The uuid
   * never decides content — it only orders equals (a drifted original may
   * keep naming its own entry; a foreign uuid still matches by bytes). */
  matched: ModuleProfile | null;
  /** The top-ranked candidate — what captureFromSlots would seed from. */
  closest: ModuleProfile | null;
  /** The closest candidate's drift count (0 = matched). */
  differs: number;
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rank every same-type profile for one slot: (differs, tie, name) — and
 * id after name, so even two identically named profiles order totally.
 * Each candidate compares under its OWN scroll convention (a Windows
 * profile names the board's cat-4 records the way Windows scrolls). */
function rankSlot(
  entry: ModuleListEntry,
  records: ConfigRecords,
  profiles: readonly ModuleProfile[],
): RankedProfile[] {
  const ranked: RankedProfile[] = profiles
    .filter((p) => p.type === entry.type)
    .map((p) => ({
      profile: p,
      differs: diffProfile(p, records, conventionOf(p.settings)).length,
      tie: (p.id === entry.uuid ? 0 : p.capturedFrom === entry.uuid ? 1 : 2) as 0 | 1 | 2,
    }));
  ranked.sort(
    (a, b) =>
      a.differs - b.differs ||
      a.tie - b.tie ||
      byName(a.profile.name, b.profile.name) ||
      byName(a.profile.id, b.profile.id),
  );
  return ranked;
}

/** Match the board's module list against the app's profiles, by content.
 * Slot 0 is the blank template and is never matched. Slots whose config
 * was not read compare against an empty map (every judgeable row drifts). */
export function matchSlots(
  entries: ModuleListEntry[],
  slotRecords: Record<number, ConfigRecords>,
  profiles: readonly ModuleProfile[],
): SlotMatch[] {
  const out: SlotMatch[] = [];
  for (const entry of entries) {
    if (entry.slot === 0) continue; // the blank template, never matched
    const records = slotRecords[entry.slot] ?? new Map();
    const ranked = rankSlot(entry, records, profiles);
    const top = ranked[0] ?? null;
    out.push({
      slot: entry.slot,
      uuid: entry.uuid,
      typeFlag: entry.typeFlag,
      type: entry.type,
      ranked,
      matched: top !== null && top.differs === 0 ? top.profile : null,
      closest: top?.profile ?? null,
      differs: top?.differs ?? 0,
    });
  }
  return out;
}

/* --- capture-on-read ----------------------------------------------------------- */

/** One captured profile and the slot it came from. */
export interface CapturedModule {
  profile: ModuleProfile;
  slot: number;
}

/** A capture's own suffix, " (on board)" or " (on board) 3", stripped
 * before naming a copy of it — a capture of a capture counts on from the
 * original ("X (on board) 2"), never "X (on board) (on board)". */
const ON_BOARD = /(?: \(on board\)(?: \d+)?)+$/;

/** "<closest name> (on board)", numbered " 2", " 3", ... on collision —
 * counted from the stripped base. A name collides when it equals the base
 * or extends it with ' <anything>' (so "X (on board) 5" forces numbering
 * even though the bare base is free). */
function captureName(closestName: string, taken: ReadonlySet<string>): string {
  const base = `${closestName.replace(ON_BOARD, '')} (on board)`;
  const collides = [...taken].some((n) => n === base || n.startsWith(`${base} `));
  if (!collides) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

function u16le(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}
function u32le(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}
function i32le(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24);
}

/** mask byte → 'M1'..'M5' (reverse of MOUSE_MASK). */
const MASK_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(MOUSE_MASK).map(([name, mask]) => [mask, name]),
);

/** Decode one device record into a plain (single-field) binding; null when
 * the bytes carry something our bindings cannot express. Absent → null too
 * (a binding cannot write "field absent" — 'none' writes an empty record). */
function decodePlain(record: Uint8Array | undefined): ProfileBinding | null {
  if (record === undefined) return null;
  if (record[1] === 0x07) return { actionType: 'none', actionCode: '' };
  if (record[1] === 0x04 && record[2] === 6) {
    // keypress body [01][04][usage u16LE][page u16LE] → its action name.
    const name = usageToName(u16le(record, 7), u16le(record, 5));
    return name ? { actionType: 'key', actionCode: name } : null;
  }
  if (record[1] === 0x0f && record[2] === 8 && u32le(record, 3) === 3) {
    // mouse-mask record [03 u32LE][mask i32LE] → its M-code.
    const name = MASK_NAME[i32le(record, 7)];
    return name ? { actionType: 'mouse', actionCode: name } : null;
  }
  return null;
}

/** One axis/dial half → its split binding: undefined (the field is empty —
 * a split's unbound half writes exactly that) | a decoded action | null
 * (absent or undecodable — give up on the whole pair). */
function decodeHalf(record: Uint8Array | undefined): ProfileBinding | undefined | null {
  if (record === undefined) return null;
  if (record[1] === 0x07) return undefined;
  const plain = decodePlain(record);
  return plain && plain.actionType !== 'none' ? plain : null;
}

function recEq(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Byte-compare ignoring the leading field byte — for swap detection,
 * where a value moved BETWEEN the two half fields. */
function bodyEq(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 1; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The device fields one gesture lands on — the bindingFields rule of
 * module-profiles.ts, derived here from the exported tables. */
function fieldsOf(type: ModuleType, gesture: string): number[] {
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

/** Every gesture of a type with device-backed fields: the axis halves, the
 * paired gestures (the combined row owns its halves), and every named
 * gesture in the field map. */
function gesturesOfType(type: ModuleType): string[] {
  const out = new Set<string>();
  for (const half of Object.keys(AXIS_HALVES[type])) out.add(half);
  const halfNames = new Set<string>();
  for (const pair of Object.values(PAIRED_GESTURES[type] ?? {})) {
    halfNames.add(pair.minus);
    halfNames.add(pair.plus);
  }
  for (const paired of Object.keys(PAIRED_GESTURES[type] ?? {})) out.add(paired);
  for (const spec of Object.values(FIELD_MAP[type])) {
    if (spec.gesture && !halfNames.has(spec.gesture)) out.add(spec.gesture);
  }
  return [...out];
}

function cloneBindings(src: ModuleProfile['bindings']): ModuleProfile['bindings'] {
  const out: ModuleProfile['bindings'] = {};
  for (const [g, b] of Object.entries(src)) {
    out[g] = { ...b };
    if (b.split) {
      out[g].split = {
        '-': b.split['-'] ? { ...b.split['-'] } : undefined,
        '+': b.split['+'] ? { ...b.split['+'] } : undefined,
      };
    }
  }
  return out;
}

/** Device bytes → a binding for one divergent gesture, or null when we
 * cannot express them (the seed's row stays — drift remains visible).
 *  - axis: a global selector swap → invert on the seed's combined row;
 *    otherwise a per-half split when every half decodes (a split writes
 *    exactly what its halves say, byte for byte);
 *  - the dial (paired keypresses): a per-half split likewise, with the
 *    combined code rebuilt from the decoded halves ('A - B', minus first).
 *  - single field: the record decoded outright. */
function rebuildBinding(
  type: ModuleType,
  gesture: string,
  seedB: ProfileBinding | undefined,
  expected: ConfigRecords,
  records: ConfigRecords,
): ProfileBinding | null {
  const half = AXIS_HALVES[type][gesture];
  if (half) {
    const devM = records.get(half.minus);
    const devP = records.get(half.plus);
    // Swap → invert (invert is a SELECTOR SWAP — no flag on the device).
    // bodyEq: the value moved BETWEEN the half fields, so the leading
    // field byte is excluded.
    if (
      seedB !== undefined && seedB.split === undefined &&
      bodyEq(devM, expected.get(half.plus)) && bodyEq(devP, expected.get(half.minus))
    ) {
      return { ...seedB, invert: 1 };
    }
    const dm = decodeHalf(devM);
    const dp = decodeHalf(devP);
    if (dm === null || dp === null) return null;
    const base = seedB ?? { actionType: 'value' as const, actionCode: half.default };
    return { actionType: base.actionType, actionCode: base.actionCode, split: { '-': dm, '+': dp } };
  }
  const pair = PAIRED_GESTURES[type]?.[gesture];
  if (pair) {
    const minusField = gestureField(type, pair.minus);
    const plusField = gestureField(type, pair.plus);
    if (minusField === undefined || plusField === undefined) return null;
    const dm = decodeHalf(records.get(minusField));
    const dp = decodeHalf(records.get(plusField));
    if (dm === null || dp === null) return null;
    // The combined code REBUILDS from the halves ('A - B', minus first) —
    // the seed row is the drifted one here, and keeping its code would
    // resurface it on an unsplit. actionType stays the seed's (a keypress
    // pair carries no action-type notion on the device).
    const code = [dm?.actionCode, dp?.actionCode].filter(Boolean).join(' - ');
    return {
      actionType: seedB?.actionType ?? 'key',
      actionCode: code,
      split: { '-': dm, '+': dp },
    };
  }
  return decodePlain(records.get(fieldsOf(type, gesture)[0]));
}

/** What a capture of `entry` looks like: a NEW profile seeded from the
 * closest candidate (settings + bindings carry what the device bytes
 * cannot express) with the device's own truth overlaid — settings adopted
 * from the slot's type-0x01 records, divergent gesture rows rebuilt from
 * the device — so the capture inherits none of the seed's drift rows. */
function buildCapture(
  entry: ModuleListEntry,
  records: ConfigRecords,
  seed: ModuleProfile | null,
  taken: ReadonlySet<string>,
): ModuleProfile {
  const type = entry.type;
  const profile: ModuleProfile = {
    id: mintLayerUuid(),
    name: captureName(seed ? seed.name : `${type} module`, taken),
    type,
    settings: { ...seed?.settings },
    bindings: seed ? cloneBindings(seed.bindings) : {},
    capturedFrom: entry.uuid,
  };
  if (seed?.variant !== undefined) profile.variant = seed.variant;

  // Settings: adopt every modeled setting the slot actually stores
  // (type-0x01 records) — identity except degrees-per-detent, which
  // converts back through ticksFromWire (SCRUM-50). scroll_convention is
  // never a device field: the capture keeps the closest profile's.
  for (const [sid, idx] of Object.entries(SETTING_FIELDS[type])) {
    const rec = records.get(idx);
    if (rec === undefined || rec[1] !== 0x01 || rec[2] < 1) continue;
    const wire = rec[3];
    if (sid === 'ticks_per_rotation') {
      const detents = ticksFromWire(wire);
      if (detents !== null) profile.settings[sid] = detents;
      continue;
    }
    profile.settings[sid] = wire;
  }

  // Bindings: the seed's expected bytes (its own projection) against the
  // device, per gesture — agreeing rows keep the seed binding, divergent
  // rows rebuild from the device (or honestly stay, undecodable).
  const expected = overlay(new Map(), profile, type);
  for (const gesture of gesturesOfType(type)) {
    if (gestureLocked(type, gesture)) continue; // firmware-driven: never judged
    const fields = fieldsOf(type, gesture);
    if (fields.length === 0) continue; // no device backing — the seed row stands
    const seedB = profile.bindings[gesture];
    const drifted = !fields.every((f) => recEq(expected.get(f), records.get(f)));
    if (!drifted) continue;
    const rebuilt = rebuildBinding(type, gesture, seedB, expected, records);
    if (rebuilt !== null) profile.bindings[gesture] = rebuilt;
  }
  return profile;
}

/** Capture every slot that differs and matches nothing (OpenFlow
 * capture_from_device semantics): a NEW uuid (mintLayerUuid), name
 * "<closest name> (on board)" numbered on collision, capturedFrom = the
 * slot's device uuid, seeded from the closest ranked candidate + the
 * device's overrides. Slot 0 (the blank template) is never captured; a
 * slot whose top candidate sees no drift is already represented and is
 * left alone. The input profiles list is not modified. */
export function captureFromSlots(
  entries: ModuleListEntry[],
  slotRecords: Record<number, ConfigRecords>,
  profiles: readonly ModuleProfile[],
): CapturedModule[] {
  const made: CapturedModule[] = [];
  const taken = new Set(profiles.map((p) => p.name));
  for (const entry of entries) {
    if (entry.slot === 0) continue; // the blank template is never captured
    const records = slotRecords[entry.slot] ?? new Map();
    const top = rankSlot(entry, records, profiles)[0];
    if (top !== undefined && top.differs === 0) continue; // content-matched
    const profile = buildCapture(entry, records, top?.profile ?? null, taken);
    taken.add(profile.name); // numbering continues across the batch
    made.push({ profile, slot: entry.slot });
  }
  return made;
}

/* --- bay repoint ---------------------------------------------------------------- */

/** Layer bay assignments keyed layer → bay position → referenced profile
 * id — the read-side view the planner's bay references come from. */
export type BayAssignments = Record<number, Record<number, string>>;

export interface RepointedBays {
  /** The updated map — a new object; the input is never mutated. */
  bays: BayAssignments;
  /** How many assignments moved. */
  moved: number;
}

/** Repoint every bay running `fromId` onto `toId` — ONE profile's scope,
 * and that matters: only the profile a read proved is no longer live
 * follows the board. Another profile's bay choices are a deliberate pick
 * of what to flash NEXT; rewriting those on every read would throw the
 * user's selections away (OpenFlow repoint_bays scoping). */
export function repointBays(bays: BayAssignments, fromId: string, toId: string): RepointedBays {
  const out: BayAssignments = {};
  let moved = 0;
  const live = fromId !== '' && toId !== '' && fromId !== toId;
  for (const [layerKey, layer] of Object.entries(bays)) {
    const next = { ...layer };
    for (const [posKey, id] of Object.entries(next)) {
      if (live && id === fromId) {
        next[Number(posKey)] = toId;
        moved++;
      }
    }
    out[Number(layerKey)] = next;
  }
  return { bays: out, moved };
}
