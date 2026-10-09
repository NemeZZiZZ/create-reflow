# OpenFlow JSON as the native format — design

Date: 2026-10-01 (verified against OpenFlow v0.7.0 source 2026-10-10)
Status: awaiting owner review (cross-checked against
`~/Repository/openflow` backend — 3 corrections folded in, one former
loss eliminated)
Source spec: HANDOFF.md ROADMAP item 1 + owner decisions 2026-10-01.

## 0. Owner decisions (settled in chat)

1. **Clean break**: only OpenFlow JSON is read/written. Old formats
   (`naya-backup`, `naya-reflow` keymap/ledmap/naya-full-backup v1/v2) are
   NOT importable anymore. Existing auto-backups in localStorage are
   discarded on upgrade (one-time wipe).
2. **Chain conflict**: import of `press`+`double_tap` without `hold` →
   clamp (write press, drop double_tap) + explicit warning in the log.
3. **Scope**: `kind:'layer'` only. Unknown `kind`/`version` → actionable
   error. Full profile (macros/mouse/LED actionTypes) waits for a sample
   from the OpenFlow author (owner's Discord contact).

## 1. Format (from the decoded sample, `~/Downloads/Layer_0.openflow-layer.json`)

```jsonc
{
  "version": 1,
  "kind": "layer",
  "layer": {
    "srcId": "<uuid>",            // identity of the layer itself
    "name": "Layer 0",
    "orderId": 0,                 // = our device layer index 0..2
    "iconId": null,
    "animationId": "solid",       // per-layer LED animation
    "keys": [
      { "positionId": 0..96, "colorHex": "#rrggbb", "bindings": [
        { "behavior": "press|hold|tap|double_tap",
          "actionType": "key|modifier|layer_polite_hold",
          "actionCode": "ESC | LSHIFT | MO_LAYER_<uuid> | …",
          "context": null }
      ]}
    ]
  },
  "macros": [],
  "layerRefs": { "<uuid>": 1 }    // uuid → device layer index (1..2)
}
```

- positionId 0–73 = keys (KK 1:1); 74–87 = LED strips; 88–96 = module bays.
- Behavior vocabulary (confirmed against OpenFlow v0.7.0 source 2026-10-10,
  `backend/…/actions_catalog.py:48` + `keymap_read.py:263`
  `SECOND_BANK_BEHAVIOR = {"press": "double_tap", "hold": "tap_hold"}`):
  `press`, `tap`, `hold`, `double_tap`, `tap_hold`.
  **Our T10 4th slot (`taphold`) DOES have an OpenFlow counterpart: `tap_hold`**
  — the 2026-10-01 sample simply contained none.
- Layer-switch actionCode prefixes seen in their source (`profiles.py:21`):
  `MO_LAYER_`, `TO_LAYER_`, `TOGGLE_LAYER_`, `STICKY_LAYER_` (+ uuid).
  `layerRefs` values are the target layer's `orderId` (= device layer index) —
  exactly our T05 ORDER semantics (`profiles.py:322-340`).

## 2. Import: OpenFlow → draft ops

Module `sdk/src/openflow.ts` (new; exported from the barrel):

- `parseOpenFlowLayer(obj): { maps: SnapMaps; anim: number; warnings: string[] } | { error }`
  - Guards: `version === 1`, `kind === 'layer'`, `layer.keys` array,
    `layerRefs` well-formed; unknown → `{ error: 'unsupported kind …' }`.
  - `orderId` → device layer 0/1/2 (anything else → error).
  - Positions 74–96: skipped, counted in `warnings` (strips/bays are not
    backed by device stores we can write yet — ROADMAP backlog).
  - `colorHex` → H/S via hex→HSV (V dropped: device stores hue/sat only;
    global brightness is separate). `#xxxxxx` placeholders → skipped.
  - `layerRefs[uuid]` = n ∈ {1, 2}; `MO_LAYER_<uuid>` with `actionType
    layer_polite_hold` → T05 record, ORDER = n.
  - Bindings per key → `BehaviorSet`-equivalent, then the existing
    op builders:
    - single `press` → T01 (`plainRecord`)
    - `press`+`hold` → T03
    - `tap`+`hold`… → T10 set (shadow mini/full as today);
      `double_tap` → double slot, `tap_hold` → taphold slot (T10 full
      shadow — direct counterpart, no loss)
    - `press`+`double_tap` without `hold` → **clamp**: keep press, drop
      double_tap, `warnings.push('key N: Double Tap dropped — device
      requires Hold first')`
    - `TO_LAYER_`/`TOGGLE_LAYER_`/`STICKY_LAYER_` prefixes and any other
      unknown `actionType`/`actionCode` → key skipped + specific warning
      (never a hard error: partial restore is the point of subset imports).
      TO/TOGGLE/STICKY wire forms are not in our verified protocol
      knowledge (special family ORDER 1=MO, 2=hold-layer2 only).
    - `animationId: null` tolerated → no anim op (DB column is nullable
      in OpenFlow, `profiles.py:_new_layer`).
    - non-empty `macros[]` → skipped with count (macros are host-side
      only in every app: firmware ACKs and discards 30/1005/1006).
- Action dictionary: vendored from
  `~/Repository/naya-reflow/research/keymap-host-table.txt` (282 names,
  `NAME = 0xPPPPUUUU`). New `sdk/src/host-table.ts`: `nameToUsage` +
  `usageToName`. Pages: 0x0007 keys, 0x000c consumer, 0x0001 system.
  - `actionType 'key'` → family 0x01 record via the existing `hid()`/
    `consumer()` builders (page taken from the table).
  - `actionType 'modifier'` → page-7 modifier **usage** (0xe0–0xe7), the
    form our whole stack already reads/writes (`HID_MODS`, `matchAction`).
    Roadmap's "MODMASK bytes" hypothesis is NOT used: no OpenFlow-written
    device dump proves the device consumes packed MODMASK here, and the
    usage form round-trips through our app. If a dump later proves
    MODMASK, add a translator then.
  - Families with no OpenFlow counterpart in the sample (BT, out-select,
    mouse, LED vendor, macros) are unknown on import (→ warning) until a
    full-profile sample decodes them.

## 3. Export: caches → OpenFlow layer doc

`buildOpenFlowLayer(keysByLayer[L], ledsByLayer[L], L, animId, meta?) → ExportResult`

- Reverse mapping per key (`behaviorSetOf` + `matchAction`):
  - T01 usage → `[{behavior:'press', actionType, actionCode}]`
  - usage 0xe0–0xe7 → `actionType 'modifier'`, name from `usageToName`
  - T03 → `press`+`hold`; T10 → `tap`+`hold`(+`double_tap`); T10 full
    shadow (`taphold` set) → emit `tap`+`hold`+`double_tap`+`tap_hold`
    (verified counterpart, no loss — see §1).
  - T05 ORDER n → `press layer_polite_hold MO_LAYER_<uuid-n>`.
  - Records that decode to no catalog action → key emitted with empty
    `bindings: []` + count (never guessed).
- `srcId`/`layerRefs` uuids: **deterministic constants** per layer index
  in `openflow.ts` (fixed UUIDs, ours). Exports are stable, refs always
  resolve, no storage needed.
- `colorHex` ← H/S with V=100 (HSV→hex). Strips 74–87 and bays 88–96 are
  emitted as `#xxxxxx` placeholders (device stores for strips are not
  decoded yet — honest data, matches the sample's bay convention).
- `animationId` ↔ ANIM byte: derived from `settings.ts` `ANIM_NAMES`
  (single source of truth — do not duplicate the order table here).
  If the app cannot know the current anim (set-only path), the client
  passes its last-known value; default `'solid'`.
- `name`: `Layer ${L}`; `orderId`: L; `iconId`: null; `macros`: [].
- File name: `Layer_${L}.openflow-layer.json` (matches the sample's
  naming from OpenFlow itself).

## 4. Clean break — what gets deleted/replaced

- `sdk/src/importers.ts`: rewritten to OpenFlow-only
  (`parseSnapshotFile` → accepts only OpenFlow docs; `migrateSnapshot`,
  `pickNotes`, naya-backup and naya-reflow paths deleted;
  `SNAPSHOT_VERSION` retires). `diffSnapshotToDraft` stays (unchanged
  shape: SnapMaps in, ops out) and gains nothing — clamping happens at
  parse time.
- `sdk/src/exporters.ts`: `buildKeymapExport`/`buildLedmapExport` deleted;
  `buildOpenFlowLayer` becomes the export surface.
- `sdk/src/backups.ts`: new internal container
  `{tool:'create-reflow', kind:'backup', v:1, exportedAt, layers:[≤3 OF
  docs], notes}` (host-side only, never shared — so it may carry our
  notes; OF files themselves carry none). Storage upgrade: existing
  `naya-auto-backups` content that fails the new shape is wiped once
  (version bump), per owner decision 1.
- Client `App.tsx` Save ▾ / Import handlers rewired to the new builders;
  log lines report clamp/skip warnings from parse; importing a layer doc
  also queues the `ed/1011` anim op when the doc's `animationId` differs
  from the app's last-known anim for that layer (parse returns `anim`).
- Per-key notes stay a client feature (localStorage) and ride only in the
  internal backup container. **Documented consequence of clean break:
  exported .openflow-layer.json files do not carry notes.**

## 5. Testing (smoke, node-runnable)

- New §-sections: fixture (inline, reduced: all binding shapes incl. the
  `press`+`double_tap` conflict, `tap_hold` (T10 full), and `MO_LAYER_`
  refs) → byte-exact asserts on the built records; export→import
  roundtrip; uuid stability; hsv converters; host-table lookups both
  directions; clamp warnings; unknown kind/version/opcode errors (incl.
  `TOGGLE_LAYER_`-prefix warning); strips/bays skip counts; null
  `animationId`; non-empty macros skip.
- Reworked existing sections: §27 (snapshot guards) and §32 (backup
  round-trip + notes carry) move to the new formats; the "future version
  guard" test now targets OF `version > 1` and backup container v>1.
- Gate unchanged (§ count grows; trust 0 FAIL), plus README/HANDOFF count
  updates and roadmap item 1 check-off.

## 6. Phases (each a separate local commit, gates green)

1. **SDK format core**: `host-table.ts` + `openflow.ts` (parse/build/hsv/
   uuids) + smoke. No callers changed yet.
2. **SDK swap**: importers/exporters/backups rewritten, old paths deleted,
   smoke §27/§32 reworked.
3. **Client**: Save/Import UI, warnings in log, notes threading, anim
   last-known value.
4. **Docs**: README, HANDOFF (roadmap item 1 done + format section).

## 7. Risks / open notes

- ~~`taphold` has no OpenFlow form~~ **Resolved 2026-10-10**: the form is
  `tap_hold` (OpenFlow `actions_catalog.py` + `keymap_read.py` second-bank
  mapping) — round-trips losslessly both directions.
- Modifier encoding assumption (usage form) — see §2; revisited when an
  OpenFlow-written dump exists.
- Strips (74–87) colors do not round-trip through our app yet (import
  skips, export placeholder) — blocked on the LED-stores RE backlog.
- `version:1`-only: a future OF `version:2` file must fail with an
  actionable message (peek guard, same UHK pattern as before).
- Full-profile `kind:'profile'` shape is now KNOWN from their source
  (`profiles.py:_profile_payload`: `{profile:{name,iconId}, layers[],
  macros[], modules:{configBindings, configs}}`) — no Discord sample
  needed; extending import/export to it is straightforward future work
  once module configs get a device model (ROADMAP E).
