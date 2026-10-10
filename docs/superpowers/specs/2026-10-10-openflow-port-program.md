# OpenFlow Port Program — Master Spec (Phases 2–10)

Date: 2026-10-10 · Authority: `docs/research/2026-10-10-openflow-gap-analysis.md` (gap analysis vs OpenFlow v0.7.0, clone at `~/Repository/openflow`) · Predecessor: Phase 1 (OpenFlow JSON native format) ✅ DONE 2026-10-10, commits `9678e91..a4445ce`

**Goal:** Port every web-portable mechanic OpenFlow has and we lack, in dependency/value order, one phase = spec-extract → plan → SDD execution → green gate → local commit(s).

**Owner decisions (2026-10-10, binding):**
1. **Firmware flashing via SMP over WebSerial: INCLUDED, last code phase** (Phase 9), with OpenFlow-grade interlocks (sha256 catalog, arm-token, per-half consent, undock-modules gate). Brick-risk acknowledged.
2. **TOGGLE/FORCE/STICK layer keys: LIVE verification session with owner, at the very end** (Phase 10) — owner will be at the keyboard; we verify ORDER bytes on-device, then implement. Until then: import keeps skip+warning (current behavior).
3. **Execution: sequential, in-session** (subagent-driven per phase, local main, plain git, explicit paths, never push).
4. Excluded (confirmed earlier or by nature): macros UI (web can't inject HID; format slot only), Smart Integrations (desktop-only), NayaFlow user-data.db import (clean-break decision), Naya key-geometry artwork copy (licensing).

**Standing rules across all phases:**
- Wire safety: only whitelisted verbs in NayaSession; every NEW wire verb a phase introduces (30/1002, be/1009/100A, fe/1008/1009, fe/1005, fa/*, MCUboot SMP) gets: protocol write-up from OF sources first, assertWireAllowed verdict, confirm-gating in UI where destructive, smoke byte-exact asserts on frame shape.
- Licensing: port KNOWLEDGE from Apache-2.0 repo, not code; app-shortcuts.json is MIT — ship ATTRIBUTION + source note; vendor-captured dictionaries (module field maps, BLE layout) get provenance comments like host-table.source.txt.
- UI copy English; App.tsx stays wiring-only (hooks + components); smoke grows per phase (gate = 0 FAIL); sdk/client gates from `client/` (CWD gotcha in project memory).
- Each phase ends: task reviews PASS + final gate green + explicit-path commit(s) on local main. No push. No hardware writes without owner present (Phase 10 is the sanctioned live session; anything needing live verification that surfaces earlier gets parked to Phase 10 with a ledger ruling).
- Phase order may swap ONLY by owner decision or a load-bearing blocker (ledger-recorded ruling).

---

## Phase 2 — Layer management (30/1002) + lighting restore

**What:** Create/delete layers in UI (currently useLayers read-only); layer-list draft op + wire write 30/1002 (add entry `[idx][id][anim][10][uuid16]`, delete form, sent twice per OF capture); end-of-flash full layer-list rewrite = lighting restore (clears runtime LED-effect wedge both halves); layer identity by UUID, names app-side.
**OF sources:** `remap.py:294-344`, `keymap_read.py:534-555`, `flash.py:1057-1075`, `service.py:1189-1213`.
**Ours:** queue.ts (new layerlist op kind), draft.ts, useLayers, App Save/layer UI, FlashDialog tail step, smoke.
**Exit:** add/delete layer on device read-back verifies; flash ends with layer-list rewrite (asserted in smoke byte-exact); recipes lights-wrong-after-flash updated to point at automatic restore.
**Size:** M-L.

## Phase 3 — LED strips & module-bay painting UI

**What:** LedTab paints full 136-LED span — keys 0-73 (have), strips 74-87, per-module 24-LED blocks 88-135; pipette works on module blocks; import/export round-trips strips (OpenFlow docs carry strip colors; bays still placeholder per Phase-1 findings).
**OF sources:** `Color.jsx:83-125`, `KeymapBoard.jsx:215-229`, `flash.py:40-82,853-885`.
**Ours:** LedTab (queueColor already spans kk 0..0x87 — extend to bay blocks), openflow.ts (strip colorHex in/out), KbFit layout for strips/bays, smoke.
**Exit:** paint strip + module LEDs on device; OF doc with strip colors round-trips; bay colors remain documented skip.
**Size:** M.

## Phase 4 — Flash capability model (drop-with-reason)

**What:** FlashDialog preview lists unstorable bindings with reason + effect ("key keeps its old binding"), before AND after write; drop report built from the same encoders the writers use; read-status taxonomy (0x11/0x16 ≠ empty) surfaces "unreadable" layers instead of treating as empty.
**OF sources:** `flash.py:270-411`, `keymap_read.py:503-526`, `FlashButton.jsx:306-359`.
**Ours:** queue/draft (encoder probes), FlashDialog, naya.ts STATUS_BYTES carry-through, smoke.
**Exit:** preview dialog shows drops with reasons for a fixture draft; verify distinguishes unreadable vs empty; 0 silent drops.
**Size:** M.

## Phase 5 — Module profile system

**What:** Per-layer bay assignment (bay byte 0x78 = inherit from base; base layer arms all 6 bays; slot ceiling 8); layout planner (allocate/template/reclaim/orphan-GC); slots matched by content + captured as new profiles on read; module settings adoption ("Use the keyboard's value"); gesture editing expansion: axis pairs ±1, per-half split, invert (Track), mouse buttons M1-M5, pinch/zoom cat-8, per-profile scroll convention, dial degrees-per-detent, firmware-locked rows inert; stock profiles from vendor-captured defaults; `openflow.module-profile`-shaped import/export.
**OF sources:** `module_layout.py`, `module_fields.py` + `module_field_map.json`, `flash.py:947-1037,1283-1416`, `rest.py:1824-1943`, `useModuleEditor.js`, `docs/reference/naya-default-module-bindings.json`, `docs/reference/module-profiles/`.
**Ours:** modules.ts (field maps vendored w/ provenance), new module-profiles.ts, queue.ts module ops, ModulesTab UI, BindingsTab bay picker, smoke.
**Exit:** per-layer bay profiles flash + read back; capture-on-read creates profile; split/invert editing round-trips; stock profiles seeded.
**Size:** L (largest; may split into 2 plans: 5a core model, 5b UI editing).

## Phase 6 — BLE slots + status decode + capability cache

**What:** Devices tab BLE panel: 5 slots (slot 0 dongle-reserved), select (BT-n keypress semantics) / clear+pair with confirm; 239-byte be/100C status blob decode (header + 5×37B profiles + split-link block); fw-keyed capability cache (unanswered opcodes never re-asked); split-link bond-table verdict wired into split-link-dead recipe.
**OF sources:** `ble_status.py:43-168`, `service.py:617-635,1215-1349,236-353`, `BleSlots.jsx:43-123`.
**Ours:** naya.ts (be verbs, decode), aux polling, DevicesTab/TroubleshootingTab UI, wire-guard verdicts, smoke.
**Exit:** slots panel operates (dry-run asserted byte-exact; live confirm-gated), 100C blob decode pinned by fixture, cache behavior asserted.
**Size:** M.

## Phase 7 — Keyscan live test (fe/1008/1009)

**What:** Test-mode toggle: device streams key events to the app (no host capture); UI overlay highlights pressed keys on the board; Escape/exit restores normal mode; safety: auto-exit on disconnect + refuse during draft≠empty.
**OF sources:** `service.py:1495-1516`.
**Ours:** naya.ts (mode toggle + event parse), new hook, BindingsTab overlay toggle, smoke (frame shapes; no live asserts).
**Exit:** toggle pins frame bytes; event decode fixture-asserted; UI overlay wired.
**Size:** S-M.

## Phase 8 — App-shortcuts dictionary in palette

**What:** 150 apps / 19,853 chords (MIT, ShortcutMapper-derived) into the action palette: app-picker tab, per-app search, platform chord swap (Win/Mac binds different bytes — desktop UA detects platform, toggle exposed); 4 MB source trimmed/lazy-loaded (build-time codegen to compact form + attribution).
**OF sources:** `app-shortcuts.json` (+ regen tool), `AppShortcutPicker.jsx:6-16,83-91`, `ActionPalette.jsx:121-201` (ranked search pattern).
**Ours:** new client asset + generated index, palette tab in KeyActionMenu, settings toggle for platform, ATTRIBUTION file, smoke (index integrity + chord swap mapping).
**Exit:** picker binds a verified chord; bundle impact bounded (lazy chunk); attribution ships.
**Size:** M.

## Phase 9 — Firmware flashing over SMP (WebSerial)

**What:** Catalog browsing (vendor-derived metadata w/ provenance, sha256s, generation-by-PID); keyboard FW update dialog: per-half checkboxes current→target, download-on-demand with sha256 gate, unknown-firmware replacement consent, downgrade-as-repair warnings, undock-modules gate, "half goes dark" expectation notice, live step timeline + JSONL run log, brightness/lighting restore after flash, stranded-half rescue; module FW update (left-half+one-module preconditions, replug prompt, force-update naming module type); update plan flags (per-half image resolution/downgrade/unknown-current); interlocks: arm-token = device's own hash, slot-1-only, size caps, side/generation checks; `/api/update-safe`-analogue: block self-page reload mid-flash.
**OF sources:** `firmware_fetch.py`, `firmware_upload.py:476-579`, `flash_procedure.py`, `module_procedure.py`, `recovery.py:34-75`, `rest.py:633-777`, `FirmwareUpdate.jsx:206-495`, `FirmwareLibrary.jsx`, `docs/reference/firmware-catalog.json`.
**Ours:** new sdk mcuboot/smp module (image upload protocol over our transport), naya.ts transport hooks, FirmwareTab UI (Settings), wire-guard additions (fa/*, ee/10be/10ae already blocked; SMP path separate guarded lane), smoke (frame/interlock logic only), run-log artifact.
**Exit:** full procedure green on smoke fixtures + interlock matrix asserted; LIVE first run happens only with owner present (parked until then or Phase 10 session).
**Size:** XL — highest risk; separate spec required (this master spec only bounds it).
**Standing hazard note:** first real flash must be owner-supervised; document recovery (bootloader-parked recipe + vendor tooling) in the dialog copy.

## Phase 10 — LIVE verification session with owner (TOGGLE/FORCE/STICK + supervised firsts)

**What:** Owner-at-keyboard session: (a) probe TOGGLE/TO/STICK layer-key ORDER bytes on-device (their vocabulary: `to_layer`, `sticky_key`; our special family knows ORDER 1=MO, 2=hold-layer2 only); record verdicts in cdc-protocol.md + naya-reflow ledger; implement support + import upgrade (drop the skip-warning) + smoke; (b) supervised first runs parked from earlier phases (Phase 9 first flash; any live-verification findings); (c) verify BLE slots live if Phase 6 was dry-run only.
**Rule:** nothing in this phase runs without the owner physically present; prepare probe scripts + checklist in advance so the session is short.

## Small items (folded)

- **fe/1005 set host OS** → Phase 7 (settings, one verb + dropdown).
- **Read-status taxonomy in flash verify** → Phase 4.
- **Device I/O log persistence + viewer** (per-frame ms timing, daily files via OPFS/download, "flash failed but landed" forensics) → Phase 6 (it serves BLE/flash debugging).
- **MCUboot bootloader inventory check (read-only)** → Phase 9 (rides the SMP module; no writes).
- **`counts.unknown` deflation** (known-empty families neither bound nor unknown) → Phase 4 cleanup.
- **Multi-keyboard grouping** — NOT ported now (backlog; low value for single-user web, high plumbing). Recorded as conscious exclusion.

## Phase gate (every phase)

1. Plan (writing-plans) → SDD execution (subagent-driven, glm-5.3-flash default / glm-5.3 for heavy reasoning; kimi k3 when quota returns).
2. Reviews PASS; smoke 0 FAIL (count grows); client build + both lints green.
3. Explicit-path commits on local main; HANDOFF roadmap updated per phase; ledger rulings carried.
4. No push, no hardware writes (except owner-present sessions: Phase 10, or owner-supervised Phase 9 first-run).
