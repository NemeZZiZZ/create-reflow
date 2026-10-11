# Keyscan Live Test + fe/1005 Host OS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live key-test mode — toggle fe/1008, stream fe/1009 events into the app (raw row/col display; no matrix mapping exists anywhere), plus fe/1005 host-OS setting — dry-run asserted, confirm-gated where stateful, Phase-10 live-probe items flagged.

**Architecture:** Pure SDK parse + verbs first; a `keyscanListen` session method that holds the cmd mutex for the whole duration (stream frames bypass `roundtrip`); a client hook owning pressed-state + safety exits; an overlay riding the existing prop-driven Keyboard; a BehaviorTab dropdown riding the existing settings-op path. Smoke drives everything through the §56-style scripted session.

**Tech Stack:** TS strict; pnpm workspace; oxlint; rolldown node smoke (§ blocks; last used §64; baseline 1107 ok / 0 FAIL).

**Spec:** `docs/superpowers/specs/2026-10-10-openflow-port-program.md` — Phase 7 section (authoritative). Wire facts: OF `service.py:1493-1516`, `recovery_ops.py:64-74`; KB `cdc-protocol.md:40,784-785`.

## Global Constraints

- fe/1008: payload exactly `[0x01]` on / `[0x00]` off, one byte; OFF guaranteed in `finally` even on abort; ON reply NOT inspected by OF — our listener uses a lenient matcher (`match: () => true`), warn-then-listen on unmatched.
- fe/1009 event: payload ≥3 bytes; `pressed = p[2] === 0` (STATE 0 = PRESS — inverted); parse first 3 bytes only (OF parity; log extra bytes).
- fe/1005: payload exactly 1 byte; `0 = Windows, 1 = macOS`; send path never reads reply (OF) — mark "ACK shape unproven" (moduleCfg precedent); NEVER confuse with t19 module values 200/201.
- The listener MUST hold the session tail-mutex + client `busyRef` for its whole duration (any interleaved `cmd()` flushes the RX buffer and destroys events). Test mode blocks all other device traffic — the UI says so.
- Row/col → KK mapping does not exist (ours, OF, KB — verified). Overlay ships RAW row/col side-panel display; NEVER guess a matrix. Phase-10 probe item.
- Wire-guard: fe/1008/1009/1005 all pass the current blocklist — no guard change; ADD verdict comments (file header + troubleshooting/index.ts danger-list note).
- ioLog gap: stream frames bypass the roundtrip tap — push RX records manually from the listener (preferred) so the I/O log stays complete.
- English copy; hedge copy for unknowns ("keys may also reach your computer", "ACK shape unproven").
- Gates: sdk `tsc --noEmit` + `oxlint src`; client `tsc -b && vite build` + oxlint touched; smoke 0 FAIL from `client/` with `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"`; §-append before `void main();` anchor; count grows exactly.
- VCS: plain git, explicit paths, local main, never push.

## Review Focus

1. OFF always sent — even on parse error, abort, or listener exception (finally path pinned by smoke). → Task 2/6.
2. Mutex/busyRef held for the WHOLE session — no window where pollers or user ops can flush the buffer mid-stream. → Task 2/3.
3. `state===0 → pressed` inversion pinned byte-exact (counterintuitive). → Task 1/6.
4. fe/1005 byte 0/1 only; cannot reach 200/201 module values; ACK-unproven surfaced. → Task 1/5.
5. Overlay never fabricates key positions — raw row/col display when no mapping; pressed-set keys highlighted only when a mapping exists. → Task 4.

---

### Task 1: SDK parse + verbs

**Files:** Modify `sdk/src/naya.ts` (or new `sdk/src/keyscan.ts` if cleaner + barrel), `sdk/src/troubleshooting/wire-guard.ts` (verdict comments only), `sdk/src/troubleshooting/index.ts` (danger-list note).
**Test:** smoke §65 part 1.

- Produces: `parseKeyScanEvent(p: Uint8Array): { row: number; col: number; pressed: boolean } | null` (null when <3 bytes; `pressed = p[2] === 0`); `HOST_OS_VALUES = { windows: 0, mac: 1 }`; `hostOsOp(os: 'windows' | 'mac')` → SettingsOp `{ path: 'fe/1005', payload: [v] }` (rides existing queueSetting/flash settings branch; length guard 1).
- Smoke asserts: parse fixtures incl. `[3, 5, 0] → pressed true` and `[3, 5, 1] → pressed false`; null on 0/1/2 bytes; hostOsOp bytes `[0]` / `[1]`; wire-guard passes fe/1008/1009/1005 (3 asserts).
- Commit: `feat(sdk): keyscan event parse + host-OS op — fe/1008/1009/1005 verbs`.

### Task 2: SDK stream listener

**Files:** `sdk/src/naya.ts` (`keyscanListen` on NayaSession).
**Test:** smoke §65 part 2 (scripted §56-style session; push unsolicited frames into the queue).

- Produces: `keyscanListen(onEvent: (e: {row,col,pressed}) => void, opts?: { durationMs?: number }): Promise<void>` — acquires tail mutex whole duration; sends ON `[01]` with lenient matcher; loops `fr.readFrame(deadline)`; dispatches fe/10/09 frames (payload≥3 → parseKeyScanEvent → onEvent; log-and-ignore extra bytes); ignores foreign frames; pushes RX records into ioLog manually; `finally` sends OFF `[00]` + releases mutex; aborts at deadline or on a thrown reader error (rethrow after OFF).
- Smoke asserts: ON bytes `[01]` then OFF `[00]` recorded at the writer; two pushed events reach onEvent with correct inversion; a stray fe/1002 frame ignored; mid-stream listener abort still emits OFF.
- Commit: `feat(sdk): keyscanListen — mutex-held event stream with guaranteed OFF`.

### Task 3: Hook `useKeyscan`

**Files:** NEW `client/src/hooks/useKeyscan.ts`.
**Test:** client gates (build/lint; code-review).

- Produces: hook owning `pressed: Set<string>` (key `row:col`; KK-keyed highlight later if mapping arrives), `running`, `events: {row,col,pressed,t}[]` tail (~64); `start()` refuses when `busyRef.current` or `draftSize > 0` (toast why); sets busyRef for the session; auto-exit on error/disconnect/unmount (finally OFF via listener); Escape keydown exits (BindingsTab ctx-popover pattern: one window listener + cleanup); raw-event log line per event.

### Task 4: UI overlay + toggle

**Files:** `client/src/components/Keyboard.tsx` (pressed prop + Key/StripDot styling), `client/src/components/KeyboardCard.tsx` (Test-keys toggle next to LED mode), `client/src/components/tabs/BindingsTab.tsx` (wire hook + raw row/col side panel).

- Produces: `pressed?: ReadonlySet<number>` prop (KK-keyed; empty until a mapping exists → overlay shows nothing on caps, raw panel carries the truth); Test-keys toggle disabled+tooltip'd when draft non-empty or busy; raw row/col live panel (last N events, PRESS/RELEASE colored); hedge copy "Test mode locks other device traffic; keys may still reach your computer."
- Gates: client build + oxlint touched + smoke unchanged count.

### Task 5: fe/1005 dropdown

**Files:** `client/src/components/tabs/BehaviorTab.tsx` (next to fe/100a timeouts block).

- Produces: Host OS select (Auto? no — explicit `Windows`/`macOS`/`Unset` display of queued state) → `hostOsOp` into draft (settings section row, flash ACK gate rides existing branch payload[0]===0x00); "ACK shape unproven" note text.
- Gates: client build + oxlint + smoke unchanged.

### Task 6: Smoke §65 assembly + docs

**Files:** `client/scripts/smoke.tsx` (§65 block if not landed with T1/T2 — land fixtures WITH their features, keep count exact), `HANDOFF.md` (ROADMAP phase-7 ✅ + keyscan notes: verbs, inversion, mutex rule, mapping-missing + Phase-10 probe items: ON-ACK shape, row/col→KK, host-input blocking, fe/1005 ACK), `README.md` (one line).

- Commit: `docs: keyscan test mode + host OS — HANDOFF/README`.
- Gates: full; smoke baseline grows exactly by §65 asserts.
