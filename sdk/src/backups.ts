/* Auto-backups: rolling pre-flash snapshots kept in localStorage (UHK
 * Agent pattern — the compensation half for a device with no staging
 * buffer: every flash starts from a known-good restore point).
 * The container is an internal envelope around OpenFlow layer docs
 * (host-side only, never shared — so it may carry our per-key notes,
 * which OpenFlow files themselves do not). Storage-swappable so the node
 * smoke can drive it with a Map-backed fake; a missing storage (node,
 * private mode, quota) degrades to skipped, never throws into the flash
 * path. */

import { buildOpenFlowLayer, parseOpenFlowLayer } from './openflow';
import type { ParseFileResult } from './openflow';
import type { SnapMaps } from './importers';
import type { KeyRec, LedRec } from './naya';

/** Internal backup container kind (device layer docs are kind:'layer'). */
export const BACKUP_KIND = 'backup';
const STORAGE_KEY = 'naya-auto-backups';
const MAX_BACKUPS = 20;
const CONTAINER_TOOL = 'create-reflow';
const CONTAINER_VERSION = 1;

export interface BackupMeta {
  id: string;
  ts: string; // ISO
  hash: string; // content hash, dedupe
  bytes: number; // sum of live blob totals
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

interface StoredBackup {
  meta: BackupMeta;
  doc: Record<string, unknown>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** djb2 — dedupe-only, not cryptographic. */
export function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function readAll(st: StorageLike | null): StoredBackup[] {
  if (!st) return [];
  try {
    const raw = st.getItem(STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v) || v.length === 0) return [];
    // One-time wipe: content written by the pre-OpenFlow builds carries a
    // different container (tool 'naya-reflow', naya-full-backup, …) that
    // nothing here can read anymore. Treat the whole store as empty —
    // list shows nothing and the next save overwrites it.
    const first = v[0] as unknown;
    const doc =
      isObj(first) && isObj((first as { doc?: unknown }).doc)
        ? ((first as { doc: unknown }).doc as Record<string, unknown>)
        : null;
    if (!doc || doc.tool !== CONTAINER_TOOL) return [];
    return v as StoredBackup[];
  } catch {
    return [];
  }
}

function writeAll(st: StorageLike | null, all: StoredBackup[]): boolean {
  if (!st) return false;
  try {
    st.setItem(STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export type SaveBackupResult =
  | { status: 'saved'; meta: BackupMeta }
  | { status: 'skipped'; reason: 'empty' | 'unchanged' | 'storage' };

export function saveAutoBackup(
  keys: KeyRec[][],
  leds: LedRec[][],
  blobKeys: number[],
  blobLeds: number[],
  notes?: Record<string, string>,
  storage?: StorageLike,
  anims?: Record<number, string>,
): SaveBackupResult {
  // One OpenFlow layer doc per non-empty layer cache (keys or leds —
  // either alone is restorable state); empty caches contribute nothing.
  const layers: unknown[] = [];
  for (let L = 0; L < 3; L++) {
    const k = keys[L] ?? [];
    const l = leds[L] ?? [];
    if (k.length === 0 && l.length === 0) continue;
    layers.push(buildOpenFlowLayer(k, l, L, anims?.[L] ?? null).data);
  }
  if (layers.length === 0) return { status: 'skipped', reason: 'empty' };
  const doc = {
    tool: CONTAINER_TOOL,
    kind: BACKUP_KIND,
    v: CONTAINER_VERSION,
    exportedAt: new Date().toISOString(),
    layers,
    notes: notes ?? {},
  } as unknown as Record<string, unknown>;
  // Content hash only — exportedAt must NOT participate, or every save
  // looks changed and the dedupe never fires. The nested OF layer docs
  // are timestamp-free by construction (deterministic builders).
  const hash = hashStr(JSON.stringify({ ...doc, exportedAt: '' }));
  const st = storage ?? defaultStorage();
  const all = readAll(st);
  if (all[0] && all[0].meta.hash === hash) return { status: 'skipped', reason: 'unchanged' };
  const bytes =
    blobKeys.reduce((a, b) => a + b, 0) + blobLeds.reduce((a, b) => a + b, 0);
  const meta: BackupMeta = {
    id: `${Date.now().toString(36)}-${hash.slice(0, 4)}`,
    ts: doc.exportedAt as string,
    hash,
    bytes,
  };
  all.unshift({ meta, doc });
  if (!writeAll(st, all.slice(0, MAX_BACKUPS))) return { status: 'skipped', reason: 'storage' };
  return { status: 'saved', meta };
}

export function listAutoBackups(storage?: StorageLike): BackupMeta[] {
  return readAll(storage ?? defaultStorage()).map((b) => b.meta);
}

export function loadAutoBackup(
  id: string,
  storage?: StorageLike,
): ParseFileResult {
  const all = readAll(storage ?? defaultStorage());
  const e = all.find((b) => b.meta.id === id);
  if (!e) return { error: `no backup with id ${id}` };
  const doc = e.doc;
  if (!isObj(doc)) return { error: `backup entry ${id} is unreadable` };
  // Peek version BEFORE the shape checks (same order as the OF parser):
  // containers from a newer app must fail with an actionable message.
  if (typeof doc.v === 'number' && doc.v > 1)
    return {
      error: `backup container version ${doc.v} is newer than this app supports (v1) — update the app`,
    };
  if (!Array.isArray(doc.layers)) return { error: `backup entry ${id} is unreadable` };
  const keys: KeyRec[][] = [[], [], []];
  const leds: LedRec[][] = [[], [], []];
  const layers: number[] = [];
  const anims: Record<number, number> = {};
  const warnings: string[] = [];
  for (const layerDoc of doc.layers) {
    const r = parseOpenFlowLayer(layerDoc);
    if ('error' in r) return { error: `backup entry ${id} is unreadable` };
    const L = r.maps.layers[0];
    keys[L] = r.maps.keys[L];
    leds[L] = r.maps.leds[L];
    if (!layers.includes(L)) layers.push(L);
    if (r.anim !== null) anims[L] = r.anim;
    for (const w of r.warnings) warnings.push(`layer ${L}: ${w}`);
  }
  layers.sort((a, b) => a - b);
  const maps: SnapMaps = { keys, leds, layers };
  if (isObj(doc.notes)) maps.notes = doc.notes as Record<string, string>;
  return { maps, anims, warnings };
}

export function deleteAutoBackup(id: string, storage?: StorageLike): boolean {
  const st = storage ?? defaultStorage();
  const all = readAll(st);
  const next = all.filter((b) => b.meta.id !== id);
  if (next.length === all.length) return false;
  return writeAll(st, next);
}
