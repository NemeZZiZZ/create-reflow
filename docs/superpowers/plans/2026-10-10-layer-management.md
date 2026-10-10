# Layer Management (30/1002) + Lighting Restore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dynamic layer list end-to-end — read the device's layer inventory (UUID identity), add/delete layers via 30/1002 draft ops, and end every flash with the layer-list echo that restores stored lighting on both halves.

**Architecture:** New pure SDK module `sdk/src/layers.ts` (inventory parse + entry encoders + the STORED-anim map). New draft op kind `layers`. Queue helpers compose add/delete from list ops + existing key/led ops (blank + wipe). The flash executor gains a tail step: re-read inventory, echo it byte-transparently (= lighting restore, measured OF fact). Client becomes inventory-driven: dynamic layer arrays (ceiling 8), dynamic tabs/save menu, add/delete UI. OpenFlow JSON code widens from the fixed 3-layer window to 0..7.

**Tech Stack:** TS strict, pnpm workspace, oxlint, rolldown node smoke (§ blocks, last used §50; §47-§50 belong to Phase 1).

**Spec:** `docs/superpowers/specs/2026-10-10-openflow-port-program.md` — Phase 2 section (authoritative). Wire facts below are verified against OpenFlow v0.7.0 sources + our cdc-protocol.md.

## Global Constraints

- Wire safety: only whitelisted verbs; 30/1002 is a normal write (passes `assertWireAllowed` — assert in smoke). No new dangerous verbs. Delete/add UI actions confirm-gated.
- SDK additions pure (no React/device) — smoke-testable under node.
- Gates: sdk `tsc --noEmit` + `oxlint src`; client `tsc -b && vite build` + oxlint on touched files; smoke 0 FAIL (count grows; CWD must be `client/`; `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"` in every shell).
- UI copy English. VCS: plain git, explicit paths, local main, never push.
- **TWO animation mappings — never mix them:**
  - RUNTIME (ed/1011, our live-proven): `[Solid, Breathe, Swirl, Spectrum]` (existing `ANIM_NAMES`, unchanged);
  - STORED (layer-list entry byte, ZMK order, confirmed by real capture layer2 swirl=03): `['Solid','Breathe','Spectrum','Swirl']`.
  - UI anim names stay ANIM_NAMES; conversion at the layer-list boundary via `storedAnimOf(name)` / `runtimeAnimOf(storedByte)`.
- Layer UUID bytes = plain hex slice of the dashed uuid string (OF R:347-356: deliberately NOT uuid.bytes LE) — 16 raw bytes.
- Write payload header byte is literal `00`; read payload byte 0 is a COUNT and is discarded on parse.
- Client layer ceiling: 8 (indices 0..7). Device may report more — display but refuse edits beyond 7 with a specific message.

## Review Focus

1. **Restore echo must use a FRESH post-write inventory read**, never a cached table — flashing an ADD then echoing the stale pre-read table would drop the new layer's entry. → Task 5 step 1.
2. **Delete the last remaining layer** → refuse (≥1 must remain; OF guard U:304-308). → Task 4 step 1.
3. **Add past the ceiling (idx > 7)** → refuse with message; also import guard: OF doc `orderId > 7` → error. → Tasks 3, 4 step 1.
4. **Empty/unreadable inventory** (no entries parsed) → layer ops refuse; flash tail step skips restore with a log line, never writes a garbage frame. → Task 5 step 1.
5. **Header-byte asymmetry** (write `00` literal vs read count byte) — pinned byte-exact by Task 1 fixtures from OF captures. → Task 1 step 1.

---

### Task 1: `sdk/src/layers.ts` — inventory model + encoders

**Files:**
- Create: `sdk/src/layers.ts`
- Modify: `sdk/src/index.ts` (barrel)
- Test: `client/scripts/smoke.tsx` — new `// §51 layer list: inventory + encoders`

**Interfaces:**
- Produces:
  - `interface LayerEntry { idx: number; uuid: string; animStored: number }` (uuid = 32 hex chars, no dashes)
  - `STORED_ANIM_NAMES: readonly [string, string, string, string]` = `['Solid','Breathe','Spectrum','Swirl']`
  - `storedAnimOf(name: string): number` (case-insensitive; -1 if unknown), `storedAnimName(byte: number): string | null`
  - `parseInventory(payload: Uint8Array): LayerEntry[]` — discards payload[0] (count), reads 20-byte entries `[idx][id][anim][0x10][uuid16]`; tolerant of trailing garbage; entries with uuid-length byte ≠ 0x10 skipped
  - `encodeLayerListAdd(entries: LayerEntry[]): Uint8Array` — `00` + per entry `[idx][idx][anim][10][uuid16bytes]`, ONLY entries passed (caller diffs)
  - `encodeLayerListDelete(idxs: number[]): Uint8Array` — `00` + `[idx] 00 00 00` per index, **whole set sent TWICE** (OF capture)
  - `encodeRestorePayload(entries: LayerEntry[]): Uint8Array` = `encodeLayerListAdd` over the full sorted table
  - `uuidToBytes(uuid: string): Uint8Array` / `bytesToUuid(b: Uint8Array): string` (plain hex slice, no dashes out)
  - `mintLayerUuid(): string` — 32 hex chars (crypto.randomUUID dashed-stripped)

- [ ] **Step 1: Write failing §51** — fixtures FROM OF CAPTURES (byte-exact):
  - parse real board table `00 | 00 00 00 10 0cb76a711d4243c88b4eab1c521695c9 | 01 01 01 10 c32c7d56a47244bbac09f8b526efa8c1 | 02 02 03 10 5cea2e1036bc4dd590dcbfd61e13a1f9` → 3 entries, layer2 `animStored === 3` and `storedAnimName(3) === 'Swirl'`; count byte discarded (leading `03` variant parses the same);
  - `encodeLayerListAdd` two entries (OF test capture): `00 03030010 878610a4c7434723a59932655479dee2 04040010 05a59817d3a442df9b959d5f85067603`;
  - `encodeLayerListDelete([3,4])` → `00 03000000 04000000 03000000 04000000`;
  - `storedAnimOf('swirl') === 3`, `storedAnimOf('Swirl') === 3`, `storedAnimOf('nope') === -1`;
  - `bytesToUuid(uuidToBytes('878610a4c7434723a59932655479dee2'))` round-trips;
  - `parseInventory` on empty/short payload → `[]`; `assertWireAllowed(0x30,0x10,0x02)` does NOT throw.
- [ ] **Step 2: Run — expect FAIL (module missing).**
- [ ] **Step 3: Implement** per interfaces; linear parse, no allocation tricks.
- [ ] **Step 4: Run — 0 FAIL, count grows by the new asserts.**
- [ ] **Step 5: Barrel + sdk gates; commit `feat(sdk): layer-list model — inventory parse, add/delete/restore encoders, stored-anim map`.**

### Task 2: draft op kind `layers`

**Files:**
- Modify: `sdk/src/draft.ts` (Op union + opKey + opSection + stats + opSummary), `sdk/src/index.ts` if types re-exported
- Test: smoke §51 extension (same block)

**Interfaces:**
- Produces: `interface LayerListOp { kind: 'layers'; payload: Uint8Array; label: string }`; `opKey` → `layers:${payloadHex}` (identical payload dedups; different payloads coexist — add + delete in one flash); `opSection` → new `'layers'` section added to `Section` union + `SECTIONS` + `SECTION_LABELS.layers = 'Layers'`; `stats()` frames += 1, bytes += 10 + payload.length; `opSummary` → `${label} (${entries} entries)` where entries = (payload.length-1)/20 for add-form or delete count by 4-byte groups — simplest: carry the count in the label at queue time; opSummary just prints label.

- [ ] **Step 1: Failing asserts** — `draft.add` two layer ops with different payloads → both present; same payload twice → one; `stats().frames` counts them; `opSection` returns `'layers'`; reconcile keeps layer ops (no readback path — they self-remove on ACK at flash time like settings).
- [ ] **Step 2: FAIL → implement → PASS.**
- [ ] **Step 3: sdk gates.** (No commit yet — folds into Task 4's phase commit.)

### Task 3: openflow.ts — widen to layers 0..7

**Files:**
- Modify: `sdk/src/openflow.ts` (orderId guard, OF_LAYER_UUIDS, layerRefs validation, buildOpenFlowLayer guard), `sdk/src/index.ts` type export if changed
- Test: smoke — new `// §52 OpenFlow layer window 0..7`

**Interfaces:**
- Consumes: existing parse/build.
- Produces: `OF_LAYER_UUIDS` becomes a function-generated `string[]` of 8 (`'6e726600-0000-4000-8000-00000000000' + L` for L 0..7 — same pattern, now 8 entries; keep export name); `parseOpenFlowLayer` accepts `orderId` 0..7 (error beyond, message `layer index ${n} is outside this app's window (0-7)`); `layerRefs` values valid 1..7; `buildOpenFlowLayer` throws/refuses `layer > 7` explicitly (closes Phase-1 deferred minor).

- [ ] **Step 1: Failing §52** — parse doc orderId 5 ok; orderId 8 → error /window/; build layer 5 → srcId = `...005` pattern entry; layerRefs `{uuid: 5}` resolves MO to special ORDER 5; build layer 8 → throws /window/; roundtrip at layer 4 byte-equal.
- [ ] **Step 2: FAIL → implement → PASS**; sdk gates.

### Task 4: queue helpers — add / delete composition

**Files:**
- Modify: `sdk/src/queue.ts`
- Test: smoke — new `// §53 layer add/delete queue helpers`

**Interfaces:**
- Consumes: Task 1 encoders, Task 2 op kind, existing key/led op kinds, `fillerRecord`, `plainRecord`.
- Produces:
  - `queueLayerAdd(draft: Draft, idx: number, uuid: string, animName?: string): { queued: boolean; error?: string }` — idx must be 0..7 and NOT already present in the caller's known list (caller passes? no — pure: just idx ≤ 7 guard); queues ONE `layers` op labeled `add layer ${idx} (${storedAnimName})`; anim default 'Solid' (byte 0). Multiple adds in one draft coexist as separate ops (different payloads).
  - `queueLayerDelete(draft: Draft, idx: number, keys: KeyRec[], leds: LedRec[], totalKeys: number): { queued: boolean; error?: string; frames: number }` — queues the delete `layers` op FIRST, then blanks the layer's data so a future re-add can't inherit ghosts (OF F:888-896 semantics): key blank = for the 74 key positions + tail slots up to `totalKeys` records → ONE `keyset` op with `[pos][07][00]` records (filler form, absent-satisfied in reconcile); LED wipe = `led` ops h0 s0 per known LED kk. Caller guard: refuse when caller's layer count ≤ 1 (error `cannot delete the only layer`).

- [ ] **Step 1: Failing §53** — add: draft holds 1 layers op, payload = encodeLayerListAdd single, label matches; add idx 8 → error; delete on 3-layer list: first op is the delete form (×2 pattern present), keyset op contains `[00,07,00]`-style fillers, led ops count = leds.length, keyset record count > 150 (records = payload.length/3 — NOT draft.stats frames, which count ops); delete guard fires at count 1; add+delete same draft coexist.
- [ ] **Step 2: FAIL → implement → PASS.**
- [ ] **Step 3: Full sdk gates + commit phase A:** `git add sdk/src/layers.ts sdk/src/draft.ts sdk/src/openflow.ts sdk/src/queue.ts sdk/src/index.ts client/scripts/smoke.tsx` → `feat(sdk): layer management — inventory ops, draft kind, queue add/delete, 8-layer window`.

### Task 5: naya write + flash tail restore

**Files:**
- Modify: `sdk/src/naya.ts` (one wrapper), `client/src/hooks/useFlash.ts` (tail step), `client/src/hooks/useLayers.ts` (inventory-driven dump), smoke §51 extension
- Test: smoke §51 extension (pure parts)

**Interfaces:**
- Consumes: `parseInventory`, `encodeRestorePayload`.
- Produces:
  - naya.ts: `async writeLayerList(payload: Uint8Array): Promise<Frame>` = `this.cmd(0x30, 0x10, 0x02, payload)` (ack gating stays caller-side: accept payload[0] === 0x00 or echoed index; 0xEA → throw).
  - useLayers: `layerList: LayerEntry[]` state; `dumpAll` parses the handshake Frame payload via `parseInventory` FIRST, then loops the inventory indices (not [0,1,2]); exposes `readInventory(ses)` (handshake + parse, returns entries) for the flash tail and UI.
  - useFlash tail (after queue loop, before settle/dump): `const inv = await readInventory(ses)`; if `inv.length === 0` → log warn, skip; else `await ses.writeLayerList(encodeRestorePayload(inv))`, ack-gated, log `layer-list echo: N entries — stored lighting restored (both halves)`; then existing settle + dumpAll.

- [ ] **Step 1: Failing smoke asserts** — §51: ack-gate predicate (export tiny pure helper? simplest: assert `encodeRestorePayload(parseInventory(realTable))` equals `encodeLayerListAdd(parseInventory(realTable))` — byte-transparent echo identity); restore payload for table with 4 entries is single frame ≤ 242+1+20 bytes ok (length assert < 250).
- [ ] **Step 2: FAIL → implement → PASS** (client hooks compile-checked by client gate).
- [ ] **Step 3: Client build gate** (`pnpm build` in client/) — typecheck only here; UI wiring is Task 6. No commit yet.

### Task 6: Client UI — dynamic layers, add/delete

**Files:**
- Modify: `client/src/components/ViewLayerTabs.tsx` (dynamic tabs + manage popover), `client/src/App.tsx` (state wiring: layerList, addLayer/deleteLayer handlers with confirm; selection clamp), `client/src/components/SaveMenu.tsx` (per-layer items dynamic), `client/src/components/FlashDialog.tsx` (only if it hardcodes 3)
- Test: client gate (build+lint+smoke) + code-reading review

**Interfaces:**
- Consumes: `layerList`, `queueLayerAdd/queueLayerDelete`, `dumpAll` post-action refresh.
- Produces: `Add layer` (mints uuid, queues add at `maxIdx+1` ≤ 7, toast, auto-refresh after flash — layer appears after flash because inventory re-reads); `Delete layer L` (confirm dialog names the layer + frame estimate; queues delete; refresh). Layer labels `Layer {idx+1}` (names-by-default only — custom names deferred, ledger YAGNI). URL `layer` param clamped to valid indices.

- [ ] **Step 1: Wire UI per interfaces** (English copy; confirm-gated delete; busy-guard respected).
- [ ] **Step 2: Full gate** — client build, smoke 0 FAIL, oxlint touched files.
- [ ] **Step 3: Commit phase B:** `feat(client): dynamic layers — inventory-driven tabs, add/delete with confirm, save menu per layer`.

### Task 7: Docs + recipes

**Files:**
- Modify: `HANDOFF.md` (Native format section: dynamic layers + STORED vs RUNTIME anim note; ROADMAP phase-2 checkoff), `README.md` (one line), `sdk/src/troubleshooting/lights-wrong-after-flash.ts` + `layers-dead.ts` (note: normal flashes now restore automatically; button remains the manual cure)

- [ ] **Step 1: Edits** — recipes gain one detail line each; HANDOFF roadmap item gets ✅ with commits.
- [ ] **Step 2: Full gate; commit phase C:** `docs: layer management + automatic lighting restore — HANDOFF/README/recipes`.
