# Phase 9: Firmware Flashing over SMP (MCUboot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port OpenFlow's firmware-update subsystem to the browser: an SMP/MCUboot client in the SDK, catalog+fetch+plan+interlock libs, keyboard and module flash procedures with JSONL run logs, FirmwareTab UI — smoke-fixture-verified, live run deferred to phase 10.

**Architecture:** SDK gains `sdk/src/smp.ts` (line-based SMP over an injected serial port — NOT Naya frames) plus a guarded `enterMcuboot()` on NayaSession. Client gains pure libs (catalog, fetch, plan, interlocks, run log) and a `useFirmwareFlash` procedure hook owning the whole run: port lifecycle via an injectable `SerialWorld` (node-testable), procedure-owned app sessions on re-enumerated ports, `useSessions.rescan()` at run end. UI = new top-level `firmware` tab.

**Tech Stack:** TypeScript, WebSerial types injected (DOM-free SDK), WebCrypto (sha256), Vite+React client, rolldown single-file smoke.

**Spec:** `docs/superpowers/specs/2026-10-12-smp-firmware-flashing-design.md` — binding; OF anchors inside it are provenance, not suggestions. Process precedent: glm-5.3-flash implementers, glm-5.3 final whole-branch review.

## Global Constraints

- ENV in every shell: `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"`.
- Gates from `client/`: `pnpm build` exit 0; `pnpm lint` exit 0 (pre-existing warnings tolerated); smoke `./node_modules/.bin/rolldown --config scripts/rolldown.smoke.mjs && node /tmp/smoke.cjs` — verify rolldown exit code (stale /tmp/smoke.cjs passes misleadingly) — 0 FAIL, count grows per § section (baseline entering this phase: 1159 ok).
- SDK stays DOM-free pure TS runnable under node (no `navigator`/`window` references at module scope; injected types only — pattern: sdk/src/index.ts:1-2).
- English UI copy, calm and hedged where uncertain.
- VCS: plain git, explicit paths, local `main`, NEVER push.
- Wire-guard block list unchanged (`sdk/src/troubleshooting/wire-guard.ts:20-38`): `fa/*`, `ee/10be`, `ee/10ae`, `0x30/0x10ca`, `0xbe/0x1004` stay blocked in the trouble lane. MCUboot entry for the firmware procedure is `ee/10ae` (RESET_MCU_BOOT=0x10AE, nayactl constants.py:247-248; OF flash_procedure.py:597); `ee/10be` is RESET_DFU and is NEVER sent by this codebase.
- Smoke fixture convention: append `// §N name` blocks in `client/scripts/smoke.tsx`; next free section is §67; helpers block-scoped; byte-exact asserts for wire features.
- `client/scripts/rolldown.smoke.mjs` has `output.codeSplitting:false` — dynamic imports (catalog JSON) inline into the single smoke bundle (app-shortcuts §66 precedent).

## Review Focus

The five spec-implied failure modes most likely to bite, each pinned by a test in its owning task:

1. **Wrong reset op** — sending the DFU reset (`ee/10be`) instead of MCUboot entry parks the half in a mode SMP rescue doesn't cover. Test (T2 §68): `enterMcuboot()` writes exactly one frame with `t=0xEE, c0=0x10, c1=0xAE`; assert no write anywhere in the SDK ever carries `0x10BE`.
2. **Offset desync** — trusting the local counter after a dropped reply corrupts the slot. Test (T6 §72): scripted device returns `off` ≠ local count; the NEXT chunk must carry the device's `off`.
3. **Stale/foreign arm token** — an upload without a same-run device hash can brick slot 1. Tests (T4 §70 gate matrix; T6 §72 integration): arm ≠ slot-0 hash → refusal AND zero upload bytes written.
4. **Page closed / sessions torn down mid-run** — leaves a half parked. Tests (T5 §71): run-active flag toggles with the window-guard registration; (T7 §73): `rescan()` skips MCUboot PIDs and auto-connect stays frozen while `firmwareRunActive()`.
5. **sha256 gate bypass** — keeping unverified bytes can flash a corrupt image. Tests (T3 §69): mismatch digest → throw, vault keeps nothing; catalog lookup with two same-`file` entries resolves by `blobSha256`, never by name.

---

### Task 1: SMP codecs + line link (`sdk/src/smp.ts`, part 1)

**Files:**
- Create: `sdk/src/smp.ts`
- Modify: `sdk/src/index.ts` (export line)
- Test: `client/scripts/smoke.tsx` (§67)

**Interfaces:**
- Consumes: nothing new (standalone).
- Produces (verbatim signatures; later tasks build on these):
```ts
export const SMP = {
  OP_READ: 0, OP_READ_RSP: 1, OP_WRITE: 2,
  GROUP_OS: 0, GROUP_IMAGE: 1,
  ID_ECHO: 0, ID_IMAGE_STATE: 0, ID_IMAGE_UPLOAD: 1, ID_OS_RESET: 5, ID_SLOT_INFO: 6,
} as const;

export function crc16Xmodem(data: Uint8Array): number; // init 0, poly 0x1021, MSB-first

export type CborValue =
  | number | bigint | Uint8Array | string | boolean | null
  | CborValue[] | { [key: string]: CborValue };

export function cborEncode(value: CborValue): Uint8Array; // map keys sorted by UTF-8 bytes (byte-stable)
export function cborDecode(buf: Uint8Array, pos?: number): { value: CborValue; next: number };
// decode supports: uint/negint/bytes/text/bool/null, arrays, maps (incl. indefinite-length with 0xFF break)

export interface SmpFrame { op: number; flags: number; group: number; seq: number; cmdId: number; payload: Uint8Array }

export function encodeSmpLine(op: number, group: number, seq: number, cmdId: number, payload?: Uint8Array): string;
// "\x06\x09" + base64([u16BE len(body+2)][body][u16BE crc16(body)]) + "\n"; payload undefined → single 0xA0 byte
// header: 8 bytes BE [(version<<3)|op, flags=0, lenHi, lenLo, groupHi, groupLo, seq, cmdId], version=1

export function parseSmpChunks(text: string): { frames: SmpFrame[]; rest: string };
// feed accumulated RX text; "\x06\x09…" starts a frame, "\x04\x14…" continues it;
// complete frames decode + CRC/len verify; bad CRC/len/base64 drops that frame, never throws; rest = unconsumed tail

export interface SmpSerialPortLike {
  open?(opts?: unknown): Promise<void> | void;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close?(): Promise<void> | void;
}

export class SmpLink {
  static open(port: SmpSerialPortLike, opts?: { settleMs?: number }): Promise<SmpLink>;
  transceive(op: number, group: number, cmdId: number, payload?: Uint8Array,
             opts?: { timeoutMs?: number }): Promise<SmpFrame>;
  close(): Promise<void>;
}
```
- `SmpLink.open`: open the port like `NayaSession.connect` does (115200 8N1, DTR/RTS; baud CDC-cosmetic), settle 250 ms (spec §1), start a line reader (TextDecoder stream accumulate). `transceive`: seq = internal counter `++ & 0xFF`, write `encodeSmpLine`, resolve on first reply frame matching `(group, cmdId, seq)`; non-matching frames (late replies) are discarded silently; timeout default 5000 ms → throws. `close`: cancel reader, release locks, close port — every step swallowed.

- [ ] **Step 1: Write failing smoke §67** — block-scoped fixtures: (a) CRC16-XMODEM vectors (`crc16xmodem(new Uint8Array([])) === 0`, known byte string vector, e.g. `"123456789"` bytes → `0x31C3`); (b) `cborEncode`/`cborDecode` round-trips: uint/negint boundaries, bytes, text, nested map — assert `cborEncode({image:0,off:512,data:bytes})` bytes match a hand-written prefix (major types + sorted keys: `data` < `image` < `off`); indefinite-length `0x9F…FF` array decodes; (c) `encodeSmpLine` → `parseSmpChunks` round-trip incl. multi-KB payload split across continuation lines (encode response side by chunking base64 across `\x04\x14` lines); bad-CRC line dropped without throw; partial line stays in `rest`; (d) `SmpLink` on a fake line-port (writer collects lines, scripted responder replies after 5 ms): matching reply resolves, late/mismatched-seq frame is skipped and the correct one still resolves, timeout throws, `close()` idempotent.
- [ ] **Step 2: Run smoke, verify §67 fails** (`UNRESOLVED_IMPORT` / fn undefined). Run from `client/`: `./node_modules/.bin/rolldown --config scripts/rolldown.smoke.mjs; echo ROLLDOWN_EXIT=$?` then `node /tmp/smoke.cjs` — expect FAIL lines naming §67, baseline 1159 ok unchanged elsewhere.
- [ ] **Step 3: Implement** `sdk/src/smp.ts` (codecs + `SmpLink`) + export from `sdk/src/index.ts`. No RegExp needed; base64 via a hand-rolled table or `Uint8Array`→btoa-free node-safe encoder (node has no `btoa` in ESM scope — implement `bytesToBase64`/`base64ToBytes` locally, no deps).
- [ ] **Step 4: Run smoke** — §67 all ok, 0 FAIL total, count = baseline + N(new asserts). `pnpm build` + `pnpm lint` exit 0.
- [ ] **Step 5: Commit** — `git add sdk/src/smp.ts sdk/src/index.ts client/scripts/smoke.tsx` → `feat(sdk): SMP codecs + line link — header, CRC16-XMODEM, CBOR, base64 frames`.

### Task 2: SMP ops + upload + numbering + `enterMcuboot()`

**Files:**
- Modify: `sdk/src/smp.ts` (append)
- Modify: `sdk/src/naya.ts` (one method)
- Test: `client/scripts/smoke.tsx` (§68)

**Interfaces:**
- Consumes: T1 exports.
- Produces:
```ts
export const SMP_DEFAULT_TIMEOUTS = { chunkMs: 20_000, eraseMs: 90_000, transceiveMs: 5_000 } as const;

export interface ImageSlot { slot: number; hash: Uint8Array; pending: boolean; permanent: boolean; confirmed: boolean; active: boolean }
// parsed from image-state reply CBOR map { images: [ { slot, hash, flags… } ] }

export class SmpDevice {
  constructor(link: SmpLink, timeouts?: Partial<typeof SMP_DEFAULT_TIMEOUTS>);
  echo(opts?: { timeoutMs?: number }): Promise<void>;
  imageState(): Promise<ImageSlot[]>;
  slotInfoMap(): Promise<Map<string, number> | null>; // "image,slot" -> uploadImageId; null when ENOTSUP (rc 8)
  setPending(hash: Uint8Array, confirm: boolean): Promise<void>; // WRITE img/0 {hash, confirm}; rc!=0 throws
  osReset(): Promise<void>; // WRITE os/5 empty map; missing reply = success (device reboots mid-reply)
  uploadImage(req: { bytes: Uint8Array; sha256: Uint8Array; imageId: number },
              cb?: {
                onProgress?(p: { sent: number; total: number }): void;
                onFirstChunkAck?(): void;
                shouldContinue?(): boolean;
              }): Promise<void>;
}

export function resolveUploadImageId(map: Map<string, number> | null,
                                     kind: 'keyboard' | 'modules',
                                     bundleSize?: number): number;
```
- Upload rules (spec §1): chunk 512 (`min(remaining, 0x200)`); first chunk payload `{image, off:0, len: total, sha, data}`, later `{image, off, data}`; reply's `off` is authoritative — `sent = reply off`; `rc != 0` → throw carrying rc; offset-0 chunk uses `eraseMs` timeout, others `chunkMs`; `shouldContinue() === false` between chunks → throw `'aborted'`; after the last chunk, re-read image state and require slot-1 hash == req.sha256, with swap-already-happened acceptance (slot-0 == sha AND slot-1 == the pre-upload slot-0 hash captured before upload).
- Numbering (spec §1): keyboard — map present must confirm `"0,1" → 2`, else if map null use ASSUMED `2` (spec Decision: keyboard ASSUMED rule equals 2, allowed); map present but NOT confirming → throw. modules — map `"0,2" → 4` wins; map null → 4 only when `bundleSize === 1_048_576`, else throw.
- `naya.ts`: `async enterMcuboot(): Promise<void>` — builds and writes ONE frame `t=0xEE, c0=0x10, c1=0xAE`, params empty, to `this.dst` via the same frame-building path `cmd()` uses; waits ≤1500 ms for any reply; swallows timeout/reply; resolves. Header docblock cites OF flash_procedure.py:597 and the DFU distinction.
- [ ] **Step 1: Write failing smoke §68** — fake scripted SMP device (stateful closure over offset): (a) `echo` round-trip; (b) `imageState` parse of a fixture CBOR reply (2 slots, flags); (c) upload happy path (2 chunks) — assert first-chunk CBOR carries `len`+`sha`, later chunk doesn't, seq increments `& 0xFF`; (d) offset-authoritative: device returns `off` one byte higher than local → next chunk's `off` is the device value; (e) `rc: 3` on first chunk → throws, nothing further written; (f) erase classification: offset-0 reply delayed past `chunkMs` (tiny injected timeouts) but within `eraseMs` → accepted; (g) `resolveUploadImageId` matrix: confirmed 2 / ASSUMED-null-map 2 / disagreeing map throws / modules 4 mapped / modules unmapped wrong size throws / unmapped exact 1 MiB → 4; (h) `setPending` frame bytes (hash 32B + confirm bool); `osReset` on a silent link resolves; (i) **`enterMcuboot()` wire pin**: fake NayaSession port records writes — exactly one frame `0xEE/0x10/0xAE` sent, resolves despite no reply; and a §68-wide scan: no encoded frame in any fixture log carries `c1 === 0xBE` with `c0 === 0x10`.
- [ ] **Step 2: Run smoke, verify §68 fails.**
- [ ] **Step 3: Implement** ops + upload + numbering + `enterMcuboot`.
- [ ] **Step 4: Run smoke** — all ok, 0 FAIL; build/lint exit 0.
- [ ] **Step 5: Commit** — `feat(sdk): SMP device ops — upload loop, numbering, set-pending, os reset, enterMcuboot`.

### Task 3: Catalog vendor + loader + fetch + plan libs

**Files:**
- Create: `client/src/data/firmware-catalog.source.json` (byte-copy of OF `docs/reference/firmware-catalog.json`)
- Create: `client/src/lib/firmware-catalog.ts`, `client/src/lib/firmware-fetch.ts`, `client/src/lib/firmware-plat.ts`, `client/src/lib/firmware-plan.ts`
- Test: `client/scripts/smoke.tsx` (§69)

**Interfaces:**
- Consumes: nothing from T1/T2.
- Produces:
```ts
// firmware-catalog.ts
export interface FwEntry { file: string; target: string; type: string; side: 'left'|'right'|null;
  generation: 'A'|'B'|null; flashable: boolean; withheldBecause?: string[]; blobSha256: string;
  plaintextSha256?: string; resourceSize?: number; historyPath?: string; createFirmware?: string;
  moduleFirmware?: string; versionLabel?: string; versionConfidence?: string; releaseOrder?: number;
  bundle?: string; bundles?: string[]; keyboardRange?: { from: string; below: string | null };
  component?: string; container?: string; sha256?: string; size?: number; [k: string]: unknown }
export interface FwCatalog { generated: string; images: FwEntry[]; releases: unknown[]; [k: string]: unknown }
export function loadFirmwareCatalog(): Promise<FwCatalog>; // memoized dynamic import, cast through unknown,
  // validate: images is a non-empty array, every entry has string file/target/blobSha256; throw otherwise
export interface KeyboardVersion { label: string; declared: boolean; releaseOrder: number; bundle?: string }
export function keyboardVersions(cat: FwCatalog): KeyboardVersion[]; // distinct keyboard versions
  // (createFirmware ?? versionLabel), declared = versionConfidence !== 'unknown', newest releaseOrder first
export function findKeyboardImage(cat: FwCatalog, side: 'left'|'right', gen: 'A'|'B', label: string): FwEntry | null;
  // target==='keyboard' && flashable && side/gen match && version label matches; match is BY ENTRY (hash-bearing), never by file name

// firmware-fetch.ts
export const FIRMWARE_SOURCE_BASE = 'https://raw.githubusercontent.com/create-collective/create-legacy-firmware/main/firmware-history/';
export interface Vault { has(sha: string): boolean; set(e: FwEntry, bytes: Uint8Array): void; get(sha: string): Uint8Array | undefined; count(): number }
export function newVault(): Vault;
export async function fetchImage(entry: FwEntry, opts?: { fetchFn?: typeof fetch; timeoutMs?: number }): Promise<Uint8Array>;
  // throws Error(reason): no historyPath / no blobSha256 / HTTP status / >8 MiB / timeout /
  // sha mismatch ("expected 3d3e544e…, got … — nothing was written"); nothing stored on any failure
export async function fetchVersion(cat: FwCatalog, label: string, vault: Vault,
  opts?: { fetchFn?: typeof fetch; onOne?(r: { entry: FwEntry; ok: boolean; reason?: string }): void }): Promise<{ fetched: number; failed: { path: string; reason: string }[] }>;
  // every historyPath-bearing entry under the label; one failure never stops the rest

// firmware-plat.ts
export const NAYA_VID = 0x37d1;
export const RECOVERY_PIDS = [0x06f, 0x16f, 0x0d3, 0x1d3] as const;
export function pidInfo(pid: number): { side: 'left'|'right'; mode: 'app'|'mcuboot'|'third'; generation: 'A'|'B' } | null;
  // family: 0x064/0x06F/0x07A left app/mcuboot/third; 0x0C8/0x0D3/0x0DE right; gen B = pid & 0x1000; unknown → null

// firmware-plan.ts
export interface HalfInput { side: 'left'|'right'; pid: number | null; fw: string | null }
export interface HalfPlan { side: 'left'|'right'; generation: 'A'|'B'|null; currentVersion: string|null;
  image: FwEntry|null; present: boolean; fetchable: boolean; unchanged: boolean; downgrade: boolean;
  unknownCurrent: boolean; reason?: string }
export function resolveKeyboardPlan(cat: FwCatalog, halves: HalfInput[], vault: Vault, label: string): { halves: HalfPlan[] };
```
- Plan flags per spec §4: `present` = vault.has(blobSha256); `fetchable` = image && historyPath present; `unchanged` = current == label; `downgrade` = target older by dot-version tuple, else `releaseOrder` fallback when either side undeclared; `unknownCurrent` = fw non-null AND not among catalog `createFirmware` values; `reason` when no image ("no image for this half+generation" / "not flashable: …").
- [ ] **Step 1: Write failing smoke §69** — (a) vendored file loads via loader (dynamic import), `images.length === 69`, `generated === '2026-09-23'`; (b) validation throws on a doctored shape; (c) `pidInfo` table: 0x0064/0x00C8/0x006F/0x00D3/0x007A/0x00DE, gen-B variants (0x1064 → B), null on 0x09; (d) plan flags: unchanged, downgrade by tuple, downgrade by releaseOrder when `versionConfidence` unknown, unknownCurrent, present/fetchable/reason; (e) catalog-by-name hazard: two entries sharing `file: 'kb_fwl.bin'` resolve distinctly by side/gen in `findKeyboardImage`; (f) fetch with fake `fetchFn`: ok → vault holds bytes; wrong digest → throws with "nothing was written", vault count unchanged; 9 MiB body → refused; HTTP 404 → reason carries status. sha256 via `crypto.subdigest` — node 22 `globalThis.crypto.subtle` (no DOM dependency).
- [ ] **Step 2: Run smoke, verify §69 fails.** Vendor step: `cmp` OF file vs vendored — byte-identical, size 101,398.
- [ ] **Step 3: Implement** the four libs; vendor the JSON byte-identical (no codegen — it is already compact metadata).
- [ ] **Step 4: Run smoke** — all ok, 0 FAIL; build/lint exit 0; `pnpm build` output shows the catalog in its own lazy chunk (dynamic import), index chunk does NOT grow by ~100 KB (assert via built file sizes in the report).
- [ ] **Step 5: Commit** — `feat(client): firmware catalog + fetch + plan libs — vendored OF catalog, sha256-gated downloads, PID/side/gen resolution`.

### Task 4: Interlock gate

**Files:**
- Create: `client/src/lib/firmware-interlocks.ts`
- Test: `client/scripts/smoke.tsx` (§70)

**Interfaces:**
- Consumes: `FwEntry` (T3).
- Produces:
```ts
export interface KeyboardGateInput { kind: 'keyboard'; entry: FwEntry; heldSha256: string;
  arm: string | null; slot0Hash: string | null; pidSide: 'left'|'right'; pidGeneration: 'A'|'B';
  fileSize: number; downgrade: boolean; allowOlder: boolean; unknownCurrent: boolean; consented: boolean;
  modulesDocked: boolean; uploadImageId: number }
export interface ModuleGateInput { kind: 'module'; entry: FwEntry; heldSha256: string;
  arm: string | null; slot0Hash: string | null; fileSize: number; bundleNewerThanKeyboard: boolean;
  downgrade: boolean; allowOlder: boolean; rightConnected: boolean; moduleDockedSide: 'left'|'right'|null;
  uploadImageId: number; forceType: string | null }
export function checkFlashGate(input: KeyboardGateInput | ModuleGateInput): string[];
```
- Rules (refusal strings, exact copy in the task brief): sha mismatch vs `blobSha256`; `!flashable` (+`withheldBecause` joined); type cross (`littlefs` never keyboard, `mcuboot` never module); arm null or ≠ slot0Hash; `uploadImageId` wrong for kind (≠2 keyboard; ≠4 module); keyboard `fileSize > 663_552`; module `fileSize !== 1_048_576`; `modulesDocked`; downgrade && !allowOlder; unknownCurrent && !consented; keyboard side/gen vs entry mismatch; module: rightConnected; module not docked left (unless forceType, which lifts ONLY type-identification blockers, never bay/right-half rules); bundle newer than keyboard.
- [ ] **Step 1: Write failing smoke §70** — full matrix: every rule alone (others passing) → exactly its refusal string; all-pass input → `[]`; forceType lifts type rules but not bay/right rules.
- [ ] **Step 2: Run smoke, verify §70 fails.**
- [ ] **Step 3: Implement** (pure function, no I/O).
- [ ] **Step 4: Run smoke** — all ok, 0 FAIL; build/lint exit 0.
- [ ] **Step 5: Commit** — `feat(client): firmware interlock gate — arm-token, slot/size/side caps, consent rules`.

### Task 5: Run log + procedure lifecycle (lock, freeze, unload guard, preflight)

**Files:**
- Create: `client/src/lib/firmware-run-log.ts`
- Create: `client/src/hooks/useFirmwareFlash.ts` (lifecycle part)
- Test: `client/scripts/smoke.tsx` (§71)

**Interfaces:**
- Consumes: T3/T4 types.
- Produces:
```ts
// firmware-run-log.ts
export type RunPhase = 'start'|'ok'|'fail'|'note'|'progress'|'action';
export interface RunEvent { ts: number; elapsed_ms: number; step: string; label: string; phase: RunPhase;
  side?: 'left'|'right'; detail?: string; took_ms?: number; percent?: number; sent?: number; total?: number;
  [k: string]: unknown }
export const STEP_LABELS: Record<string, string>; // ported OF STEP_LABELS (flash_procedure.py:54-80) + module steps
export class FirmwareRunLog {
  constructor(kind: 'keyboard'|'module'); // id = `${kind}-YYYYMMDD-HHMMSS`
  start(step: string, side?: 'left'|'right'): void;
  ok(step: string, side?: 'left'|'right', extra?: Record<string, unknown>): void;
  fail(step: string, side: 'left'|'right'|undefined, detail: string): void;
  note(step: string, side: 'left'|'right'|undefined, detail: string, extra?: Record<string, unknown>): void;
  progress(step: string, side: 'left'|'right', percent: number, sent: number, total: number): void;
  action(step: string, side: 'left'|'right'|undefined, text: string): void;
  finish(ok: boolean, summary: string, failures?: string[], advisories?: string[]): void;
  readonly events: readonly RunEvent[]; readonly id: string; readonly done: boolean;
  lines(): string; // JSONL; one JSON object per line; keys in fixed order ts,elapsed_ms,step,label,phase,then optionals
  subscribe(fn: (e: RunEvent) => void): () => void;
}

// useFirmwareFlash.ts (lifecycle surface; T6-T8 extend the same hook's internals)
export function firmwareRunActive(): boolean; // module-level flag, true from beginRun to endRun
export interface FlashWindowLike { addEventListener(t: string, l: unknown): void; removeEventListener(t: string, l: unknown): void }
export function useFirmwareFlash(deps: {
  sesRef: React.RefObject<Map<'left'|'right', NayaSession>>; busyRef: React.RefObject<boolean>;
  win?: FlashWindowLike; // default globalThis — injectable for node smoke
}): {
  status: 'idle'|'running'|'done'|'failed';
  log: FirmwareRunLog | null;
  events: readonly RunEvent[];
  exportLog(): void; // saveText(`${log.id}.log.jsonl`, log.lines()) — no-op when null
  // startKeyboard/startModule added by T6/T10
};
```
- Lifecycle internals (this task): `beginRun(kind)` — refuse if in-flight (one run at a time), set `firmwareRunActive` flag, set `busyRef`, register `beforeunload`+`pagehide` guards (handler sets `returnValue` and calls preventDefault — the injected `win` receives them); `endRun(ok,…)` — clear flag/busyRef, remove guards, set status. `capturePreflight(sessions, sides)` — per side: fw via existing `fe/1002` read, BLE identity via the same SDK be/ read helpers App.tsx:464-505 uses, module presence `de/1001` both halves (the undock gate input); left-only keymap+LED snapshot via the same SDK backup read `useFlash` auto-backup uses (useFlash.ts:189-206); serialize (stable key order) + sha256 hex as a `preflight` artifact note; `verifyPreflight` — re-serialize, byte-identical or refuse.
- [ ] **Step 1: Write failing smoke §71** — (a) log shape: run.start first (meta kind), events carry fixed key order (parse each line, deep-equal key arrays), run.end last with failures/advisories; progress/action/note rows carry their fields; `lines()` parse-clean JSONL; (b) lifecycle: second `beginRun` while active refuses; flag true during run, false after; injected fake `win` records add/removeEventListener pairs — guards registered exactly while active; (c) preflight on scripted NayaSession fakes (existing fixture patterns): capture produces artifact note with sha256; re-serialize equality passes; a mutated snapshot fails verify.
- [ ] **Step 2: Run smoke, verify §71 fails.**
- [ ] **Step 3: Implement** run log + hook lifecycle + preflight capture.
- [ ] **Step 4: Run smoke** — all ok, 0 FAIL; build/lint exit 0.
- [ ] **Step 5: Commit** — `feat(client): firmware run log + procedure lifecycle — one-run lock, freeze flag, unload guard, preflight capture`.

### Task 6: Flash-one-side — enter, identify, gate, upload, swap verify

**Files:**
- Modify: `client/src/hooks/useFirmwareFlash.ts` (append core)
- Create: `client/src/lib/serial-world.ts`
- Test: `client/scripts/smoke.tsx` (§72)

**Interfaces:**
- Consumes: T1/T2 SDK exports, T3 plan/vault, T4 gate, T5 log/lifecycle.
- Produces:
```ts
// serial-world.ts
export interface PortWithInfo extends SmpSerialPortLike { getInfo?: () => { usbVendorId?: number; usbProductId?: number } }
export interface SerialWorld {
  getPorts(): Promise<PortWithInfo[]>;
  requestPort(filters?: Array<{ usbVendorId?: number }>): Promise<PortWithInfo>;
}
export function defaultSerialWorld(): SerialWorld; // navigator.serial guarded; node-safe (throws "no WebSerial" lazily)

// useFirmwareFlash.ts additions
export interface StartKeyboardOpts { targets: Array<{ side: 'left'|'right'; label: string }>;
  allowOlder: boolean; acceptUnknown: boolean; consentedUnknown: boolean }
// hook returns startKeyboard(opts): Promise<void> plus injectable ctor opts (world, vault, timeouts) via deps
```
- Flow (spec §5 steps 1-8, left first when both): preflight (T5) → per target side: `ses.enterMcuboot()` → poll `world.getPorts()` every 500 ms ≤60 s for `pidInfo(pid).mode==='mcuboot'` && side match; if none appears and `requestPort` is needed, emit `action` event ("grant the bootloader port") and await the UI calling it (dep-injected callback; smoke uses a stub world) → `SmpLink.open` on candidates, probe with `imageState` — first answering port wins, non-answering becomes a console tap (line accumulator surfaced as `bootloader.console` note) → identify: slot-0 hash → arm token; match running hash against catalog `plaintextSha256` for version/unknown classification → assemble `KeyboardGateInput` with live values + `resolveUploadImageId` → `checkFlashGate` — non-empty → `fail` + abort (NO upload bytes written) → upload via `SmpDevice.uploadImage` wiring `onProgress`→`log.progress` (5% steps), `onFirstChunkAck`→`slot.erase` ok → `swap.verify`: ≤300 s (injected timeouts in smoke), re-`imageState` every 2 s on any mcuboot port of the side, early success if the side's app PID appears.
- All wait durations come from a `timeouts` dep with spec defaults; smoke passes millisecond-scale values.
- [ ] **Step 1: Write failing smoke §72** — scripted world: fake mcuboot line-ports behind `getPorts`; (a) happy path two chunks: log order `mcuboot.enter → identify → slot.erase(ok) → upload(progress) → swap.verify(ok)`; ON enters via the app session fake asserting frame `0xEE/0x10/0xAE`; (b) arm mismatch: identify returns foreign hash → gate refusal logged, ZERO smp writes on the bootloader port (assert fake's write count 0); (c) rc≠0 abort → run.fail, rescue path (T8) not yet — status failed; (d) probe discipline: two mcuboot ports, first silent, second answers — link uses the second, first accumulated console text; (e) swap-already-happened: post-upload state shows slot-0 == target hash → swap.verify ok without reset loop.
- [ ] **Step 2: Run smoke, verify §72 fails.**
- [ ] **Step 3: Implement** serial-world + flash-one-side core.
- [ ] **Step 4: Run smoke** — all ok, 0 FAIL; build/lint exit 0.
- [ ] **Step 5: Commit** — `feat(client): keyboard flash core — mcuboot entry, SMP identify, gated upload, swap verify`.

### Task 7: Return to app — os reset, version confirm, settle, rescan

**Files:**
- Modify: `client/src/hooks/useFirmwareFlash.ts` (append)
- Modify: `client/src/hooks/useSessions.ts` (rescan + freeze)
- Test: `client/scripts/smoke.tsx` (§73)

**Interfaces:**
- Consumes: T6.
- Produces: `useSessions` gains `rescan(): Promise<void>` (re-sweep `getPorts()`, skip non-app PIDs, connect unclaimed halves) and its auto-connect/hot-plug effect checks `firmwareRunActive()` first; hook's flow continues: `mcuboot.exit` (`SmpDevice.osReset` on the answering port) → `version.confirm` (poll app PID ≤300 s, re-reset every 30 s, open procedure-owned `NayaSession` on the app port — same connect+identify discipline as `useSessions.connectPort` — read fw via fe/1002; mismatch → refuse; unknown → advisory) → `halves.settle` (≤90 s until BOTH halves answer: existing sessions re-probed + world polling; timeout → fail-and-continue note) → run end hands over: close owned sessions, clear flag, `rescan()`.
- [ ] **Step 1: Write failing smoke §73** — mutable world fake where the mcuboot port object is REPLACED by an app-mode Naya fake port after `osReset`: (a) reset goes to the answering port only (silent twin sees no SMP write); (b) app session opens on the new port, fw read matches → `version.confirm` ok; mismatch → refusal with hash-verified write note; (c) settle: second half answers late (within window) → ok; never → fail note, run continues to restores; (d) `rescan()` on fake world: connects app-PID ports, SKIPS mcuboot-PID port (assert no connect attempt); auto-connect effect body: `firmwareRunActive()===true` → no sweep (assert via spy).
- [ ] **Step 2: Run smoke, verify §73 fails.**
- [ ] **Step 3: Implement** return-to-app + useSessions changes.
- [ ] **Step 4: Run smoke** — all ok, 0 FAIL; build/lint exit 0.
- [ ] **Step 5: Commit** — `feat(client): post-flash return — os reset, version confirm, halves settle, session rescan`.

### Task 8: Restores, verify.compare, stranded rescue, verdict

**Files:**
- Modify: `client/src/hooks/useFirmwareFlash.ts` (append)
- Test: `client/scripts/smoke.tsx` (§74)

**Interfaces:**
- Consumes: T7 owned sessions.
- Produces (internal, exercised through the hook): `brightness.restore` (LED `0x1013` write `max_brightness` 100 or app-saved value — never 0 — per side; cosmetic, never fatal), `lighting.restore` (read the left half's layer list and write it straight back — one frame to the left clears runtime effects on both halves, OF service.py:1189-1207; use the same SDK layer-list read op the app already uses), `verify.compare` (re-capture snapshot; strict failures: BLE address/pair address/bond table + primary keymap bank; advisories when version changed: LED map + second bank; absent keymap position == `07 00` NONE record counts as equal), stranded-half rescue (failure path: per side still mcuboot → answering port → osReset → await app ≤300 s with 30 s re-resets; three logged outcomes: back running X / still parked → power-cycle note / not on USB → unplug-replug note), verdict `finish` with failures/advisories.
- [ ] **Step 1: Write failing smoke §74** — (a) full dry-run FAILURE branch: upload throws mid-run → rescue resets the parked fake → outcome note logged → run.end fail with failures list; (b) compare: two snapshots differing in BLE address → strict failure; differing in LED map with version change → advisory only; identical → clean; (c) restores: owned-session fakes observe the `0x1013` write (value 100) and a layer-list read+write-back; restore throwing → note, run still ends ok; (d) brightness never 0 (fake records value, assert).
- [ ] **Step 2: Run smoke, verify §74 fails.**
- [ ] **Step 3: Implement** restores + compare + rescue + verdict wiring.
- [ ] **Step 4: Run smoke** — all ok, 0 FAIL; build/lint exit 0.
- [ ] **Step 5: Commit** — `feat(client): flash tail — brightness/lighting restore, postflight compare, stranded rescue`.

### Task 9: FirmwareTab UI — library + keyboard dialog

**Files:**
- Create: `client/src/components/tabs/FirmwareTab.tsx`, `client/src/components/firmware/FirmwareLibraryView.tsx`, `client/src/components/firmware/KeyboardFlashDialog.tsx`, `client/src/components/firmware/FlashTimeline.tsx`
- Modify: `client/src/components/AppTabs.tsx` (tab union + entry), `client/src/App.tsx` (wiring-only: render + hook instantiation)

**Interfaces:**
- Consumes: T3-T8 libs/hook; existing UI primitives (Notice/Card/Row patterns, `usePersistentFlag`, `saveText`).
- Produces: `FlashTimeline` exports `stepRows(events)` + `currentLabel(rows)` (ported from OF FirmwareUpdate.jsx:34-64: one row per side+step arrival order; `!` failed sticky, `✓` done, `…` running; percent column only when a row has one) — reused by T10's module dialog. Tab id `'firmware'`.
- UI content per spec §9: library view (grouped keyboard-before-module, newest releaseOrder first, per-group download with sizes + result notices, sha256 prefixes, flashable badges + withheldBecause tooltips, "catalog, not the flasher" header prose); keyboard dialog (version select with declared/"no version number declared" labels, per-half rows `current → target` + `(already on it)`/`(older)` suffixes, file column only when usable, download notice fetchable-button vs fact, unknown-current consent block, downgrade danger state, undock notice, expectations block incl. "do not unplug", live timeline with action prompts replacing the headline, verdict panel with failures/advisories + "saved as <id>" keep note, JSONL export); modal non-dismissable while running.
- No new smoke section (UI task — precedent phases 7/8); gates must stay green and the built index must not inline catalog strings (lazy chunk intact — report bundle sizes).
- [ ] **Step 1: Implement** components + wiring (logic stays in hook/libs — house rule).
- [ ] **Step 2: Gates** — build/lint exit 0, smoke unchanged 0 FAIL; bundle check: catalog chunk separate.
- [ ] **Step 3: Commit** — `feat(client): FirmwareTab — catalog library, keyboard flash dialog, live timeline`.

### Task 10: Module firmware procedure + dialog

**Files:**
- Modify: `client/src/hooks/useFirmwareFlash.ts` (append `startModule`)
- Create: `client/src/components/firmware/ModuleFlashDialog.tsx`, FirmwareTab entry button
- Modify: `sdk/src/naya.ts` (two vendor read/write helpers if absent — see below)
- Test: `client/scripts/smoke.tsx` (§75)

**Interfaces:**
- Consumes: T2/T6/T7 machinery; SDK needs `moduleFileFwVersion()` (read `0xDE/0x100A`, left, app mode — verify against OF service.py:1155) and `modFwup(typeCode)` (write `0xDE/0x1005`, ONE payload byte, dest 0x50, NO reply expected — 2 s write-and-forget; OF module_procedure.py:479). Add both to NayaSession if missing.
- Produces: `startModule(opts: { label?: string; forceUpload?: boolean; forceType?: 'Touch'|'Tune'|'Track'; allowOlder: boolean }): Promise<void>` — preconditions (left app present; right NOT connected; module docked LEFT; type known unless forceType; bundle = newest flashable littlefs with `keyboardRange.from` ≤ keyboard fw; pairing guard; `upload = forceUpload || stored !== target`; `program = forceType != null || running !== target`; neither → finish ok "already runs …") → ONE link conversation (identify + slot map 3 tries + chunks; unmapped → exact-1 MiB id 4) → NO reset after last chunk (half self-restarts) → `bundle.restart` await-left (replug `action` event after 30 s unseen: "unplug its USB cable, count to ten, plug it back in — not a power cycle"; ≤600 s; boot reset re-send 60 s) → `bundle.verify` (stored == target) → `module.program` MOD_FWUP with `FWUP_TYPES {Touch:1, Tune:2, Track:3}` (these exact codes — NOT nayactl MODULE_TYPES order) → `module.restart` (await drop 120 s + await left) → `module.verify` (module fw == target AND type == want ≤90 s; wrong type → refusal pointing at Force Update) → `verify.compare` (left identity + keymap) → verdict; failure path recovers left; module-fw client cache invalidated in `finally`.
- Dialog: three static rows (left half / module left bay / right half "unplug it"), blockers list, version select with `needs keyboard X or newer` disables, force-type select with NO default, replug prompt as the dialog's largest words, expectations (~3-6 min, keep module docked), verdict + log (reuses `FlashTimeline`).
- [ ] **Step 1: Write failing smoke §75** — fixtures: (a) precondition refusals (right connected; module in right bay; bundle newer than keyboard); (b) happy path: MOD_FWUP frame on the app-session fake is EXACTLY `0xDE/0x1005` + one byte code, and NO reset is sent after the last chunk (world fake records osReset calls — count 0 post-upload); (c) stored == target && !program → "already runs it" ok verdict without bootloader entry; (d) replug: world hides the left port 30 s (tiny timeouts) → exactly ONE action event with the replug text, cleared by the return; (e) force-type flow: type unknown + forceType 'Tune' → program byte 0x02; wrong-type verify → refusal mentions Force Update.
- [ ] **Step 2: Run smoke, verify §75 fails.**
- [ ] **Step 3: Implement** SDK helpers + procedure + dialog.
- [ ] **Step 4: Run smoke** — all ok, 0 FAIL; build/lint exit 0.
- [ ] **Step 5: Commit** — `feat(client): module firmware procedure — bundle upload, MOD_FWUP programming, replug UX`.

### Task 11: KB copy updates + docs

**Files:**
- Modify: `sdk/src/troubleshooting/kb/bootloader-parked.ts`, `sdk/src/troubleshooting/kb/firmware-mismatch.ts`, `sdk/src/troubleshooting/wire-guard.ts` (header comment only)
- Modify: `HANDOFF.md`, `README.md`

**Interfaces:**
- Consumes: landed T1-T10.
- Produces: docs only. `bootloader-parked` cure copy → Firmware tab rescue (procedure's failure path puts halves back; power-cycle fallback stays); `firmware-mismatch` line "this app does not flash firmware" retired → points at FirmwareTab; wire-guard header gains the SMP-lane sentence (procedure-only, consent-gated); HANDOFF ROADMAP item 12 (`✅ DONE 2026-10-…`, commit range, summary) + `## Firmware flashing notes (Phase 9)` section (SMP line protocol + header/CRC/CBOR summary, PID table, interlock list, upload numbering, module FWUP codes, phase-10 live unknowns: WebSerial re-grant on PID change, real erase/swap timings, CORS download, MOD_FWUP no-reply — each with its designed fallback); README one clause on the `client/` bullet.
- [ ] **Step 1: Verify every doc fact against landed code** (grep anchors; no uninvented claims — phase 7/8 T-docs precedent).
- [ ] **Step 2: Gates** — docs-only: build/lint/smoke unchanged green.
- [ ] **Step 3: Commit** — `docs: firmware flashing — HANDOFF roadmap item 12 + notes, README, KB copy`.

---

## Self-Review (done at write time)

- Spec coverage: catalog (T3), fetch+sha gate (T3), plan flags (T3), interlocks §7 (T4), SMP client §1 (T1/T2), transport+re-enum §2 (T6/T7 serial-world), procedures §5/§6 (T5-T8, T10), update-safe §8 (T5/T7), UI §9 (T9/T10), wire-guard/KB §10 (T11), smoke §11 (T1-T8, T10 sections), docs (T11). Exit-criteria line (live = phase 10) carried in T11 notes.
- Type consistency: `SmpLink`/`SmpDevice`/`SmpSerialPortLike` (T1→T2→T6), `FwEntry`/`Vault` (T3→T4/T6), `FirmwareRunLog` (T5→T6/T8/T10), `SerialWorld` (T6→T7/T10), `FlashTimeline` (T9→T10).
- Proportion: steps name signatures, fixtures, and asserts — bodies unwritten.
