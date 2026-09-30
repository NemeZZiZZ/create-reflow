# HANDOFF — create-reflow development

Written 2026-10-01 for a third-party agent taking over development of this
repo. Read top to bottom before touching anything.

## What this is

A web-based configurator for the **Naya Create** split keyboard, talking to
the device directly over **Web Serial** (USB CDC). Extracted 2026-09-30 from
the research repo `~/Repository/naya-reflow` (which remains the RE lab:
toolkit, protocol docs, dumps). Two commits of history so far — clean start
by design; the full engineering history lives in naya-reflow.

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
  `flavors.ts` (flavor byte map), `importers/exporters` (snapshot schema
  **v2**, `SNAPSHOT_VERSION`, migrations, peek-guards), `backups.ts`
  (localStorage auto-backups, max 20, content-hash dedupe), `aux.ts`
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

## Commands / gates (run from `client/`)

```sh
pnpm build                                                  # tsc -b && vite build
./node_modules/.bin/rolldown --config scripts/rolldown.smoke.mjs   # MUST exit 0
node /tmp/smoke.cjs                                         # 426/426 ok, 0 FAIL
./node_modules/.bin/oxlint <touched files>
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
  The SDK's `assertWireAllowed` already blocks these at runtime.
- Keymap write form: `30/1004` params `[00, layer] + record`. Records
  `[KK, T, LEN, payload]`. Shadow slot = KK+0x52, filler `[KK,07,00]` (NONE;
  legacy `00 00` also reconciles). Hold-tap records carry term (u16 LE,
  default 200 ms), flavor byte (0=hold-preferred, 1=balanced,
  2=tap-preferred, 3=tap-unless-interrupted — cross-source measured,
  NayaFlow's "Balanced" writes 00), and unknown flag bytes —
  `behaviorMetaOf` preserves them; NEVER zero them.
- Timeouts `fe/100a`: 3×u32 LE ms; 0 = off; 0<v<30000 refused by device
  (SDK throws early). Animation `ed/1011 [layer, effect]`.

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
- Right half never answers `30/1001`; left port proxies dst 0x51.

## Process rules

- Commits are LOCAL until the owner orders a push. Stage EXPLICIT paths
  (never `git add -A` — the checkout may contain owner's untracked files).
- Smoke is the SDK's public-API test (426 asserts; §-numbered). New features
  get new §-sections; helpers inside a §-block are block-scoped.
- UX language of the app is English. UI copy: calm, footgun hints preferred
  over modals. Existing patterns: shadcn-style `ui/`, structural selectors
  for tests, `KeyActionMenu` reused for popover AND panel.

## ROADMAP (owner-set priorities, 2026-10-01)

1. **Native OpenFlow JSON format** (owner decision: "лучше просто
   использовать этот формат изначально" — adopt it as the native
   save/import/export format instead of our own snapshot schema).
   Decoded format (analysis 2026-09-29, sample Layer_0.openflow-layer.json):
   `{version:1, kind:'layer', layer:{srcId, name, orderId, iconId,
   animationId, keys:[{positionId, colorHex, bindings:[{behavior,
   actionType, actionCode, context}]}]}, macros:[], layerRefs:{uuid→layerIndex}}`.
   - positionId 0-73 = keys (KK 1:1); 74-87 = LED strips (colors only);
     88-96 = module bays (`#xxxxxx` placeholder — skip).
   - behavior press/tap/hold/double_tap: press+hold pair → T03; tap+hold →
     T10 (tap ≠ press = explicit multi-set); actionType 'modifier' →
     MODMASK bytes; `layer_polite_hold` + `MO_LAYER_<uuid>` → T05 MO(n)
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
3. Bigger backlog (unranked): LED strips/bays UI coverage (74-96), module
   gesture editing beyond donor-copy (blocked by 1-byte payload same-length
   rule), macros (wire format still unknown — NayaFlow `macro_data` param
   exists, nothing decoded).

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
- Prior art in-repo: `sdk/src/importers.ts` (peek-version guard +
  migration chain pattern to reuse for any schema v3).
