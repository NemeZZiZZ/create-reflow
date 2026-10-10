/* Import: parse a file back into draft ops (restore-from-file).
 * Pure — no device access, no React — fully smoke-testable. OpenFlow-only
 * (clean break, 2026-10): the only importable file is a kind:"layer"
 * OpenFlow doc; every legacy snapshot format (naya-backup toolkit dumps,
 * naya-reflow keymap/ledmap exports, naya-full-backup containers) is
 * rejected up front with an actionable error. Caller diffs the maps
 * against the live caches and flashes via the normal queue. */

import { describeRecord } from './naya';
import { fillerRecord, hasT10Shadow, SHADOW_OFF } from './t10';
import type { Draft } from './draft';
import type { KeyRec, LedRec } from './naya';
import { parseOpenFlowLayer } from './openflow';
import type { ParseFileResult } from './openflow';

export interface SnapMaps {
  keys: KeyRec[][];
  leds: LedRec[][];
  /** layers present in the file (subset restores only touch these) */
  layers: number[];
  /** per-key free-text notes (schema v2+), key "L:kk" — never flashed,
   * carried through exports/backups only */
  notes?: Record<string, string>;
}

export function hexToBytes(hex: string): Uint8Array | null {
  // Our own exports store spaced hex ('toHex' joins with spaces); strip all
  // whitespace first — parseInt silently tolerates stray spaces and turns
  // them into garbage bytes instead of failing.
  const h = hex.replace(/\s+/g, '');
  if (typeof hex !== 'string' || h.length === 0 || h.length % 2 !== 0) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) return null;
    out[i] = b;
  }
  return out;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Parse an unknown JSON value into per-layer key/LED maps + per-layer
 * animation indices, or an error. Peek guards run BEFORE the deep parse
 * (UHK pattern), most actionable first:
 * 1. a future OpenFlow file version → tell the user to update the app;
 * 2. legacy snapshot markers → clean-break error naming the re-export path;
 * 3. any kind other than "layer" → unsupported.
 * A doc passing all three is delegated to parseOpenFlowLayer; its single
 * anim index is re-keyed by the doc's layer for the whole-file shape. */
export function parseSnapshotFile(obj: unknown): ParseFileResult {
  if (!isObj(obj)) return { error: 'not a JSON object' };
  if (typeof obj.version === 'number' && obj.version > 1)
    return {
      error: `OpenFlow file version ${obj.version} is newer than this app supports (version 1) — update create-reflow`,
    };
  if (obj.tool === 'naya-backup' || obj.tool === 'naya-reflow' || obj.kind === 'naya-full-backup')
    return {
      error:
        'legacy snapshot format removed (clean break, 2026-10) — re-export the layer as an OpenFlow .openflow-layer.json file or restore an auto-backup',
    };
  if (obj.kind !== 'layer')
    return { error: 'unsupported kind — this app reads kind:"layer" files only' };
  const r = parseOpenFlowLayer(obj);
  if ('error' in r) return r;
  return {
    maps: r.maps,
    anims: r.anim === null ? {} : { [r.maps.layers[0]]: r.anim },
    warnings: r.warnings,
  };
}

export interface DiffResult {
  keysQueued: number;
  ledsQueued: number;
  /** snapshot entries with no live counterpart */
  skippedMissing: number;
}

/** Diff snapshot maps against the live caches; differing entries become
 * draft ops (latest-op-wins dedups against already-queued edits). Length
 * changes queue too (S1-proven); a live T10 shadow downgrades via filler. */
export function diffSnapshotToDraft(
  draft: Draft,
  snap: SnapMaps,
  liveKeys: KeyRec[][],
  liveLeds: LedRec[][],
): DiffResult {
  const r: DiffResult = { keysQueued: 0, ledsQueued: 0, skippedMissing: 0 };
  for (const L of snap.layers) {
    const liveK = new Map((liveKeys[L] ?? []).map((x) => [x.kk, x]));
    for (const s of snap.keys[L] ?? []) {
      const cur = liveK.get(s.kk);
      if (!cur) {
        r.skippedMissing++;
        continue;
      }
      let same = cur.rec.length === s.rec.length;
      if (same)
        for (let i = 0; i < s.rec.length; i++)
          if (cur.rec[i] !== s.rec[i]) {
            same = false;
            break;
          }
      if (!same) {
        const liveT10 =
          (cur.rec[1] === 0x10 || hasT10Shadow(liveKeys[L], s.kk)) &&
          s.rec[1] !== 0x10;
        if (liveT10) {
          draft.add({
            kind: 'keyset',
            layer: L,
            kk: s.kk,
            records: [s.rec, fillerRecord(s.kk + SHADOW_OFF)],
            label: describeRecord(s.rec),
          });
        } else {
          draft.add({
            kind: 'key',
            layer: L,
            kk: s.kk,
            record: s.rec,
            label: describeRecord(s.rec),
          });
        }
        r.keysQueued++;
      }
    }
    const liveL = new Map((liveLeds[L] ?? []).map((x) => [x.kk, x]));
    for (const s of snap.leds[L] ?? []) {
      const cur = liveL.get(s.kk);
      if (!cur) {
        r.skippedMissing++;
        continue;
      }
      if (cur.h !== s.h || cur.s !== s.s) {
        draft.add({ kind: 'led', layer: L, kk: s.kk, h: s.h, s: s.s });
        r.ledsQueued++;
      }
    }
  }
  return r;
}
