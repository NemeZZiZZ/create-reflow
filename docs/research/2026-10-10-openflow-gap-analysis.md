# OpenFlow → create-reflow: missing mechanics inventory

Date: 2026-10-10 · Based on: `create-collective/openflow` v0.7.0 (local clone `~/Repository/openflow`, Apache-2.0)

**Context.** OpenFlow is Travis Wye's clean-room Electron+Python rebuild of NayaFlow 1.25.1.
Naya B.V. is defunct and NayaFlow is unmaintained — OpenFlow is now the most active
configurator for the Create. Their docs (`docs/nayaflow-interop.md`, `docs/reference/*.json`)
are reverse-engineered ground truth that complements our `naya-reflow/docs/cdc-protocol.md`.

Status legend (verified against our tree on 2026-10-10):
✅ have · ◐ partial · ❌ lack. Pointers: `OF:` = their tree, `CR:` = ours.

---

## A. Wire protocol mechanics

| # | Mechanic | Their impl | Ours |
|---|---|---|---|
| A1 | Read status taxonomy (0x11 not-implemented / 0x16 no-data / 0x18 continuation / 0xEA value-refused) carried as **per-layer read status**, so a flash never trusts an unreadable-but-empty layer | OF `backend/…/keymap_read.py:503-526` | ◐ `naya.ts:899-905` knows the bytes; flash verify doesn't distinguish "unreadable" from "empty" |
| A2 | Second bank 0x52 shadows + GC (filler on downgrade, NayaFlow never clears them → its verify fails) | OF `docs/nayaflow-interop.md` | ✅ `queue.ts:43-51,120-125`, t10.ts |
| A3 | **Write ceiling ≤2 CDC frames (483 B)**, split at record boundaries only (3rd frame hangs fw 3.28.7) | OF `flash.py:1085-1141` | ◐ we chunk on record boundaries (documented in transport-sulk recipe); explicit 2-frame ceiling unverified in our writer |
| A4 | Ack gating: 0x00/0x01 accepted (0x01 = "more frames coming"), 0xEA = value-rejected vs hard abort | OF `flash.py:1259-1267` | ◐ STATUS_BYTES decodes 0xEA; cmd() treats it as generic failure |
| A5 | **Layer-list writes (30/1002)** in normal flow: add entry `[idx][id][anim][10][uuid16]`, delete form sent twice, animation byte | OF `remap.py:294-344` | ❌ we only echo-back 30/1002 in the lights-wrong troubleshooting button; no draft op kind exists |
| A6 | **End-of-flash lighting restore** = full layer-list rewrite as the LAST write of every flash (clears runtime LED-effect wedge on both halves) | OF `flash.py:1057-1075` | ❌ nothing analogous; our nayaflow-verify-fail recipe dances around the symptom |
| A7 | fe/1005 set host OS (device adapts scroll conventions etc.) | OF `service.py` | ❌ |
| A8 | fe/1008/1009 **keyscan mode + live key-event stream** (press keys, see events in app — no host capture needed) | OF `service.py:1495-1516` | ❌ |
| A9 | BLE 100C **239-byte status blob** decode (header + 5×37 B profiles + split-link block) + fw-keyed **capability cache** (unanswered opcodes never re-asked) | OF `ble_status.py:43-168`, `service.py:617-635` | ❌ |
| A10 | BLE slots be/1009/100A **select/clear BT profile slot** (5 slots, slot 0 = dongle reserved) | OF `service.py:1215-1349` | ❌ |
| A11 | Module battery unit sniff (de/1009 is 0.1 mV vs de/100B mV), de/100A file-fw-version, module type from dock-bus address high nibble | OF `service.py:569-615`, `constants.py:113-163` | ◐ we poll de/1001 battery + bay presence; no unit sniff/type decode |
| A12 | Wire truth: **firmware ACKs and discards macro writes** (30/1005/1006 dead) — macros can only be host-side | OF `db/macros.py:5-25` | knowledge ❌ → retargets our roadmap "macros" item to app-side forever |

## B. Flash pipeline

| # | Mechanic | Their impl | Ours |
|---|---|---|---|
| B1 | **Capability model + drop report**: per-action encoders; unstorable bindings dropped *with reason + user-visible effect* ("key keeps its old binding"); shown before AND after flash | OF `flash.py:270-411` | ❌ our FlashDialog shows op counts only |
| B2 | Flash preview write-plan table (per-op frames/bytes/destination) | OF `FlashButton.jsx:256-303` | ◐ draft stats exist |
| B3 | **Sync mode requires fresh device read** as preservation baseline; separate blind "recovery" mode | OF `rest.py:2270-2360` | ❌ |
| B4 | Read-back verification with op/frame/ack failure detail | OF `FlashButton.jsx:147-162` | ✅ useFlash readback (detail level ◐) |
| B5 | Orphan module-slot reclamation + layer-0 bay-gap gate (blocks Confirm) | OF `flash.py:1283-1416` | ❌ (needs E-modules first) |
| B6 | 0x10 wrapper written only when double-tap/tap-hold exists — changes typing timing | OF `flash.py:414-439` | ◐ t10.ts writes T10 records; timing-when-absent nuance unverified |

## C. Layers & bindings

| # | Mechanic | Their impl | Ours |
|---|---|---|---|
| C1 | **Layer management**: add/delete/reorder; identity by 16-byte UUID (names are app-side, survive re-reads) | OF `keymap_import.py`, layer-list writes | ❌ useLayers is read-only; no draft op can create/remove a layer |
| C2 | **TOGGLE / FORCE / STICK layer keys** (`to_layer`, `sticky_key` in NayaCore vocabulary) | OF palette layer keys: hold/toggle/force/stick | ❌ actions.ts special family = MO + hold-layer2 only |
| C3 | Layer-toggle safety engine (refuse toggling base/lower layers, actionable reasons) | OF `ActionPalette.jsx:23-49` | n/a until C2 |
| C4 | Ranked global search across all catalog tabs + **5,311 app shortcuts**, field-weighted scoring, platform chord swap (Win/Mac binds different bytes) | OF `ActionPalette.jsx:121-201`, `AppShortcutPicker.jsx:83-91` | ◐ palette search exists; no app shortcuts, no platform chords |
| C5 | Virtual-keyboard chord builder (modifier checkboxes → chord, layout picker QWERTY/Dvorak, live "binds Ctrl+X" hint), drawn mouse | OF `VirtualKeyboard.jsx:154-183`, `VirtualMouse.jsx` | ❌ we pick modifiers as individual HID usages |
| C6 | **Apps/Shortcuts dictionaries**: 150 apps / 19,853 chords (MIT source), 610 action-chords, 95-entry byte-verified dictionary | OF `docs/reference/app-shortcuts.json` (4 MB), `action-chords.json`, `shortcut-dictionary.json` | ❌ |

## D. LED

| # | Mechanic | Their impl | Ours |
|---|---|---|---|
| D1 | **Strips + module-bay LED painting**: 136-LED span — keys 0-73, strips 74-87, per-module 24-LED blocks 88-135, pipette works on module blocks | OF `Color.jsx:118-125`, `KeymapBoard.jsx:215-229` | ◐ SDK ready (`queueColor` accepts kk ≤ 0x87 = full span, `queue.ts:67`); LedTab UI exposes keys only — our roadmap "LED strips/bays 74-96" |
| D2 | Device-true color projection (H/S only, no per-key value; dark colors lighten) with "lights up as…" tooltips | OF `lib/color.js`, swatch chips | ✅ conceptually (`ledCss`, V=1); tooltips ◐ |
| D3 | Animations Solid/Breathe/Swirl/Spectrum with parameters | OF `Color.jsx:252-274` | ◐ we write per-layer animation ed/1011 (ANIM_NAMES); no params UI |
| D4 | Persistent LED settings: scan mode 0x1012, max brightness 0x1013, **per-layer LED override 0x1014** | OF `service.py:1122-1187` | ◐ 1013 written live (undark); 1012/1014 unused |
| D5 | All ED payloads carry a leading target byte — `[value]` alone silently zeroes while acking OK | OF `service.py:1084-1114` | ✅ known (our ed writes carry 0xff target) |

## E. Modules

| # | Mechanic | Their impl | Ours |
|---|---|---|---|
| E1 | Gesture→action editing | OF `useModuleEditor.js`, `GestureRow.jsx` | ◐ we have the S2-proven 30/100c path (`queueModuleGesture`) for supported slots/fields |
| E2 | **Axis model**: pairs = 2 fields ±1, per-half **split** checkbox, **invert** (Track), mouse buttons M1-M5, pinch/zoom cat-8, per-profile scroll convention (mac names vs cat-4 flip), dial degrees-per-detent, firmware-locked Touch rows shown inert | OF `module_fields.py:124-459` | ❌ none of these field semantics |
| E3 | **Module profile model**: per-layer bay assignment (bay byte 0x78 = inherit from base — proved not nearest-below; base layer must arm all 6 bays; slot ceiling 8), layout planner (allocate/template/reclaim/orphan-GC), slots matched **by content** + captured as new profiles on read | OF `module_layout.py:70-140`, `flash.py:947-1037` | ❌ |
| E4 | Module profile import/export (`openflow.module-profile` JSON Schema + 3 stock exports) + vendor-captured stock bindings (Track/Tune/Touch Win+Mac) | OF `docs/reference/module-profiles/`, `naya-default-module-bindings.json` | ❌ |
| E5 | Per-gesture "on device: X" diff badges + one-click "Use the keyboard's value" | OF `GestureRow.jsx:9-22` | ❌ |
| E6 | Module firmware update procedure (SMP bundle, MODULE_FWUP type bytes, replug prompt) | OF `module_procedure.py` | ❌ (out of scope for web client) |

## F. Devices / BLE / firmware

| # | Mechanic | Their impl | Ours |
|---|---|---|---|
| F1 | BLE slot manager UI (select/clear & pair per slot, dongle reserved, old-fw degradation notice) | OF `BleSlots.jsx:43-123` | ❌ |
| F2 | Bond-table cross-check split-link **verdict** + partner-via-left relay probe | OF `service.py:236-353` | ◐ our split-link-dead recipe is diagnosis-only text |
| F3 | Firmware library (catalog with sha256s, QSPI generation by PID, "downloadable ≠ flashable" withheld reasons) + supervised FW update | OF `FirmwareLibrary.jsx`, `firmware_upload.py` | ❌ deliberate (web client can't SMP); Naya's defunctness raises its long-term value |
| F4 | Multi-keyboard support (group halves by mutual pair addresses, "acting on" picker, refuse-to-guess) | OF `service.py:876-935` | ❌ single keyboard assumed |
| F5 | MCUboot bootloader inventory check (what image the parked half runs) | OF `BootloaderCheck.jsx:6-30` | ◐ we detect PID only |
| F6 | Quiet-half + FW-mismatch banners | OF `Troubleshooting.jsx:94-105` | ✅ our firmware-mismatch / right-cdc-deaf recipes |

## G. Data model / import-export

| # | Mechanic | Their impl | Ours |
|---|---|---|---|
| G1 | OpenFlow JSON profile/layer **export v2 incl. module configs + LED maps** | OF SCRUM-31, `.openflow-profile.json` | ◐ our native-format spec (c004e79) covers kind:'layer'; their schema files are the reference to mirror |
| G2 | NayaFlow `user-data.db` (SQLite) + `.zip` import, beta-schema converter | OF `db/nayaflow_convert.py` | ❌ conscious clean-break (owner decision 2026-10-01) |
| G3 | Backup files on disk (SQLite snapshots, auto keep-20 + manual + pre-restore) | OF `db/backup.py` | ◐ localStorage auto-backups only |
| G4 | **Offline editing from bundled stock profile** — app never opens empty | OF `seed.py:24-40` | ❌ we require a connected board to get layer data |
| G5 | Host-side macro engine (Key/Text/Wait/Launch/Shell steps, recorder with real per-key timing) — honestly labeled "app only" | OF `Macros.jsx`, `MacroRecorder.jsx` | ❌ (and A12 says it stays host-side) |

## H. UX polish (lower priority)

- ★ badge counting multi-behavior keys; LED-outline toggle on keycaps; action icons; layer-switch glyphs with numbers (`KeymapBoard.jsx:142-174`) — ❌
- Device I/O log viewer with per-frame ms timing + daily files ("flash failed but landed" forensics) (`Settings.jsx:389-421`) — ◐ we stream a log in-app, no persistence
- Per-route ErrorBoundary, profile bar with live per-half status chips, multi-keyboard "acting on" picker — ❌/◐
- Undo/redo — ❌ on both sides (our draft is the right substrate if ever needed)

## I. Reference data assets (licensing matters)

| Asset | Size/content | License posture |
|---|---|---|
| `docs/reference/app-shortcuts.json` | 150 apps, 19,853 validated chords w/ device bytes | **MIT** (ShortcutMapper merge) — reusable with attribution |
| `docs/reference/action-chords.json` | 610 actions win/mac/linux bytes | community-built on vendor names |
| `docs/reference/shortcut-dictionary.json` | 95 entries, 79/80 byte-identical to a real flash capture | mixed vendor-captured |
| `docs/reference/nayacore-action-vocabulary.json` | 248 HID + consumer/LED/BT/mouse names, 652-record server catalog, flashable-vs-not flags | reverse-engineered from NayaCore.exe — cross-check against our host-table (282 names) |
| `docs/reference/nayaflow-key-palette.json` | vendor palette model: 376 actions, behavior-slot dependencies, chord grammar, module-gesture disallow rules | reverse-engineered (exe bytes cited) |
| `docs/reference/create-key-geometry.json` | exact key/LED/bay coordinates + 34 keycap SVG paths | **Naya-drawn artwork — "confirm/redraw before public release"**; do not copy verbatim |
| `docs/reference/naya-default-module-bindings.json` | stock Track/Tune/Touch(Win+Mac) bindings | vendor-captured |
| `docs/reference/firmware-catalog.json` | 25 releases / 69 images, sha256s, mcuboot fields, generation-by-PID | vendor-derived metadata |
| `docs/reference/module-profiles/` | JSON Schema + 3 stock exports | Apache-2.0 — reference for our G1 |
| `device/userdata-snapshot/user-data-*.db` | real captured NayaFlow DB (201 key bindings, 39 module bindings) | fixture |

## J. Strategy notes

1. **Naya B.V. is defunct; NayaFlow unmaintained.** OpenFlow (v0.7.0, signed installers, weekly
   update checks) is the de-facto successor app. Their `docs/backlog.md` (partially stale):
   open items = Smart Integrations (foreground-app auto profile switching — desktop-only),
   module gesture-binding editing (front-end already shows editing UI — treat backlog as stale),
   richer macros, shortcut icons, board cosmetics.
2. Their `nayaflow-interop.md` independently confirms our second-bank model and explains
   NayaFlow's "Failed to verify" exactly the way our nayaflow-verify-fail recipe does.
3. Their format (`.openflow-profile.json`, layer export, module-profile schema) is the format
   our native-format spec (c004e79) adopts — their schemas are ground truth for the importer.

## Suggested priorities (tying into our ROADMAP)

1. **OpenFlow JSON native format** (already speced) — mirror their schemas (G1).
2. **Layer management + 30/1002 draft op** (A5, C1) — unblocks layer add/delete, and gives us
   A6 (end-of-flash lighting restore) almost for free.
3. **LED strips/bays UI** (D1) — SDK span already supports it; pure UI work.
4. **Flash preview capability model** (B1-B3) + A6.
5. **Module profile model** (E2-E5) — biggest chunk; their field maps are the spec.
6. **BLE slots + 100C decode** (A9, A10, F1) — Devices-tab feature.
7. **Keyscan live test** (A8) — cheap, high delight, great for on-device smoke.
8. **App-shortcuts dictionary into the palette** (C4, C6) — MIT data, mechanical work.
