// OpenFlow layer-list model — board inventory parse + add/delete/restore
// encoders for the layer list wire format (30/1002 family).
// Provenance — owner's measured KB + real captures (fw 3.41.0,
// naya-reflow research/dumps/aux-left*.txt):
//   inventory (30/1001 reply): [status][index echo] | [idx][id][anim][0x10]
//     [uuid16] ×n — TWO leading bytes before the first entry (62 B payload
//     = 2 + 3×20 in the captures; the second byte is NOT a layer count).
//   add     : 00 00 | [idx][idx][anim][0x10][uuid16] ×n   (caller diffs)
//   delete  : 00 00 | [idx] 00 00 00 ×n — whole set sent TWICE
// Every 30/1002 write begins `00 00` — flag byte + index byte 0x00, the
// same [00, index, data] convention as writeKey/writeLed in naya.ts.
// uuids are 32 hex chars, dashes stripped (16 raw bytes on the wire).

export interface LayerEntry {
  idx: number;
  /** 32 hex chars, no dashes */
  uuid: string;
  animStored: number;
}

/** Stored-animation names by wire byte (shared with layer labeling). */
export const STORED_ANIM_NAMES: readonly [string, string, string, string] = [
  'Solid',
  'Breathe',
  'Spectrum',
  'Swirl',
];

/** Case-insensitive name → stored-anim byte. -1 when unknown. */
export function storedAnimOf(name: string): number {
  const lower = name.toLowerCase();
  return STORED_ANIM_NAMES.findIndex((n) => n.toLowerCase() === lower);
}

/** Stored-anim byte → name. Null when out of range. */
export function storedAnimName(byte: number): string | null {
  return byte >= 0 && byte < STORED_ANIM_NAMES.length ? STORED_ANIM_NAMES[byte] : null;
}

const ENTRY_LEN = 20; // [idx][id][anim][0x10][uuid16]

/** Parse the board's layer-list inventory (30/1001 reply payload). The
 * payload opens with TWO leading bytes — status + index echo — before
 * the 20-byte entries (real captures: aux-left*.txt, fw 3.41.0; the
 * second byte is NOT a layer count). Entries whose uuid-length byte ≠
 * 0x10 are skipped; trailing bytes that don't form a full 20-byte block
 * are ignored. */
export function parseInventory(payload: Uint8Array): LayerEntry[] {
  const out: LayerEntry[] = [];
  for (let off = 2; off + ENTRY_LEN <= payload.length; off += ENTRY_LEN) {
    if (payload[off + 3] !== 0x10) continue;
    out.push({
      idx: payload[off],
      uuid: bytesToUuid(payload.subarray(off + 4, off + 4 + 16)),
      animStored: payload[off + 2],
    });
  }
  return out;
}

/** 32-hex uuid → 16 raw bytes. */
export function uuidToBytes(uuid: string): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(uuid.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Raw bytes → hex, no dashes. */
export function bytesToUuid(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** Layer-list add payload: 00 00 (flag byte + index byte 0x00 — every
 * measured 30/1002 write opens with both) + [idx][idx][anim][0x10]
 * [uuid16] per entry. Encodes ONLY the entries passed — the caller
 * diffs against the board table and sends just the new layers. */
export function encodeLayerListAdd(entries: LayerEntry[]): Uint8Array {
  const out = new Uint8Array(2 + entries.length * ENTRY_LEN);
  out[0] = 0x00; // flag byte
  out[1] = 0x00; // index byte 0x00 (writeKey/writeLed convention)
  entries.forEach((e, i) => {
    const off = 2 + i * ENTRY_LEN;
    out[off] = e.idx;
    out[off + 1] = e.idx; // id byte repeats idx on the wire
    out[off + 2] = e.animStored;
    out[off + 3] = 0x10;
    out.set(uuidToBytes(e.uuid), off + 4);
  });
  return out;
}

/** Layer-list delete payload: 00 00 (flag byte + index byte 0x00) +
 * [idx] 00 00 00 per index — the whole set sent TWICE (measured writes
 * repeat the set; the board expects it). */
export function encodeLayerListDelete(idxs: number[]): Uint8Array {
  const out = new Uint8Array(2 + idxs.length * 8);
  out[0] = 0x00;
  out[1] = 0x00;
  for (let rep = 0; rep < 2; rep++) {
    idxs.forEach((idx, i) => {
      out[2 + (rep * idxs.length + i) * 4] = idx;
    });
  }
  return out;
}

/** Restore payload = layer-list add over the FULL table (00 00 prefix +
 * every entry), sorted by idx. */
export function encodeRestorePayload(entries: LayerEntry[]): Uint8Array {
  return encodeLayerListAdd([...entries].sort((a, b) => a.idx - b.idx));
}

/** Fresh uuid: 32 hex chars, dashes stripped. Math.random-hex fallback for
 * runtimes without crypto.randomUUID (keeps the sdk browser/Node neutral). */
export function mintLayerUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replaceAll('-', '');
  }
  let out = '';
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}
