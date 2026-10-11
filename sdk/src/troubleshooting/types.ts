/* Troubleshooting plugin types.
 *
 * A problem is a TroubleEntry; its treatments are TroubleActions — either a
 * declarative wire recipe (steps) or a scripted run(ctx) for app-side flows.
 * All wire traffic goes through TroubleCtx.send, which refuses never-send
 * verbs at runtime (see wire-guard.ts). */

/** One guarded wire frame; delayMs settles after the step (default 350). */
export interface WireStep {
  t: number;
  c0: number;
  c1: number;
  params?: number[];
  delayMs?: number;
  /** advisory step: no-reply is logged, not fatal (default false) */
  tolerateNoReply?: boolean;
  /** human label for the log line */
  note?: string;
}

/** Runtime capabilities handed to scripted actions. */
export interface TroubleCtx {
  /** guarded wire send — throws on never-send verbs */
  send(t: number, c0: number, c1: number, params?: number[]): Promise<void>;
  confirm(msg: string): boolean;
  toast(msg: string, kind?: "success" | "info" | "error"): void;
  log(cls: "cdc" | "inf" | "err", msg: string): void;
  sleep(ms: number): Promise<void>;
  dump(): Promise<void>;
  refreshAux(): Promise<void>;
  reboot(): Promise<void>;
  /**
   * Read the layer list (30/1001 handshake) on the LEFT half and echo the
   * same entries back via 30/1002. Restores wedged runtime lighting on both
   * halves without changing anything stored (measured, 2026-09). Validates
   * the reply shape and refuses odd replies instead of writing garbage.
   */
  rewriteLayerList(): Promise<void>;
  /**
   * Read-only BLE identity reads on BOTH halves' live sessions for scripted
   * checks: per half be/1008 (own address), be/1002 (pair address — the PEER
   * this half points at) and be/1005 (bond-table MACs). No writes, ever —
   * checks grade, they never repair. Runs under the app's busy gate and
   * refuses while a dump/flash holds it.
   */
  bleSplitReads(): Promise<SplitLinkReads>;
}

/** One half's BLE identity snapshot for scripted checks (see
 * TroubleCtx.bleSplitReads). Null reads = offline half or a verb the
 * firmware left unanswered — absence of evidence, never a verdict. */
export interface BleIdentityRead {
  /** the half's session is live (reads were actually attempted). */
  connected: boolean;
  /** be/1008 — this half's own BLE address. */
  address: Uint8Array | null;
  /** be/1002 — the PEER this half points at. */
  pairAddress: Uint8Array | null;
  /** be/1005 bond-table MACs; null = unanswered / not attempted. */
  pairedPeers: Uint8Array[] | null;
}

/** Both halves' identity reads + the transport facts a split-link verdict
 * needs (connected flags + base FW per half, null = unknown). */
export interface SplitLinkReads {
  left: BleIdentityRead;
  right: BleIdentityRead;
  leftFw: string | null;
  rightFw: string | null;
}

export interface TroubleAction {
  label: string;
  /** which half must be connected ('any' = app-side only) */
  side: "left" | "right" | "any";
  /** window.confirm text — required for anything that mutates device state */
  confirm?: string;
  /** declarative wire recipe (simple cases) — or run() for scripted ones */
  steps?: WireStep[];
  run?: (ctx: TroubleCtx) => Promise<void>;
}

export interface TroubleEntry {
  id: string;
  title: string;
  summary: string;
  details: string[];
  /** human recipe, numbered in the UI */
  steps: string[];
  actions?: TroubleAction[];
}
