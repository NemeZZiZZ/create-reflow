# App-Shortcuts Dictionary in Palette (Phase 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port OpenFlow's app-shortcuts dictionary (150 apps / 19,853 chords, MIT-licensed, ShortcutMapper-derived) into the create-reflow action palette: an Applications tab with app picker + per-app search + Win/Mac platform swap, lazy-loaded from a generated compact index, with attribution.

**Architecture:** Vendor the 4 MB OF source verbatim, codegen it at commit time into a compact JSON (arrays-of-arrays, deterministic), lazy-load that JSON via dynamic import (separate Vite chunk) only when the user first opens the Applications tab. A DOM-free loader lib maps the compact form to typed objects, synthesizes byte-identical `ActionDef`s from OF's pre-baked bytes (zero SDK change), and provides a scoped port of OF's ranked search. The palette grows a two-tab header; palette-wide search gains a ranked app-hits section once the corpus is loaded.

**Tech Stack:** TypeScript, React, Vite (dynamic JSON import → code-split chunk), existing `usePersistentFlag`, existing SDK `ActionDef`/`buildRecord`/`describeRecord`.

**Spec:** `docs/superpowers/specs/2026-10-10-openflow-port-program.md` §"Phase 8" (lines 70-76). Binding lines: app-picker tab, per-app search, platform chord swap (desktop UA detects platform, toggle exposed), 4 MB source trimmed/lazy-loaded (build-time codegen to compact form + attribution); ours: new client asset + generated index, palette tab in KeyActionMenu, settings toggle for platform, ATTRIBUTION file, smoke (index integrity + chord swap mapping); exit: picker binds a verified chord, bundle impact bounded (lazy chunk), attribution ships.

## Global Constraints

- Every shell command runs with `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"` first.
- Gates run from `client/`: `pnpm build` (tsc -b && vite build), `pnpm lint` (oxlint, exit-code gate; warnings documented), smoke `./node_modules/.bin/rolldown --config scripts/rolldown.smoke.mjs && node /tmp/smoke.cjs` — currently **1135 ok / 0 FAIL**; 0 FAIL must hold, count grows with §66.
- smoke lives at `client/scripts/smoke.tsx` (NOT client/src); it runs under **node** — imported lib code must not touch `navigator`/`localStorage` at module top level.
- VCS: plain git, explicit paths in `git add`, local `main`, **never push**.
- No SDK wire-behavior changes this phase — OF bytes flow through the existing family-0x01 path unchanged.
- UI copy: calm English, hedged where unproven. Code comments: house doc style with provenance anchors.
- Vendored source stays verbatim (`_meta` block intact); generated file is deterministic (rerun ⇒ identical bytes).
- `tsc -b` must stay fast: the 2 MB JSON is typed via the `vite/client` `*.json` wildcard (already referenced in `client/src/vite-env.d.ts`) — never import it in a way that triggers literal-type inference; loader casts through `unknown`.

## Decisions (ruled during planning — treat as plan-mandated)

1. **Platform toggle lives in the Applications pane header**, persisted via `usePersistentFlag('reflow.appsc.mac', detectPlatform() === 'mac')`, default UA-detected. No Settings tab exists yet (Phase 9 adds FirmwareTab); the spec's binding text is "desktop UA detects platform, toggle exposed". The pane toggle is the exposed, persisted toggle. *Cost if wrong: relocate one prop, one-line move.*
2. **Lazy strategy:** the generated JSON loads ONLY on first switch to the Applications tab (dynamic import → separate chunk, no prefetch). Palette-wide ranked app hits appear only after the corpus is loaded. Main bundle and default network both unaffected. *Cost: first tab visit shows a brief "Loading…" line.*
3. **Ranked search is a scoped port, not OF's full unified-tabs search** (we have no unified search surface). Fields: name w=40, context w=20, chord w=10; bases: exact 3 / word-hit 2 / startsWith 1 / contains 0; `fieldScore = matched ? weight + base : 0`; `score = max(fieldScores)*1000 + sum(fieldScores)`; dedup by chord string (keep highest score); cap 20. No RegExp (ReDoS-free, OF parity). *Cost: ranking differs from OF on the margins.*
4. **The `codeFrom` page-parse quirk** (`client/src/components/tabs/modules/bindings.ts` ~:205 reads the mods byte as page-hi) is **noted, not fixed**: unreachable for this feature (module-binding dialog filters chords out) and fixing untested parse code risks module-path regressions. Noted in HANDOFF known limitations. *Cost if wrong: none for Phase 8; quirk is documented.*
5. **Behavior-slot gating is inherited, not built:** `hidPairOf` (`sdk/src/t10.ts:217-223`) returns non-null only for page 0x0007 with mods 0, so chord records (mods ≠ 0 or page 0x0c or page 0x00) are rejected from Hold/Double/Tap+Hold slots — OF's shortcut_alias-is-whole-key semantics. Pinned by a smoke assert, no code change.
6. **App-shortcut ActionDefs are synthesized at pick/search time**, never added to static `ACTIONS`: `id = app:{platform}:{app name}::{action name}`, `label = {action} ({chord})`, `category = 'Applications'`, `body() = [0x01, 0x04, b0, b1, b2, b3]` from the OF bytes hex. Reverse lookup after flash describes by bytes (e.g. "LCtrl+LShift+Space"), not app name — OF parity.
7. **Modifiers-only entries** (e.g. "(Hold) Direct Selection tool", bytes `00000001` — page 0x00) bind as-is; `describeRecord` shows no glyph for page-0 records. Bytes are truth; OF shipped these too.
8. **Codegen runs at commit time, not build time; the generated JSON is committed.** The spec says "build-time codegen to compact form"; committing the deterministic artifact gives bit-reproducible builds without ordering node against the bundler, matches the repo's committed-generated-data precedent (`sdk/src/stock-module-profiles.source.json`), and keeps `pnpm build` unchanged. The script stays runnable (`node client/scripts/gen-app-shortcuts.mjs`) for source updates. *Cost if wrong: a `prebuild` hook line, if strict build-time regen is later demanded.*

## Review Focus

Five input classes the spec implies but no happy path exercises; each is pinned by the named test.

1. **Platform swap binds the wrong platform's bytes** (tuple index mixup win/mac) → T2 smoke: 1Password "Show Quick Access" win `2c000703` vs mac `2c00070a` bodies differ at the mods byte only.
2. **The 2 MB corpus leaks into the main bundle** (a static import sneaks in) → T3 build-artifact check: `dist/assets` contains a separate `app-shortcuts-*.js` chunk and no `index-*.js` references it statically.
3. **Null-platform entries crash rendering** (action with only mac binds while platform=windows) → T2 `bindOf` returns `null`, `appShortcutActionDef` returns `null`; T3 empty states assert-by-review; smoke pins the null path.
4. **Ranked search nondeterminism or ReDoS** → T2: no RegExp in the scorer (hand-built whitespace tokenization); smoke pins exact hit order for fixed queries.
5. **2 MB JSON breaks tsc/oxlint** (literal-type inference or `any` lint) → T2: import typed via `vite/client` wildcard, cast through `unknown` with shape validation; the build/lint gates verify.

---

### Task 1: Vendor source, compact codegen, attribution

**Files:**
- Create: `client/src/data/app-shortcuts.source.json` (verbatim copy)
- Create: `client/scripts/gen-app-shortcuts.mjs`
- Create: `client/src/generated/app-shortcuts.json` (codegen output, committed)
- Create: `ATTRIBUTION.md` (repo root)

**Interfaces:**
- Consumes: `/Users/nemezzizz/Repository/openflow/docs/reference/app-shortcuts.json` (read-only, outside repo).
- Produces: the compact format consumed by Task 2 — exact shape:
```json
{ "v": 1,
  "cats": ["AI", "Browser", "CAD / 3D", "Communication", "Creative",
            "Development", "Files", "Games", "Music", "Office", "Other",
            "Productivity", "Shopping", "Social", "System", "Video"],
  "apps": [ ["1Password", 11,
             [ ["Show Quick Access", "LCTRL + LSHIFT + SPACE", "2c000703",
                "LGUI + LSHIFT + SPACE", "2c00070a", "Global"], … ]], … ] }
```
  Rule: `cats` = 16 category names sorted `localeCompare`; each app = `[name, catIndex, actions]`, apps sorted by name `localeCompare`; each action = `[name, winChord|null, winBytes|null, macChord|null, macBytes|null, ctx|null]`, actions keep source-file order; no timestamps — output is deterministic byte-for-byte on rerun.

- [ ] **Step 1: Vendor the source**

```bash
cp /Users/nemezzizz/Repository/openflow/docs/reference/app-shortcuts.json \
   client/src/data/app-shortcuts.source.json
```
Verify: file size exactly 4,087,530 B; `head -c 300` shows `_meta` with `"license": "MIT"` intact (source self-documents provenance — nothing prepended, JSON takes no comments).

- [ ] **Step 2: Write `client/scripts/gen-app-shortcuts.mjs`**

Node ESM script (no deps). Reads `../src/data/app-shortcuts.source.json` relative to the script's own path (`import.meta.url`), writes `../src/generated/app-shortcuts.json` per the Interfaces shape with `JSON.stringify(obj)` (no pretty-print — smaller). Prints a count table to stdout: apps, categories, total actions, per-platform (windows-any, mac-any, both, win-only, mac-only), entries missing chord or bytes (must be 0).

- [ ] **Step 3: Run codegen and verify counts exactly**

```bash
cd client && node scripts/gen-app-shortcuts.mjs
```
Expected printed counts (recon-verified against the source): apps **150**, cats **16**, total **19,853**, windows-any **17,373**, mac-any **15,765**, both **13,285**, win-only **4,088**, mac-only **2,480**, missing **0**.

- [ ] **Step 4: Determinism check**

Run the script a second time; `git status` must show no modification to the generated file (byte-identical rerun).

- [ ] **Step 5: Write `ATTRIBUTION.md` at repo root**

Terse English matching repo tone (see README.md). Must contain: app-shortcuts data provenance — derived from [ShortcutMapper](https://github.com/waldobronchart/ShortcutMapper) by Waldo Bronchart (MIT) plus the CreateCompanion curated catalog and hand-authored entries, per the vendored file's `_meta` (generated 2026-09-06); vendored verbatim at `client/src/data/app-shortcuts.source.json`; compact index regenerated via `node client/scripts/gen-app-shortcuts.mjs`; license MIT.

- [ ] **Step 6: Run gates (must be unchanged — nothing imports the data yet)**

From `client/`: `pnpm build`, `pnpm lint`, smoke build + run → **1135 ok / 0 FAIL**.

- [ ] **Step 7: Commit**

```bash
git add client/src/data/app-shortcuts.source.json client/scripts/gen-app-shortcuts.mjs \
        client/src/generated/app-shortcuts.json ATTRIBUTION.md
git commit -m "feat(client): vendor app-shortcuts source, compact codegen, attribution"
```

### Task 2: Loader lib + smoke §66 part A

**Files:**
- Create: `client/src/lib/app-shortcuts.ts`
- Modify: `client/scripts/smoke.tsx` (append §66 before `void main();`)

**Interfaces:**
- Consumes: Task 1's generated JSON (via `await import('../generated/app-shortcuts.json')` — typed `any` by the `vite/client` wildcard; cast through `unknown` and validate `v === 1` + basic shape before use); `ActionDef` from `@create-reflow/sdk`.
- Produces (exact — Task 3 builds on these):

```ts
export type Platform = "windows" | "mac";
export interface ShortcutBind { chord: string; bytes: string }
export interface ShortcutEntry { name: string; win: ShortcutBind | null; mac: ShortcutBind | null; ctx: string | null }
export interface AppEntry { name: string; cat: string; actions: ShortcutEntry[] }
export interface AppShortcutDb { apps: AppEntry[]; byName: Map<string, AppEntry> }
export function loadAppShortcuts(): Promise<AppShortcutDb>;      // memoized promise; validates shape; DOM-free
export function detectPlatform(): Platform;                       // /Mac|iPhone|iPad/.test(navigator.userAgent) → "mac", else "windows"; guard typeof navigator === "undefined" → "windows"
export function bindOf(e: ShortcutEntry, p: Platform): ShortcutBind | null;
export function appShortcutActionDef(app: AppEntry, e: ShortcutEntry, p: Platform): ActionDef | null;
                                                                 // null iff bindOf null; id `app:${p}:${app.name}::${e.name}`;
                                                                 // label `${e.name} (${bind.chord})`; category "Applications";
                                                                 // body [0x01, 0x04, ...4 bytes of bind.bytes hex]
export interface AppHit { app: AppEntry; entry: ShortcutEntry; bind: ShortcutBind; score: number }
export function rankAppHits(db: AppShortcutDb, q: string, p: Platform, cap?: number): AppHit[];
                                                                 // Decision 3 scorer; default cap 20; deterministic order
```

Scorer (Decision 3, pinned): `needle = q.trim().toLowerCase()`; empty → `[]`. Iterate `db.apps` in order (already name-sorted) × entries with `bindOf ≠ null`. Fields: entry name w=40, ctx w=20, chord w=10 (each lowercased). Base per field: exact equality 3; word-hit 2 (some whitespace-token of needle equals some whitespace-token of the field — `split(/\s+/)`, no other RegExp); startsWith 1; contains 0 — only when the field contains the needle but nothing stronger matched. `fieldScore = matched ? weight + base : 0`. `score = max(fieldScores) * 1000 + sum(fieldScores)`; drop score 0. Dedup by `bind.chord` string keeping the highest score (tie → first in iteration order). Sort: score desc, then app name `localeCompare` asc, then entry name `localeCompare` asc. Return first `cap` (default 20).

- [ ] **Step 1: Write the failing smoke asserts (§66 part A, before `void main();`)**

New IIFE in `client/scripts/smoke.tsx`, importing from `'../src/lib/app-shortcuts'` and `buildRecord`, `describeRecord`, `hidPairOf` from `'@create-reflow/sdk'` (async body — the loader is async):

```ts
// §66 app-shortcuts dictionary, part 1 (loader lib): corpus integrity,
// bytes→body equivalence, platform swap, slot gate, ranker pins.
```
Assertions (use the existing `eq()` helper):
1. `(await loadAppShortcuts())` → `db.apps.length === 150`; unique `cat` values = 16; `byName.size === 150`; total actions across apps `=== 19853`.
2. `byName.get('1Password')` → `.cat === 'Productivity'`, `.actions.length === 58`.
3. 1Password entry "Show Quick Access": `bindOf(e, 'windows')!.bytes === '2c000703'`, `bindOf(e, 'mac')!.bytes === '2c00070a'`.
4. `appShortcutActionDef(app, e, 'windows')!.body()` deep-equals `[0x01, 0x04, 0x2c, 0x00, 0x07, 0x03]` (the byte-identity claim: OF param `[usageLo, usageHi, page, mods]` == our family-0x01 payload).
5. Same entry mac: body deep-equals `[0x01, 0x04, 0x2c, 0x00, 0x07, 0x0a]` — differs from windows **only at the mods byte** (assert both bodies and their inequality).
6. `def.label === 'Show Quick Access (LCTRL + LSHIFT + SPACE)'`, `def.id === 'app:windows:1Password::Show Quick Access'`, `def.category === 'Applications'`.
7. `describeRecord(buildRecord(0, def.body()))` contains `'Space'` (readback works — page 0x0007 + mods suffix).
8. `hidPairOf(buildRecord(0, def.body())) === null` (Decision 5 slot gate pinned).
9. Null path: find any entry in the corpus with `win === null` (mac-only, ≥1 exists — 2,480 do) → `bindOf(e, 'windows') === null` and `appShortcutActionDef(app, e, 'windows') === null`.
10. `rankAppHits(db, 'quick access', 'windows')`: first hit `.entry.name === 'Show Quick Access'`; every hit has `bindOf(entry, 'windows') ≠ null`.
11. `rankAppHits(db, 'zzz-no-such-shortcut', 'windows').length === 0`.
12. Rank order pin: `rankAppHits(db, 'ripple delete', 'windows')` first hit `.entry.name === 'Ripple Delete'` (Adobe Premiere Pro).
13. `detectPlatform() === 'windows'` (node has no navigator — pins the guard).

- [ ] **Step 2: Run smoke to verify it fails**

```bash
cd client && ./node_modules/.bin/rolldown --config scripts/rolldown.smoke.mjs && node /tmp/smoke.cjs
```
Expected: FAIL — module `'../src/lib/app-shortcuts'` not found (or §66 asserts erroring).

- [ ] **Step 3: Implement `client/src/lib/app-shortcuts.ts`**

Per the Interfaces block. The dynamic import resolves through the `vite/client` `*.json` wildcard (typed `any`): cast `as unknown`, validate `v === 1`, `Array.isArray(apps)`, then map compact tuples to the typed objects in one pass. Module contains no DOM access at top level (node-safe for smoke). Memoize the promise in a module-level variable.

- [ ] **Step 4: Run smoke to verify it passes**

Same command. Expected: 0 FAIL, count = 1135 + 13ish new asserts (exact count from the run; record it in the report).

- [ ] **Step 5: Full gates**

`pnpm build`, `pnpm lint` (exit 0; any new warnings documented), smoke again → 0 FAIL.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/app-shortcuts.ts client/scripts/smoke.tsx
git commit -m "feat(client): app-shortcuts loader — typed corpus, platform binds, ActionDef synthesis, ranked hits"
```

### Task 3: Applications pane + palette tab + ranked search section

**Files:**
- Create: `client/src/components/AppShortcutPane.tsx`
- Modify: `client/src/components/ActionPalette.tsx`

**Interfaces:**
- Consumes: Task 2 exports (exact signatures above); `usePersistentFlag` from `../hooks/usePersistentFlag` (`(key: string, defaultValue: boolean) => [boolean, () => void]`); `ActionDef` from `@create-reflow/sdk`; existing ui components (`Button`, `InputGroup`, `InputGroupAddon`, `InputGroupInput`, `Accordion*`).
- Produces: `ActionPalette` external API unchanged (`{ onPick, pickedId?, filter? }`) — the tab is internal. `AppShortcutPane` exports default component + `AppShortcutRow` (named) for reuse in the ranked section.

- [ ] **Step 1: Implement `client/src/components/AppShortcutPane.tsx`**

Component tree (props: `{ db: AppShortcutDb | null; loading: boolean; error: boolean; platform: Platform; onTogglePlatform: () => void; onPick: (a: ActionDef) => void; filter?: (a: ActionDef) => boolean }`):
1. `loading` → one muted line `Loading application shortcuts…`. `error` → `Application shortcuts failed to load.` (calm, muted). Neither renders the rest.
2. Platform segmented control: two `Button`s `Windows` / `macOS` (active = `variant="default"`, inactive `"outline"`, `size="sm"`, text-xs) — active reflects `platform`; click → `onTogglePlatform()`. Shared `title`: `Shortcuts differ per platform — picks bind the selected platform's key bytes.`
3. App select: native `<select class="rounded border bg-background px-2 py-1 text-sm">` (BehaviorTab select style). `<optgroup label={cat}>` per category in `cats` order (Task 1 sorted), options = that category's apps in name order (iterate `db.apps`, group by `cat`). Controlled value = selected app name; default = first app's name. On change → set app, clear the per-app query.
4. Per-app search: `InputGroup` input (Search icon addon, placeholder `Search in {appName}…`, text-xs, controlled).
5. Rows: `app.actions` filtered by `bindOf(e, platform) ≠ null` AND `e.name.toLowerCase().includes(needle)`; synthesize `def = appShortcutActionDef(app, e, platform)`; render at most **300** rows via `AppShortcutRow`; when more remain → muted line `…{n} more — refine the search.`
6. `AppShortcutRow({ app, entry, platform, def, onPick, filter })`: full-width `Button variant="outline" h-auto text-sm flex justify-between gap-2`; left: `{entry.name}` (truncate) plus `{entry.ctx}` as muted `text-xs` (` · {ctx}`) when present; right: `{bind.chord}` in `font-mono text-xs whitespace-nowrap`; `disabled = filter ? !filter(def) : false`; `title = "{app} — {entry.name} ({chord})"` (+ ` · {ctx}`); click → `onPick(def)`.
7. Empty states: selected app has zero platform binds → `No {Windows|macOS} shortcuts for {app}.` ; filtered list empty → `No matches in {app}.`
8. Footer muted line: `{db.apps.length} apps · MIT-licensed data — see ATTRIBUTION.md`.

- [ ] **Step 2: Wire the tab + ranked section into `ActionPalette.tsx`**

1. New state: `tab: 'actions' | 'apps'` (default `'actions'`); `db/dbLoading/dbErr` via `loadAppShortcuts()` **fired only when the user switches to `'apps'`** (Decision 2 — no prefetch); `mac` via `usePersistentFlag('reflow.appsc.mac', detectPlatform() === 'mac')` lifted here (shared by pane and ranked section).
2. Tab header row above the search input: two `Button`s `Actions` / `Applications` (active `variant="default"`, else `"outline"`, text-xs). Switching to Applications triggers the one-time load.
3. `tab === 'apps'` → render `<AppShortcutPane … />` instead of the accordion (pane carries its own search).
4. `tab === 'actions'` with `needle && db` → ranked section ABOVE the accordion: muted header `Application shortcuts` + `rankAppHits(db, needle, platform).map(...)` as `AppShortcutRow`s (def synthesized per hit), each `onPick(def)`; empty hits → no section at all.
5. Keep every existing behavior when `db` is null (current palette untouched until the corpus is loaded).

- [ ] **Step 3: Full gates**

`pnpm build` (exit 0), `pnpm lint` (exit 0; warnings documented), smoke → 0 FAIL (count unchanged from Task 2 — UI task).

- [ ] **Step 4: Bundle-bound check (Review Focus 2)**

```bash
ls client/dist/assets | grep app-shortcuts
grep -l "app-shortcuts" client/dist/assets/index-*.js || echo "main chunk clean"
```
Expected: a separate `app-shortcuts-*.js` chunk exists; the main `index-*.js` does not inline the corpus (a reference to the chunk filename in the lazy-load wrapper is fine — the check is that the 2 MB of data is not inlined; verify chunk sizes: the app-shortcuts chunk ~1.5-2 MB, index chunk within ~10% of its pre-phase size). Record both chunk sizes in the report.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/AppShortcutPane.tsx client/src/components/ActionPalette.tsx
git commit -m "feat(client): Applications tab — app picker, platform swap, ranked palette hits"
```

### Task 4: Docs — HANDOFF roadmap + notes, README

**Files:**
- Modify: `HANDOFF.md` (ROADMAP item 11 after item 10; new notes section after the keyscan notes)
- Modify: `README.md` (one clause on the `client/` bullet)

**Interfaces:**
- Consumes: Task 1-3 landed facts (counts, encoding equivalence, lazy strategy, commit hashes).
- Produces: documentation only.

- [ ] **Step 1: ROADMAP item 11** — same numbered-entry shape as item 10 (`HANDOFF.md:402-411`): `11.` `**App-shortcuts dictionary (Phase 8)**` `✅ DONE 2026-10-12`, commit range `<T1>..<T4>` + plan commit, one-paragraph summary, `See the app-shortcuts notes below.`

- [ ] **Step 2: `## App shortcuts notes (Phase 8) — provenance & mechanics`** after the keyscan notes section (same bold-lead-in bullet style as the BLE/keyscan notes). Bullets must cover (all code-anchored):
  - **Provenance:** MIT; ShortcutMapper (Waldo Bronchart) + CreateCompanion curated catalog + hand-authored, per the vendored `_meta` (generated 2026-09-06); vendored verbatim at `client/src/data/app-shortcuts.source.json`; compact regen `node client/scripts/gen-app-shortcuts.mjs`; `ATTRIBUTION.md` at root.
  - **Counts:** 150 apps / 16 categories / 19,853 actions; windows 17,373, mac 15,765, both 13,285; zero missing chord/bytes.
  - **Encoding equivalence:** OF `bytes` hex = KEY_PRESS param `[usageLo, usageHi, page, mods]`; our ActionDef body `[0x01, 0x04, b0, b1, b2, b3]` is the identical family-0x01 payload — zero SDK change; `describeRecord` reads back page 0x0007/0x000c + mods suffix; modifiers-only entries (page 0x00, e.g. "(Hold)" gestures) bind as-is with no glyph.
  - **Platform semantics:** UA-detect default, persisted toggle (`reflow.appsc.mac`) in the pane header; swap binds the other platform's bytes; `hidPairOf` page-0x0007+mods-0 gate keeps chords out of behavior slots (OF shortcut_alias parity).
  - **Lazy strategy:** dynamic import → separate Vite chunk, loaded on first Applications tab switch; palette ranked app hits activate only once the corpus is loaded (no hidden prefetch).
  - **Known limitations:** `codeFrom` mods-as-page-hi parse quirk noted not fixed (Decision 4); ranked search is a scoped port (Decision 3); per-app search is substring, not ranked.

- [ ] **Step 3: README clause** — append to the `client/` bullet's semicolon list, per-tab voice: `; app-shortcut dictionary (150 apps, MIT-licensed, platform-aware chords) in the action palette`.

- [ ] **Step 4: Gates + commit**

`pnpm build`, `pnpm lint`, smoke → 0 FAIL (docs-only; counts unchanged from Task 2's final number).

```bash
git add HANDOFF.md README.md
git commit -m "docs: app shortcuts — HANDOFF roadmap item 11 + notes, README"
```
