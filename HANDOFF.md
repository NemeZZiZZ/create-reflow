# HANDOFF — create-reflow development

Written 2026-10-01 for a third-party agent taking over development of this
repo. Read top to bottom before touching anything.

## What this is

A web-based configurator for the **Naya Create** split keyboard, talking to
the device directly over **Web Serial** (USB CDC). Extracted 2026-09-30 from
the research repo `~/Repository/naya-reflow` (which remains the RE lab:
toolkit, protocol docs, dumps). Clean start by design; the full engineering
history lives in naya-reflow.

- License: MIT. Owner: NemeZZiZZ. Pushes to GitHub only on explicit order
  (initial push done 2026-10-01 by owner's order).

## Layout

pnpm workspace (pnpm 10.33.0), two packages:

- **`sdk/`** — `@create-reflow/sdk`, pure TypeScript, no React/DOM.
  `src/`: `naya.ts` (CDC protocol: frames, NayaSession, multipart reads,
  partMatcher, timeouts, status decode), `t10.ts` (keymap record builders
  T01/T03/T05/T10 + `behaviorMetaOf` unknown-byte preservation), `actions.ts`
  (action catalog), `draft.ts` (op queue + reconcile), `queue.ts` (selection
  → ops), `settings.ts` (ED settings ops), `modules.ts` (30/100c gestures),
  `flavors.ts` (flavor byte map), `openflow.ts` (OpenFlow layer-doc
  parse/build, host-table name resolution), `importers.ts` (OpenFlow-only
  file parse with peek-guards; legacy snapshot formats rejected — clean
  break 2026-10, no schema migrations), `backups.ts`
  (localStorage auto-backups, max 20, content-hash dedupe, internal
  container around OpenFlow layer docs), `aux.ts`
  (per-half telemetry), `palette-groups.ts`, `troubleshooting/` (12 recipes,
  hybrid `steps|run(ctx)` plugins + `assertWireAllowed` runtime guard).
  Barrel: `src/index.ts`. Source-dist (no build step).
- **`client/`** — `@create-reflow/client`, React 19 + Vite 8 + Tailwind 4 +
  radix ui. 6 tabs: Bindings / LED Map / Modules / Behavior / Devices /
  Troubleshooting. Right-click a key → KeyActionMenu popover (also in the
  bottom SelectionPanel). URL is editor state (`?tab&view&layer&key`, Back
  closes selection). Per-key notes (localStorage, schema v2).

Client-only libs stayed in `client/src/lib/`: `kb-data.ts`,
`key-icon-map.ts`, `key-icons.ts` (?raw SVGs, 860 glyphs vendored from
NayaFlow), `utils.ts` (cn), `save.ts` (saveJson).

## Continuing development — start here

Reading order for a new agent (each item assumes the previous):

1. This file, top to bottom.
2. `sdk/src/naya.ts` — protocol core (frames, `NayaSession`, multipart reads,
   `partMatcher`, status decode). ~1000 lines, heavily commented.
3. `~/Repository/naya-reflow/docs/cdc-protocol.md` — wire ground truth.
4. `client/src/App.tsx` — composition root; header comment explains the
   dual-half model. State lives in `client/src/hooks/`, views in
   `client/src/components/` (tabs in `components/tabs/`).
5. `client/scripts/smoke.tsx` — the executable spec (below).

### Architecture in one screen

- **Client**: `App.tsx` only wires. State hooks: `useSessions` (Web Serial
  ports; left half = data plane, right = status-only), `useLayers` (read
  keymap/LED maps), `useDraft` (pending edits as ops), `useFlash` (apply +
  readback verify), `useSelection`/`useUrlSync` (`?tab&view&layer&key`,
  Back closes the selection), `useAuxPolling` (per-half telemetry),
  `useCustomColors`, `useLog`. `KeyActionMenu` is reused as popover AND
  panel.
- **SDK**: pure TS, source-dist — no build output; `pnpm --filter
  @create-reflow/sdk build` is typecheck-only (`tsc --noEmit`); the client
  imports it from source via the workspace. Edit model: UI mutation → op in
  `Draft` (`draft.ts`: sections/dedup/stats) → FlashDialog → `queue.ts`
  turns ops into wire writes (`30/1004` …) → readback verify. **No
  `fe/100a` commit is ever sent.** Snapshots: OpenFlow layer docs
  (`openflow.ts`/`importers.ts`, clean break 2026-10); `backups.ts`
  auto-saves to localStorage; `troubleshooting/` =
  recipe engine + `assertWireAllowed` guard.

### Adding a feature end-to-end

1. **SDK first**: pure function/type in the owning module (queue logic →
   `queue.ts`, records → `t10.ts`, settings → `settings.ts` …). New file ⇒
   export it from `src/index.ts`.
2. **Client**: logic in a hook, markup in a component; keep `App.tsx`
   wiring-only. UI copy in English; footgun hints over modals.
3. **Smoke**: append a numbered section (`// §N name`, next free N) to
   `client/scripts/smoke.tsx`; helpers are block-scoped inside their
   §-block. Wire-format features get byte-exact asserts — most commands
   already have live-proven vectors, extend them rather than forking.
4. **Gate + commit**: all commands below green, stage explicit paths,
   local commit (push only on owner's order).

## Commands / gates (run from `client/`)

```sh
pnpm build                                                  # tsc -b && vite build
./node_modules/.bin/rolldown --config scripts/rolldown.smoke.mjs   # MUST exit 0
node /tmp/smoke.cjs                                         # assert count grows with §-sections — the gate is 0 FAIL
./node_modules/.bin/oxlint <touched client files>           # client files (from client/)
pnpm --filter @create-reflow/sdk lint                       # sdk files (oxlint src, in-package — avoids the .. rule)
pnpm --filter @create-reflow/sdk build                      # tsc --noEmit
```

Per-commit gate = all of the above green. **Smoke-cjs hazard:** rolldown
WRITES `/tmp/smoke.cjs`; a stale file from another checkout passes
misleadingly — always verify rolldown's exit code before trusting the run.
oxlint rejects paths containing `..` (run from package dir). Shell pipes eat
exit codes (`cmd | tail; echo $?` shows tail's) — redirect to a file instead.

## Protocol ground truth (do not guess)

- `~/Repository/naya-reflow/docs/cdc-protocol.md` — wire format, all proven
  verdicts, gotchas (19-KK layer byte, multipart traps, full-map 100e DEAD).
- `~/Repository/naya-create-kb` (github.com/NemeZZiZZ/naya-create-kb) — the
  public knowledge base; protocol/device/host pages. Cross-source findings
  applied 2026-10-01 (commit 94aafa7).
- **Never send** (device-destroying): `fa/1002`, `fa/1006`, `ee/10be`,
  `ee/10ae`, `clear_bonds`, `mcuboot_reset`. Safe reset: `ee/10ce`.
  `30/10ca` (factory format) only by explicit owner decision — it also wipes
  the layer-list store (hold-to-layer dies until a stock NayaFlow flash).
  Runtime enforcement: `assertWireAllowed` (`sdk/src/troubleshooting/
  wire-guard.ts`) throws on ANY `fa/*` verb, `ee/10be`/`ee/10ae`, and
  `30/10ca`; it wraps the troubleshooting recipes' `ctx.send` chokepoint
  (App.tsx). Regular flash traffic bypasses it — safe by construction,
  since `NayaSession` implements only whitelisted verbs.
- Keymap write form: `30/1004` params `[00, layer] + record`. Records
  `[KK, T, LEN, payload]`. Shadow slot = KK+0x52, filler `[KK,07,00]` (NONE;
  legacy `00 00` also reconciles). Hold-tap records carry term (u16 LE,
  default 200 ms), flavor byte (0=hold-preferred, 1=balanced,
  2=tap-preferred, 3=tap-unless-interrupted — cross-source measured,
  NayaFlow's "Balanced" writes 00), and unknown flag bytes —
  `behaviorMetaOf` preserves them; NEVER zero them.
- Timeouts `fe/100a` = SET ACTIVITY TIMEOUTS: params 13B = status `00` +
  3×u32 LE ms; 0 = off; 0<v<30000 refused by device (SDK throws early).
  Sending fresh values is the stock, proven path. The "**no `fe/100a`
  commit**" rule means: keymap writes apply instantly and persist — there
  is no legitimate commit verb, and REPLAYING captured `fe/100a` bytes
  commit-style wedges the state machine (`naya.ts` setTimeouts note).
  Animation `ed/1011 [layer, effect]`.

## Device & live-testing rules

- Device work (any `--apply`/live write) requires the owner present and
  **NayaFlow quit** (it holds the ports). Current device state 2026-10-01:
  left half lit + typing + layers OK; right half render is being repaired by
  ANOTHER agent — do not touch it. Known-open FW bug: brightness step wraps
  (host-side arithmetic; MAXBRT button in Troubleshooting is the workaround).
- **The dev server belongs to the owner** (started from their IDE; any free
  port). The agent must NOT start its own vite. Web Serial grants are
  origin+port-scoped: the first open on a new origin needs a one-time manual
  port pick by the owner (the agent cannot click the browser picker).
- Right half never answers `30/1001` — it holds no keymap data to read
  back (the LEFT half owns all keymap/LED maps); the left port proxies
  dst 0x51 for right-half status/telemetry.

## Process rules

- Commits are LOCAL until the owner orders a push. Stage EXPLICIT paths
  (never `git add -A` — the checkout may contain owner's untracked files).
- Smoke is the SDK's public-API test (assert count grows with §-sections;
  §-numbered). New features
  get new §-sections; helpers inside a §-block are block-scoped.
- UX language of the app is English. UI copy: calm, footgun hints preferred
  over modals. Existing patterns: shadcn-style `ui/`, structural selectors
  for tests, `KeyActionMenu` reused for popover AND panel.

## Native format — OpenFlow JSON (since 2026-10-10)

Save, Import, and auto-backups all speak the OpenFlow layer format
(`version: 1`, `kind: 'layer'`, `.openflow-layer.json`) — the in-house
snapshot schema is gone (clean break). Core: `sdk/src/openflow.ts` (parse +
build, host-table name resolution); file gate: `sdk/src/importers.ts`
(`parseSnapshotFile` peek-guards); backup container: `sdk/src/backups.ts`.

- **Save**: per-layer `Layer N (.openflow-layer.json)` items + `All layers`
  (SaveMenu); one doc carries keys AND colors; the doc's `animationId` comes
  from last-known `animByLayer` state, defaulting to `'solid'`.
- **Import / restore**: OpenFlow layer docs and auto-backups only. Legacy
  formats (naya-backup, naya-reflow v1/v2, naya-full-backup) are rejected up
  front with a clean-break error naming the re-export path. Import diffs
  against the live caches and queues only the changes; when the doc's
  `animationId` differs from last-known, `ed/1011` anim ops are queued too.
  Warnings are logged verbatim — partial restore is the point of a subset
  import (LED strips/bays entries are colors-only, informational).
- **Auto-backups**: internal container `{tool: 'create-reflow',
  kind: 'backup', v: 1, layers: [OpenFlow docs], notes}`. Per-key notes ride
  ONLY there — OpenFlow files never carry them. Legacy localStorage content
  is wiped once on upgrade; pre-flash backups preserve last-known
  `animationId`.
- **Dynamic layers (Phase 2, 2026-10-10)**: the board's layer window is
  0-7. The inventory comes from the 30/1001 handshake's layer-list table
  (`parseInventory`, `sdk/src/layers.ts`); Add/Delete queue `layers` draft
  ops (30/1002) and the post-flash dump re-reads the inventory. Layer
  caches (keys/leds/notes/anims) are inventory-width — never assume 3.
  Every flash ends with a layer-list restore echo; that echo also restores
  runtime lighting on both halves automatically.
- **STORED vs RUNTIME animation bytes — never mix them**: the layer-list
  STORED byte is ZMK order Solid/Breathe/Spectrum/Swirl
  (`STORED_ANIM_NAMES`, `sdk/src/layers.ts`); the RUNTIME `ed/1011` effect
  index is Solid/Breathe/Swirl/Spectrum (`ANIM_NAMES`,
  `sdk/src/settings.ts`) — the two tails are swapped (2↔3). Convert only
  at the boundary, by name, via `storedAnimOf`/`storedAnimName`; never
  reuse an index across the two tables.

- **LED strips & bays (Phase 3, 2026-10-10)**: strip positions 74-87
  round-trip as ordinary `colorHex` entries — parse maps them to
  color-only led records, export emits `colorHex` for keys AND strips
  (pos ≤ 87; OF parity, LAST_KEYED_LED = 87). Bay positions 88-96 are a
  documented silent skip: OF files carry only stale `#xxxxxx` placeholders
  there, OF's own flash refuses to write bays, and OF also loses bay
  colors — parity. In the app one bay click queues 24 per-LED ops via
  `queueBayColor` (kk 88-135, 24 per side); layer fill never touches bays
  (`queueFillLayer` gates kk ≤ 87).

- **Flash capability model (Phase 4, 2026-10-11)**: the flash dialog
  explains what will not store, and readbacks no longer confuse "unreadable"
  with "empty". Refused edits become data: `Draft.drops` (`DraftDrop`,
  `sdk/src/draft.ts`) records every queue-time refusal verbatim (`reason` =
  validator/queue message, `effect` = the honest sentence for what the
  keyboard does instead), deduped by reason+layer+kk; `probeDraft` re-checks
  the queued ops purely (draft alone, no live cache, never mutates), and
  `collectDrops` (`client/src/hooks/useFlash.ts`) merges ledger + probe into
  the dialog's drop list (snapshotted at flash start, re-rendered after the
  run). `counts.unknown` in OpenFlow export is deflated: known-empty
  families — a filler `[kk,07,00]`, the legacy `[kk,00,00]` blank, or a
  matchAction hit on the 'empty' catalog action — export `bindings: []`
  WITHOUT an unknown increment (the slot is genuinely cleared, nothing was
  unrepresentable); `unknown` counts only genuine unexportable records
  (matchAction misses, unmapped usages). Multipart reads return
  `{blob, status}` (`chunkStatus`, `sdk/src/naya.ts`): 'ok' | 'empty' |
  'unsupported' | 'unknown:0x..' — a bare 0x16/0x18 means nothing stored
  ('empty' stops the read clean instead of erroring), 0x11 means the read
  itself is unsupported, any other bare byte is reported verbatim; a
  short/garbled read is NEVER classified as empty. `LayerDump.status`
  carries that per layer idx (keymap read seeds it; the LED read only
  overwrites an 'ok', so the first non-'ok' classification wins). Flash
  verdicts grade as ok | cannot-verify | partial | fail: cannot-verify sits
  strictly between ok and partial — a still-queued op targets a layer whose
  post-flash read came back 'unsupported'/'unknown:…', so the write may
  have landed (never fails the flash; 'empty' and dump-absent layers fall
  through to a plain partial). NACK aborts are structured
  (`${opSummary} — device refused the value (0xEA): nothing was stored` /
  `bad or missing ack (hex)`) and throw → fail; the layers op's NACK is the
  one non-throwing case (idempotent write, the restore echo re-sends the
  full table) → partial with a "layer-list write not acked" note.

Known limitation (binding shape): OpenFlow bindings are
`{behavior, actionType, actionCode, context: null}` — there is no slot for
behavior parameters, so term ≠ 200 ms and non-zero unknown flag bytes do NOT
survive an export→import round-trip; they reset to defaults on import. Also:
backups created before ff58f42 baked a `'solid'` `animationId` into every
layer doc. Import/export asymmetry for layer switches: import maps
`MO_LAYER_<uuid→2>` to T05 ORDER 2 (hold-layer2), but export only emits MO
refs for `special:1` — an imported MO(2) is counted `unknown` on re-export
(semantically honest; documented asymmetry).

## ROADMAP (owner-set priorities, 2026-10-01)

> 2026-10-10: полный инвентарь механик, которых нет у нас, но есть у
> OpenFlow v0.7.0 (конкурент/community-приёмник NayaFlow) —
> `docs/research/2026-10-10-openflow-gap-analysis.md` (локальный клон
> `~/Repository/openflow`). Важное из него: Naya B.V. закрылась,
> NayaFlow не поддерживается; прошивка ACK-ает и выбрасывает запись
> макросов (макросы — только host-side, навсегда); их схемы
> `.openflow-profile.json` — ground truth для пункта 1.

1. **Native OpenFlow JSON format** — ✅ DONE 2026-10-10 (commits
   9678e91..ff58f42 + the docs commit marking this; see "Native format"
   section above). Owner decision: "лучше просто
   использовать этот формат изначально" — adopt it as the native
   save/import/export format instead of our own snapshot schema.
   Decoded format (analysis 2026-09-29, sample Layer_0.openflow-layer.json):
   `{version:1, kind:'layer', layer:{srcId, name, orderId, iconId,
   animationId, keys:[{positionId, colorHex, bindings:[{behavior,
   actionType, actionCode, context}]}]}, macros:[], layerRefs:{uuid→layerIndex}}`.
   - positionId 0-73 = keys (KK 1:1); 74-87 = LED strips (colors only);
     88-96 = module bays (`#xxxxxx` placeholder — skip).
   - behavior press/tap/hold/double_tap: press+hold pair → T03; tap+hold →
     T10 (tap ≠ press = explicit multi-set); actionType 'modifier' →
     page-7 modifier usage 0xe0-0xe7 (nameToUsage), NOT MODMASK;
     `layer_polite_hold` + `MO_LAYER_<uuid>` → T05 MO(n)
     resolved via layerRefs (device layers 1-2); per-layer animationId ≈
     ed/1011; colorHex → our H/S.
   - actionCode dictionary == the NayaCore host table already mirrored at
     `~/Repository/naya-reflow/research/keymap-host-table.txt` (282 names,
     e.g. NUMBER_1=0x0007001e, CAPSLOCK=0x39).
   - Open design questions to settle with the owner: schema-v2 migration vs
     clean break (auto-backups compatibility); chain-rule conflict when
     press+double_tap exists without hold (clamp or write as-is); full
     profile kind (macros/mouse/LED actionTypes) — request a sample export
     from the OpenFlow author (Discord contact exists).
2. Optional: live-verify flavor selector on device (byte written only on
   explicit user pick — safe by construction).
3. Bigger backlog (unranked): LED strips/bays UI coverage (74-96) — done,
   Phase 3 (item 5); module gesture editing beyond donor-copy (blocked by
   1-byte payload same-length rule), macros (wire format still unknown —
   NayaFlow `macro_data` param exists, nothing decoded).
4. **Layer management + lighting restore (Phase 2)** — ✅ DONE 2026-10-10
   (commits 20c04e7..d853965 + the docs commit marking this). Dynamic 0-7
   layer window: inventory parse + add/delete/restore encoders
   (`sdk/src/layers.ts`), layer add/delete queue helpers, inventory-driven
   tabs, and the flash-tail layer-list echo that restores runtime lighting
   automatically. See the STORED vs RUNTIME animation note in "Native
   format" above.
5. **LED strips/bays painting (Phase 3)** — ✅ DONE 2026-10-10 (commits
   f00ce67..e069276 + the docs commit marking this). Full 136-LED painting
   in the LED tab: edge strips (74-87) as individual dots, module-bay
   swatches (one click → 24 per-LED ops per side via `queueBayColor`),
   layer fill stays keys+strips. Strips round-trip as `colorHex` in
   OpenFlow layer docs; bay positions 88-96 are a documented silent skip
   (parity — OF also loses bay colors). See the LED strips & bays note in
   "Native format" above.
6. **Flash capability model (Phase 4)** — ✅ DONE 2026-10-11 (commits
   148bcdb..e66207f + the docs commit marking this). The flash dialog
   renders every unstorable change with reason + effect (drop ledger + pure
   probe), export `counts.unknown` stops counting known-empty slots, layer
   reads distinguish empty from unsupported/unknown, and verdicts grade as
   ok/cannot-verify/partial/fail. See the flash capability note in
   "Native format" above.

## Ecosystem / diplomacy context

The competitor **OpenFlow** (author = Discord contact) ships an Electron
configurator + their own KB (github.com/create-collective/Create-knowledge-base,
CC BY 4.0 + MIT code — one-way compatible INTO a CC BY-SA KB of ours).
Negotiation state: he proposed a GitHub org + merging the KBs; our position
(so far): repos stay separate, KBs cross-link, review-gated PRs welcome, no
maintainer rights for him in our KB. naya-create-kb still has NO license
file — owner is choosing (CC BY-SA 4.0 recommended by the previous agent).

## Pointers

- Engineering ledger (full history of this app's development):
  `~/Repository/naya-reflow/.superpowers/sdd/2026-09-17-openflow-parity/progress.md`
  (local-only, not in git).
- Competitor-KB reconciliation research (21 disputed claims + verdicts):
  `~/Repository/naya-reflow/.superpowers/kb-competitor-reconciliation-2026-09-30.md`
  (local-only).
- Device-state handoff for the right-half agent:
  `~/Repository/naya-reflow/research/HANDOFF-device-state-2026-09-22.md`.
- Prior art in-repo: `sdk/src/importers.ts` (peek-guard ordering pattern —
  most actionable error first; the legacy schema-migration chain was removed
  in the OpenFlow clean break).
