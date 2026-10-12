/* Live firmware-run timeline — the OF FirmwareUpdate.jsx:34-64 row model,
 * ported to the RunEvent stream (lib/firmware-run-log):
 *
 * - one row per (side, step), in first-arrival order;
 * - `start` opens a row as running, `ok` closes it done, `fail` closes it
 *   failed — and a failed row is STICKY (a later event on the same
 *   side+step never repaints it; a failed step stays visible as failed);
 * - `progress` only refreshes the row's percent (5%-step uploads);
 * - `note`/`action` attach their detail text to the row when one exists
 *   (never create rows — the console-babble notes ride existing steps);
 * - `currentLabel` is the last row that started and has not ended — the
 *   "what is happening right now" headline.
 *
 * Exports `stepRows` + `currentLabel` for the module dialog (T10) to reuse;
 * the component itself is pure presentation over the row model. */

import { STEP_LABELS } from '../../lib/firmware-run-log';
import type { RunEvent } from '../../lib/firmware-run-log';
import { cn } from '../../lib/utils';

export interface FlashRow {
  key: string;
  step: string;
  side?: 'left' | 'right';
  phase: 'running' | 'done' | 'fail';
  percent?: number;
  notes: string[];
}

const rowKey = (step: string, side: 'left' | 'right' | undefined): string =>
  `${side ?? ''}\u0000${step}`;

/* Fold the event stream into timeline rows (arrival order preserved). The
 * step label is the STEP_LABELS human string, falling back to the step name
 * exactly like the log itself does. */
export function stepRows(events: readonly RunEvent[]): FlashRow[] {
  const rows = new Map<string, FlashRow>();
  for (const e of events) {
    const key = rowKey(e.step, e.side);
    if (e.phase === 'progress') {
      const row = rows.get(key);
      if (row !== undefined && typeof e.percent === 'number') row.percent = e.percent;
      continue;
    }
    if (e.phase === 'note' || e.phase === 'action') {
      const row = rows.get(key);
      if (row !== undefined && e.detail !== undefined) row.notes.push(e.detail);
      continue;
    }
    let row = rows.get(key);
    if (e.phase === 'start') {
      // Running, but never resurrecting a failed row (fail is sticky).
      if (row !== undefined && row.phase === 'fail') continue;
      if (row === undefined) {
        row = { key, step: e.step, side: e.side, phase: 'running', notes: [] };
        rows.set(key, row);
      } else {
        row.phase = 'running';
      }
      continue;
    }
    // ok / fail close the row; create-on-close keeps ad-hoc steps visible.
    // run.end also closes the run.start row it belongs to — otherwise a
    // finished run would leave a phantom open "Firmware update" headline.
    if (e.step === 'run.end') {
      const startRow = rows.get(rowKey('run.start', e.side));
      if (startRow !== undefined && startRow.phase !== 'fail') {
        startRow.phase = e.phase === 'fail' ? 'fail' : 'done';
      }
    }
    if (row === undefined) {
      row = { key, step: e.step, side: e.side, phase: 'running', notes: [] };
      rows.set(key, row);
    }
    if (row.phase === 'fail') continue;
    row.phase = e.phase === 'fail' ? 'fail' : 'done';
    if (e.phase === 'fail' && e.detail !== undefined) row.notes.push(e.detail);
  }
  return [...rows.values()];
}

/* The headline: the label of the last row that started and has not ended.
 * Empty string when nothing is in flight (idle or every step closed). */
export function currentLabel(rows: readonly FlashRow[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.phase === 'running') {
      return `${STEP_LABELS[r.step] ?? r.step}${r.side === undefined ? '' : ` — ${r.side}`}`;
    }
  }
  return '';
}

/* The latest action-phase event's text — the replug/grant prompt that
 * replaces the headline while the procedure waits on the user. */
export function currentAction(events: readonly RunEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.phase === 'action') return e.detail ?? null;
  }
  return null;
}

const MARK: Record<FlashRow['phase'], string> = {
  running: '…',
  done: '✓',
  fail: '!',
};

export default function FlashTimeline({
  events,
  className,
}: {
  events: readonly RunEvent[];
  className?: string;
}) {
  const rows = stepRows(events);
  if (rows.length === 0) return null;
  // The percent column exists only when at least one row carries a percent
  // (upload) — no empty ruler next to steps that have none.
  const showPct = rows.some((r) => r.percent !== undefined);
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {rows.map((r) => (
        <div key={r.key} className="text-[13px] leading-snug">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                'w-3 shrink-0 text-center tabular-nums',
                r.phase === 'fail'
                  ? 'font-semibold text-[#ff9d9d]'
                  : r.phase === 'done'
                    ? 'text-[#7ee2a8]'
                    : 'text-muted-foreground',
              )}
              aria-label={r.phase}
            >
              {MARK[r.phase]}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                r.phase === 'fail' ? 'text-[#ff9d9d]' : undefined,
              )}
            >
              {STEP_LABELS[r.step] ?? r.step}
              {r.side !== undefined && (
                <span className="text-muted-foreground"> — {r.side}</span>
              )}
            </span>
            {showPct && (
              <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                {r.percent !== undefined ? `${r.percent}%` : ''}
              </span>
            )}
          </div>
          {r.notes.length > 0 && (
            <div className="ml-5 text-xs text-muted-foreground">
              {r.notes[r.notes.length - 1]}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
