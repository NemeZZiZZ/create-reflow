# Flash Capability Model (Phase 4) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No silent capability losses — every binding the app cannot express becomes a reasoned drop (pre- and post-flash), layer reads distinguish unreadable from empty, and the export counter stops crying wolf.

**Architecture:** Three additions, all OF-parity: (1) `Draft.drops` ledger filled at queue time + a pure `probeDraft` re-validation for the pre-flash list; (2) read-status taxonomy threaded out of `readMultipart` (`{blob, status}`) into `LayerDump` and the flash verdict (third flavor "cannot verify"); (3) `counts.unknown` deflation in openflow.ts. NACK semantics stay ABORT (OF parity) but messages become structured.

**Tech Stack:** TS strict, pnpm workspace, oxlint, rolldown node smoke (§ blocks; last used §54; baseline 654 ok / 0 FAIL).

**Spec:** `docs/superpowers/specs/2026-10-10-openflow-port-program.md` — Phase 4 section. OF sources verified in research: flash.py:205-411, keymap_read.py:508-526, FlashButton.jsx:306-401.

## Global Constraints

- NACK handling stays ABORT-FLASH (OF parity, flash.py:1259-1267); the ONLY non-throwing op remains `layers` (existing `layersNack`). Drops come from queue-time refusals and probe-time re-validation — never from continuing past a NACK.
- Effect sentences (English, fixed): primary `this key keeps whatever the keyboard already had on it`; module/gesture/layer refusals use their domain noun (`this module keeps its current bindings`, `this layer list change was not queued`).
- `Draft.drops` is a ledger, not errors: recording a drop never throws.
- Read-status vocabulary (exact strings): `'ok' | 'empty' | 'unsupported' | 'unknown:0x..'` (port of OF chunk_status; 0x16/0x18 no-data → 'empty'; 0x11 → 'unsupported'; healthy body → 'ok'; anything else → `unknown:0x{hex}`).
- Gates: sdk `tsc --noEmit` + `oxlint src`; client `tsc -b && vite build` + oxlint touched; smoke 0 FAIL from `client/` (`export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"`); count grows exactly from 654; § blocks appended before `void main();` anchor.
- UI copy English; App.tsx wiring-only; plain git, explicit paths, local main, never push.

## Review Focus

1. **A no-data layer (0x16 at part 0) must parse as empty, not runaway** — today `readMultipart` throws 'runaway parts'; the fix stops at part 0 with status 'empty'. → Task 2 step 1.
2. **A queue-time refusal must both return `{queued:false}` (existing callers) AND append a drop** — one without the other breaks either the toast path or the ledger. → Task 1 step 1.
3. **Deflation must not hide real unknowns** — filler `[kk,07,00]` and 'empty' catalog match export `bindings: []` with NO count; a genuine matchAction miss still counts `unknown`. → Task 1 step 1.
4. **'cannot verify' sits strictly between ok and partial** — a layer whose post-flash status is unsupported/unknown must not mark the flash 'fail' (dump ladder exception today) nor claim 'verified'. → Task 3 step 1.
5. **probeDraft must not mutate the draft** — pure walk; double-run gives identical output. → Task 1 step 1.

---

### Task 1: `Draft.drops` + `probeDraft` + `counts.unknown` deflation

**Files:**
- Modify: `sdk/src/draft.ts` (DraftDrop interface, `drops` array, `clear()` empties it, `probeDraft`), `sdk/src/queue.ts` (refusal sites append drops), `sdk/src/openflow.ts` (deflation), `sdk/src/index.ts` (exports)
- Test: smoke §55

**Interfaces:**
- Produces:
  - `export interface DraftDrop { layer?: number; kk?: number; opKey?: string; reason: string; effect: string; at: 'queue' }`
  - `Draft.drops: DraftDrop[]`; `Draft.clear()` resets it; drops dedup by `reason+layer+kk` (same refusal twice = one entry).
  - `export function probeDraft(d: Draft): DraftDrop[]` — pure: re-walks ops (bounds re-check per op kind; `key`/`led` ops for layers absent from `layers` set → drop 'no live record at this key' when probe given cache; minimal: no-cache mode returns only bounds/shape findings). Simplest honest scope: probe validates invariants already decidable from the draft alone (record lengths, kk ranges, layer window) — NO cache parameter this phase.
  - queue.ts refusal sites (queueAction skip, queueBehaviorSet error, queueModuleGesture error, queueLayerAdd/Delete errors) append `{reason: <validator message>, effect: <domain sentence>}` before returning `{queued:false,error}`.
  - openflow.ts `bindingsFor`: known-empty families (`fillerRecord` shape `[kk,07,00]`, `[kk,00,00]`, and matchAction hit on `'empty'` action) → `bindings: []` with no count increment; real misses still `unknown++`.

- [ ] **Step 1: Write failing §55** — queue a behavior-set violation → `{queued:false}` AND `draft.drops.length === 1` with reason matching the chain message + effect sentence; dedup double-queue → still 1; queueAction no-record path unchanged (still silent — no drop: it's not a refusal the user made, probe can't know); probeDraft: draft with one invalid hand-built op (e.g. key op kk 999) → 1 finding; probeDraft twice → identical; healthy draft → `[]`; deflation: build from cache with filler + empty-slot records → `counts.unknown === <only real misses>`, bindings `[]`; genuine miss → still counted.
- [ ] **Step 2: RED run.** **Step 3: Implement.** **Step 4: GREEN (654 + N).**
- [ ] **Step 5: Barrel + sdk gates + commit `feat(sdk): capability drops ledger + probe + export-count deflation`.**

### Task 2: read-status taxonomy out of `readMultipart`

**Files:**
- Modify: `sdk/src/naya.ts` (chunkStatus, readMultipart → `{blob,status}`, readLayer/readLedmap/readModuleConfig wrappers), `client/src/hooks/useLayers.ts` (LayerDump carries `status: Record<number,string>`), smoke §56
- Test: smoke §56

**Interfaces:**
- Produces: `export function chunkStatus(body: Uint8Array): 'ok' | 'empty' | 'unsupported' | \`unknown:0x${string}\`` (body-based: non-empty → 'ok'; [0x16] or [0x18] → 'empty'; [0x11] → 'unsupported'; else unknown). `readMultipart(cat, layer)` returns `{blob: Uint8Array, status: string}` — status 'empty' returns empty blob WITHOUT the runaway walk; 'unsupported'/'unknown' return `{blob: empty, status}` without throwing (callers decide); healthy path unchanged. `readLayer/readLedmap` return `{blob,status}`; `LayerDump` gains `status: Record<number,string>` keyed by layer ('ok' default for reads that succeeded).

- [ ] **Step 1: Failing §56** — chunkStatus literals ([0x16]→'empty', [0x11]→'unsupported', [00 00 10 …]→'ok', [0x55]→'unknown:0x55'); readMultipart with a fake session replying bare `[0x16]` → status 'empty', blob length 0, NO 'runaway' throw (smoke fakes transport by calling chunkStatus-bearing path directly or refactoring readMultipart to accept frames — implementer's choice, assert the taxonomy + no-throw); useLayers LayerDump type carries statuses.
- [ ] **Step 2: RED.** **Step 3: Implement** (keep `Frame`/partMatcher behavior for healthy multipart; status exits short-circuit before partMatcher). **Step 4: GREEN + client tsc.**
- [ ] **Step 5: Commit `feat(sdk): layer read-status taxonomy — empty ≠ unreadable, no-data no longer runaways`.**

### Task 3: FlashDialog drop report + structured aborts + 'cannot verify'

**Files:**
- Modify: `client/src/components/FlashDialog.tsx` (pre+post drop Notice, capped 6 + 'those keys keep what they have'), `client/src/hooks/useFlash.ts` (FlashState `drops?: DraftDrop[]`; NACK abort messages `'{opSummary} — device refused the value (0xEA): nothing was stored'` / `'{opSummary} — bad or missing ack ({hex})'`; verdict 'cannot-verify' when post-flash layer status unsupported/unknown, message names layers), `client/src/App.tsx` (wiring only if needed)
- Test: client gates + code reading

**Interfaces:**
- Consumes: `probeDraft`, `Draft.drops`, LayerDump statuses.
- Produces: pre-flash section `"{n} change(s) cannot be written"` (warn tone, list capped 6 + overflow, closing 'Everything else in this flash is unaffected; those keys keep what they have.'); post-flash same list when drops exist (verdict line still reports confirmed counts); third verdict flavor surfaces as `'cannot verify'` status line naming the unreadable layers; abort messages per above (thrown → 'fail' phase, message carries structure).

- [ ] **Step 1: Implement UI + hook changes** (probe on dialog open; drops from state post-flash).
- [ ] **Step 2: Full gates** (build, smoke 654+N unchanged-or-grown, oxlint).
- [ ] **Step 3: Commit `feat(client): flash drop report, structured NACK aborts, cannot-verify verdict`.**

### Task 4: docs

- [ ] **Step 1:** HANDOFF — roadmap phase-4 ✅ entry; native-format note: counts.unknown semantics change (deflated) + read-status vocabulary; README one line.
- [ ] **Step 2: Full gates; commit `docs: flash capability model — HANDOFF/README`.**
