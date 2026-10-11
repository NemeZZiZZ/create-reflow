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
  STOCK_PROFILES,
  captureFromSlots,
  matchSlots,
  mintLayerUuid,
  parseModuleList,
  recordsFromModuleBlob,
  repointBays,
} from '@create-reflow/sdk';
import type {
  BayAssignments,
  ConfigRecords,
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
 * would seed from; `differs` is its drift count (0 ⇔ matched). */
export interface ModuleSlotLive {
  slot: number;
  uuid: string;
  type: ModuleType;
  matched: ModuleProfile | null;
  closest: ModuleProfile | null;
  differs: number;
}

export function useModuleProfiles({
  sesRef,
  busyRef,
  log,
}: {
  sesRef: React.RefObject<Map<Side, NayaSession>>;
  busyRef: React.RefObject<boolean>;
  log: LogFn;
}) {
  // Lazy validated parse (useCustomColors pattern) — runs once at mount.
  const [profiles, setProfiles] = useState<ModuleProfile[]>(loadProfiles);
  const [bays, setBays] = useState<BayAssignments>(loadBays);
  const [live, setLive] = useState<Record<number, ModuleSlotLive>>({});

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
      // Content match → live verdicts (slot → matched/differs/closest).
      const matches = matchSlots(readEntries, slotRecords, profiles);
      const nextLive: Record<number, ModuleSlotLive> = {};
      for (const m of matches) {
        nextLive[m.slot] = {
          slot: m.slot,
          uuid: m.uuid,
          type: m.type,
          matched: m.matched,
          closest: m.closest,
          differs: m.differs,
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
    }
  }, [sesRef, busyRef, log, profiles, bays, saveProfiles, saveBays]);

  /** Replace one gesture's binding action; null removes the row. The row's
   * own extras (invert/threshold/mode/split — ProfileBinding) are preserved:
   * minimal mutation of the action, nothing else on the row changes. */
  const setBinding = useCallback(
    (
      profileId: string,
      gesture: string,
      binding: Pick<ProfileBinding, 'actionType' | 'actionCode'> | null,
    ) => {
      saveProfiles(
        profiles.map((p) => {
          if (p.id !== profileId) return p;
          const bindings = { ...p.bindings };
          if (binding === null) delete bindings[gesture];
          else {
            const prev = bindings[gesture];
            bindings[gesture] = prev
              ? { ...prev, actionType: binding.actionType, actionCode: binding.actionCode }
              : { actionType: binding.actionType, actionCode: binding.actionCode };
          }
          return { ...p, bindings };
        }),
      );
    },
    [profiles, saveProfiles],
  );

  const setSetting = useCallback(
    (profileId: string, key: string, value: number) => {
      saveProfiles(
        profiles.map((p) =>
          p.id === profileId ? { ...p, settings: { ...p.settings, [key]: value } } : p,
        ),
      );
    },
    [profiles, saveProfiles],
  );

  /** Point one bay position at a profile; null clears it (an emptied layer
   * row is dropped). Bay picks are the user's deliberate choice — only
   * capture-on-read repoints rows programmatically. */
  const setBay = useCallback(
    (layer: number, pos: number, profileId: string | null) => {
      const next: BayAssignments = {};
      for (const [lk, layerMap] of Object.entries(bays)) next[Number(lk)] = { ...layerMap };
      const row = next[layer] ?? {};
      if (profileId === null) delete row[pos];
      else row[pos] = profileId;
      if (Object.keys(row).length > 0) next[layer] = row;
      else delete next[layer];
      saveBays(next);
    },
    [bays, saveBays],
  );

  /** New profile seeded from the type's stock map (the first stock of that
   * type — TRACK seeds from Track Left; Right exists because the module is
   * physically asymmetric, not as a setting). Deep-cloned, fresh uuid,
   * caller's name (stock-derived when empty). Returns the new profile. */
  const addProfile = useCallback(
    (type: ModuleType, name: string): ModuleProfile | null => {
      const stock = STOCK_PROFILES.find((p) => p.type === type);
      if (!stock) return null;
      const next: ModuleProfile = JSON.parse(JSON.stringify(stock)) as ModuleProfile;
      next.id = mintLayerUuid();
      const trimmed = name.trim();
      next.name = trimmed !== '' ? trimmed : `${stock.name} copy`;
      saveProfiles([...profiles, next]);
      return next;
    },
    [profiles, saveProfiles],
  );

  /** Remove a profile and scrub every bay row that referenced it. */
  const deleteProfile = useCallback(
    (profileId: string) => {
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
    [profiles, bays, saveProfiles, saveBays],
  );

  const renameProfile = useCallback(
    (profileId: string, name: string) => {
      const trimmed = name.trim();
      if (trimmed === '') return;
      saveProfiles(profiles.map((p) => (p.id === profileId ? { ...p, name: trimmed } : p)));
    },
    [profiles, saveProfiles],
  );

  return {
    profiles,
    bays,
    live,
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
