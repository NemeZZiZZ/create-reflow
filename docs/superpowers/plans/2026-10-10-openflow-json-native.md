# OpenFlow JSON Native Format — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenFlow `kind:'layer'` JSON the only save/import/export format (and the auto-backup container), deleting all legacy snapshot formats per the owner's clean-break decision.

**Architecture:** New pure SDK module `sdk/src/openflow.ts` (parse + build) on top of the existing record builders (`t10.ts`, host-table dictionary vendored from naya-reflow research). `importers.ts` is rewritten as a thin OpenFlow-only guard; `exporters.ts` is deleted; `backups.ts` switches to a new internal container holding OpenFlow docs. Client Save/Import handlers rewire; anim + warnings thread through.

**Tech Stack:** TypeScript (strict), pnpm workspace, oxlint, rolldown-bundled node smoke (`client/scripts/smoke.tsx`, `eq()`/`throws()` asserts, block-scoped `// §N` sections — last used §46).

**Spec:** `docs/superpowers/specs/2026-10-01-openflow-native-format-design.md` (updated `fd5e5c0`). The spec travels with this plan; executors read both.

## Global Constraints

- SDK additions are pure: no React, no device access, no timers — smoke-testable under node.
- TypeScript strict gates: sdk `tsc --noEmit`; client `tsc -b && vite build`.
- oxlint runs in-package (`sdk`: `oxlint src`; `client`: `oxlint <files>` — never `..` paths).
- Smoke gate = 0 FAIL (rolldown writes `/tmp/smoke.cjs`, then `node /tmp/smoke.cjs`; the count grows, only 0 FAIL matters).
- UI copy English; warning strings English and specific (they surface verbatim in the app log).
- No new wire verbs; the only settings write this feature may queue is `ed/1011` via existing `animOp`.
- VCS: plain git, explicit-path staging, local commits only, never push, one commit per phase (4 total).
- Color conversion reuses `hsToHex`/`hexToHs` from `sdk/src/naya.ts` (h in degrees, s 0–100, V=1) — write no new HSV math.

## Review Focus

1. **Future file version** — an OpenFlow `version: 2` doc must fail with an actionable message before any deep parse (never a cryptic shape error). → Task 2 step 1, Task 4 step 1.
2. **Broken layerRefs** — `MO_LAYER_<uuid>` whose uuid is absent from `layerRefs`, or a ref value outside 1–2, must skip that binding with a specific warning, never throw or corrupt the rest. → Task 2 step 1.
3. **positionId abuse** — ids > 96, or duplicate ids: skip (out of range) / last-wins (duplicate), each counted in `warnings`; the doc still imports. → Task 2 step 1.
4. **`press` and `tap` on the same key** — invalid per their model; deterministic resolution = prefer the `tap` multi-set, drop `press`, warn. → Task 2 step 1.
5. **Empty layer caches on export** — old builders returned `null`; the new builder must still emit a valid 97-key doc (empty bindings, `#xxxxxx` placeholders), never `null`/throw. → Task 3 step 1.

---

### Task 1: Host table (vendored dictionary)

**Files:**
- Create: `sdk/src/host-table.ts` (generated literal + lookups)
- Create: `sdk/src/host-table.source.txt` (verbatim copy of `~/Repository/naya-reflow/research/keymap-host-table.txt` — provenance)
- Modify: `sdk/src/index.ts` (barrel export)
- Test: `client/scripts/smoke.tsx` (new `// §47 OpenFlow core: host table` block at end)

**Interfaces:**
- Produces: `nameToUsage(name: string): { page: number; usage: number } | null` (exact name match, case-sensitive); `usageToName(page: number, usage: number): string | null` (first name in file order wins); `HOST_TABLE_SIZE: number` (entry count, aliases included).

- [ ] **Step 1: Write the failing test** — append block-scoped §47:

```ts
// §47 OpenFlow core: host table (vendored from naya-reflow research)
{
  const { nameToUsage, usageToName, HOST_TABLE_SIZE } = SDK;
  eq(HOST_TABLE_SIZE >= 282, true, '47 table size');
  eq(nameToUsage('A')?.page === 0x0007 && nameToUsage('A')?.usage === 0x04, true, '47 A');
  eq(nameToUsage('SYS_PWR')?.usage === 0x81 && nameToUsage('SYSTEM_POWER')?.page === 0x0001, true, '47 alias');
  eq(usageToName(0x0007, 0x04), 'A', '47 reverse A');
  eq(nameToUsage('NO_SUCH_KEY'), null, '47 unknown null');
  eq(usageToName(0x0007, 0xff), null, '47 reverse unknown null');
}
```

(If smoke imports named, not `SDK.*`, extend the existing named import block instead.)

- [ ] **Step 2: Run to verify it fails** — `cd client && ./node_modules/.bin/rolldown --config scripts/rolldown.smoke.mjs && node /tmp/smoke.cjs`; expect FAIL (import not found / undefined lookups).
- [ ] **Step 3: Generate + implement** — copy the source txt; generate the literal with:
  `grep '^… =' sdk/src/host-table.source.txt`-style extraction → `const ENTRIES: ReadonlyArray<readonly [string, number]> = [['SYSTEM_POWER', 0x00010081], …]` (one-off shell/node, output pasted into `host-table.ts` with a provenance header naming the source file and date). `nameToUsage` = linear scan (282 entries, cold path); `usageToName` = first match. Parse `'NAME = 0xPPPPUUUU'` lines only (skip the `pairs:` header).
- [ ] **Step 4: Run to verify it passes** — smoke, expect previous ok-count + 6, 0 FAIL.
- [ ] **Step 5: Barrel** — export from `sdk/src/index.ts`; run `pnpm --filter @create-reflow/sdk build && pnpm --filter @create-reflow/sdk lint`; sdk oxlint on new file only.

### Task 2: `openflow.ts` — parse

**Files:**
- Create: `sdk/src/openflow.ts`
- Modify: `sdk/src/index.ts`
- Test: `client/scripts/smoke.tsx` (new `// §48 OpenFlow import: parse layer doc`)

**Interfaces:**
- Consumes: `SnapMaps` (`importers.ts`), `KeyRec`/`LedRec` (`naya.ts`), `plainRecord`/`t03Record`/`t10Primary`/`t10ShadowMini`/`t10ShadowFull`/`TAIL_T10`/`BehaviorSet` (`t10.ts`), `nameToUsage`/`usageToName` (`host-table.ts`), `hexToHs` (`naya.ts`), `ANIM_NAMES` (`settings.ts`).
- Produces: `parseOpenFlowLayer(obj: unknown): { maps: SnapMaps; anim: number | null; warnings: string[] } | { error: string }`; `OF_LAYER_UUIDS: readonly [string, string, string]`; `export type ParseFileResult = { maps: SnapMaps; anims: Record<number, number>; warnings: string[] } | { error: string }`.

- [ ] **Step 1: Write the failing test** — §48 with an inline fixture doc `doc` (version 1, kind 'layer', orderId 1, layerRefs `{ [OF_TEST_UUID1]: 1, [OF_TEST_UUID2]: 2 }`, animationId 'breathe', macros `[{any: 1}]`) and keys:
  - pos 0 press `A` → `maps.keys[1]` holds `00 01 04 04 00 07 00` (T01);
  - pos 7 press `A` + hold `B` → `07 03 15 01 01 00 c8 00 05 00 07 00 00 00 00 00 04 00 07 00 00 00 00 00` (T03);
  - pos 9 tap `C` + hold `D` + double_tap `E` → primary + shadow-mini at `0x5b` + `4b 02 00` tail;
  - pos 12 tap `C` + hold `D` + double_tap `E` + tap_hold `F` → primary + shadow-full at `0x5e`;
  - pos 20 press `G` + double_tap `H` (no hold) → clamp: T01 for G kept, warning matches /Double Tap dropped/;
  - pos 25 press `layer_polite_hold` `MO_LAYER_<OF_TEST_UUID1>` → `19 05 04 01 00 00 00`;
  - pos 30 press `layer_polite_hold` `TOGGLE_LAYER_<OF_TEST_UUID1>` → skipped, warning matches /TOGGLE/;
  - pos 31 press `layer_polite_hold` `MO_LAYER_<unlisted-uuid>` → skipped + warning (Review Focus 2);
  - pos 35 actionType 'key' actionCode `NO_SUCH_KEY` → skipped + warning;
  - pos 40 press + tap both present → tap set wins, `press` dropped, warning (Review Focus 4);
  - pos 97 → skipped + warning (Review Focus 3);
  - pos 74 `colorHex '#ff0000'` and pos 88 `' #xxxxxx'`-style placeholder → neither in `maps.leds`, strip+bay counts in warnings;
  - pos 1 `colorHex '#3366ff'` → `maps.leds[1]` equals `hexToHs('#3366ff')`;
  - assert `anim === 1`, warnings mention macros count.
  Errors: `{version:2,…}` → /version 2 is newer/; `kind:'profile'` → /unsupported kind/; `orderId:3` → error; `keys` missing → error.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `parseOpenFlowLayer`** — guards → `orderId` L ∈ {0,1,2} → per key: build slots `{tap?,hold?,double?,taphold?}` from bindings (press = plain-slot; tap = set-slot; both → tap wins + warning) → records via the exact builder selection `behaviorSetOps` uses, but emitted as `KeyRec[]` entries (primary at kk, shadow at kk+0x52, `TAIL_T10` once per T10 key); actionCode resolution: `layer_polite_hold` + `MO_LAYER_` prefix → target = `layerRefs[uuid]`, valid ∈ {1,2}, else skip+warn; `TO_/TOGGLE_/STICKY_LAYER_` prefixes → skip+warn; `key`/`modifier` → `nameToUsage`, page 0x0007 usage (incl. 0xe0–0xe7) → `[kk,01,04,u,00,07,00]`, page 0x000c → `[kk,01,04,u,00,0c,00]`; unknown page/actionType → skip+warn. Single press-only → `plainRecord`; sets must respect the chain (clamp per spec §0.2 before building). `anim`: `ANIM_NAMES.findIndex(name === animationId.toLowerCase())`, null-safe; `null` → `anim: null`. Never throw on data — only return `{error}` for structural failures.
- [ ] **Step 4: Run to verify it passes** (0 FAIL).
- [ ] **Step 5: Barrel + sdk gates** (`tsc --noEmit`, `oxlint src`).

### Task 3: `openflow.ts` — build (export) + roundtrip

**Files:**
- Modify: `sdk/src/openflow.ts`, `sdk/src/index.ts`
- Test: `client/scripts/smoke.tsx` (new `// §49 OpenFlow export + roundtrip`)

**Interfaces:**
- Consumes: `behaviorSetOf`, `matchAction` (`actions.ts`), `hsToHex`, `OF_LAYER_UUIDS`.
- Produces: `export interface ExportResult { fileName: string; data: unknown; counts: Record<string, number> }` (moved here; old home deleted in Task 6); `buildOpenFlowLayer(keys: KeyRec[], leds: LedRec[], layer: number, animId: string | null): ExportResult`.

- [ ] **Step 1: Write the failing test** — §49: build from crafted caches (same records as §48 plus a BT-family record `[kk,00,08,03 00 00 00 01 …]` and a modifier T01 `usage 0xe1`, one led `{h:30,s:100}`):
  - `fileName === 'Layer_1.openflow-layer.json'`;
  - keys array length 97, ordered by positionId;
  - T01 'A' → `[{behavior:'press', actionType:'key', actionCode:'A', context:null}]`;
  - T03 → press+hold; T10 mini → tap/hold/double_tap; T10 full → all four (incl. `tap_hold`);
  - modifier → `actionType 'modifier'`, `actionCode === usageToName(0x0007, 0xe1)`;
  - special ORDER 1 → `actionType 'layer_polite_hold'`, `actionCode === 'MO_LAYER_' + OF_LAYER_UUIDS[1]`, `layerRefs` = `{[OF_LAYER_UUIDS[1]]:1, [OF_LAYER_UUIDS[2]]:2}`;
  - BT record → `bindings: []` + `counts.unknown ≥ 1`;
  - strips 74–87 and bays 88–96 → `'#xxxxxx'`;
  - key 1 colorHex === `hsToHex(30, 100)`;
  - `animId 'swirl'` → `animationId 'swirl'`; `null` → `'solid'`;
  - empty caches (`[], [], 2, null`) → valid doc, 97 keys, no throw (Review Focus 5);
  - uuid stability: two builds deep-equal (no timestamps in doc);
  - roundtrip: `parseOpenFlowLayer(buildOpenFlowLayer(...).data)` → identical record bytes per kk and identical led h/s; `anim` round-trips.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `buildOpenFlowLayer`** — per key: `behaviorSetOf` → bindings per spec §3 mapping (plain → `press`; sets → `tap`…; usage 0xe0–0xe7 → `modifier`; special ORDER n → MO ref to `OF_LAYER_UUIDS[n]`; `matchAction` miss → empty bindings + count). Colors from leds cache by kk; missing → no colorHex entry (omit field). `OF_LAYER_UUIDS` = fixed `'6e726600-0000-4000-8000-00000000000' + L` shaped constants (documented as ours, deterministic).
- [ ] **Step 4: Run to verify it passes** (0 FAIL); barrel + sdk gates.
- [ ] **Step 5: Commit phase 1** — `git add sdk/src/host-table.ts sdk/src/host-table.source.txt sdk/src/openflow.ts sdk/src/index.ts client/scripts/smoke.tsx && git commit -m "feat(sdk): OpenFlow JSON core — host table, layer parse/build, smoke"`.

### Task 4: `importers.ts` rewrite (OpenFlow-only)

**Files:**
- Rewrite: `sdk/src/importers.ts`
- Test: `client/scripts/smoke.tsx` (new `// §50 import accepts only OpenFlow`)

**Interfaces:**
- Consumes: `parseOpenFlowLayer`, `ParseFileResult` (openflow.ts), `diffSnapshotToDraft` stays as-is.
- Produces: `parseSnapshotFile(obj: unknown): ParseFileResult` (new return shape — callers updated in Task 7); keeps exporting `SnapMaps`, `DiffResult`, `diffSnapshotToDraft`.

- [ ] **Step 1: Write the failing test** — §50: valid OF doc → `{maps, anims:{1:1}, warnings}`; `{version:2,kind:'layer'}` → /newer/; legacy `{tool:'naya-backup'}` and `{tool:'naya-reflow',kind:'keymap-layer'}` → /clean break/ error naming re-export path; `{kind:'profile'}` → /unsupported kind/.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Rewrite** — delete `migrateSnapshot`, `pickNotes`, `parseExportLayers`, naya-backup branch, `SNAPSHOT_VERSION` import; keep `hexToBytes` ONLY if still referenced after Task 6 (check grep; delete otherwise). New body: peek guards (version > 1 first; legacy tool markers; kind !== 'layer' → unsupported) → delegate to `parseOpenFlowLayer` → map `anim` into `anims` keyed by the doc's layer.
- [ ] **Step 4: Run** — smoke now fails inside §27/§32 (old formats gone): expected intermediate state; §27/§32 still passing asserts must not be deleted yet — they get reworked in Task 5/6. If §27 blocks the gate, temporarily narrow it to the asserts that still hold; the rework lands in this same commit phase.
- [ ] **Step 5: sdk gates.**

### Task 5: `backups.ts` new container + §27 rework

**Files:**
- Rewrite: `sdk/src/backups.ts`
- Test: rework `// §27` in place; keep its `mkStorage`/`mkRec` fixtures

**Interfaces:**
- Consumes: `buildOpenFlowLayer`, `parseOpenFlowLayer`, `ParseFileResult`.
- Produces: `saveAutoBackup(keys, leds, blobKeys, blobLeds, notes?, storage?, anims?: Record<number, string>)` (anims appended last — existing positional callers unchanged); `loadAutoBackup(id, storage?): ParseFileResult`; `listAutoBackups`/`deleteAutoBackup`/`hashStr`/`StorageLike`/`BackupMeta` unchanged. Container doc: `{tool:'create-reflow', kind:'backup', v:1, exportedAt, layers: [OF docs of non-empty layers], notes}`.

- [ ] **Step 1: Rework §27 asserts** — save→load round-trip equality (records + notes carried); dedupe ('unchanged') on identical re-save; `v:2` container injected into storage → load error /newer/; legacy-shaped stored array (fabricate `{meta:{…}, doc:{tool:'naya-reflow'}}`) → next save succeeds and list shows only the new entry (wipe-once); `anims` param lands as `animationId` in stored docs and comes back via load's `anims`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Rewrite `backups.ts`** — per non-empty layer `buildOpenFlowLayer(keys[L], leds[L], L, anims?.[L] ?? null)`; hash over the doc with `exportedAt` stripped top-level (OF layer docs are timestamp-free by construction); `readAll` treats arrays whose first entry lacks `doc.tool === 'create-reflow'` as empty (the one-time wipe); `loadAutoBackup` parses each layer doc, merges maps/anims/warnings.
- [ ] **Step 4: Run to verify it passes** (0 FAIL); sdk gates.

### Task 6: delete `exporters.ts`, retire `SNAPSHOT_VERSION`, §32 rework

**Files:**
- Delete: `sdk/src/exporters.ts`
- Modify: `sdk/src/index.ts` (drop old exports, keep `buildOpenFlowLayer` path), `sdk/src/utils.ts` (remove `SNAPSHOT_VERSION`)
- Test: rework `// §32` (notes) — OF export carries NO notes field; notes ride only in the backup container (assert both).

- [ ] **Step 1: Rework §32 asserts** (as above).
- [ ] **Step 2: Delete + cleanup** — remove file + barrel line + `SNAPSHOT_VERSION`; grep for stragglers (`buildKeymapExport|buildLedmapExport|SNAPSHOT_VERSION|hexToBytes` — drop `hexToBytes` from importers/smoke if now unreferenced).
- [ ] **Step 3: Full gate** — `pnpm build` (client), rolldown + node smoke (0 FAIL), `oxlint` both packages, sdk build+lint. Client build will fail on old handler imports — **this phase's commit includes the minimal App.tsx/useFlash import stubs only if needed to compile; full rewiring is Task 7.** Prefer instead: do Task 7's edits before running the client build; smoke (which imports only SDK + lib) must pass here regardless.
- [ ] **Step 4: Commit phase 2** — `git add -A` FORBIDDEN; explicit paths; message `feat(sdk)!: OpenFlow-only import/export/backups — legacy snapshot formats removed (clean break)`.

### Task 7: Client rewire (Save/Import/anim/warnings)

**Files:**
- Modify: `client/src/App.tsx` (imports ~38–42; export handlers ~228–246; import/restore handlers ~365–408), the Behavior-tab anim call site (grep `animOp` in `client/src`), Save-menu component labels.
- Verify untouched: `client/src/hooks/useFlash.ts` (saveAutoBackup signature compatible).

- [ ] **Step 1: Export side** — Save menu items become per-layer + all: `buildOpenFlowLayer(keysByLayer[L], ledsByLayer[L], L, animByLayer[L] ?? null)` → download `r.fileName`, `JSON.stringify(r.data, null, 2)`; 'All layers' loops L = 0..2. Old keymap/ledmap menu entries removed (one OF doc carries both).
- [ ] **Step 2: Import side** — `parseSnapshotFile`/`loadAutoBackup` new result shape: `{error}` → log; ok → log every `warnings` line (`log('inf', …)`), `diffSnapshotToDraft` as today, then for each `[L, anim]` of `anims` where `anim` differs from current last-known → `draft.add(animOp(L, anim))` + log line 'layer animation → X'.
- [ ] **Step 3: Anim last-known** — `animByLayer` state/ref in App, updated at the Behavior-tab `animOp` call site and after successful flashes (value = `ANIM_NAMES[anim].toLowerCase()`); default absence → `null` → builder emits 'solid'.
- [ ] **Step 4: Full gate + manual reader pass** of the handler diff (no client unit harness; correctness = build + lint + smoke + code reading).
- [ ] **Step 5: Commit phase 3** — `feat(client): Save/Import on OpenFlow layer docs — anim + warning threading`.

### Task 8: Docs

**Files:**
- Modify: `README.md`, `HANDOFF.md`

- [ ] **Step 1:** README — formats section: OpenFlow layer docs in/out, backup container internal, legacy formats rejected; keep the future-proof smoke line ('the gate is 0 FAIL').
- [ ] **Step 2:** HANDOFF — ROADMAP item 1 → done (date, commit refs); add a short 'Native format' section (what Save/Import/backup do now, clean-break consequence: no notes in OF files, warnings semantics). Update any references to `buildKeymapExport`/`parseSnapshotFile` old shape.
- [ ] **Step 3: Full gate; commit phase 4** — `docs: OpenFlow native format — README/HANDOFF updates`.
