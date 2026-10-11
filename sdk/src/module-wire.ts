/* Module wire encoders — write-side bytes for module profiles
 * (OpenFlow v0.7.0 measured sources: remap.py:395-537, module_layout.py:45-46).
 *
 * MODULE_ADDR — THE addressing seam. Every module param payload below opens
 * with [0x00, slot] (our live-proven writeKey/writeLed/30-100A convention:
 * flag byte, then the slot index). OpenFlow instead emits a single [slot]
 * byte with no 0x00 prefix — the layer-vs-slot ambiguity is an open
 * hardware question; the Phase-10 live probe settles it. Until then
 * NOTHING outside moduleAddr() may hand-build these two bytes.
 *
 * Conventions (config field record = [field][type][len][value x len]):
 *   none      type 0x07, empty (OF write convention; read-back captures
 *             also show a 0x00/len-0 variant — the parser accepts both)
 *   setting   type 0x01, one-byte value
 *   keypress  type 0x04, body = action record body [01, 04, usage, 00,
 *             pageLE16] (sdk/src/actions.ts hid family) — taken as bytes,
 *             never re-derived here
 *   twoWord   type 0x0f, 8B = [category u32LE][selector i32LE signed]
 *   mouseMask type 0x0f, 8B = [03 u32LE][mask i32LE]; MOUSE_MASK M5=16
 *             proved live
 *   module-list entry (30/100A add) = 00 [slot][listId][flag][0x10][uuid16]
 *             — listId mirrors slot, flag = MODULE_TYPE_CODE, uuid16 = the
 *             uuid's 16 raw bytes in plain hex order (uuidToBytes, NOT
 *             LE-swapped — same convention as the layer list; captured:
 *             00 05 05 01 10 <uuid16> for slot 5 Track)
 *   delete    = 00 [slot] 00 00 00 (captured: 00 05 00 00 00)
 *   blank config (30/100C) = [slot] + 40 records [f, 00, 00] = 121 bytes
 *             total (NayaFlow removal idiom — a short write leaves the
 *             previous module's tail on the device)
 *   bay record (30/1004 layer-data record form) = [pos][value][00] where
 *             value = slot 1..7 | BAY_INHERIT 0x78 (resolves to the BASE
 *             layer — proved) | 0x00 disabled; captured: 4c 05 00.
 * Chunk budget: module writes cap at 483 payload bytes (2 CDC frames x
 * 242 - 1; a 3rd frame hangs fw 3.28.7). */

import { uuidToBytes } from './layers';

/** The addressing seam: single source of the layer-vs-slot prefix bytes. */
export const MODULE_ADDR = { prefix: [0x00] as const };

/** Module addressing prefix: [0x00, slot] — see MODULE_ADDR header note. */
export function moduleAddr(index: number): number[] {
  return [...MODULE_ADDR.prefix, index & 0xff];
}

/** Module type flag for 30/100A list entries. */
export const MODULE_TYPE_CODE = { TOUCH: 0, TRACK: 1, TUNE: 2, FLOAT: 3 } as const;
export type ModuleTypeCode = (typeof MODULE_TYPE_CODE)[keyof typeof MODULE_TYPE_CODE];

/** [field][type][len][body] record builder. */
function fieldRecord(field: number, type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(3 + body.length);
  out[0] = field;
  out[1] = type;
  out[2] = body.length;
  out.set(body, 3);
  return out;
}

export type ModuleFieldKind = 'none' | 'setting' | 'keypress' | 'twoWord' | 'mouseMask';

/** Config field record: [field][type][len][value]. `keypress` takes the
 * action record body bytes verbatim (actions.ts hid family). */
export function encodeModuleField(
  field: number,
  kind: ModuleFieldKind,
  value?: number | Uint8Array,
): Uint8Array {
  const f = field & 0xff;
  switch (kind) {
    case 'none':
      return fieldRecord(f, 0x07, new Uint8Array(0));
    case 'setting':
      return fieldRecord(f, 0x01, Uint8Array.from([Number(value) & 0xff]));
    case 'keypress':
      return fieldRecord(f, 0x04, value instanceof Uint8Array ? value : new Uint8Array(0));
    case 'twoWord':
      return fieldRecord(f, 0x0f, value instanceof Uint8Array ? value : new Uint8Array(0));
    case 'mouseMask': {
      const mask = Number(value);
      return fieldRecord(f, 0x0f, Uint8Array.from([
        0x03, 0x00, 0x00, 0x00, // category 3 u32LE
        mask & 0xff, (mask >> 8) & 0xff, (mask >> 16) & 0xff, (mask >> 24) & 0xff,
      ]));
    }
  }
}

/** twoWord record: type 0x0f, [category u32LE][selector i32LE signed]. */
export function encodeTwoWord(field: number, category: number, selector: number): Uint8Array {
  return encodeModuleField(field, 'twoWord', Uint8Array.from([
    category & 0xff, (category >> 8) & 0xff, (category >> 16) & 0xff, (category >> 24) & 0xff,
    selector & 0xff, (selector >> 8) & 0xff, (selector >> 16) & 0xff, (selector >> 24) & 0xff,
  ]));
}

/** Mouse-button bitmask value for the mouseMask record family. */
export const MOUSE_MASK: Record<'M1' | 'M2' | 'M3' | 'M4' | 'M5', number> = {
  M1: 1, M2: 2, M3: 4, M4: 8, M5: 16, // M5=16 proved live
};

/** mouseMask record: type 0x0f, [03 u32LE][mask i32LE]. */
export function encodeMouseMask(field: number, mask: number): Uint8Array {
  return encodeModuleField(field, 'mouseMask', mask);
}

/** 30/100A add entry: 00 [slot][listId][flag][0x10][uuid16]. */
export function encodeListAdd(
  slot: number,
  listId: number,
  typeFlag: ModuleTypeCode,
  uuid: string,
): Uint8Array {
  const out = new Uint8Array(5 + 16);
  out.set(moduleAddr(slot), 0); // seam: 00 [slot]
  out[2] = listId & 0xff; // list id mirrors slot on the wire
  out[3] = typeFlag;
  out[4] = 0x10; // uuid byte-length marker (16, layer-list convention)
  out.set(uuidToBytes(uuid), 5);
  return out;
}

/** 30/100A delete entry: 00 [slot] 00 00 00. */
export function encodeListDelete(slot: number): Uint8Array {
  return Uint8Array.from([...moduleAddr(slot), 0x00, 0x00, 0x00]);
}

/** Full module config payload (30/100C): [slot] + records joined flat.
 * 100C opens with the bare slot byte (NO 0x00 prefix — the one verb that
 * breaks the MODULE_ADDR pattern; see header note). All 100C senders build
 * their payload through here so the addressing knowledge stays in this
 * file. */
export function encodeModuleConfig(slot: number, records: Uint8Array[]): Uint8Array {
  return Uint8Array.from([slot & 0xff, ...records.flatMap((r) => [...r])]);
}

/** Full blank module config (30/100C): encodeModuleConfig over 40 empty
 * records [f, 00, 00] = 121 bytes. The short write leaves the previous
 * module's tail — the NayaFlow removal idiom. */
export function encodeBlankConfig(slot: number): Uint8Array {
  const records = Array.from({ length: 40 }, (_, f) => Uint8Array.from([f, 0, 0]));
  return encodeModuleConfig(slot, records);
}

/** Module bay positions in the layer data (30/1004 record form). */
export const BAY_POSITIONS = {
  TOUCH: [0x4a, 0x4b],
  TRACK: [0x4c, 0x4d],
  TUNE: [0x4e, 0x4f],
  FLOAT: [0x50, 0x51],
} as const;

/** Bay value meaning "inherit" — resolves to the BASE layer (proved). */
export const BAY_INHERIT = 0x78;

/** Bay record: [pos][value][00], value = slot 1..7 | BAY_INHERIT | 0x00. */
export function bayRecord(pos: number, value: number): Uint8Array {
  return Uint8Array.from([pos & 0xff, value & 0xff, 0x00]);
}

/** Max module-write payload: 2 CDC frames x 242 - 1 (a 3rd frame hangs
 * fw 3.28.7). */
export const CHUNK_PAYLOAD_CAP = 483;

/** True when a module-write payload fits the chunk budget. */
export function fitsChunkBudget(payload: Uint8Array): boolean {
  return payload.length <= CHUNK_PAYLOAD_CAP;
}

/** CDC frames a payload needs under the 242-byte chunking (1 byte per
 * frame goes to framing, hence the +1). */
export function chunkBudget(payload: Uint8Array): number {
  return Math.ceil((payload.length + 1) / 242);
}
