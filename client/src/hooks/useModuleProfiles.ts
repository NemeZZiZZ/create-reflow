/* Module profile store (Phase 5b): the app-side profile list + bay
 * assignments, persisted in localStorage, plus capture-on-read.
 *
 * Two stores, one per persistence key, both on the useCustomColors pattern
 * (lazy validated parse at mount + explicit sync save on every mutation):
 *   - 'naya-module-profiles' — ModuleProfile[] (JSON-safe by construction)
 *   - 'naya-module-bays'     — BayAssignments (layer → pos → profileId)
 * Corrupt JSON (or private mode) degrades to empty defaults, never a crash.
 *
 * Edits mutate the STORE only — never the Draft. Writes to the device are
 * the planner's job (a later phase); this hook is the source of truth the
 * planner plans FROM.
 *
 * readAll() is the capture-on-read flow (module-read.ts semantics): read
 * the 30/1009 module list + every slot's 30/100b config, matchSlots() by
 * content, captureFromSlots() for slots that match nothing, and repoint
 * ONLY the bay rows that pointed at the captured slot's closest candidate —
 * other profiles' bay choices are deliberate picks and must survive a read.
 *
 * `live` (per-slot match verdicts) is the one in-memory transient: it is
 * rebuilt by every readAll() and cleared when the left half disconnects.
 * Profiles and bay picks persist across disconnects. */

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import {
  MODULE_TYPES,
  SETTING_FIELDS,
  STOCK_PROFILES,
  captureFromSlots,
  conventionOf,
  diffProfile,
  matchSlots,
  mintLayerUuid,
  parseModuleList,
  queueBayAssignment,
  recordsFromModuleBlob,
  repointBays,
  ticksFromWire,
} from '@create-reflow/sdk';
import type {
  BayAssignments,
  ConfigRecords,
  DiffRow,
  Draft,
  ModuleListEntry,
  ModuleProfile,
  ModuleType,
  NayaSession,
  ProfileBinding,
  Side,
} from '@create-reflow/sdk';
import type { LogFn } from './useLog';

const PROFILES_KEY = 'naya-module-profiles';
const BAYS_KEY = 'naya-module-bays';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** localStorage → profiles. Shallow shape check per entry (id/name/type +
 * settings + bindings objects — the store only ever holds what this app
 * wrote); entries that fail are dropped, corrupt JSON → []. */
function loadProfiles(): ModuleProfile[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const out: ModuleProfile[] = [];
    for (const p of parsed) {
      if (!isObj(p)) continue;
      if (typeof p.id !== 'string' || p.id === '') continue;
      if (typeof p.name !== 'string') continue;
      if (
        typeof p.type !== 'string' ||
        !(MODULE_TYPES as readonly string[]).includes(p.type)
      )
        continue;
      if (!isObj(p.settings) || !isObj(p.bindings)) continue;
      out.push(p as unknown as ModuleProfile);
    }
    return out;
  } catch {
    return [];
  }
}

/** localStorage → bay assignments. JSON object keys are strings — layer/pos
 * keys must be digit strings, values non-empty profile ids; anything else
 * (or corrupt JSON) → {} for that row. */
function loadBays(): BayAssignments {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(BAYS_KEY) ?? '{}');
    if (!isObj(parsed)) return {};
    const out: BayAssignments = {};
    for (const [lk, layer] of Object.entries(parsed)) {
      if (!/^\d+$/.test(lk) || !isObj(layer)) continue;
      const row: Record<number, string> = {};
      for (const [pk, id] of Object.entries(layer)) {
        if (!/^\d+$/.test(pk) || typeof id !== 'string' || id === '') continue;
        row[Number(pk)] = id;
      }
      out[Number(lk)] = row;
    }
    return out;
  } catch {
    return {};
  }
}

/** One slot's read verdict — the in-memory transient readAll() rebuilds and
 * the left-disconnect clears. `matched` is the content match (null — every
 * same-type candidate drifts, or none exists); `closest` is what a capture
 * would seed from; `differs` is its drift count (0 ⇔ matched). `diffRows`
 * is that drift per gesture (the gesture rows' 'device: X' badges);
 * `settings` is the slot's modeled settings in app units (the Settings
 * tab's adopt buttons read them); `records` is the raw slot config (the
 * unmodelled-fields disclosure). */
export interface ModuleSlotLive {
  slot: number;
  uuid: string;
  type: ModuleType;
  matched: ModuleProfile | null;
  closest: ModuleProfile | null;
  differs: number;
  diffRows: DiffRow[];
  settings: Record<string, number>;
  records: ConfigRecords;
}

/** A slot's modeled settings (type-0x01 records) as app-unit numbers —
 * identity except ticks_per_rotation, which converts back from its wire
 * degrees-per-detent (SCRUM-50). */
function decodeSlotSettings(type: ModuleType, records: ConfigRecords): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [sid, idx] of Object.entries(SETTING_FIELDS[type])) {
    const rec = records.get(idx);
    if (rec === undefined || rec[1] !== 0x01 || rec[2] < 1) continue;
    const wire = rec[3];
    if (sid === 'ticks_per_rotation') {
      const detents = ticksFromWire(wire);
      if (detents !== null) out[sid] = detents;
      continue;
    }
    out[sid] = wire;
  }
  return out;
}

/** One binding edit for setBinding: the action to store plus the row extras
 * the caller wants changed EXPLICITLY. Carries [i]+[ii]: the old
 * Pick<'actionType' | 'actionCode'> parameter could neither clear nor
 * create a split, and plain merges preserve an existing split — whose
 * halves would silently win on the overlay. So: `split` absent leaves any
 * split untouched, `null` clears it (every combined rebind passes null), a
 * value sets it; `invert` 1 sets the selector-swap flag, 0 clears it. */
export interface BindingEdit {
  actionType: string;
  actionCode: string;
  split?: ProfileBinding['split'] | null;
  invert?: 0 | 1;
}

export function useModuleProfiles({
  sesRef,
  busyRef,
  log,
  draftRef,
  bumpDraft,
}: {
  sesRef: React.RefObject<Map<Side, NayaSession>>;
  busyRef: React.RefObject<boolean>;
  log: LogFn;
  /** The shared edit queue — bay picks queue a wire op into it (a bay
   * record is a plain key op at KK 0x4A-0x51; Task 4). */
  draftRef: React.RefObject<Draft>;
  bumpDraft: () => void;
}) {
  // Lazy validated parse (useCustomColors pattern) — runs once at mount.
  const [profiles, setProfiles] = useState<ModuleProfile[]>(loadProfiles);
  const [bays, setBays] = useState<BayAssignments>(loadBays);
  const [live, setLive] = useState<Record<number, ModuleSlotLive>>({});
  /** Reactive mirror of busyRef during readAll — the UI disables the edit
   * controls while a read is in flight (the mutators are gated anyway). */
  const [reading, setReading] = useState(false);

  // Explicit sync saves: state + localStorage in one call; private mode
  // keeps the session in-memory only.
  const saveProfiles = useCallback((next: ModuleProfile[]) => {
    setProfiles(next);
    try {
      localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);
  const saveBays = useCallback((next: BayAssignments) => {
    setBays(next);
    try {
      localStorage.setItem(BAYS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const clearLive = useCallback(() => setLive({}), []);

  /** Read the board's module inventory + every slot's config, match against
   * the store by content, and capture whatever matches nothing. Per capture
   * the bay rows pointing at the slot's closest candidate follow the board
   * onto the new profile (repointBays is scoped to ONE profile's id). */
  const readAll = useCallback(async () => {
    if (busyRef.current) {
      log('inf', 'modules read: device busy (flash or dump in flight), ignored');
      return;
    }
    const ses = sesRef.current.get('left');
    if (!ses) {
      log('err', 'modules read: left half not connected');
      return;
    }
    busyRef.current = true;
    setReading(true);
    try {
      const entries = parseModuleList(await ses.readModuleList());
      if (entries.length === 0) {
        setLive({});
        log('inf', 'modules: list is empty — no modules on the board');
        return;
      }
      // Per-slot configs. A slot whose config read fails is EXCLUDED from
      // match + capture: an unread slot compares against an empty map
      // (every judgeable row drifts) and would capture spuriously.
      const slotRecords: Record<number, ConfigRecords> = {};
      const readEntries: ModuleListEntry[] = [];
      for (const entry of entries) {
        try {
          const { blob } = await ses.readModuleConfig(entry.slot);
          slotRecords[entry.slot] = recordsFromModuleBlob(blob);
          readEntries.push(entry);
        } catch (e) {
          log(
            'err',
            `modules: slot ${entry.slot} config read failed (${(e as Error).message}) — excluded from match/capture`,
          );
        }
      }
      // Content match → live verdicts (slot → matched/differs/closest plus
      // the per-gesture drift rows, the slot's decoded settings and its raw
      // records for the UI's badges / adopt buttons / disclosure).
      const matches = matchSlots(readEntries, slotRecords, profiles);
      const nextLive: Record<number, ModuleSlotLive> = {};
      for (const m of matches) {
        const records = slotRecords[m.slot] ?? new Map();
        nextLive[m.slot] = {
          slot: m.slot,
          uuid: m.uuid,
          type: m.type,
          matched: m.matched,
          closest: m.closest,
          differs: m.differs,
          diffRows:
            m.closest !== null && m.differs > 0
              ? diffProfile(m.closest, records, conventionOf(m.closest.settings))
              : [],
          settings: decodeSlotSettings(m.type, records),
          records,
        };
      }
      setLive(nextLive);
      log(
        'inf',
        `modules: ${matches.filter((m) => m.matched !== null).length}/${matches.length} slot(s) content-matched`,
      );
      // Capture-on-read: an unmatched slot becomes a new profile seeded
      // from its closest candidate; only that candidate's bay rows follow.
      const captures = captureFromSlots(readEntries, slotRecords, profiles);
      if (captures.length === 0) return;
      let nextBays = bays;
      for (const c of captures) {
        const from = matches.find((x) => x.slot === c.slot)?.closest ?? null;
        if (from) nextBays = repointBays(nextBays, from.id, c.profile.id).bays;
        log(
          'inf',
          `modules: captured "${c.profile.name}" (${c.profile.type}) from slot ${c.slot}` +
            (from ? ` — bays on "${from.name}" follow the board` : ''),
        );
      }
      saveProfiles([...profiles, ...captures.map((c) => c.profile)]);
      saveBays(nextBays);
      toast.info(`Captured ${captures.length} new module profile(s) from the keyboard`);
    } catch (e) {
      log('err', `modules read failed: ${(e as Error).message}`);
    } finally {
      busyRef.current = false;
      setReading(false);
    }
  }, [sesRef, busyRef, log, profiles, bays, saveProfiles, saveBays]);

  /** Carries [iii]: every store mutator is gated against an in-flight read
   * (or flash) — readAll saves from its closure snapshot, so an edit that
   * lands mid-read would be clobbered by the read's own saveProfiles.
   * Returns true when the mutation must be dropped. */
  const busyGated = useCallback((): boolean => {
    if (!busyRef.current) return false;
    log('inf', 'modules: device busy (read or flash in flight) — edit ignored, retry after it finishes');
    return true;
  }, [busyRef, log]);

  /** Replace one gesture's binding; null removes the row. The row's other
   * extras (threshold/mode) are preserved; split/invert only move when the
   * edit says so (see BindingEdit). */
  const setBinding = useCallback(
    (
      profileId: string,
      gesture: string,
      binding: BindingEdit | null,
    ) => {
      if (busyGated()) return;
      saveProfiles(
        profiles.map((p) => {
          if (p.id !== profileId) return p;
          const bindings = { ...p.bindings };
          if (binding === null) delete bindings[gesture];
          else {
            const prev = bindings[gesture];
            const next: ProfileBinding = prev
              ? { ...prev, actionType: binding.actionType, actionCode: binding.actionCode }
              : { actionType: binding.actionType, actionCode: binding.actionCode };
            if (binding.split !== undefined) {
              if (binding.split === null) delete next.split;
              else next.split = binding.split;
            }
            if (binding.invert !== undefined) {
              if (binding.invert === 1) next.invert = 1;
              else delete next.invert;
            }
            bindings[gesture] = next;
          }
          return { ...p, bindings };
        }),
      );
    },
    [profiles, saveProfiles, busyGated],
  );

  const setSetting = useCallback(
    (profileId: string, key: string, value: number) => {
      if (busyGated()) return;
      saveProfiles(
        profiles.map((p) =>
          p.id === profileId ? { ...p, settings: { ...p.settings, [key]: value } } : p,
        ),
      );
    },
    [profiles, saveProfiles, busyGated],
  );

  /** Point one bay position at a pick; null clears the stored intent (an
   * emptied layer row is dropped). `pick` is a profile id or the literal
   * intents 'inherit' / 'disabled' — the bay→wire mapping is the hook's
   * job, the caller never passes raw bytes.
   *
   * The store is updated first (JSON-safe: ids and intents are strings;
   * the planner reads the ids as bay references), then the wire op is
   * queued into the draft when the byte is known NOW:
   *   - 'inherit' → BAY_INHERIT 0x78, 'disabled' → 0x00 — always queueable
   *     (inherit refused on layer 0: 0x78 points AT the base layer, so on
   *     the base layer itself it resolves to nothing);
   *   - a profile id → its live matched slot — a profile not on the
   *     keyboard yet has no slot byte until the next read plans one, so
   *     the pick is stored and the queue touched only after a read.
   * Bay ops are plain key ops at KK 0x4A-0x51 (queueBayAssignment) — they
   * ride the existing executor/preview, no executor change. Clearing to
   * null never un-queues a previously queued op — the queue is reviewed
   * (and its rows removable) in the flash dialog. */
  const setBay = useCallback(
    (layer: number, pos: number, pick: string | null) => {
      if (busyGated()) return;
      if (pick === 'inherit' && layer === 0) {
        log(
          'inf',
          'modules: bay inherit points at the BASE layer — nothing to inherit on layer 0, ignored',
        );
        return;
      }
      const next: BayAssignments = {};
      for (const [lk, layerMap] of Object.entries(bays)) next[Number(lk)] = { ...layerMap };
      const row = next[layer] ?? {};
      if (pick === null) delete row[pos];
      else row[pos] = pick;
      if (Object.keys(row).length > 0) next[layer] = row;
      else delete next[layer];
      saveBays(next);
      // Wire op: only when the byte is resolvable this moment.
      let wire: number | 'inherit' | 'disabled' | null = null;
      if (pick === 'inherit' || pick === 'disabled') wire = pick;
      else if (pick !== null) {
        const slot = Object.values(live).find((m) => m.matched?.id === pick)?.slot;
        if (slot === undefined) {
          const name = profiles.find((p) => p.id === pick)?.name ?? pick;
          log(
            'inf',
            `modules: bay pick "${name}" stored — the profile is not on the keyboard yet, its bay write is queued after the next read`,
          );
          return;
        }
        wire = slot;
      }
      if (wire === null) return; // clearing a pick queues nothing
      const r = queueBayAssignment(draftRef.current, layer, pos, wire);
      if (r.queued) {
        bumpDraft();
        log('inf', `modules: bay write queued (layer ${layer}, KK 0x${pos.toString(16)})`);
      } else {
        log('err', `modules: bay write refused — ${r.error ?? 'unknown reason'}`);
      }
    },
    [bays, live, profiles, saveBays, busyGated, log, draftRef, bumpDraft],
  );

  /** New profile seeded from the type's stock map (the first stock of that
   * type — TRACK seeds from Track Left; Right exists because the module is
   * physically asymmetric, not as a setting). Deep-cloned, fresh uuid,
   * caller's name (stock-derived when empty). Returns the new profile. */
  const addProfile = useCallback(
    (type: ModuleType, name: string): ModuleProfile | null => {
      if (busyGated()) return null;
      const stock = STOCK_PROFILES.find((p) => p.type === type);
      if (!stock) return null;
      const next: ModuleProfile = JSON.parse(JSON.stringify(stock)) as ModuleProfile;
      next.id = mintLayerUuid();
      const trimmed = name.trim();
      next.name = trimmed !== '' ? trimmed : `${stock.name} copy`;
      saveProfiles([...profiles, next]);
      return next;
    },
    [profiles, saveProfiles, busyGated],
  );

  /** Remove a profile and scrub every bay row that referenced it. */
  const deleteProfile = useCallback(
    (profileId: string) => {
      if (busyGated()) return;
      saveProfiles(profiles.filter((p) => p.id !== profileId));
      let changed = false;
      const next: BayAssignments = {};
      for (const [lk, layerMap] of Object.entries(bays)) {
        const row: Record<number, string> = {};
        for (const [pk, id] of Object.entries(layerMap)) {
          if (id === profileId) {
            changed = true;
            continue;
          }
          row[Number(pk)] = id;
        }
        if (Object.keys(row).length > 0) next[Number(lk)] = row;
      }
      if (changed) saveBays(next);
    },
    [profiles, bays, saveProfiles, saveBays, busyGated],
  );

  const renameProfile = useCallback(
    (profileId: string, name: string) => {
      if (busyGated()) return;
      const trimmed = name.trim();
      if (trimmed === '') return;
      saveProfiles(profiles.map((p) => (p.id === profileId ? { ...p, name: trimmed } : p)));
    },
    [profiles, saveProfiles, busyGated],
  );

  return {
    profiles,
    bays,
    live,
    reading,
    readAll,
    setBinding,
    setSetting,
    setBay,
    addProfile,
    deleteProfile,
    renameProfile,
    clearLive,
  };
}
