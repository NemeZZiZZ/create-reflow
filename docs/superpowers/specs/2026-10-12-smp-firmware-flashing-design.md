# Phase 9 Design — Firmware flashing over SMP (MCUboot serial recovery), browser-side

Port of OpenFlow's firmware-update subsystem (backend Python + pyserial) into
create-reflow's DOM-free SDK + WebSerial client. This is the highest-risk
phase of the port program (XL). Provenance anchors are OF file:line from
`/Users/nemezzizz/Repository/openflow/backend/openflow_backend/` (recon
2026-10-12) and our repo where marked `ours:`.

Parent program: `docs/superpowers/specs/2026-10-10-openflow-port-program.md`
§"Phase 9" (lines 78-85) — the binding bounds. This spec is the detailed
design that master spec demands before any plan.

## Intent & why

Owners must be able to bring a Create keyboard's halves to a chosen firmware
version, update module firmware, and rescue a half parked in MCUboot — from
the browser, with every destructive step interlocked and every claim about
device state coming from the device itself. OF proved the procedure on real
hardware with a Python backend; we port it to the same wire protocol over
WebSerial, keeping OF's safety architecture (arm-token, slot-1-only, sha256
gates, preflight backup, stranded-half rescue) byte-faithful where the wire
is concerned.

## Goals

1. SMP/MCUboot client in the SDK (`sdk/src/smp.ts`, DOM-free, WebSerial types
   injected like the rest of the SDK): framing, CBOR, image upload, image
   state, set-pending, os reset, slot info.
2. Firmware catalog: vendored verbatim from OF, loader with validation,
   download-on-demand from the same GitHub source with sha256 gate.
3. Update plan: per-half target resolution by PID side+generation, flags
   (`downgrade`, `unchanged`, `unknownCurrent`, `present`, `fetchable`).
4. Keyboard flash procedure as a client state machine with JSONL run log,
   live step timeline, preflight backup + postflight compare, brightness and
   lighting restore, stranded-half rescue.
5. Module firmware procedure (left-bay module, replug UX, force-type naming).
6. Interlocks: arm-token = device-reported slot-0 hash, slot-1-only, size
   caps, side/generation checks, catalog sha256 match, downgrade consent,
   unknown-current consent, undocked-modules gate, one-run lock.
7. Update-safe analogue: page reload blocked while a run is active;
   auto-connect/hot-plug teardown frozen; flash queue locked.
8. Smoke coverage of all frame/interlock logic on scripted fixtures.
9. FirmwareTab UI (catalog browse + keyboard dialog + module dialog).

## Non-goals (v1)

- No persistent image cache (OPFS/Cache API) — images live in memory for the
  run; each run downloads what it needs. A cache is a later enhancement.
- No `.sfb` extraction or per-app module rows (they ride inside
  FlashMemory.bin; catalog shows them as reference only, like OF).
- No OF "recovery-ops" donor tooling (OF itself ships it disabled).
- No auto-update scheduling, no channel/betaPath handling, no right-bay
  module updates, no signing-key crypto (we match OF: gate = blobSha256
  equality against the vendored catalog; plaintextSha256 equality against
  what the device reports).
- No `wait:true` blocking API form; no SSE (in-process event stream instead).

## Anti-goals (failure even if it technically works)

- Never write slot 0. Never send a upload chunk without a matching arm token
  obtained in the same run. Never keep an image whose sha256 does not equal
  the catalog's `blobSha256`. Never start a keyboard flash with any module
  docked on either half. Never let the page be closed mid-run without a
  warning. Never expose MCUboot entry (`ee/10ae`) to the troubleshooting
  wire lane — it stays wire-guard-blocked there (along with the DFU reset
  `ee/10be`, which we never send at all).

## Constraints (global, inherited)

- SDK stays DOM-free pure TS runnable under node for smoke (`SerialPort`
  injected; ours: sdk/src/index.ts:1-2).
- Client gates: `pnpm build` exit 0, `pnpm lint` exit 0 (pre-existing
  warnings tolerated), smoke 0 FAIL from `client/` cwd; rolldown smoke
  single-file contract (`client/scripts/rolldown.smoke.mjs` has
  `codeSplitting:false`; dynamic imports must not split new chunks in the
  smoke bundle — keep catalog data behind a dynamic import that the smoke
  imports statically via the same module).
- English UI copy, calm hedged where uncertain. VCS: plain git, explicit
  paths, local main, never push.
- Wire-guard (`sdk/src/troubleshooting/wire-guard.ts:20-38`) block list is
  unchanged: `fa/*`, `ee/10be`, `ee/10ae`, `0x30/0x10ca`, `0xbe/0x1004`
  stay blocked in the trouble lane.

## 1. SMP client — `sdk/src/smp.ts`

**Header** (OF recovery.py:246-258): 8 bytes big-endian
`[b0, flags, lenHi, lenLo, groupHi, groupLo, seq, cmdId]` where
`b0 = (version<<3) | op`, `version = 1` (0 is silently ignored by the
bootloader — no reply), `flags = 0`, `len` = CBOR payload length (u16).

**Frame** (recovery.py:261-271): `[u16BE len = body.length + 2][body][u16BE
CRC16-XMODEM(body)]`, then base64 of the whole byte string, prefixed
`\x06\x09` and terminated `\n`. Wrong length or CRC → silent ignore.
Default empty payload = `0xa0` (empty CBOR map).

**CRC16-XMODEM** (recovery.py:237-243): init 0, poly 0x1021, MSB-first per
byte.

**CBOR subset** (encode firmware_upload.py:202-232 with map keys sorted for
byte-stability; decode recovery.py:165-229): encode uint/negint/bytes/text/
map; decode additionally arrays, bools, null, indefinite-length with 0xFF
break.

**Line transport**: writes are single `\n`-terminated lines; responses start
with a `\x06\x09` line and may continue on `\x04\x14` lines — reassemble
continuations before base64-decode (recovery.py:278-287). Serial params are
CDC-cosmetic (115200 8N1, DTR/RTS on open; ours: reuse the port open shape
from `NayaSession.connect` naya.ts:494-581). After-open settle 250 ms
(recovery.py SETTLE_AFTER_OPEN). Response grace 30 ms after first bytes
(RESPONSE_GRACE).

**Ops** (numeric, OF firmware_upload.py:101-115 / recovery.py:77-88):
READ=0, READ_RSP=1, WRITE=2; group OS=0, IMAGE=1; ids: os echo=0,
image state=0, image upload=1, os reset=5, image slot info=6. Known rc:
ENOTSUP=8 (also what this bootloader answers to image-state WRITE and to
whole groups it lacks), EINVAL=3 (first-chunk too large).

**Image upload** (firmware_upload.py:582-662): WRITE group 1 id 1, CBOR map
`{"image": N, "off": O, "data": bytes}`; the FIRST chunk additionally
carries `"len": total` and `"sha": sha256(full image bytes)`. Later chunks
carry only image/off/data. The device reply's `off` is authoritative —
use it as the resume point, never our own counter. `rc != 0` on any chunk →
abort, nothing further sent. seq increments per chunk masked `& 0xFF`, echoed
by the device for reply matching (match on group+id+seq; late replies to
earlier requests are a real failure mode — recovery.py:313-341).

**Chunking**: default 512 (`min(remaining, 0x200)`), hard cap 4096 (SMP u16
length + bootloader receive buffer). No env override in ours (constant 512).

**Timeouts**: per-chunk 20 s; first-chunk (offset 0, full secondary-slot
erase — measured 6-19 s stalls) 90 s; post-upload settle while MCUboot swaps
300 s with image-state re-polls every 2 s on the original and re-enumerated
recovery ports of that side, early-bail if the half shows up in app mode
(firmware_upload.py:605-617, 757-819).

**Upload target numbering** (firmware_upload.py:158-194, 304-353): prefer
the device's `image slot info` (`uploadImageId` per image/slot). Keyboard
writes direct-upload id **2** (slot 1 / secondary); module bundle id **4**
(slot 2 / modules). If the map is silent: keyboard falls back to the
ASSUMED rule `2*image + slot + 1` (= 2 for image 0 slot 1); modules may use
id 4 unmapped ONLY with `allowUnmapped` and only for a bundle of exactly
1,048,576 B. Refuse keyboard upload unless the map confirms image-0/slot-1
→ 2 (OF `_numbering_is_understood`).

**Set pending** (firmware_upload.py:696-722): WRITE group 1 id 0, CBOR map
`{"hash": <32-byte plaintextSha256>, "confirm": bool}`. The hash is OF's
`plaintextSha256` — the SHA-256 of the decrypted image, which is what the
device reports for a running image. No hash-less form is ever sent.

**Os reset** (firmware_upload.py:725-727): WRITE group 0 id 5, empty map.
The reply is expected to fail/timeout (device reboots mid-reply) — treat
missing reply as success.

**Post-upload read-back** (firmware_upload.py:859-890): re-read image state;
require slot 1 hash == catalog `plaintextSha256`. Detect "swap already
happened": new hash in slot 0 AND the arm-token image moved to slot 1 (only
when armed and hashes differ). If armed and not yet swapped, bootloader
slot flags must show pending; not-pending → refuse to reset.

**Swap/confirm defaults**: identical to OF's default `flash()` path
(firmware_upload.py:696-929); the plan pins the exact `confirm` /
vendor-trailer defaults by reading that function before implementation.
Binding rule: byte-faithful to OF defaults, no new policy.

## 2. Transport & re-enumeration (browser reality)

- The SMP conversation rides raw CDC lines, NOT Naya frames. Our SDK's
  `NayaSession` exposes public `writeFn` and `fr` (FrameReader), but the
  FrameReader's pump assumes AA..04 framing and is single-consumer — so the
  SMP client does NOT reuse a NayaSession's reader. Instead `SmpLink` owns
  its own port: `new reader`/`writer` from the (re-enumerated) SerialPort,
  line-oriented read loop.
- A half in MCUboot exposes TWO CDC interfaces; only one speaks SMP, the
  other is a log port that silently swallows frames (resets sent there look
  like "power cycle required") — probe every candidate port with image-state
  (or os echo as cheapest liveness) and keep the answering one for the whole
  visit; 60 s find timeout (OF BootloaderLink recovery.py:529-657). The log
  port is drained into a console buffer surfaced in the run log as a
  `bootloader.console` note on success and failure.
- MCUboot entry: vendor op `ee/10ae` (nayactl `RESET_MCU_BOOT = 0x10AE`;
  `RESET_DFU = 0x10BE` is a DIFFERENT op we never send) sent through the
  EXISTING NayaSession (app mode) as a raw roundtrip with no matcher —
  OF flash_procedure.py:597 / module_procedure.py:356 both use CAT_RESET +
  RESET_MCU_BOOT. Reply handling per OF: short timeout, the mid-reply
  reboot is expected and swallowed. Never through the trouble `ctx.send`
  lane (wire-guard keeps blocking both 0x10AE and 0x10BE there). SDK gets
  a dedicated `ses.enterMcuboot()` that the firmware procedure alone calls;
  it is the only new unguarded write on NayaSession.
- PIDs (OF recovery.py:34-62, confirmed on hardware): VID `0x37D1`; app
  0x0064 left / 0x00C8 right; MCUboot 0x006F left / 0x0D3 right; third-mode
  0x007A / 0x00DE; generation B = `pid & 0x1000` set. A half entering MCUboot
  does NOT leave on its own — only SMP os reset or power cycle. Every
  power-on passes through MCUboot ~1.6-1.7 s, so "parked" means seen in
  recovery ≥ 3 s apart (two looks).
- **Re-enumeration flow**: after `enterMcuboot()` the OS re-enumerates the
  port with the MCUboot PID. Procedure: (a) wait for the app port's
  disconnect; (b) poll `navigator.serial.getPorts()` for a port whose
  `getInfo().usbProductId` ∈ RECOVERY set with matching side; (c) if Chrome
  does not re-grant automatically (live unknown — see Unknowns), surface an
  `action`-phase step with a button that calls `requestPort({filters:
  [{usbVendorId: 0x37D1}]})` — the timeline UI supplies the user gesture.
  Same path in reverse (app PID) after os reset. The client freezes
  useSessions' auto-connect/hot-plug teardown while a run is active (a
  module-level fw-run flag; ours: useSessions.ts:219-295 effect checks it).

## 3. Catalog & fetch

- Vendor OF `docs/reference/firmware-catalog.json` (101,398 B, 69 images,
  `_note`, `generated`, `releases`, `signingKeys`, `source`) verbatim to
  `client/src/data/firmware-catalog.source.json` + provenance header comment
  in the loader (program convention; the JSON itself stays byte-identical).
- Loader `client/src/lib/firmware-catalog.ts`: dynamic-import lazy chunk
  (like app-shortcuts), shape validation, typed view. Fields consumed
  (exactly OF's set): `file, target, side, generation, type, flashable,
  withheldBecause, blobSha256, plaintextSha256, resourceSize, historyPath,
  createFirmware, moduleFirmware, versionLabel, versionConfidence,
  releaseOrder, bundle, bundles, keyboardRange, contents, pairedKeyboard,
  component, container, sha256, size`. Match images by `blobSha256`, NEVER
  by name (filenames repeat across releases — OF `_note`).
- Fetch `client/src/lib/firmware-fetch.ts`: GET
  `https://raw.githubusercontent.com/create-collective/create-legacy-firmware/main/firmware-history/`
  + `historyPath` (OF firmware_fetch.py:42 SOURCE_DEFAULT — the
  `/firmware-history` suffix is part of the base, historyPath values like
  `v1.25.1/kb_fwl.bin` are relative to it); 30 s timeout; hard cap 8 MiB
  (+1 byte read then refuse);
  WebCrypto sha256; the returned bytes are only usable when the digest
  equals the entry's 64-hex `blobSha256` (refuse otherwise, keep nothing).
  Version download = every image under that version label (both sides, both
  generations — which of the four a half needs is decided from its PID at
  flash time). `fetchable` = has `historyPath`; downloadable ≠ flashable
  (withheld rows still downloadable, `.sfb` rows get no download).

## 4. Update plan (pre-bootloader resolution)

Resolve per connected half, in app mode, from `port.getInfo()` PID →
(side, generation) — never guessed (OF pid_info recovery.py:65-74).
Per chosen version label: target image = the catalog entry with matching
side+generation+target=keyboard+flashable; flags per OF rest.py:633-777:
- `present` — image bytes held in memory from a download this session.
- `fetchable` — catalog has a historyPath (a button, not a fact).
- `unchanged` — current fw version == target version.
- `downgrade` — target older by version tuple, else `releaseOrder` fallback
  when either side has no declared version (UI must then send `allowOlder`).
- `unknownCurrent` — running version not among catalog `createFirmware`
  values (factory firmware) → consent checkbox BEFORE the half goes dark;
  once replaced we cannot put it back.
Current version source: `halves[side].fw` (ours: fe/1002, aux.ts:124-130).

## 5. Keyboard flash procedure — `client/src/hooks/useFirmwareFlash.ts`

State machine + event emitter, one run at a time (in-flight promise guard,
useFlash.ts:157 precedent), busyRef held for the WHOLE run, JSONL run log
(`run id flash-YYYYMMDD-HHMMSS`), step names ported from OF
STEP_LABELS flash_procedure.py:54-80. Left half first when both (988-999).

1. `preflight.capture` — refuse if any module docked on EITHER half
   (de/1001 modPresence both halves; OF 290-306). Capture per-half identity
   (fw version, BLE address/pair/bonds — ours: existing be/ helpers
   App.tsx:464-505) + keymap & LED map from the LEFT half only (left owns
   keymap/LED dest 0x50; ours: dump machinery from useLayers/dumpAll).
   Serialize to the run-log artifact `preflight` with its sha256. Existing
   sdk auto-backup (useFlash.ts:189-206 precedent) fires first.
2. `preflight.verify` — re-read the artifact, byte-identical or refuse.
3. Per side: `mcuboot.enter` — `ses.enterMcuboot()` (ee/10ae, RESET_MCU_BOOT),
   LEDs go off, expected.
4. `identify` — poll image state ≤ 90 s; refuse if PID side ≠ expected;
   log port discovery; arm token = slot-0 hash from the device.
5. Interlock gate (§7) re-checked with live values; unknown-running
   accepted only with prior consent (logged "no way back" note).
6. `slot.erase` — starts at first chunk; marked ok when the first chunk is
   accepted (the bootloader erased the slot).
7. `upload` — §1 upload loop; progress events every 5%; log-port console
   tap kept for the whole upload, dumped as a note on success AND failure.
8. `swap.verify` — settled wait (300 s, re-poll every 2 s); ok event
   carries the swap + final hash.
9. `mcuboot.exit` — os reset (sent by the upload client itself; expected
   reply-less). No power cycle needed.
10. `version.confirm` — await app mode ≤ 300 s, re-send reset every 30 s to
    the answering port; read fw version; mismatch → refuse (write is
    hash-verified, half re-flashable); unknown target → advisory.
11. `halves.settle` — wait ≤ 90 s until BOTH halves answer identity again
    (central drops off USB during re-link — known hardware behavior);
    timeout logs fail-and-continue.
12. `brightness.restore` — write LED max-brightness 100 (or app-saved
    value) per side; cosmetic, never fatal.
13. `lighting.restore` — re-send stored colors/animations from the left
    half's own storage (runtime state is lost through the bootloader);
    cosmetic, never fatal.
14. `verify.compare` — re-read identities + keymap → `postflight`
    artifact. Strict failures: BLE address/pair address/bond table, primary
    keymap bank. Advisories (version changed): LED map, second keymap bank.
    Absent position == `07 00` NONE record.
15. `run.end` — verdict {ok, summary, failures[], advisories[]}.
- **Failure path**: for each side still in recovery → find answering port,
  os reset, await app ≤ 300 s; three logged outcomes (back running /
  still parked → power cycle brings it back / left bootloader but not on
  USB → unplug+replug). Then `run.end` fail. A half left in its bootloader
  is put back into the application before the dialog reports failure.
- **Run log**: JSONL, one object per line in memory + exported via
  `saveText` (ours: lib/save.ts): `{ts, elapsed_ms, step, label, phase:
  start|ok|fail|note|progress|action, side?, detail?, took_ms?, …extra}`;
  first line run.start meta, last run.end. The live timeline consumes the
  same event stream. `action`-phase events (replug prompts, port-grant
  button) replace the running headline, cleared by the next ok.

## 6. Module firmware procedure

Preconditions (OF module_procedure.py:26-52, 210-270): left half in app on
USB; right half NOT connected; exactly one module docked in the LEFT bay;
module type ∈ {Touch, Tune, Track} unless force-typed; bundle = newest
flashable littlefs/target=module with `keyboardRange.from` ≤ keyboard fw;
bundle newer than keyboard fw refused (older bundles fine); downgrade needs
allowOlder (skipped when forced). `upload = forceUpload || stored != target`
(stored = app-mode bundle-version read — `MODULE_FILE_FW_VERSION`, op path
pinned from OF service layer at plan time; ours: SDK may need this one new
vendor read). `program = forceType != null || running != target`. Neither →
finish ok "already runs it".

- One `SmpLink` conversation for identify + slot map + all chunks (slot-map
  read retried 3×, else `allowUnmapped` + exact 1 MiB bundle → id 4).
- NO reset after the last chunk — the half self-restarts ~1 s later.
- `bundle.restart` — await left half back: after 30 s unseen, ONE `action`
  event: "unplug its USB cable, count to ten, plug it back in — not a power
  cycle, nothing being written is interrupted"; wait ≤ 600 s total.
- `bundle.verify` — stored bundle version == target or fail.
- `module.program` — MOD_FWUP = `0xDE/0x1005`, dest 0x50, one payload byte =
  type code `FWUP_TYPES {Touch:1, Tune:2, Track:3}` (deliberately NOT
  nayactl's MODULE_TYPES order — flashing the wrong table gives a Tune the
  Track app; ours must use these exact codes), NO reply expected; module
  lights out 10-15 s; keyboard restarts ~32 s later.
- `module.restart` / `module.verify` — module fw == target AND type still ==
  want within 90 s; wrong type → refuse, pointing at Force Update.
- `verify.compare` vs the captured left identity + keymap. Failure path:
  reset left if parked, await app; module-firmware cache forgotten in
  `finally`.
- Constants: replug prompt 30 s, return wait 600 s, drop wait 120 s, module
  find wait 90 s, boot reset re-send 60 s, poll 1 s.

## 7. Interlocks (each asserted in smoke)

| Gate | Rule | OF anchor |
|---|---|---|
| Arm token | flash call must carry `arm` == device-reported slot-0 hash THIS run; never boolean, never cached | firmware_upload.py:574-576, 683-686 |
| Slot | upload target is slot 1 only (direct id 2; map must agree) | 545-550 |
| Size | keyboard image ≤ 663,552 B; bundle exactly 1,048,576 B unmapped; fetch ≤ 8 MiB | 180-183, 555-558 |
| Side/gen | running image catalog side+generation == target; PID agrees | 528-536, 417-429 |
| Catalog sha | image bytes sha256 == exactly one `blobSha256`; known name + unknown bytes refused; not-in-catalog refused; `flashable` required | 374-414, 502-504 |
| Downgrade | refuse unless `allowOlder` (version tuple, else releaseOrder) | 432-450 |
| Unknown current | refuse unless consented before bootloader entry | 453-473, rest.py:760-767 |
| Modules docked | keyboard flash refuses with any module on either half | flash_procedure.py:290-306 |
| Module pairing | bundle newer than keyboard fw refused | firmware_upload.py:953-994 |
| One run | second procedure start refused while one runs (any kind) | rest.py 409 RunBusy |
| Type safety | littlefs bundle never planned as keyboard image and vice versa | 497-501, 1042-1046 |

## 8. Update-safe analogue

- `beforeunload` + `pagehide` handlers installed while a run is active:
  preventDefault + `returnValue` set (browser prompts). This replaces OF's
  `/api/update-safe` (no backend exists to ask).
- busyRef held the whole run (dumps, flash queue, trouble actions, keyscan
  all refuse — existing checkers, ours naya.ts:632 BusySkipError etc.).
- useSessions auto-connect + hot-plug teardown frozen while the fw-run flag
  is set (the procedure owns port lifecycle).
- No reload-survival catch-up stream (OF's `since=seq`): reload is blocked
  instead; a finished run's log remains exportable from the dialog.

## 9. UI — FirmwareTab (new top-level tab `firmware`)

Ours: `AppTab` union + `TABS` (AppTabs.tsx:9-24) gain `firmware`; App.tsx
conditional render; logic in `useFirmwareFlash`/libs, markup in components
(house rule HANDOFF.md:83-84). Three surfaces, OF semantics:

1. **Library** (FirmwareLibrary.jsx port): grouped catalog browsing
   (keyboard-before-module, newest releaseOrder first), per-group download
   buttons with sizes, "Downloaded" chips for held images, sha256 prefixes,
   flashable badges with `withheldBecause` tooltips, header prose: catalog
   not flasher; images download on demand and are hash-checked before use.
2. **Keyboard dialog**: version select (declared vs "no version number
   declared" labels), per-half checkbox rows `current → target` with
   `(already on it)` / `(older)` suffixes, file column only when usable,
   download notice (fetchable = button; else "no record of where to fetch
   it"), unknown-current consent block, downgrade notice (danger button),
   undock-modules notice, expectations block ("one half goes dark… do not
   unplug"), live step timeline (one row per side+step, ✓/!/… marks,
   percent only for upload, `action` prompts replace the headline), verdict
   panel (failures/advisories lists, "saved as <run id>" keep-it note),
   log viewer + JSONL export. Modal non-dismissable while running.
3. **Module dialog**: three static rows (left half / module left bay /
   right half "unplug it"), blockers list, version select with
   `needs keyboard X or newer` disables, force-type selector (no default —
   "the wrong type gives it the wrong app"), replug action prompt (largest
   words in the dialog), expectations ("keep the module docked", ~3-6 min).

## 10. Wire-guard & KB updates

- `assertWireAllowed` unchanged (trouble lane keeps blocking ee/10be etc.).
- The SMP/MCUboot path is a separate guarded lane: reachable only from the
  firmware procedure's explicit consent flow (dialog start button) and
  interlocks; documented as such in wire-guard.ts header comment +
  HANDOFF danger list.
- KB copy updates: `bootloader-parked.ts` cure changes from "use vendor
  tooling" to "Firmware tab → rescue" (the procedure's failure path covers
  it); `firmware-mismatch.ts` "this app does not flash firmware" line is
  retired; danger-list note gains the SMP lane sentence.

## 11. Smoke scope (§67+, fixtures only — no live device)

- SMP codec: header bytes, CRC16-XMODEM vectors, CBOR round-trips (incl.
  sorted-key byte-stability, indefinite-length decode), frame
  encode/decode, multi-line continuation reassembly.
- Upload loop on a scripted line-based fake port: offset-authoritative
  resume, first-chunk len+sha presence, rc!=0 abort, erase-timeout
  classification (offset-0 slow ok), seq echo matching, late-reply
  rejection.
- Numbering: map-confirmed id 2; ASSUMED fallback; modules unmapped 1 MiB
  rule.
- Interlock matrix: every row of §7 refused/approved correctly.
- Plan resolution: PID→side/generation table, downgrade-by-releaseOrder,
  unknownCurrent, unchanged, fetchable.
- Procedure dry-run: full keyboard run against scripted fixtures (enter →
  identify → upload → swap → reset → await → settle → restore → verify,
  including a failure branch that rescues the parked half), JSONL line
  shape, one-run lock, update-safe flag behavior.
- Catalog loader validation + fetch gate with a fake digest (match /
  mismatch keeps nothing).
- NOT smoke-testable (live-session items, see Unknowns): WebSerial grant
  behavior on re-enumeration, real erase/swap timings, CORS download of
  real images, actual MOD_FWUP no-reply behavior.

## Decisions (calls made in this spec)

1. In-memory images only, re-download per run (no OPFS) — simplest correct
   v1; a cache adds a staleness surface for zero safety gain.
2. Catalog lazy-loaded behind dynamic import on FirmwareTab mount
   (app-shortcuts precedent); ~100 KB chunk.
3. MCUboot entry as a dedicated `enterMcuboot()` SDK method, NOT a
   wire-guard exception — the guard's job is the trouble lane, the
   procedure's job is consent.
4. No env/feature gate (OF's `FIRMWARE_FLASH_ENABLED` is a backend-release
   concept): the browser gate is the consent dialog + interlocks.
5. New top-level `firmware` tab (no Settings tab exists in our app).
6. Reload blocked rather than survived (no SSE/catch-up machinery in a
   page that cannot outlive the flash anyway).
7. Swap/confirm semantics byte-faithful to OF `flash()` defaults, pinned:
   `slot=1, confirm=false, vendor_trailer=true` (firmware_upload.py:696-929,
   verified by builder check).
8. Vendor op paths for the module path, pinned (plan re-verifies each
   against OF's service layer before use): bundle-version read
   `MODULE_FILE_FW_VERSION = 0xDE/0x100A` (left, app mode);
   `MOD_FWUP = 0xDE/0x1005` (one byte = FWUP_TYPES code, no reply);
   LED max-brightness write = LED family `0x1013` op.
9. Console/log-port tap is best-effort text surfaced in the run log
   (observational, never fatal) — browser has no daemon thread; the tap is
   a line accumulator on the non-SMP port when two ports are held.
10. Post-run session ownership: mid-run app-mode conversations
   (`version.confirm`…`verify.compare`) run on procedure-owned
   NayaSessions opened on the re-enumerated app ports (same
   connect+identify discipline as useSessions.connectPort). At `run.end`
   the procedure closes its sessions, clears the fw-run flag, and calls a
   new `useSessions.rescan()` — a re-run of the granted-ports sweep +
   connectPort, taught to skip non-app PIDs (MCUboot/third-mode PIDs are
   never auto-connected). No adopt-API; a fresh handshake is cheap and
   keeps one owner per port.

## Unknowns (live-session items with designed fallbacks — phase 10)

1. **WebSerial re-grant on PID change**: Chrome may or may not return the
   re-enumerated port from `getPorts()`. Fallback: action-step button →
   `requestPort({filters:[{usbVendorId:0x37D1}]})`. If even that fails,
   the rescue path (power cycle → app mode) is always available.
2. **Real timings**: erase stalls (6-19 s), swap (~100 s), module restart
   (~32 s) — OF's measured timeouts are adopted verbatim; smoke uses them
   only as constants, never sleeps that long.
3. **CORS on raw.githubusercontent.com**: expected `access-control-allow-
   origin: *`; if not, fetch fails cleanly into the fetchable-notice error
   path (no images held, nothing written).
4. **Two-CDC-port enumeration in Chrome**: the log port may enumerate as a
   second SerialPort; the probe-answering rule (image-state echo) picks
   the SMP port regardless of order.

## Exit criteria

- Full keyboard + module procedures green end-to-end on scripted smoke
  fixtures; interlock matrix §7 fully asserted; gates green (build, lint,
  smoke 0 FAIL with new §sections); docs landed (HANDOFF ROADMAP item 12 +
  notes, README, danger-list update).
- LIVE first run happens ONLY owner-present (phase 10), with the recovery
  recipe (bootloader-parked cure, power-cycle, unplug-replug) documented
  in the dialog copy and HANDOFF.

## Hazards (standing)

- First real flash is owner-supervised; a bad write can require vendor
  tooling to recover. The design never writes slot 0 and always leaves a
  rescue path (existing firmware is only replaced after the new image is
  written and hash-checked).
- The console log port swallows frames silently — every reset is sent only
  to the SMP-answering port found by probe.
