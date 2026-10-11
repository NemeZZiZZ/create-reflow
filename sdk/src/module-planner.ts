/* Module planner — slot lifecycle for the module-profile system (Phase 5a).
 *
 * Pure planning over three inputs: the profiles to place (id + type +
 * optional capturedFrom), the device's current module list (slot + uuid +
 * type as read from 30/100A), and the profile ids any layer bay still
 * references. Output: per-profile slot assignments + the 30/100A list
 * entry to write, which slots were reclaimed to make room, and where each
 * profile's template records come from. No device access, no React.
 *
 * Model facts:
 *   - profile.id IS the uuid we wrote for it, so a slot whose device uuid
 *     equals a profile id keeps that profile (uuid-keep).
 *   - a profile captured from a module CLAIMS that module's slot (its
 *     capturedFrom uuid matches a device entry); the list entry is
 *     rewritten with the NEW uuid at that slot.
 *   - slots allocate lowest-free from 1..7; slot 0 is the blank template
 *     (30/100C encodeBlankConfig) and is never allocated, never a
 *     template source.
 *   - when nothing is free, the lowest slot that no profile claims, no
 *     bay references, and no pending capture needs is RECLAIMED (the
 *     caller wipes it — orphanGcOps below builds those ops).
 *   - the module list holds 8 entries (0..7): more distinct profiles than
 *     that is a refusal, not a plan.
 *   - a NEW slot needs a template: the smallest same-type slot on the
 *     device (its raw records seed overlay's unmodeled fields — the
 *     planner takes no record counts, so "smallest" is by slot number).
 *     None available → 'Dock the module and read the keyboard first'
 *     (OpenFlow LayoutError parity; the string is pinned by smoke §59).
 *
 * Orphan GC ordering (orphanGcOps): when a slot leaves the list, any bay
 * still pointing at it goes disabled FIRST (the board must never target a
 * dead slot), the module-list delete comes second, and the config blank
 * goes LAST and IN FULL — the 121-byte blank config; a short write leaves
 * the previous module's tail on the device (NayaFlow removal idiom). */

import type { ModuleType } from './module-fields';
import { MODULE_TYPE_CODE } from './module-wire';
import type { ModuleTypeCode } from './module-wire';
import { BAY_POSITIONS, bayRecord, encodeBlankConfig, encodeListDelete } from './module-wire';

/** A profile to place: id + module type + optional capture origin. */
export interface PlanProfile {
  id: string;
  type: ModuleType;
  capturedFrom?: string;
}

/** One device module-list entry (30/100A read form). */
export interface PlanDeviceEntry {
  slot: number;
  uuid: string;
  type: ModuleType;
}

/** One 30/100A add-entry input: listId mirrors slot; uuid16 is the uuid
 * string whose 16 raw bytes ride the wire (uuidToBytes inside
 * encodeListAdd — plain hex order, same convention as the layer list). */
export interface PlanListEntry {
  slot: number;
  id: number;
  flag: ModuleTypeCode;
  uuid16: string;
}

export interface PlanAssignment {
  profileId: string;
  slot: number;
  listEntry: PlanListEntry;
}

/** templateSources: per profile, the device slot to read template records
 * from — null when the profile keeps an existing slot (uuid-keep or
 * capture-claim: its records are already there). */
export type PlanResult =
  | {
      assignments: PlanAssignment[];
      reclaimed: number[];
      templateSources: Record<string, number | null>;
    }
  | { error: string };

/** The module list's total window (slots 0..7; slot 0 reserved for the
 * blank template). */
export const MODULE_LIST_WINDOW = 8;
const FIRST_SLOT = 1;
const LAST_SLOT = 7;

/** Exact refusal when a NEW slot has no same-type template on the device
 * (OpenFlow LayoutError parity). */
export const DOCK_MODULE_FIRST = 'Dock the module and read the keyboard first';

export function planModuleLayout(
  profiles: PlanProfile[],
  deviceList: PlanDeviceEntry[],
  references: string[],
): PlanResult {
  const refSet = new Set(references);

  // Distinct profiles by id — a duplicated id is ONE profile.
  const seen = new Set<string>();
  const distinct: PlanProfile[] = [];
  for (const p of profiles) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    distinct.push(p);
  }
  if (distinct.length > MODULE_LIST_WINDOW) {
    return {
      error:
        `the module list holds at most ${MODULE_LIST_WINDOW} modules — ` +
        `${distinct.length} profiles do not fit`,
    };
  }

  const byUuid = new Map(deviceList.map((e): [string, PlanDeviceEntry] => [e.uuid, e]));
  const atSlot = new Map<number, PlanDeviceEntry>();
  for (const e of deviceList) if (!atSlot.has(e.slot)) atSlot.set(e.slot, e);
  const occupied = new Set(atSlot.keys());

  // slot → profile, built in three passes.
  const claimed = new Map<number, PlanProfile>();
  const slotOf = new Map<string, number>();

  // Pass 1 — uuid-keep: profile.id IS the uuid we wrote for it.
  for (const p of distinct) {
    const dev = byUuid.get(p.id);
    if (!dev || dev.slot < FIRST_SLOT || claimed.has(dev.slot)) continue;
    claimed.set(dev.slot, p);
    slotOf.set(p.id, dev.slot);
  }
  // Pass 2 — capture-claim: a profile captured from a module claims that
  // module's slot (the slot still holds the uuid it was captured from).
  for (const p of distinct) {
    if (slotOf.has(p.id) || !p.capturedFrom) continue;
    const dev = byUuid.get(p.capturedFrom);
    if (!dev || dev.slot < FIRST_SLOT || claimed.has(dev.slot)) continue;
    claimed.set(dev.slot, p);
    slotOf.set(p.id, dev.slot);
  }
  // Pass 3 — the rest allocate lowest-free; when nothing is free, reclaim
  // the lowest slot that no profile claims, no bay references, and no
  // pending capture still needs.
  const reclaimed: number[] = [];
  for (const p of distinct) {
    if (slotOf.has(p.id)) continue;
    let slot: number | null = null;
    for (let s = FIRST_SLOT; s <= LAST_SLOT; s++) {
      if (!occupied.has(s) && !claimed.has(s)) {
        slot = s;
        break;
      }
    }
    if (slot === null) {
      for (let s = FIRST_SLOT; s <= LAST_SLOT; s++) {
        if (!occupied.has(s) || claimed.has(s)) continue;
        const dev = atSlot.get(s)!;
        if (refSet.has(dev.uuid)) continue; // a layer bay still points here
        // A pending capture needs this slot's uuid as its claim target.
        if (distinct.some((q) => q.capturedFrom === dev.uuid)) continue;
        slot = s;
        reclaimed.push(s);
        break;
      }
    }
    if (slot === null) {
      return {
        error: `no free module slot for ${p.id} — the module slots are full and none can be reclaimed`,
      };
    }
    claimed.set(slot, p);
    slotOf.set(p.id, slot);
  }

  // Template sources + list entries. A kept/claimed existing slot needs no
  // template; a NEW slot reads the smallest same-type device slot that is
  // not itself being reclaimed this flash (its records are about to go).
  const reclaimedSet = new Set(reclaimed);
  const assignments: PlanAssignment[] = [];
  const templateSources: Record<string, number | null> = {};
  for (const [slot, p] of claimed) {
    const dev = atSlot.get(slot);
    const existing =
      dev !== undefined && (dev.uuid === p.id || dev.uuid === p.capturedFrom);
    if (!existing) {
      const src = [...atSlot.values()]
        .filter(
          (e) =>
            e.type === p.type && e.slot >= FIRST_SLOT && !reclaimedSet.has(e.slot),
        )
        .sort((a, b) => a.slot - b.slot)[0];
      if (!src) return { error: DOCK_MODULE_FIRST };
      templateSources[p.id] = src.slot;
    } else {
      templateSources[p.id] = null;
    }
    assignments.push({
      profileId: p.id,
      slot,
      listEntry: { slot, id: slot, flag: MODULE_TYPE_CODE[p.type], uuid16: p.id },
    });
  }
  assignments.sort((a, b) => a.slot - b.slot);
  return { assignments, reclaimed, templateSources };
}

/* --- BASE-layer bay gate --------------------------------------------------- */

/** Bay values as the UI layer stores them: a slot number, 'inherit'
 * (BAY_INHERIT on the wire), 'disabled' (0x00), plus the lenient forms
 * 'transparent'/'' seen in parsed dumps. */
export type BayValue = number | 'inherit' | 'disabled' | 'transparent' | '';

/** The BASE-layer requirements: touch/track/tune L+R; float (0x50/0x51)
 * is exempt — a float carries no profile this phase. */
const REQUIRED_BAYS: { pos: number; label: string }[] = [
  { pos: BAY_POSITIONS.TOUCH[0], label: 'touch left' },
  { pos: BAY_POSITIONS.TOUCH[1], label: 'touch right' },
  { pos: BAY_POSITIONS.TRACK[0], label: 'track left' },
  { pos: BAY_POSITIONS.TRACK[1], label: 'track right' },
  { pos: BAY_POSITIONS.TUNE[0], label: 'tune left' },
  { pos: BAY_POSITIONS.TUNE[1], label: 'tune right' },
];

/** Gaps in the BASE-layer bay assignments: a required bay with no module
 * on the BASE layer. undefined / 'inherit' / 'transparent' / '' are all
 * gaps — 'inherit' on BASE resolves to nothing (BAY_INHERIT points AT the
 * BASE layer); 'disabled' is a deliberate empty, not a gap to fill. */
export function missingBaseBays(bayByPos: Record<number, BayValue>): string[] {
  const gaps: string[] = [];
  for (const { pos, label } of REQUIRED_BAYS) {
    const v = bayByPos[pos];
    if (v === undefined || v === 'inherit' || v === 'transparent' || v === '') {
      gaps.push(`${label} bay (0x${pos.toString(16)}) has no module on the BASE layer`);
    }
  }
  return gaps;
}

/* --- orphan GC -------------------------------------------------------------- */

/** One orphan-GC op with ready-to-send payload bytes, in send order. */
export type OrphanGcOp =
  | { kind: 'bay'; layer: number; pos: number; payload: Uint8Array }
  | { kind: 'listDelete'; slot: number; payload: Uint8Array }
  | { kind: 'blank'; slot: number; payload: Uint8Array };

/** Ordered GC ops for orphaned module slots (slots leaving the list):
 *  1. every bay still pointing at an orphan goes disabled (0x00) — layer
 *     then pos ascending — so the board never targets a dead slot;
 *  2. the module-list deletes;
 *  3. the config blanks LAST, each IN FULL (the 121-byte blank config —
 *     a short write leaves the previous module's tail on the device). */
export function orphanGcOps(
  orphanSlots: number[],
  baysByLayer: Record<number, Record<number, BayValue>>,
): OrphanGcOp[] {
  const out: OrphanGcOp[] = [];
  // Slot 0 is the blank template — never allocated, never GC'd. Filtered
  // BEFORE the set is built so a bay value of 0 (which means DISABLED, not
  // "points at slot 0") can never trip the bay pass either. Defense-in-
  // depth for direct callers: the planner's scans start at 1.
  const orphans = [...new Set(orphanSlots)]
    .filter((s) => s !== 0)
    .sort((a, b) => a - b);
  const orphanSet = new Set(orphans);
  const layers = Object.keys(baysByLayer).map(Number).sort((a, b) => a - b);
  for (const layer of layers) {
    const bays = baysByLayer[layer];
    const poss = Object.keys(bays).map(Number).sort((a, b) => a - b);
    for (const pos of poss) {
      const v = bays[pos];
      if (typeof v === 'number' && orphanSet.has(v)) {
        out.push({ kind: 'bay', layer, pos, payload: bayRecord(pos, 0x00) });
      }
    }
  }
  for (const slot of orphans) {
    out.push({ kind: 'listDelete', slot, payload: encodeListDelete(slot) });
  }
  for (const slot of orphans) {
    out.push({ kind: 'blank', slot, payload: encodeBlankConfig(slot) });
  }
  return out;
}
