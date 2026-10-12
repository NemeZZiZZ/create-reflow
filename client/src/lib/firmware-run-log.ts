/* Firmware procedure run log — the JSONL observability stream every flash
 * procedure (keyboard / module) writes into: one event per row in memory,
 * exported as `${id}.log.jsonl` via lib/save.saveText. First line is the
 * `run.start` meta (carries the run kind), last is `run.end` carrying the
 * verdict {ok, summary, failures[], advisories[]}; the log freezes after
 * run.end — post-finish emits are ignored, so the exported file always ends
 * on the verdict.
 *
 * Key order in lines() is canonical and fixed: ts, elapsed_ms, step, label,
 * phase, then side, detail, took_ms, percent, sent, total, then any extra
 * keys in insertion order (run.start's `kind`, run.end's verdict fields,
 * artifact notes' sha256…). Events are built in exactly that order, so
 * JSON.stringify per row is byte-stable and the smoke can deep-equal key
 * arrays per line.
 *
 * Step names are the ported OF flash_procedure.py STEP_LABELS set (54-80)
 * plus the module-procedure steps from the design spec (§6); an unknown
 * step's label falls back to the step name so procedures can log ad-hoc
 * steps without touching this map.
 *
 * Also hosts the preflight-artifact serialization helpers: stableStringify
 * (recursively key-sorted JSON — re-serialization of unchanged data is
 * byte-identical, which is what makes the sha256 equality check meaningful)
 * and sha256Hex over globalThis.crypto.subtle (WebCrypto — available in
 * browsers AND node 22, so the smoke exercises the real digest). */

export type RunPhase = 'start' | 'ok' | 'fail' | 'note' | 'progress' | 'action';

export interface RunEvent {
  ts: number;
  elapsed_ms: number;
  step: string;
  label: string;
  phase: RunPhase;
  side?: 'left' | 'right';
  detail?: string;
  took_ms?: number;
  percent?: number;
  sent?: number;
  total?: number;
  [k: string]: unknown;
}

/* Ported OF flash_procedure.py STEP_LABELS (54-80) + module steps (design
 * spec §6). Labels are the human timeline strings the live UI shows. */
export const STEP_LABELS: Record<string, string> = {
  'run.start': 'Firmware update',
  'run.end': 'Run finished',
  'preflight.capture': 'Preflight capture',
  'preflight.verify': 'Preflight verify',
  'mcuboot.enter': 'Enter bootloader',
  'identify': 'Identify half in bootloader',
  'gate.check': 'Safety gate',
  'slot.erase': 'Erase slot',
  'upload': 'Upload image',
  'swap.verify': 'Verify swap',
  'mcuboot.exit': 'Exit bootloader',
  'version.confirm': 'Confirm version',
  'halves.settle': 'Settle halves',
  'bootloader.console': 'Bootloader console',
  'brightness.restore': 'Restore brightness',
  'lighting.restore': 'Restore lighting',
  'verify.compare': 'Compare against preflight',
  'slot.map': 'Read slot map',
  'bundle.stored': 'Read stored bundle version',
  'bundle.verify': 'Verify bundle version',
  'bundle.restart': 'Restart keyboard (bundle)',
  'module.program': 'Program module',
  'module.restart': 'Restart keyboard',
  'module.verify': 'Verify module',
  'rescue': 'Recover half',
};

type Sub = (e: RunEvent) => void;

interface EmitOpt {
  side?: 'left' | 'right';
  detail?: string;
  percent?: number;
  sent?: number;
  total?: number;
  extra?: Record<string, unknown>;
}

export class FirmwareRunLog {
  readonly id: string;
  readonly kind: 'keyboard' | 'module';
  private t0 = Date.now();
  private evs: RunEvent[] = [];
  private subs = new Set<Sub>();
  private finished = false;

  constructor(kind: 'keyboard' | 'module') {
    this.kind = kind;
    const d = new Date();
    const p2 = (x: number): string => String(x).padStart(2, '0');
    this.id = `${kind}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-` +
      `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    this.emit('start', 'run.start', { extra: { kind } }, this.t0);
  }

  get events(): readonly RunEvent[] {
    return this.evs;
  }

  get done(): boolean {
    return this.finished;
  }

  /* Procedure steps: start at entry, ok/fail at exit. */
  start(step: string, side?: 'left' | 'right'): void {
    this.emit('start', step, { side });
  }

  ok(step: string, side?: 'left' | 'right', extra?: Record<string, unknown>): void {
    this.emit('ok', step, { side, extra });
  }

  fail(step: string, side: 'left' | 'right' | undefined, detail: string): void {
    this.emit('fail', step, { side, detail });
  }

  note(
    step: string,
    side: 'left' | 'right' | undefined,
    detail: string,
    extra?: Record<string, unknown>,
  ): void {
    this.emit('note', step, { side, detail, extra });
  }

  progress(step: string, side: 'left' | 'right', percent: number, sent: number, total: number): void {
    this.emit('progress', step, { side, percent, sent, total });
  }

  action(step: string, side: 'left' | 'right' | undefined, text: string): void {
    this.emit('action', step, { side, detail: text });
  }

  /* run.end — the verdict row. First finish wins; later finishes are no-ops
   * (and the log is frozen to further emits either way). */
  finish(ok: boolean, summary: string, failures?: string[], advisories?: string[]): void {
    if (this.finished) return;
    this.emit(ok ? 'ok' : 'fail', 'run.end', {
      extra: { ok, summary, failures: failures ?? [], advisories: advisories ?? [] },
    });
    this.finished = true;
  }

  subscribe(fn: Sub): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  /* JSONL export: one JSON object per line, canonical key order (built into
   * the events themselves). No trailing newline — line count == event count. */
  lines(): string {
    return this.evs.map((e) => JSON.stringify(e)).join('\n');
  }

  private emit(phase: RunPhase, step: string, opt: EmitOpt, nowTs?: number): void {
    if (this.finished) return;
    /* Known optional keys ride their canonical slot even when the caller
     * passed them inside extra; the rest append in insertion order. */
    const extra = { ...opt.extra };
    const side = opt.side ?? (extra.side as 'left' | 'right' | undefined);
    const detail = opt.detail ?? (extra.detail as string | undefined);
    const took = extra.took_ms as number | undefined;
    const percent = opt.percent ?? (extra.percent as number | undefined);
    const sent = opt.sent ?? (extra.sent as number | undefined);
    const total = opt.total ?? (extra.total as number | undefined);
    for (const k of ['side', 'detail', 'took_ms', 'percent', 'sent', 'total']) delete extra[k];
    const now = nowTs ?? Date.now();
    const e: RunEvent = {
      ts: now, elapsed_ms: now - this.t0, step,
      label: STEP_LABELS[step] ?? step, phase,
    };
    if (side !== undefined) e.side = side;
    if (detail !== undefined) e.detail = detail;
    if (took !== undefined) e.took_ms = took;
    if (percent !== undefined) e.percent = percent;
    if (sent !== undefined) e.sent = sent;
    if (total !== undefined) e.total = total;
    for (const k of Object.keys(extra)) {
      if (extra[k] !== undefined) e[k] = extra[k];
    }
    this.evs.push(e);
    for (const fn of this.subs) fn(e);
  }
}

/* Recursively key-sorted JSON — the preflight artifact serialization. Build
 * order never matters, so re-serializing unchanged data is byte-identical
 * and the sha256 equality check verifies content, not construction. */
export function stableStringify(value: unknown): string {
  const enc = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(enc);
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = enc(o[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(enc(value));
}

/* sha256 over WebCrypto (globalThis.crypto.subtle — browser AND node 22),
 * lowercase hex; same digest pattern as firmware-fetch. */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
