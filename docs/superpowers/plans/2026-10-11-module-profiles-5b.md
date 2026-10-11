# Module Profiles 5b — Client UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Phase-5a module-profile SDK into the client: profile store + read/capture flow, flash-executor dispatch with template-read ordering, ModulesTab editing UI, per-layer bay picker, and `.openflow-module-profile` import/export.

**Architecture:** New `useModuleProfiles` hook (persistence + device read via `readModuleList`/`matchSlots`/`captureFromSlots`) slots into App's hook pattern. The flash executor gains `moduleCfg`/`moduleList` dispatch (pre-encoded payloads, self-remove on ACK) plus a pre-loop template-read step. ModulesTab is rewritten around the profile model; the bay picker rides existing key ops. Research facts: `.superpowers/research-5b-report.md`.

**Tech Stack:** TS strict, React 19 hooks, radix primitives, sonner toasts, pnpm workspace, rolldown node smoke (baseline 939 ok / 0 FAIL; §57-§60 cover the 5a API).

**Spec:** master spec `docs/superpowers/specs/2026-10-10-openflow-port-program.md` Phase 5 (5b section) + Phase-5a binding conditions [a]-[e] carried below.

## Global Constraints

- 5a binding conditions (BINDING): (a) `queueBayAssignment` window guard `0 | 0x78 | 1..7` else refuse-with-drop + `orphanGcOps` slot-0 guard (both, start of Task 4); (b) template-read ordering — executor reads template records from ALL `templateSources` slots BEFORE sending any `moduleList`/`moduleCfg` op (probe A proved overwrite hazard); (c) chunkBudget↔writer parity assert when the executor lands (Task 2); (d) plan-errata: 5a plan text stale on none-type/blank-size — code+smoke are right; (e) `readModuleConfig` 30/100B is the third addressing site (Phase-10).
- moduleCfg ACK echo shape is UNPINNED (100C opens bare slot) — Task 2 pins a conservative gate (`payload[0] === 0x00` OR echo of `o.slot`), flagged for Phase-10 live verification; `moduleList` adds/deletes are NOT idempotent → throwing nackMessage (not layers-style).
- Bay writes are plain `key` ops at KK 0x4A-0x51 — NO executor change; preview/dirtyKks/reconcile ride existing paths.
- English UI copy; App.tsx wiring-only; hooks hold logic, components markup; confirm-gated destructive actions (delete profile in use, flash already gated).
- Gates: sdk `tsc --noEmit` + `oxlint src`; client `tsc -b && vite build` + oxlint touched files; smoke 0 FAIL from `client/` with `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"` (count grows only where the plan says so; `void main();` anchor preserved).
- VCS: plain git, explicit paths, local main, never push. Client UI verified by build+lint+code-review (no client unit harness — standing ruling).

## Review Focus

1. Template-read ordering is a hard precondition: no `moduleList`/`moduleCfg` op may be sent before every needed template slot is read — reviewer traces the pre-loop step executes before the write loop and that plan failures abort before any write. → Task 2.
2. Executor self-remove only on ACK; NACK on moduleList/moduleCfg aborts (throwing); queuedOpLayer stays null; reconcile untouched. → Task 2.
3. Bay window guard: values outside `0|0x78|1..7` refuse-with-drop; slot-0 guard in orphanGcOps. → Task 4.
4. Profile store survives reload (lazy validated parse), clears on left-disconnect, never corrupts on malformed JSON. → Task 1.
5. Locked gestures render inert; split/invert semantics match 5a tables (invert = TRACK axis only, not split). → Task 3.

---

### Task 1: `useModuleProfiles` hook + persistence

**Files:**
- Create: `client/src/hooks/useModuleProfiles.ts`
- Modify: `client/src/App.tsx` (hook wiring, onLeftCleared)
- Test: client build+lint; smoke untouched (count 939)

**Interfaces:**
- Consumes: `readModuleList`/`matchSlots`/`captureFromSlots`/`repointBays`/`ModuleProfile`/`BayAssignments` (sdk), `parseModuleConfig` records path NOT needed (matchSlots works on raw slot records via `recordsFromModuleBlob`).
- Produces: `useModuleProfiles({sesRef, busyRef, log}): { profiles, bays, live (slot→{matched, differs, gestures}), readAll(), setBinding(profileId, gesture, half, binding|null), setSetting(profileId, key, value), setBay(layer, pos, profileId|'inherit'|'disabled'), addProfile(from?), deleteProfile(id), renameProfile(id, name) }`; persistence keys `naya-module-profiles` + `naya-module-bays` (useCustomColors pattern: lazy validated parse + explicit sync save); readAll = busyRef-gated `readModuleList(ses)` → `matchSlots(profiles, slots)` → new captures via `captureFromSlots` + `repointBays` (bays state follows matched profile), toast on captures.

- [ ] Step 1: Implement hook per interfaces (all state local; save on every mutation; clear live+bays device state on left-disconnect via App's onLeftCleared).
- [ ] Step 2: Wire in App (hook at top, ModulesTab props replaced in Task 3; here only App compiles).
- [ ] Step 3: Gates (build+lint+smoke 939 unchanged). Commit: `feat(client): module profile store — useModuleProfiles hook with capture-on-read`.

### Task 2: Executor dispatch + template-read pre-step

**Files:**
- Modify: `client/src/hooks/useFlash.ts` (+ small sdk exports if recordsFromModuleBlob not yet public), `client/scripts/smoke.tsx` (§61 — only SDK-side additions need asserts)
- Test: smoke §61 grows

**Interfaces:**
- Consumes: `planModuleLayout`/`templateSources`/`overlay`/`recordsFromModuleBlob`/`encodeModuleConfig` (sdk).
- Produces: `moduleCfg` dispatch `ses.cmd(0x30,0x10,0x0c,o.payload)` ACK `payload[0]===0x00 || payload[1]===o.slot` (conservative, Phase-10 flag) + self-remove; `moduleList` dispatch `(…,0x0a,…)` ACK same shape + self-remove, NACK throws; pre-loop step after handshake: for each queued moduleCfg/moduleList op set, run planner against live state (profiles+bays from draft-consuming hook args — take as `useFlash` options `modules?: {profiles, bays, live}`), read ALL templateSources slots, overlay, REPLACE the pending moduleCfg records with the overlaid ones, log the plan (slots allocated/reclaimed/gaps) — plan error → abort before any write with structured message.

- [ ] Step 1: §61 failing asserts first for any new pure sdk helper (chunkBudget↔payload frames parity: one moduleCfg payload length → expected frame count).
- [ ] Step 2: Implement dispatch + pre-step; conservative ACK gate commented UNPINNED Phase-10.
- [ ] Step 3: Gates. Commit: `feat(client): module flash dispatch — template-read ordering, moduleCfg/moduleList executor`.

### Task 3: ModulesTab rewrite

**Files:**
- Rewrite: `client/src/components/tabs/ModulesTab.tsx` (keep ModuleRow/badge idioms per research)
- Modify: `client/src/App.tsx` (prop wiring), maybe new `client/src/components/tabs/modules/GestureRow.tsx` + `ModuleBindingDialog.tsx`
- Test: build+lint; smoke untouched

**Interfaces:**
- Consumes: Task-1 hook API.
- Produces: profile rail (name, type badge, live/dirty indicator, add-rename-delete with in-use confirm), per-target tabs (button/finger targets from FIELD_MAP), GestureRow (binding label, `on device`/`device: X` badge from live gestures, locked rows inert `<firmware behavior> (firmware)`, Track holds 'not settable'), split checkbox (seeds halves from combined, unsplit rebuilds), invert toggle (TRACK axis only, not split), mini binding dialog (None / Mouse M1-M5 / Key via embedded ActionPalette), Settings tab with 'Use the keyboard's value' adopt. Edits mutate the hook store (not the draft — draft ops come only from flash planning in Task 2/queueBayAssignment).

- [ ] Step 1: Implement per interfaces (English copy; existing component style).
- [ ] Step 2: Gates. Commit: `feat(client): module profile editing — rail, gesture rows, split/invert, settings adopt`.

### Task 4: Bay picker + guards

**Files:**
- Modify: `sdk/src/queue.ts` (window guard), `sdk/src/module-planner.ts` (slot-0 guard), `client/scripts/smoke.tsx` (§59 ext asserts), `client/src/components/KeyboardCard.tsx` or `BindingsTab.tsx` (picker UI), `client/src/App.tsx` (wiring)
- Test: smoke grows

**Interfaces:**
- Consumes: `queueBayAssignment`, `BAY_POSITIONS`, hook `bays` + `setBay`.
- Produces: window guard (0|0x78|1..7 else `{queued:false}` + addDrop) + orphanGcOps slot-0 skip (+2 §59 asserts); bay picker UI: per-layer six radios (touch/track/tune L/R + inherit/disabled) showing live badge, queues via setBay → hook queues queueBayAssignment into draft (rides key ops); base-bay gap warning surfaces `missingBaseBays` result before flash.

- [ ] Step 1: §59 failing asserts (window refuse, slot-0 no-op).
- [ ] Step 2: Implement guards + UI; gates. Commit: `feat(client): per-layer bay picker — window+slot-0 guards, base-bay gap warning`.

### Task 5: Import/export + delete-in-use

**Files:**
- Modify: `client/src/App.tsx`, `client/src/components/SaveMenu.tsx` (profiles section), `client/src/hooks/useModuleProfiles.ts` (import/delete semantics)
- Test: build+lint; smoke untouched

**Interfaces:**
- Consumes: `buildModuleProfileFile`/`parseModuleProfileFile`, `saveJson`.
- Produces: SaveMenu per-profile export items (`<name> (.openflow-module-profile.json)`); import via the single hidden input flow (accept sniff; always-new profile, toast `skipped` list count; empty-bindings leniency = accept + info toast); delete-in-use confirm names layers, refuses last profile of a type.

- [ ] Step 1: Implement; Step 2: gates. Commit: `feat(client): module profile import/export — openflow.module-profile io, in-use delete guard`.

### Task 6: Docs

**Files:**
- Modify: `HANDOFF.md`, `README.md`
- Steps: ROADMAP 5b ✅ entry (module phase complete); native-format note: module profiles in `naya-module-profiles` store, `.openflow-module-profile` io, template-read ordering documented, ACK-gate-unpinned note; README one line.
- Gates; commit: `docs: module profiles 5b — HANDOFF roadmap + README`.
