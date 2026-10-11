/* App-shortcuts dictionary loader over Task 1's generated corpus
 * (client/src/generated/app-shortcuts.json, compact form:
 * {v:1, cats[], apps:[[name, catIdx, [[action, winChord, winBytes,
 * macChord, macBytes, ctx], ...]], ...]}).
 *
 * DOM-free at module top level — the smoke bundle runs under node
 * (no navigator: detectPlatform guards → 'windows'). The loader memoizes
 * its promise; the ranker is the pinned Decision-3 scorer. */

import type { ActionDef } from '@create-reflow/sdk';

export type Platform = 'windows' | 'mac';

export interface ShortcutBind { chord: string; bytes: string }

export interface ShortcutEntry {
  name: string;
  win: ShortcutBind | null;
  mac: ShortcutBind | null;
  ctx: string | null;
}

export interface AppEntry { name: string; cat: string; actions: ShortcutEntry[] }

export interface AppShortcutDb { apps: AppEntry[]; byName: Map<string, AppEntry> }

let dbPromise: Promise<AppShortcutDb> | null = null;

/* Load + validate + expand the compact corpus into typed objects (one pass).
 * The dynamic import types as any via the vite/client *.json wildcard —
 * cast through unknown and check the basic shape before use. */
export function loadAppShortcuts(): Promise<AppShortcutDb> {
  if (!dbPromise) dbPromise = buildDb();
  return dbPromise;
}

async function buildDb(): Promise<AppShortcutDb> {
  const mod = (await import('../generated/app-shortcuts.json')) as unknown;
  const raw = ((mod as { default?: unknown }).default ?? mod) as {
    v?: unknown;
    cats?: unknown;
    apps?: unknown;
  };
  if (!raw || raw.v !== 1 || !Array.isArray(raw.cats) || !Array.isArray(raw.apps))
    throw new Error('app-shortcuts.json: bad corpus shape');
  const cats = raw.cats as string[];
  const apps: AppEntry[] = [];
  const byName = new Map<string, AppEntry>();
  for (const a of raw.apps as unknown[]) {
    const [name, catIdx, acts] = a as [string, number, unknown[]];
    const actions = acts.map((at) => {
      const [n, wc, wb, mc, mb, cx] = at as [
        string, string | null, string | null,
        string | null, string | null, string | null,
      ];
      return {
        name: n,
        win: wc != null && wb != null ? { chord: wc, bytes: wb } : null,
        mac: mc != null && mb != null ? { chord: mc, bytes: mb } : null,
        ctx: cx,
      };
    });
    const app: AppEntry = { name, cat: cats[catIdx] ?? 'Other', actions };
    apps.push(app);
    byName.set(name, app);
  }
  return { apps, byName };
}

/* UA sniff only (no feature detect exists for this split);
 * node/no-navigator → 'windows'. */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'windows';
  return /Mac|iPhone|iPad/.test(navigator.userAgent) ? 'mac' : 'windows';
}

export function bindOf(e: ShortcutEntry, p: Platform): ShortcutBind | null {
  return p === 'mac' ? e.mac : e.win;
}

/* Synthesize a palette ActionDef from an app-shortcut entry. Null iff the
 * platform has no bind. Body is the family-0x01 HID record body AFTER KK —
 * the 4 hex bytes bind.bytes = [usageLo, usageHi, page, mods] land in the
 * OF param slot verbatim (byte-identity with OpenFlow's param layout). */
export function appShortcutActionDef(
  app: AppEntry,
  e: ShortcutEntry,
  p: Platform,
): ActionDef | null {
  const bind = bindOf(e, p);
  if (!bind) return null;
  const bytes: number[] = [];
  for (let i = 0; i + 1 < bind.bytes.length; i += 2)
    bytes.push(Number.parseInt(bind.bytes.slice(i, i + 2), 16));
  return {
    id: `app:${p}:${app.name}::${e.name}`,
    label: `${e.name} (${bind.chord})`,
    category: 'Applications',
    body: () => [0x01, 0x04, ...bytes],
  };
}

export interface AppHit {
  app: AppEntry;
  entry: ShortcutEntry;
  bind: ShortcutBind;
  score: number;
}

/* Ranked search: scoped port of OF's ActionPalette rate()/dedup/sort
 * (openflow frontend/src/components/ActionPalette.jsx ~:147-200). The plan
 * prose paraphrased two details; the OF original is what the §66 pins hold,
 * so they are implemented OF-faithful:
 *   - word-hit = the WHOLE needle occurring at token boundaries (neighbors
 *     non-alnum), not per-token equality — DaVinci's bare "DELETE" chord
 *     must not outrank Adobe's "Ripple Delete" for needle "ripple delete";
 *   - dedup keeps the FIRST hit per chord (seen-set), not the highest score —
 *     1Password's "Show Quick Access" and "Open/close Quick Access" share
 *     LCTRL + LSHIFT + SPACE and the source-first entry must win.
 * No RegExp in the scorer at all (the boundary check is hand-built) —
 * ReDoS-free, stronger than the plan's split(/\s+/) allowance. */

const isAlnum = (ch: string | undefined): boolean =>
  ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9'));

function isWordHit(v: string, q: string): boolean {
  for (let i = v.indexOf(q); i !== -1; i = v.indexOf(q, i + 1))
    if (!isAlnum(v[i - 1]) && !isAlnum(v[i + q.length])) return true;
  return false;
}

/* Pinned base ladder (OF score()): exact 3, boundary word-hit 2,
 * startsWith 1, contains 0 — else no match. */
function scoreField(f: string | null, weight: number, q: string): number {
  if (!f) return 0;
  const v = f.toLowerCase();
  if (v === q) return weight + 3;
  if (isWordHit(v, q)) return weight + 2;
  if (v.startsWith(q)) return weight + 1;
  return v.includes(q) ? weight : 0;
}

/* score = max(fieldScores) * 1000 + sum(fieldScores); drop 0. Sort score
 * desc, then app name asc, then entry name asc (deterministic; the walk is
 * already app-name-sorted × source order, so this only firms up OF's stable
 * sort). First cap (default 20). */
export function rankAppHits(
  db: AppShortcutDb,
  q: string,
  p: Platform,
  cap = 20,
): AppHit[] {
  const needle = q.trim().toLowerCase();
  if (needle === '') return [];
  const hits: AppHit[] = [];
  const seen = new Set<string>();
  for (const app of db.apps) {
    for (const entry of app.actions) {
      const bind = bindOf(entry, p);
      if (!bind) continue;
      const all = [
        scoreField(entry.name, 40, needle),
        scoreField(entry.ctx, 20, needle),
        scoreField(bind.chord, 10, needle),
      ];
      const best = Math.max(...all);
      const score =
        best === 0 ? 0 : best * 1000 + all.reduce((a, b) => a + b, 0);
      if (score === 0) continue;
      if (seen.has(bind.chord)) continue; // OF: first hit per chord wins
      seen.add(bind.chord);
      hits.push({ app, entry, bind, score });
    }
  }
  return hits
    .sort((a, b) =>
      b.score - a.score ||
      a.app.name.localeCompare(b.app.name) ||
      a.entry.name.localeCompare(b.entry.name))
    .slice(0, cap);
}
