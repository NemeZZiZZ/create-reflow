# Firmware Daytime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the bugs and daytime defects found in the 2026-10-13 live night session, plus the highest-value optimizations, without breaking the 1717-assert smoke suite.

**Architecture:** Seven small, independently testable tasks over the existing Phase-9 modules (hook core, App grant bridge, dump hook, vault lib, one dialog helper). No new modules except a tiny vault-persistence helper. Every behavioral change is pinned by new smoke asserts first (TDD red).

**Tech Stack:** TypeScript, React (client/), WebSerial, IndexedDB (vault persistence only), existing rolldown smoke harness.

**Spec:** `docs/superpowers/specs/2026-10-12-smp-firmware-flashing-design.md` (the plan argues from it; executors read both). Plus the **Live facts** section below — measured 2026-10-13 on fw 3.41.0, macOS/Chrome, and binding where the spec is silent.

## Live facts (binding — from the night session, take precedence over speculation)

- `ee/10ae` does NOT self-park on this host/fw: it opens a **~30s MCUboot window** (half resident on 0x06F/0x0D3, two CDC ifaces with identical OS names); a valid SMP frame inside the window **latches** parking (KB boot-pass latch rule). `probeOnce`'s imageState read IS such a frame — the window must only survive until the first probe.
- First image-state answer after a fresh latch is slow: echo answered in 1.6s live, image-state stayed silent >30s (KB measures 4–69s). Current default `probeMs: 70_000` (useFirmwareFlash.ts:547) is correct for production; smoke fixtures inject their own short `probeMs`.
- A half in MCUboot the browser never granted is **invisible to getPorts**; stale grants (e.g. left 0x6F) persist in getPorts/picker until browser restart; both CDC ifaces (data+log) share one OS name — picker choice is a 50/50 lottery, the log port swallows SMP frames silently.
- `dumpAll` (useLayers.ts:73-219) can hang forever with **zero TX** (wedged USB transport: even the first write never resolves); it holds `busyRef` until its body settles — `finally` at useLayers.ts:214-216 releases it, so the defect is *no watchdog*, not a missing release.
- The in-memory vault (`firmwareVault()` in useFirmwareFlash.ts:619-623) dies on every page reload/HMR — the night lost 4+ downloads to this (~1 min each).
- Devices report Naya version form `v0.3.41.0` / `v0.2.3.3`; catalog labels are `3.41.0` / `2.3.3`. Shared normalizer: `stripNayaLeadingZero` in client/src/lib/firmware-plan.ts (strip ONE leading `0.` iff remainder valid and head nonzero).

## Global Constraints

- Every shell command starts with `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"`.
- Gates run from `client/`: `pnpm build` exit 0, `pnpm lint` exit 0 (27-warning baseline, no new warnings), `./node_modules/.bin/rolldown --config scripts/rolldown.smoke.mjs` exit code verified then `node /tmp/smoke.cjs`, **0 FAIL** (baseline 1717 ok).
- SDK (`sdk/`) stays DOM-free: IndexedDB/WebSerial code lives in `client/` only, never in `sdk/`.
- UI copy is calm English; new refusal/notice strings are pinned verbatim in smoke.
- Plain git, explicit file paths in every commit, local `main`, NEVER push.
- TDD: red run first (new asserts fail on unmodified code), then green. Commit message verbs: `fix(client): …`, `feat(client): …`.
- No hardware writes without owner consent — smoke fixtures only; nothing in this plan touches a real device.

## Review Focus

1. A PID filter that hides the needed bootloader port (gen-B `0x106F`/`0x10D3` forgotten, or a future PID) strands the run at grant with no recovery — the grant action copy must name the expected entry, and the filter test pins all four mcuboot PIDs plus exclusion of app PIDs. (Task 1 pins it.)
2. Parallel probing opens two serial ports at once — if both candidates are the same physical port object, double-open throws; the helper must dedupe by port identity first. (Task 2 pins it.)
3. A dumpAll watchdog that fires mid-healthy-read bricks a good dump — budget must be generous (≥120s wall clock) and fire only on zero-progress. (Task 3 pins it.)
4. Vault hydration racing a fresh download — keys are content digests (same key ⇒ same bytes), so last-write-wins is safe; the test pins double-hydrate idempotence. (Task 6 pins it.)
5. A second-chance grant that outlives the ~30s window burns the run on a dead wait — the second round is bounded by remaining `enterMs` and then aborts. (Task 7 pins it.)

---

### Task 1: PID-scoped grant filters + late-grant cleanup (O1, M3, D4-root)

**Files:**
- Modify: `client/src/lib/serial-world.ts:21-29` (filter type)
- Modify: `client/src/hooks/useFirmwareFlash.ts:105` (`FlashDeps.grantPort` type), `:1162-1195` (grant race)
- Modify: `client/src/App.tsx:261-273` (`fwGrantPick` passes filters)
- Test: `client/scripts/smoke.tsx` §72 grant fixtures + new asserts

**Interfaces:**
- Consumes: `RECOVERY_PIDS`, `pidInfo` from `client/src/lib/firmware-plat.ts`; `portMatches` (hook-local).
- Produces: `GrantFilter = { usbVendorId: number; usbProductId?: number }`; `grantPort?: (filters?: GrantFilter[]) => Promise<PortWithInfo>` (optional arg — existing zero-arg injectors keep compiling); side→PID map for the enter step.

- [ ] **Step 1: Write failing asserts** — §72: (a) filter builder for left yields exactly `[{vid:0x37D1,pid:0x6F},{vid:0x37D1,pid:0x106F}]`, right yields `0xD3/0x10D3`, and excludes app PIDs `0x64/0xC8`; (b) late-grant-after-scan-win: the unused granted port gets `forget()` called (fake port records it), scan winner is used.
- [ ] **Step 2: Run to verify they fail** — `node /tmp/smoke.cjs` shows the new FAIL lines; rolldown exit code verified first.
- [ ] **Step 3: Implement** — widen `requestPort` filter type with optional `usbProductId`; build side-specific mcuboot PID filters at the enter step and pass through `grantPort(filters)`; when scan wins while a grant is still pending, `forget()` the late grant result (guard `typeof port.forget === 'function'` — fakes may lack it). Keep vendor-only behavior when no filters given.
- [ ] **Step 4: Run gates** — build 0, lint 0 (no new warnings), smoke 0 FAIL with count risen by the new asserts.
- [ ] **Step 5: Commit** — `git add` the 4 explicit paths; `git commit -m "feat(client): PID-scoped bootloader grant filters + forget late grants"`.

### Task 2: Parallel identify probing (O2, M1)

**Files:**
- Modify: `client/src/hooks/useFirmwareFlash.ts:747-765` (add `probeFirst` beside `probeOnce`), `:1220-1230` (identify), `:830-838` (exitBootloader fresh probe), rescue probe site near `:976` and `:2051`
- Test: `client/scripts/smoke.tsx` §72 new asserts

**Interfaces:**
- Consumes: `probeOnce(port, probeMs, resetMs)` (unchanged); `portMatches`, `dumpConsole`.
- Produces: `probeFirst(ports, probeMs, resetMs): Promise<{ winner, consoleText }>` — dedupes by port identity, races all candidates, first winner wins, losers closed, console text of ALL settled results concatenated.

- [ ] **Step 1: Write failing asserts** — §72: with candidates `[silent-70s-port, answering-port]` (in that order) and `probeMs` short-injected, identify resolves via the answering port in under 2× the single-probe time (fixture clock: answering port tried without waiting out the silent one); both ports opened; the loser closed afterward (fake records open/close counts).
- [ ] **Step 2: Run to verify they fail** (sequential code waits out the silent port first).
- [ ] **Step 3: Implement** `probeFirst` and replace the sequential loops at identify, exitBootloader fresh-probe, and the rescue probe site(s). Leave swap.verify's `Promise.all` results loop (1394) untouched — it needs every winner's slots.
- [ ] **Step 4: Run gates** — build 0, lint 0, smoke 0 FAIL.
- [ ] **Step 5: Commit** — `git commit -m "feat(client): race bootloader identify probes in parallel — first answer wins"`.

### Task 3: dumpAll watchdog (O4, D1, D3)

**Files:**
- Modify: `client/src/hooks/useLayers.ts:73-219`
- Test: `client/scripts/smoke.tsx` — new asserts using the existing fake-session pattern (a transport whose first write never resolves)

**Interfaces:**
- Consumes: `NayaSession`, `busyRef`, existing `log('inf'|'err', …)` copy voice.
- Produces: dumpAll with a 120s wall-clock watchdog: on fire → `log('err', 'dump: <exact copy>')`, close + drop the dead session is the CALLER's job — dumpAll itself releases `busyRef` (existing finally), returns null, and sets stats to `FAILED: dump timed out — replug the half and retry` (exact string, smoke-pinned).

- [ ] **Step 1: Write failing asserts** — stalled transport: dumpAll resolves null (not hangs — assert with a test-level timeout), `busyRef.current === false` after, stats string exact.
- [ ] **Step 2: Run to verify they fail** (hangs → test-timeout FAIL).
- [ ] **Step 3: Implement** — race the existing body against a 120_000 ms timer; watchdog constant named `DUMP_WATCHDOG_MS` beside the hook. No change to the happy path or retry ladder.
- [ ] **Step 4: Run gates** — build 0, lint 0, smoke 0 FAIL.
- [ ] **Step 5: Commit** — `git commit -m "fix(client): dumpAll wall-clock watchdog — a wedged transport can no longer hold busyRef"`.

### Task 4: Refusal reasons instead of silent null (O5, D2)

**Files:**
- Modify: `client/src/hooks/useFirmwareFlash.ts:164-188` (`beginFirmwareRun`), callers near `:893` and `:1767` (startKeyboardRun/startModuleRun early-return), both dialogs' `start()` (KeyboardFlashDialog.tsx:~274, ModuleFlashDialog equivalent)
- Test: `client/scripts/smoke.tsx` §71 (currently pins `null` — update to the new shape)

**Interfaces:**
- Consumes: `FirmwareRunLog`, `FlashDeps`.
- Produces: `beginFirmwareRun(deps, kind): { ok: true; log: FirmwareRunLog } | { ok: false; reason: 'run-active' | 'device-busy' }`. Dialogs toast the reason (`'A firmware run is already active'` / `'Device busy — wait for the current operation to finish'`, exact strings smoke-pinned via the exported helper, not via DOM).

- [ ] **Step 1: Write failing asserts** — §71: refusal returns `{ok:false,reason:'device-busy'}` with busyRef held (and `'run-active'` with a run open); update the old null asserts in the same step (they must FAIL pre-change).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — new return shape, both procedure call sites surface the reason to the log + resolve (no throw), both dialogs toast it. Keep `endFirmwareRun` untouched.
- [ ] **Step 4: Run gates** — build 0, lint 0, smoke 0 FAIL.
- [ ] **Step 5: Commit** — `git commit -m "feat(client): firmware run refusals carry reasons — dialogs say why instead of going silent"`.

### Task 5: Version-form unification + documentation nits (M2 + nits)

**Files:**
- Modify: `client/src/components/firmware/KeyboardFlashDialog.tsx:63-80` (`fwLabelOf`)
- Modify: `sdk/src/smp.ts` (doc comment on `resolveUploadImageId`: fixture-covered, no production callers) and/or `client/src/hooks/useFirmwareFlash.ts` (gate comment noting the static-2/4 tautology is intentional defense-in-depth)
- Test: existing §69 asserts must stay green; add one: `fwLabelOf`-equivalent path with a genuine `0.0.x` label never matches a nonzero catalog label (export the helper if needed for the test —Dialog-local today; check coverage first)

**Interfaces:**
- Consumes: `stripNayaLeadingZero` (firmware-plan.ts), `versionsMatch`-style trailing-zero-insensitive equality (hook-local `versionsMatch`, useFirmwareFlash.ts:789).
- Produces: `fwLabelOf` with identical signature and identical results on all real inputs, delegating normalization to the shared helper.

- [ ] **Step 1: Write failing assert** — the `0.0.x`-never-matches case (fails on strip-ALL semantics if reachable; if unreachable, assert current behavior is preserved and skip to docs — record the call in the report).
- [ ] **Step 2: Run to verify.**
- [ ] **Step 3: Implement** — replace the `while (cur[0] === 0) shift` with the shared helper; add the two doc comments. No production deletions.
- [ ] **Step 4: Run gates** — build 0, lint 0, smoke 0 FAIL.
- [ ] **Step 5: Commit** — `git commit -m "fix(client): unify Naya leading-zero handling on the shared helper + document static upload ids"`.

### Task 6: Persistent vault (O3)

**Files:**
- Create: `client/src/lib/firmware-vault-store.ts`
- Modify: `client/src/lib/firmware-fetch.ts` (`fetchVersion` writes through), App-level vault creation (`App.tsx:70`-area `firmwareVault()`), FirmwareTab hydration call site
- Test: `client/scripts/smoke.tsx` — async IDB is absent in node: pin (a) double-hydrate idempotence on the in-memory path, (b) write-through calls the store behind a `typeof indexedDB` guard (injectable store for the test)

**Interfaces:**
- Consumes: `Vault`/`newVault` (`firmware-fetch.ts`), `fetchVersion(catalog, label, vault, opts)`.
- Produces: `hydrateVault(vault): Promise<void>` (no-op when `indexedDB` undefined; loads sha→bytes pairs, skips corrupt rows) and write-through inside `fetchVersion` (fire-and-forget, digest-gated bytes only — a failed write never blocks the run).

- [ ] **Step 1: Write failing asserts** — hydrate empty store → vault unchanged; store pre-seeded via the injectable → vault has the digests; corrupt row skipped.
- [ ] **Step 2: Run to verify they fail** (no module yet).
- [ ] **Step 3: Implement** — new module (client-only, raw `indexedDB`, no dependency), wire write-through + one hydrate call at FirmwareTab mount. Reads stay synchronous.
- [ ] **Step 4: Run gates** — build 0, lint 0, smoke 0 FAIL.
- [ ] **Step 5: Commit** — `git commit -m "feat(client): persist the firmware vault in IndexedDB — reloads no longer lose downloads"`.

### Task 7: Second-chance grant on wrong pick (O6)

**Files:**
- Modify: `client/src/hooks/useFirmwareFlash.ts:1190-1195` (wrong-pick guard area)
- Test: `client/scripts/smoke.tsx` §72

**Interfaces:**
- Consumes: Task 1's filters + grant race, `T.enterMs` remaining budget, `portMatches`.
- Produces: on wrong-pick refusal with time left in `enterMs`: ONE `log.action` (`'that port did not answer — grant the other <Side> Keyboard entry'`, exact copy) + one more grant race, then re-validate; second failure aborts with the existing copy.

- [ ] **Step 1: Write failing asserts** — fixture: first grant resolves a wrong-side mcuboot port, second resolves the right one → run proceeds past enter (currently aborts on first); plus: second wrong pick → abort with the original copy; plus: no time left → no second action event.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — single second round only, bounded by remaining `enterMs`. No changes to the cancel path.
- [ ] **Step 4: Run gates** — build 0, lint 0, smoke 0 FAIL.
- [ ] **Step 5: Commit** — `git commit -m "feat(client): second-chance bootloader grant when the picked port is wrong"`.

### Task 8: Docs + close-out

**Files:**
- Modify: `HANDOFF.md` (firmware notes: night-session addendum — latch window, grant choreography, defect list with task numbers, live-run log ids), `README.md` only if a user-visible behavior changed its wording
- Delete: `client/public/park-probe.html` (throwaway probe page, never part of the product)

**Interfaces:**
- Consumes: commit SHAs of Tasks 1–7, run log ids from the night (keyboard-20261013-035301 success, module-20261013-020507 already-runs).

- [ ] **Step 1: Draft the HANDOFF addendum** (facts only, every claim anchored to code or a run log id).
- [ ] **Step 2: Self-check** every anchor resolves (grep each file:line cited).
- [ ] **Step 3: Delete the probe page + full gates** (build 0, lint 0, smoke 0 FAIL — docs-only otherwise).
- [ ] **Step 4: Commit** — `git commit -m "docs: firmware night-session addendum + remove throwaway probe page"`.

### Task 9 (parity P1): LED "No colour" — unset marker reaches the keyboard

OF anchor: openflow 571e126 (SCRUM-118). OF writes "No colour" as the NayaFlow unset marker record: hue 0, UNSET_SATURATION 150 (wire bytes; LED op 30/100e params [00, layer, KK, H_lo, H_hi, S], S is one byte 0..255 — 150 = 0x96 fits). Previously absent colour = no op = LED kept old colour.

**Files:**
- Modify: `client/src/components/tabs/LedTab.tsx` (add a "No colour" affordance beside the existing tools)
- Test: `client/scripts/smoke.tsx` (new §77)

**Interfaces:**
- Consumes: existing `queueColor(draft, sel, {h, s})` (sdk draft op) — verify s passes to the wire byte VERBATIM (named risk: UI S-slider may be a 0..100 scale; the affordance must queue the literal `{h: 0, s: 150}`, NOT slider-scale values).
- Produces: a user-visible "No colour" action that queues exactly `{h: 0, s: 150}` for the current selection; readback/display treats a stored `(h=0, s=150)` record as unset (no colour swatch, not a red-ish hue-0 colour).

- [ ] **Step 1: Failing asserts (§77)** — (a) queueing "no colour" for a key yields a draft LED op whose wire params contain H_lo=0 H_hi=0 S=0x96; (b) the readback/parse path maps a stored [KK, 00, 00, 96] record to the unset display state, distinct from [KK,00,00,00].
- [ ] **Step 2: Red run** (rolldown exit verified, FAILs observed).
- [ ] **Step 3: Implement** — one affordance in the LED editor (button, calm English copy e.g. "No colour — LED off"), queueing the literal unset marker; display-side mapping for the marker.
- [ ] **Step 4: Gates** — build 0, lint 0 (27 baseline), smoke 0 FAIL.
- [ ] **Step 5: Commit** — `feat(client): LED 'No colour' queues the NayaFlow unset marker — an absent colour reaches the keyboard`.

### Task 10 (parity P2): terminal unbind queues NONE instead of refusing

OF anchor: 571e126 (SCRUM-117). Our exact bug class: KeyActionMenu offers clear(tap) on the last slot → `onClearSlot` → `queueBehaviorSet` with a fully-empty set → `behaviorSetOps` returns null (`set.tap == null` guard) → drop row "behavior chain: Tap is required first" → NOTHING queued → key KEEPS its stale binding. The UI offers unbind; the draft silently refuses.

**Files:**
- Modify: `client/src/lib/queue.ts:154-204` (`queueBehaviorSet` — the fully-empty-set terminal case only; the existing drop message stays for sets that are merely incomplete)
- Test: `client/scripts/smoke.tsx` (§78)

**Interfaces:**
- Consumes: `prevRecs` (live dump records at kk) already passed to `queueBehaviorSet`; the keyset op shape used by layer blanking (`[pos][07][00]` fillerRecord + shadow-bank filler — see `queueLayerDelete` queue.ts:283-330 for the exact records).
- Produces: fully-empty set + prevRecs has ≥1 live (non-NONE) record at kk → queue keyset op(s) writing the NONE record for kk AND clearing any second-bank (double-tap/tap-hold) records the key owns (OF `_own_second_bank` semantics). Fully-empty set + no live record → keep today's honest no-op behavior.

- [ ] **Step 1: Failing asserts (§78)** — (a) empty set + live prevRec → draft gains the NONE keyset record(s) for kk (incl. second-bank clear when prevRecs show double-tap/tap-hold); (b) empty set + no live prevRec → no op queued, no drop row claiming a write; (c) incomplete set (some slots null, tap present) → existing behavior unchanged.
- [ ] **Step 2: Red run.**
- [ ] **Step 3: Implement** — terminal branch in `queueBehaviorSet`; reuse the existing filler-record builders, do not invent new op shapes.
- [ ] **Step 4: Gates.**
- [ ] **Step 5: Commit** — `fix(client): clearing the last behavior queues a NONE record — unbind reaches the keyboard`.

### Task 11 (parity P3): layer-delete bulk-clear confirmation

OF anchor: 571e126 bulk guard (BULK_CLEAR_MIN_KEYS=5, >half the layer's own-bound keys, explicit allowBulk tick, server refuses without flag). Our risk surface: `queueLayerDelete` (queue.ts:283-330) blanks a whole layer (156 slots + LED ops) and FlashDialog shows drop rows only — no bulk warning.

**Files:**
- Modify: the flash confirm dialog (FlashDialog.tsx) + its inputs; possibly `client/src/hooks/useFlash.ts` to expose the count.
- Test: `client/scripts/smoke.tsx` (§79)

**Interfaces:**
- Consumes: the live dump (keysByLayer / layer records) to count a layer's bound keys (non-NONE, non-filler records).
- Produces: when the draft contains a layer-delete op for layer L whose dump shows ≥5 bound keys → dialog renders a warn block ("this deletes every binding on layer L — N keys") + an explicit tick; Flash button stays disabled until ticked. Below the threshold → no new UI. The tick does NOT need to ride the wire (client-side gate only; OF's server flag has no analog here — the draft IS the plan).

- [ ] **Step 1: Failing asserts (§79)** — derive-bound-count logic + dialog gate (threshold 5 pinned; 4 → no gate, 5 → gate; layer with <5 bound keys deleted → no gate).
- [ ] **Step 2: Red run.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Gates.**
- [ ] **Step 5: Commit** — `feat(client): layer-delete bulk-clear confirmation when a layer loses many bound keys`.

### Task 12 (parity P4): OF 0.7.1 notes — naming divergence + SPI-flash-test facts

**Files:**
- Modify: `HANDOFF.md` (notes section), `sdk/src/troubleshooting/wire-guard.ts` (comment-only)

**Content (facts, no uninvented claims):**
- Naming divergence: OF 0.7.1 added Settings > Shortcut Names (OS-based override of BOUND-chord display names, 6 mac presets). We are deliberately N/A: our phase-8 platform toggle (`reflow.appsc.mac`) bakes the platform into the queued def at pick time — no global override layer needed.
- SPI-flash-test (OF naya-probe --spi-flash-test): op 0xfa/0x1001, per-partition verdict (status + five return codes; 32B payload = 5 partitions, 20B = 3). NOT read-only: writes+reads back a test file per partition (like NayaCore's repair-flash diagnose); never formats/erases. Our wire-guard already blocks fa/* in the trouble lane — add the op-facts sentence to the guard's comment.
- /rpc/flash own-refusals 400-not-500 in OF: N/A for us (our refusals are client-side drops with reasons since T4).

- [ ] **Step 1: Write notes** (grep-anchored facts only).
- [ ] **Step 2: Gates** (docs+comment only — build/lint/smoke unchanged, run once to confirm).
- [ ] **Step 3: Commit** — `docs: OF 0.7.1 parity notes — naming divergence, SPI-flash-test op facts`.
