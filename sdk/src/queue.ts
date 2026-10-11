/* Queue helpers: pure logic that turns a selection + intent into draft ops.
 * No device access, no React, no logging — callers report the counts. */

import { buildRecord } from './actions';
import type { ActionDef } from './actions';
import { behaviorSetOps, fillerRecord, hasT10Shadow, plainRecord, SHADOW_OFF } from './t10';
import type { BehaviorSet } from './t10';
import { gesturePayload } from './modules';
import type { GestureBinding } from './modules';
import type { Draft } from './draft';
import type { SettingsOp } from './draft';
import { toHex } from './naya';
import type { KeyRec, LedRec } from './naya';
import {
  encodeLayerListAdd,
  encodeLayerListDelete,
  storedAnimOf,
  storedAnimName,
} from './layers';
import {
  BAY_INHERIT,
  bayRecord,
  encodeListAdd,
  encodeListDelete,
  encodeModuleConfig,
  fitsChunkBudget,
} from './module-wire';
import type { PlanListEntry } from './module-planner';

export interface SelKey {
  layer: number;
  kk: number;
}

/** Queue the picked action for every selected key. Length-changing writes
 * apply (S1-proven 7B↔27B via 30/1004); picking a non-T10 action on a key
 * that is T10 or still carries a T10 shadow at KK+0x52 downgrades via
 * keyset + filler so the stale shadow can't keep reporting old slots. */
export function queueAction(
  draft: Draft,
  sel: SelKey[],
  action: ActionDef,
  keysByLayer: KeyRec[][],
): { queued: number; skipped: number } {
  let queued = 0;
  let skipped = 0;
  for (const { layer: l, kk } of sel) {
    const rec = buildRecord(kk, action.body());
    const cur = (keysByLayer[l] ?? []).find((r) => r.kk === kk);
    if (!cur) {
      skipped++;
      // Ledger drop (return shape unchanged): the skip is a capability
      // refusal — without a live record the flash can't address the key.
      draft.addDrop({
        layer: l,
        kk,
        reason: 'no live record at this key',
        effect: 'this key keeps whatever the keyboard already had on it',
      });
      continue;
    }
    if (
      rec[1] !== 0x10 &&
      (cur.rec[1] === 0x10 || hasT10Shadow(keysByLayer[l], kk))
    ) {
      draft.add({
        kind: 'keyset',
        layer: l,
        kk,
        records: [rec, fillerRecord(kk + SHADOW_OFF)],
        label: action.label,
      });
    } else {
      draft.add({ kind: 'key', layer: l, kk, record: rec, label: action.label });
    }
    queued++;
  }
  return { queued, skipped };
}

/** Queue a color for every selected key (KK 0x00–0x87 only). */
export function queueColor(
  draft: Draft,
  sel: SelKey[],
  color: { h: number; s: number },
): { queued: number; skipped: number } {
  let queued = 0;
  let skipped = 0;
  for (const { layer: l, kk } of sel) {
    if (kk < 0 || kk > 0x87) {
      skipped++;
      continue;
    }
    draft.add({ kind: 'led', layer: l, kk, h: color.h, s: color.s });
    queued++;
  }
  return { queued, skipped };
}

/** Queue a color for every LED of one layer. Keys + strips only (kk ≤ 87
 * decimal): the device LED map spans 136 blocks, and kk 88-135 are the
 * module bays — no per-layer store, so filling them would queue 48 dead
 * ops. Returns the queued op count. */
export function queueFillLayer(
  draft: Draft,
  layer: number,
  recs: LedRec[],
  color: { h: number; s: number },
): number {
  let n = 0;
  for (const r of recs) {
    if (r.kk < 0 || r.kk > 87) continue;
    draft.add({ kind: 'led', layer, kk: r.kk, h: color.h, s: color.s });
    n++;
  }
  return n;
}

/** Module bay LED block spans (device LED map kk): 24 writable blocks per
 * side — left edge 88..111, right edge 112..135. */
export const BAY_LED_RANGES = {
  left: { first: 88, last: 111 },
  right: { first: 112, last: 135 },
} as const;

/** Queue one color across a module bay side's 24 LED blocks (all blocks
 * get the same h/s). Routed through queueColor's existing kk ≤ 0x87 gate —
 * exactly 24 led ops per call. */
export function queueBayColor(
  draft: Draft,
  layer: number,
  side: 'left' | 'right',
  h: number,
  s: number,
): void {
  const { first, last } = BAY_LED_RANGES[side];
  const sel: SelKey[] = [];
  for (let kk = first; kk <= last; kk++) sel.push({ layer, kk });
  queueColor(draft, sel, { h, s });
}

/** Thin draft.add wrapper for settings ops (symmetry with queue helpers). */
export function queueSetting(draft: Draft, op: SettingsOp): void {
  draft.add(op);
}

/** Queue a full T10/T03 behavior set for one key (device stores truth per
 * set — editing any behavior rewrites all slots). `tappingTerm` rides
 * inside the records (default 200 ms); `flavorByte` (0-3, cross-source
 * measured encoding) is written ONLY when the user explicitly picked a
 * flavor — otherwise preserved from the live record via behaviorMetaOf.
 * A tap-only result downgrades to the plain T01 record (plus shadow
 * cleanup when the old set was a T10). */
export function queueBehaviorSet(
  draft: Draft,
  layer: number,
  kk: number,
  set: BehaviorSet,
  tappingTerm: number,
  label: string,
  prevRecs?: KeyRec[],
  flavorByte?: number,
): { queued: boolean; error?: string } {
  try {
    const op = behaviorSetOps(kk, set, layer, label, prevRecs, {
      termHold: tappingTerm,
      termDouble: tappingTerm,
      ...(flavorByte != null ? { bodyFlags: flavorByte } : {}),
    });
    if (!op) {
      if (set.tap == null) {
        draft.addDrop({
          layer,
          kk,
          reason: 'behavior chain: Tap is required first',
          effect: 'this key keeps whatever the keyboard already had on it',
        });
        return { queued: false, error: 'behavior chain: Tap is required first' };
      }
      if (hasT10Shadow(prevRecs, kk))
        draft.add({
          kind: 'keyset', layer, kk,
          records: [plainRecord(kk, set.tap), fillerRecord(kk + SHADOW_OFF)],
          label,
        });
      else
        draft.add({
          kind: 'key', layer, kk,
          record: plainRecord(kk, set.tap), label,
        });
      return { queued: true };
    }
    draft.add(op);
    return { queued: true };
  } catch (e) {
    draft.addDrop({
      layer,
      kk,
      reason: (e as Error).message,
      effect: 'this key keeps whatever the keyboard already had on it',
    });
    return { queued: false, error: (e as Error).message };
  }
}

/** Queue a module gesture write (30/100c, S2-proven path only).
 * Latest-wins per (layer, slot): stale ops for the same target are dropped
 * so the flash sends one write per gesture. */
export function queueModuleGesture(
  draft: Draft,
  layer: number,
  g: GestureBinding,
  actionBody: number[],
): { queued: boolean; error?: string } {
  try {
    const payload = gesturePayload(g, actionBody);
    draft.ops = draft.ops.filter(
      (o) => !(o.kind === 'module' && o.layer === layer && o.slot === g.slot),
    );
    draft.add({
      kind: 'module',
      layer,
      slot: g.slot,
      payload,
      label: `${g.gesture} → ${toHex(payload)}`,
    });
    return { queued: true };
  } catch (e) {
    draft.addDrop({
      layer,
      reason: (e as Error).message,
      effect: 'the module bay keeps its current gesture',
    });
    return { queued: false, error: (e as Error).message };
  }
}

/** Queue a new layer for the board's layer list (30/1002 add form — the
 * caller diffs against the board table and sends just the new entry).
 * idx must sit inside the app's 8-slot window 0..7 (same window the
 * OpenFlow port enforces); `animName` resolves case-insensitively through
 * storedAnimOf (default 'Solid'). Refused with no op queued on an
 * out-of-window idx or an unknown anim name — never write byte-255 garbage.
 * Draft keys layers ops by payload hex, so adds with different uuids/idx
 * coexist as separate frames in queue order. */
export function queueLayerAdd(
  draft: Draft,
  idx: number,
  uuid: string,
  animName?: string,
): { queued: boolean; error?: string } {
  if (idx < 0 || idx > 7) {
    const error = `layer index ${idx} is outside this app's window (0-7)`;
    draft.addDrop({ layer: idx, reason: error, effect: 'the layer list stays unchanged' });
    return { queued: false, error };
  }
  const animStored = storedAnimOf(animName ?? 'Solid');
  if (animStored < 0) {
    const error = `unknown stored animation: ${animName}`;
    draft.addDrop({ layer: idx, reason: error, effect: 'the layer list stays unchanged' });
    return { queued: false, error };
  }
  draft.add({
    kind: 'layers',
    payload: encodeLayerListAdd([{ idx, uuid, animStored }]),
    label: `add layer ${idx} (${storedAnimName(animStored)})`,
  });
  return { queued: true };
}

/** Queue a layer deletion (30/1002 delete form — the idx set rides TWICE on
 * the wire) plus a full blank of the layer's data so a future re-add can't
 * inherit ghosts (OF F:888-896 semantics):
 *   1. the delete layers op FIRST (queue order = send order),
 *   2. ONE keyset op blanking `totalKeys` record slots with [pos][07][00]
 *      fillers — 74 key positions plus the tail up to the full keymap span
 *      incl. the T10 shadow bank (callers pass 156); fillers are
 *      absent-satisfied in reconcile, so a compacted dump clears them,
 *   3. h0 s0 led ops per known LED kk.
 * `layerCount` is the caller's known layer count — when provided and ≤ 1
 * the delete is refused (the board must keep at least one layer); omitted
 * means the caller checked elsewhere. */
export function queueLayerDelete(
  draft: Draft,
  idx: number,
  keys: KeyRec[],
  leds: LedRec[],
  totalKeys: number,
  layerCount?: number,
): { queued: boolean; error?: string; frames: number } {
  if (layerCount != null && layerCount <= 1) {
    draft.addDrop({
      layer: idx,
      reason: 'cannot delete the only layer',
      effect: 'the layer list stays unchanged',
    });
    return { queued: false, error: 'cannot delete the only layer', frames: 0 };
  }
  draft.add({
    kind: 'layers',
    payload: encodeLayerListDelete([idx]),
    label: `delete layer ${idx}`,
  });
  // Known key kks sit in 0..73; blanking every slot 0..totalKeys-1 covers
  // them plus the shadow-bank tail (keys only anchors the op's display kk —
  // the span does the wiping). Records are counted from the op itself:
  // 1 record = 3 bytes, so count > 150 means payload.length/3 > 150.
  draft.add({
    kind: 'keyset',
    layer: idx,
    kk: keys[0]?.kk ?? 0,
    records: Array.from({ length: totalKeys }, (_, i) => fillerRecord(i)),
    label: `delete layer ${idx}: blank keymap (${totalKeys} slots)`,
  });
  for (const r of leds) draft.add({ kind: 'led', layer: idx, kk: r.kk, h: 0, s: 0 });
  return { queued: true, frames: 1 + totalKeys + leds.length };
}

/** Idxes of layer ADDs already queued in the draft (double-add guard).
 * The board inventory only changes after a flash, so a UI computing the
 * next free idx from the inventory would queue a second add at the SAME
 * idx on a second click — callers refuse when the target idx is already
 * here. Decodes add ops from their payload: an add entry carries the
 * wire signature [idx][idx][anim][0x10][uuid16] after the 00 00 prefix;
 * delete payloads ([idx] 00 00 00 ×2) never match it. */
export function pendingLayerAddIdxs(draft: Draft): number[] {
  const out: number[] = [];
  for (const o of draft.ops) {
    if (o.kind !== 'layers') continue;
    const p = o.payload;
    for (let off = 2; off + 20 <= p.length; off += 20) {
      if (p[off] === p[off + 1] && p[off + 3] === 0x10) out.push(p[off]);
    }
  }
  return out;
}

/* --- module profiles (Phase 5a) --------------------------------------------- */

/** Queue a full module config write (30/100C): payload = slot byte +
 * records joined. Refused with a ledger drop when the payload exceeds the
 * 483-byte two-frame ceiling (a 3rd CDC frame hangs fw 3.28.7) — nothing
 * is queued; the module keeps its stored configuration. */
export function queueModuleConfig(
  draft: Draft,
  slot: number,
  records: Uint8Array[],
  label: string,
): { queued: boolean; error?: string } {
  const payload = encodeModuleConfig(slot, records);
  if (!fitsChunkBudget(payload)) {
    const error = 'module config exceeds the 483-byte two-frame ceiling';
    draft.addDrop({ reason: error, effect: 'the module keeps its stored configuration' });
    return { queued: false, error };
  }
  draft.add({ kind: 'moduleCfg', slot, records, payload, label });
  return { queued: true };
}

/** Queue a module-list add (30/100A) from a planner list entry (the list
 * id mirrors the slot on the wire — encodeListAdd owns the bytes). */
export function queueModuleListAdd(
  draft: Draft,
  entry: PlanListEntry,
  label?: string,
): { queued: boolean } {
  draft.add({
    kind: 'moduleList',
    payload: encodeListAdd(entry.slot, entry.id, entry.flag, entry.uuid16),
    label: label ?? `add module ${entry.slot}`,
  });
  return { queued: true };
}

/** Queue a module-list delete (30/100A delete entry 00 [slot] 00 00 00). */
export function queueModuleListDelete(
  draft: Draft,
  slot: number,
  label?: string,
): { queued: boolean } {
  draft.add({
    kind: 'moduleList',
    payload: encodeListDelete(slot),
    label: label ?? `remove module ${slot}`,
  });
  return { queued: true };
}

/** Queue a module bay assignment: the EXISTING key op kind at KK
 * 0x4A–0x51 carrying a bay record ([pos][value][00], Task-1 bytes). Bay
 * records live in the layer data (30/1004), so they ride the key path —
 * latest-wins per layer+pos comes free from the shared opKey. The value
 * window is 0 | 0x78 (BAY_INHERIT) | 1..7 — anything else would be byte
 * garbage on the wire (the device ignores unknown bay bytes, so a bad
 * write would silently no-op); refused with a ledger drop, nothing
 * queued (queueModuleConfig guard style). */
export function queueBayAssignment(
  draft: Draft,
  layer: number,
  pos: number,
  value: number | 'inherit' | 'disabled',
): { queued: boolean; error?: string } {
  const v = value === 'inherit' ? BAY_INHERIT : value === 'disabled' ? 0x00 : value;
  if (v !== 0x00 && v !== BAY_INHERIT && (v < 1 || v > 7)) {
    const error = `bay value ${v} is outside the writable window (0, 0x78 inherit, 1-7)`;
    draft.addDrop({
      layer,
      kk: pos,
      reason: error,
      effect: 'this bay keeps its current assignment',
    });
    return { queued: false, error };
  }
  const name =
    value === 'inherit' ? 'BASE (inherit)' : value === 'disabled' ? 'disabled' : `slot ${v}`;
  draft.add({
    kind: 'key',
    layer,
    kk: pos,
    record: bayRecord(pos, v),
    label: `bay 0x${pos.toString(16)} → ${name}`,
  });
  return { queued: true };
}
