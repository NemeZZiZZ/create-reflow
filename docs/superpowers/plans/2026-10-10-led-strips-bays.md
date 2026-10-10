# LED Strips & Module-Bay Painting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paint the full 136-LED span — 14 edge-strip LEDs (74-87) individually and 2 module bays as one swatch per side (stamping 24 LEDs each) — with OpenFlow-file strip colors now round-tripping.

**Architecture:** SDK gets the semantics fixes (strip colorHex parse/export in `openflow.ts`, fill range gate, `queueBayColor` block helper) — the wire path (`queueColor`/`writeLed`/`parseLedmap`/`reconcile`) already spans kk 0..135. Client renders strip columns flanking the halves and bay swatches in place of the static docks, ledMode-gated, wired into the existing paint pipeline. Per-LED writes stay (no bulk op — see Global Constraints).

**Tech Stack:** TS strict, pnpm workspace, oxlint, rolldown node smoke (last used §53; baseline **625 ok / 0 FAIL**).

**Spec:** `docs/superpowers/specs/2026-10-10-openflow-port-program.md` — Phase 3. LED layout (OF-measured, flash.py:30-82): kk 0-73 keys · 74-80 RIGHT edge strip · 81-87 LEFT edge strip · 88-111 LEFT bay · 112-135 RIGHT bay.

## Global Constraints

- **Per-LED writes only** — no bulk/2-frame LED op (ledger ruling: consistent with existing fill + reconcile per-op semantics; avoids introducing 2-frame writes near the 3.28.7 wedge hazard; 136-frame worst case is established behavior).
- **Fill = keys + strips only**: `queueFillLayer` filters `kk <= 87` (OF semantics, flash.py:252-266 — bays excluded; they have their own swatch). Fixes today's accidental 136-op fill.
- **Bays = one color per side per layer, stamped across the 24-LED block** (`queueBayColor`; free-painted, NOT derived from module profiles — OF parity). Pipette on a bay reads `ledmap.get(88 | 112)`.
- **OF file interop**: strips 74-87 round-trip as ordinary `colorHex` (OF parity, LAST_KEYED_LED=87); bays 88-96 = SILENT skip in parse (OF files carry only stale `#xxxxxx` placeholders there; OF's own flash refuses to write them; bay colors have no OF-field — documented skip, parity with OF which also loses them).
- Strips render **only in ledMode** — Bindings view board untouched.
- Gates: sdk `tsc --noEmit` + `oxlint src`; client `tsc -b && vite build` + oxlint touched files; smoke 0 FAIL from `client/` with `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"`; count grows exactly by the new §54 asserts.
- UI copy English; App.tsx wiring-only; plain git, explicit paths, local main, never push.

## Review Focus

1. **Strip round-trip byte-exact** — OF doc with strip colorHex at 74/80/87 → parse → LedRec; export → same colorHex back (§54).
2. **Fill must not paint bays** — 136-rec input → exactly 88 ops, all kk ≤ 87 (§54; regression trap: today's fill queues 136).
3. **queueBayColor stamps exactly 24 ops** in the right span per side, single (h,s) (§54).
4. **Strips/bays render only in ledMode** — Bindings view identical; client, reviewer-verified by code reading.
5. **No warning-consumer breakage** — strips warning removed (now parsed), bays silenced; importers/backups warning flows still typecheck and §48/§50/§52 asserts stay green.

---

### Task 1: SDK — strip round-trip, fill gate, bay helper

**Files:**
- Modify: `sdk/src/openflow.ts` (parse strips; export strip colorHex; bay silent skip), `sdk/src/queue.ts` (fill filter + `queueBayColor` + `BAY_LED_RANGES`), `sdk/src/index.ts` only if re-exports need it
- Test: `client/scripts/smoke.tsx` — new `// §54 LED strips + bays`

**Interfaces:**
- Produces:
  - `BAY_LED_RANGES: { left: readonly number[]; right: readonly number[] }` (left = 88..111, right = 112..135)
  - `queueBayColor(draft: Draft, layer: number, side: 'left' | 'right', h: number, s: number): void` — queues exactly 24 `led` ops (one per block kk, all same h/s)
  - `queueFillLayer` — signature unchanged; now filters recs to `kk <= 87`
  - `parseOpenFlowLayer`: pos 74-87 with `colorHex` → `maps.leds` entries (hexToHs, null-safe); no strip warning; pos 88-96 → silent skip (no warning, no record)
  - `buildOpenFlowLayer`: pos 74-87 emit `colorHex` from ledByKk when present; pos 88-96 unchanged (placeholder rows, no colorHex)

- [ ] **Step 1: Write failing §54** (before `void main();`, verify count grows from 625):
  - parse fixture doc with strip colors `#ff0000` at 74, `#00ff00` at 87 → `maps.leds` holds both (h/s from `hexToHs`); no warning matches /strip/;
  - export from ledByKk {74: h/s of #ff0000} → keys[74].colorHex === `'#ff0000'`; keys[75] no colorHex; keys[88..96] no colorHex;
  - round-trip: build(anim 'solid', leds incl. 74/87) → parse → same h/s back;
  - `queueFillLayer` on 136-rec input → draft led ops for kk 0..87 only (count 88, max kk 87);
  - `queueBayColor(draft, 1, 'left', 30, 90)` → exactly 24 ops, kk span [88,112), all h 30 s 90; `side:'right'` → [112,136);
  - existing §48/§50/§52 asserts untouched and still passing (strip-skip warning asserts updated: old /no writable device store/ strip asserts move to bay-silent or are removed — keep bay count out of warnings entirely).
- [ ] **Step 2: Run — FAIL (missing exports / wrong counts).**
- [ ] **Step 3: Implement** — parse: move `hexToHs` read above the range branch, strips → led entry, bays → `continue` with no counter; export: extend `pos <= 87` for colorHex emission (keys 88+ stay binding-less/no-color); queue: `BAY_LED_RANGES` literal arrays; `queueBayColor` loops the range; fill filter inside `queueFillLayer`.
- [ ] **Step 4: Run — 0 FAIL, count = 625 + new asserts.**
- [ ] **Step 5: sdk gates; commit:** `git add sdk/src/openflow.ts sdk/src/queue.ts sdk/src/index.ts client/scripts/smoke.tsx` → `feat(sdk): LED strip round-trip + bay block helper + fill range gate`.

### Task 2: Client — strip columns + bay swatches

**Files:**
- Modify: `client/src/components/Keyboard.tsx` (strip columns flanking halves, bay swatches replacing static docks — both ledMode-gated), `client/src/components/tabs/LedTab.tsx` (bay paint/pipette handling)
- Test: client gate (build + lint + smoke unchanged count) + code review

**Interfaces:**
- Consumes: `queueBayColor`, `BAY_LED_RANGES` (Task 1); existing `onSelect`/`onPaint`/`dirtyKks` pipeline (kk ≥ 74 already accepted by `queueColor`/draft).
- Produces: Keyboard renders, when `ledMode`, two strip columns (right edge kks 74-80 adjacent to the right half; left edge kks 81-87 adjacent to the left half; individual LED dots, clickable + drag-paintable via existing `onPaint(kk)`), and two bay swatch buttons in the middle (replacing the static `dock` divs; click → `onBayPaint(side)`; tooltip names the side). New prop `onBayPaint?: (side: 'left' | 'right') => void`. Non-ledMode rendering byte-identical to today.

- [ ] **Step 1: Keyboard.tsx** — strip dots styled like existing key dots (compact, `w-2 h-4`-ish), background from `ledmap.get(kk)` via existing per-key color logic (`ledCss`), dirty ring from `dirtyKks`; bay swatch background from `ledmap.get(side === 'left' ? 88 : 112)`, aria-label `Left module bay` / `Right module bay`.
- [ ] **Step 2: LedTab.tsx** — bay click routing: pipette → `setColor(ledmap.get(88|112))` (no-op when absent); brush/fill → `queueBayColor(draft, layer, side, color.h, color.s)`; strips go through existing `toolClick`/`paintKey` unchanged.
- [ ] **Step 3: Full gate** — `pnpm build` 0, smoke 0 FAIL (count unchanged from Task 1), oxlint both files 0 errors.
- [ ] **Step 4: Commit:** `feat(client): paint LED strips and module bays — ledMode board extension`.

### Task 3: Docs

**Files:**
- Modify: `HANDOFF.md` (ROADMAP phase-3 ✅ with commits; Native-format section: strips round-trip, bays documented skip, OF-parity note that OF also loses bay colors), `README.md` (one line: full 136-LED painting).

- [ ] **Step 1: Edits; full gate; commit:** `docs: LED strips/bays painting — HANDOFF/README`.
