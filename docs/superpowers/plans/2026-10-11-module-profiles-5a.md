# Module Profiles 5a — Core Model (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port OpenFlow's module-config system core — wire encoders, field/profile data model, slot planner, and content-match read path — as pure SDK, no UI (UI = Phase 5b).

**Architecture:** New SDK modules: `module-wire.ts` (record/list encoders + the addressing seam), `module-fields.ts` (vendored field maps + axis/settings tables, provenance-commented), `module-profiles.ts` (profile store shape, stock profiles, overlay/encode/compare pure functions, capture), `module-planner.ts` (slot allocation lifecycle + base-bay gaps + orphan-GC op ordering). `naya.ts` gains readModuleList (1009) and the addressing-pinned read/write helpers. Client untouched except type fallout.

**Tech Stack:** TS strict, pnpm workspace, oxlint, rolldown node smoke (§ blocks; last used §56; smoke baseline 715).

**Spec:** `docs/superpowers/specs/2026-10-10-openflow-port-program.md` Phase 5 (5a = core cut). Research facts: this session's Phase-5 research report (file:line citations to ~/Repository/openflow — all byte literals below are OF-verified or vendor-captured).

## Global Constraints

- **Addressing pin (B12) rules everything:** our live-proven convention `[00, index, data]` (writeKey/writeLed/1004/100B/100C on fw 3.41.0) is the DEFAULT; OF's single-byte `[slot]` model is recorded as the open alternative. ALL addressing flows through one seam (`MODULE_ADDR` constants in module-wire.ts) with a header note naming the Phase-10 live probe as the settle point. No write path ships enabled in UI this phase (5a is SDK-only; ModulesTab untouched except imports it already has).
- New verbs 30/1009 (list read) + 30/100A (list write): read may be wired; write encoders exist but are NOT called by client code this phase (planner produces ops; flash-loop dispatch lands in 5b with UI). Wire-guard: 1009/100A pass assertWireAllowed (assert in smoke).
- Vendor-captured data gets provenance comments + source files under `sdk/src/` (host-table pattern): field map facts, AXIS_HALVES, FIRMWARE_DEFAULTS, SETTING_FIELDS, MOUSE_MASK, stock profiles. Apache-2.0 OF code → port knowledge, never verbatim.
- Destructive invariants encoded and asserted: orphan-GC order = bays→list-delete→full-blank; full blank = exactly 40 records `[f,00,00]`; stale-field clears on full writes; 2-frame/483B ceiling respected by encoder chunk helper (compute, assert ≤483 per op payload).
- Pure SDK: no React/device/timer imports; all functions smoke-testable under node.
- Gates: sdk `tsc --noEmit` + `oxlint src`; client `tsc -b && vite build`; smoke 0 FAIL from `client/` with `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"`; count grows exactly (§57+); `void main();` anchor preserved.
- English copy; plain git, explicit paths, local main, never push; one commit per task.

## Review Focus

1. **Addressing ambiguity containment** — every byte that depends on layer-vs-slot interpretation comes from the MODULE_ADDR seam, nowhere else (reviewer greps for raw `[0,` module params outside the seam). → Tasks 1, 4.
2. **Encoder byte-exactness vs OF literals** — list add `00 05 05 01 10 <uuid16>`, delete `[slot] 00 00 00`, blank = 40×`[f,00,00]`, bay triple `01 4c 05 00`, two-word cat/selector u32LE pair, mouse mask M5=16. → Task 1.
3. **Planner refuses rather than guesses** — >8 distinct profiles → error; nothing-to-template → LayoutError message; base-bay gaps detected not silently flashed. → Task 3.
4. **Content match never trusts UUIDs** — ranking (differs, tie, name) deterministic; comparison by re-encoded bytes, not names; locked/firmware-default rows never count as drift. → Task 4.
5. **Overlay never invents fields** — template-copy + overlay of modeled fields only; unmodeled fields carried through; track shape check rejects wrong-shape config before write. → Tasks 2, 3.

---

### Task 1: `module-wire.ts` — encoders + addressing seam

**Files:**
- Create: `sdk/src/module-wire.ts`
- Modify: `sdk/src/index.ts` (barrel), `client/scripts/smoke.tsx` (§57)
- Test: smoke §57

**Interfaces:**
- Produces:
  - `MODULE_ADDR = { prefix: [0x00] as const }` + doc note (B12 reconciliation, Phase-10 probe) — single seam every module param flows through
  - `encodeModuleField(field: number, kind: 'none'|'setting'|'keypress'|'twoWord'|'mouseMask', value?: number|Uint8Array): Uint8Array` — `[field][type][len][value]`; setting = type 0x01 one byte; keypress = type 0x04 body bytes; twoWord = type 0x0f `cat u32LE + selector i32LE`; mouseMask = type 0x0f `3 u32LE + mask i32LE`; none = type 0x00 len 0
  - `MOUSE_MASK: Record<'M1'|'M2'|'M3'|'M4'|'M5', number>` = 1/2/4/8/16
  - `encodeListAdd(slot: number, listId: number, typeFlag: ModuleTypeCode, uuid: string): Uint8Array` — `00 [slot][listId][flag][10][uuid16 plain-hex-slice]`
  - `encodeListDelete(slot: number): Uint8Array` — `[slot] 00 00 00`
  - `encodeBlankConfig(): Uint8Array` — 40 records `[f, 0x00, 0x00]`
  - `MODULE_TYPE_CODE: {TOUCH:0, TRACK:1, TUNE:2, FLOAT:3}`
  - `bayRecord(pos: number, slot: number|0x78|0): Uint8Array` — `[pos][slot][0]` (the `014c0500` triple minus layer)
  - `chunkBudget(payload: Uint8Array): number` — frames needed under 242B chunking; assert helper used by planner
- Consumes: `uuidToBytes` (layers.ts).

- [ ] **Step 1: §57 failing asserts** — byte-exact literals: list add for slot 5/Track = `00 05 05 01 10 <uuid16>`; delete slot 3 = `03 00 00 00`; blank = 120 bytes, records `05 00 00`…; twoWord(4, −1) = `0f 08 04 00 00 00 ff ff ff ff`; mouseMask M5 = `0f 08 03 00 00 00 10 00 00 00`; bayRecord(0x4c, 5) = `4c 05 00`; setting(0x00, 72) = `00 01 01 48`; `assertWireAllowed(0x30,0x10,0x09)` + `(0x30,0x10,0x0a)` pass; chunkBudget 300B → 2.
- [ ] **Step 2: FAIL run.** **Step 3: Implement** (constants + pure functions, provenance header citing OF remap.py:395-537 + module_layout.py:45-46).
- [ ] **Step 4: PASS run (715 + N, 0 FAIL); sdk gates.**
- [ ] **Step 5: Commit `feat(sdk): module wire encoders + addressing seam — 100A/100C payloads, blank, bay bytes`.**

### Task 2: `module-fields.ts` + `module-profiles.ts` — data model + pure logic

**Files:**
- Create: `sdk/src/module-fields.ts` (vendored tables, provenance), `sdk/src/module-profiles.ts`
- Create: `sdk/src/module-field-map.source.json`, `sdk/src/stock-module-profiles.source.json` (verbatim OF copies w/ attribution headers — vendor-captured data, source-noted)
- Modify: barrel, smoke §58
- Test: smoke §58

**Interfaces:**
- Produces (module-fields): `MODULE_TYPES`, `FIELD_MAP` (per type: field→{kind, gesture, axis?, direction?, mask?}), `AXIS_HALVES`, `SETTING_FIELDS` (incl Tune 0x05 degrees-per-detent conversion `ticksToWire = round(360/n)`), `FIRMWARE_DEFAULTS` + `LOCKED_GESTURES`, `PAIRED_GESTURES` (dial 0x23/0x22), `splitPair(code)` (last two parts), `conventionSign(cat, selector, convention)` (FLIPPED_ON_WINDOWS={4}).
- Produces (module-profiles): `ModuleProfile {id, name, type, variant?, settings, bindings, capturedFrom?}`, `StockProfiles` (4 seeded), `overlay(template: ConfigRecords, profile, type): ConfigRecords` (copy + modeled overlay, unmodeled carried), `encodeAxis(halves, invert, convention)` (selector swap + sign flip), `compareRecords(a, b)` (byte-compare via re-encode), `diffProfile(profile, records, type): DiffRow[]` (locked/never-drift honored), `parseModuleProfileFile(obj)`/`buildModuleProfileFile(profile)` (openflow.module-profile v1 shape, import-validations: unknown type → error, all-foreign-gestures → error, partial → skipped list).
- [ ] **Step 1: §58 failing asserts** — ticksToWire(10)=36, ticksToWire(4)=90; AXIS_HALVES TUNE vert = 0x0A/0x0B cat 4 (the reversed-order fact); splitPair('C_VOL_DOWN - C_VOL_UP') = [CCW, CW]; conventionSign cat4 −1 mac vs windows flipped, cat6 untouched; FIRMWARE_DEFAULTS locked set; overlay carries unmodeled field bytes untouched; encodeAxis invert swaps halves; diffProfile: locked row drift ignored, keypress diff counted; parse file: Touch file into TRACK profile → error 'belongs to another type'; stock profile count 4 + TRACK_LEFT buttons M1/M3/M2/M4.
- [ ] **Step 2-4: red → implement → green; sdk gates.**
- [ ] **Step 5: Commit `feat(sdk): module field maps + profile model — vendored tables, overlay/axis/compare, openflow.module-profile io`.**

### Task 3: `module-planner.ts` — slot lifecycle + queue ops

**Files:**
- Create: `sdk/src/module-planner.ts`
- Modify: `sdk/src/queue.ts` (new helpers queueModuleConfig, queueModuleListAdd/Delete, queueBayAssignment), `sdk/src/draft.ts` (op kinds `moduleCfg`/`moduleList` — bay assignment reuses existing `key` op kind at KK 0x4A-0x51 with bayRecord payload), barrel, smoke §59
- Test: smoke §59

**Interfaces:**
- Produces:
  - `planModuleLayout(profiles, deviceList, deviceBays): PlanResult { assignments: slot→profileId; ops: PlannedOp[]; reclaimed: number[]; baseBayGaps: string[]; error?: string }` — uuid-keep, capture-claim (capturedFrom), allocate lowest free 1..7, reclaim unreferenced when full, refuse when >8 distinct; template rule: new slot needs a same-type source on device or in stock → else error 'Dock the module and read the keyboard first'
  - `missingBaseBays(bays)` — touch/track/tune L/R required on layer 0, float exempt
  - `orphanGcOps(orphans, bays)` — ordered: bay-mutations (slot→0) FIRST, then list-deletes, then FULL blanks LAST
  - queue helpers: `queueModuleConfig(draft, slot, records, label)` (chunk-budgeted: >483B → drop with reason); `queueModuleListAdd/Delete`; `queueBayAssignment(draft, layer, pos, slot|'inherit'|'off')` → key op with bayRecord (0x78/0x00 semantics)
  - draft: `ModuleCfgOp {kind:'moduleCfg', slot, payload, label}`, `ModuleListOp {kind:'moduleList', payload, label}` — opKey `moduleCfg:{slot}:{hex}` / `moduleList:{hex}`; section 'modules'; stats frames = chunkBudget, bytes accordingly; reconcile keeps (no readback); probeDraft: slot ≤7 + payload ≤483 + record count ≤40 for cfg
- [ ] **Step 1: §59 failing asserts** — plan keeps existing uuid slots; capture claims; allocates 1..7 lowest; reclaim reported when full; refuses 9 distinct; missingBaseBays detects gap; orphanGcOps order pinned (bay ops first, blanks last, blank = 40 records); queueModuleConfig 500B → drop with reason 'exceeds 2-frame budget'; bay assignment op payload = `4c 05 00`-shaped record at KK 0x4c; probe catches slot 8.
- [ ] **Step 2-4: red → implement → green; sdk gates.**
- [ ] **Step 5: Commit `feat(sdk): module planner — slot lifecycle, orphan-GC ordering, queue ops, base-bay gate`.**

### Task 4: read path — 1009 list + content match + capture

**Files:**
- Modify: `sdk/src/naya.ts` (readModuleList via readMultipart(0x09), addressing via MODULE_ADDR seam; readModuleConfig re-exported through seam), `sdk/src/module-profiles.ts` (matchSlots, captureFromSlots, repointBays), barrel, smoke §60
- Test: smoke §60

**Interfaces:**
- Produces:
  - naya.ts: `readModuleList(): Promise<Uint8Array>` — multipart 0x09, empty index; parse in module-profiles
  - `parseModuleList(blob): {slot, typeFlag, uuid}[]` — entries `[slot][id][flag][10][uuid16]`, tolerant trailing
  - `matchSlots(list, slotRecords, profiles): MatchResult[]` — per slot: closest by (differs, tie[uuid-share 0 / capturedFrom 1 / else 2], name), compared under each candidate's OWN convention, `_same_record` byte compare; matched = differs 0
  - `captureFromSlots(list, slotRecords, profiles, sourceName): {profile, slot}[]` — new uuid, '<source> (on board)' numbered, capturedFrom = slot uuid, seeded from closest + overrides, entries rebuilt
  - `repointBays(bays, fromId, toId)`
- [ ] **Step 1: §60 failing asserts** — parseModuleList literal `[05][05][01][10]<uuid>` → entry slot 5 Track; match: drifted original names its own entry (uuid tie), foreign slot matches by content with type byte; capture: creates numbered profile, capturedFrom set, no inherited diff rows; repoint moves one profile's bays only; readModuleList smoke via scripted session (like §56 pattern) incl. addressing-seam param bytes.
- [ ] **Step 2-4: red → implement → green; sdk gates.**
- [ ] **Step 5: Commit `feat(sdk): module read path — 1009 list, content match, capture-on-read, bay repoint`.**

### Task 5: docs

**Files:**
- Modify: `HANDOFF.md` (ROADMAP phase-5a entry — 5a core done, 5b UI pending; addressing-pin note in known-limitations), `README.md` (nothing user-visible yet — no line, or extend modules bullet if accurate)

- [ ] **Step 1: Edits (claims verified against code).**
- [ ] **Step 2: Full gate; commit `docs: module profiles 5a — HANDOFF roadmap + addressing-pin note`.**
