/* Flash dialog: preview of the queued write plan — nothing is written until
 * confirmed. Ops are grouped by section (bindings / LED / modules /
 * behavior) in the canonical SECTIONS order; the original op index rides
 * along each row so removeAt keeps working after grouping. Inspired by (and
 * deliberately simpler than) OpenFlow's dialog. */

import { useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from './ui/accordion';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  opSection,
  opSummary,
  SECTIONS,
  SECTION_LABELS,
  type Draft,
  type DraftDrop,
  type Op,
} from '@create-reflow/sdk';
import { X } from 'lucide-react';
import { collectDrops } from '../hooks/useFlash';
import type { FlashResult, FlashState } from '../hooks/useFlash';

/** Render guard for drop rows: refused targets may carry a layer outside
 * the 0..7 window (e.g. a layer-add rejected past the inventory) or a kk
 * outside the 0..135 LED map — label them as refused operations, never
 * map them onto board layers/keys. */
function dropWhere(d: DraftDrop): string {
  const parts: string[] = [];
  if (d.layer !== undefined)
    parts.push(
      d.layer >= 0 && d.layer <= 7
        ? `L${d.layer}`
        : `refused layer ${d.layer}`,
    );
  if (d.kk !== undefined)
    parts.push(
      d.kk >= 0 && d.kk <= 0x87
        ? `KK ${d.kk} (0x${d.kk.toString(16)})`
        : `refused KK ${d.kk}`,
    );
  return parts.join(' ');
}

const DROP_CAP = 6;

/** The warn drop Notice: pre-flash it lists the live queue's refusals,
 * post-flash the same list is re-rendered in the verdict area. Capped at
 * 6 rows + overflow; each row shows layer/kk (when present) + reason. */
function DropNotice({ drops }: { drops: DraftDrop[] }) {
  return (
    <div className="rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-sm">
      <div className="font-medium text-amber-300">
        {drops.length} change(s) cannot be written
      </div>
      <ul className="mt-1.5 space-y-1 text-muted-foreground">
        {drops.slice(0, DROP_CAP).map((d, i) => {
          const where = dropWhere(d);
          return (
            <li key={i} className="truncate">
              {where ? `${where} — ${d.reason}` : d.reason}
            </li>
          );
        })}
        {drops.length > DROP_CAP && <li>+{drops.length - DROP_CAP} more…</li>}
      </ul>
      <div className="mt-1.5 text-muted-foreground">
        Everything else in this flash is unaffected; those keys keep what
        they have.
      </div>
    </div>
  );
}

export default function FlashDialog({
  open,
  onOpenChange,
  draft,
  onFlash,
  onChanged,
  busy,
  state,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  draft: Draft;
  onFlash: () => Promise<FlashResult>;
  onChanged: () => void;
  busy: boolean;
  state: FlashState;
}) {
  const [running, setRunning] = useState(false);
  // Synchronous guard: state updates are async, two clicks in the same tick
  // must not both pass (double events / double-click).
  const runningRef = useRef(false);
  const st = draft.stats();

  // Single pass over the ops, section order fixed by SECTIONS.
  const groups = (() => {
    const by: Record<string, { o: Op; i: number }[]> = {};
    for (let i = 0; i < draft.ops.length; i++) {
      const o = draft.ops[i];
      const s = opSection(o);
      (by[s] ??= []).push({ o, i });
    }
    return SECTIONS.map((section) => ({ section, rows: by[section] ?? [] })).filter(
      (g) => g.rows.length > 0,
    );
  })();

  async function confirm() {
    if (runningRef.current) return; // double-dispatched clicks must not start two runs
    runningRef.current = true;
    setRunning(true);
    try {
      const res = await onFlash();
      if (res === 'ok') onOpenChange(false); // keep open on cannot-verify/partial/fail
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  // Drop list: while nothing has run yet, a live merge of the refusal
  // ledger + a pure probe of the queued ops; once a flash started, the
  // flash-start snapshot in state takes over (the run self-removes ops and
  // reconciles the queue, so a live re-probe would under-report what the
  // flash carried).
  const drops =
    state.phase === 'idle' || state.drops === undefined
      ? collectDrops(draft)
      : state.drops;

  const status =
    state.phase === 'running'
      ? `Writing ${state.done}/${state.total}…`
      : state.phase === 'ok'
        ? `Done — ${state.total}/${state.total} verified`
        : state.phase === 'cannot-verify'
          ? state.message
          : state.phase === 'partial'
            ? `Partial — ${state.message}`
            : state.phase === 'fail'
              ? `Failed — ${state.message}`
              : null;
  const statusCls =
    state.phase === 'ok'
      ? 'text-[#7ee2a8]'
      : state.phase === 'fail'
        ? 'text-[#ff9d9d]'
        : state.phase === 'partial' || state.phase === 'cannot-verify'
          ? 'text-amber-300'
          : 'text-muted-foreground';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Flash to keyboard</DialogTitle>
        <DialogDescription>
          Preview only — nothing is written until you confirm.
        </DialogDescription>
        <div className="text-sm text-muted-foreground">
          {st.ops} ops · {st.frames} frames · {st.bytes} bytes
        </div>
        <div className="max-h-64 overflow-y-auto rounded-md border border-border">
          {draft.ops.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground">
              Queue is empty.
            </div>
          )}
          {groups.length > 0 && (
            <Accordion
              type="multiple"
              defaultValue={groups.map((g) => g.section)}
            >
              {groups.map((g) => (
                <AccordionItem key={g.section} value={g.section}>
                  <AccordionTrigger>
                    <span className="flex items-center gap-2">
                      {SECTION_LABELS[g.section]}
                      <Badge className="tabular-nums">{g.rows.length}</Badge>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    {g.rows.map(({ o, i }) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 px-3 py-1.5 text-sm"
                      >
                        <span className="text-xs text-muted-foreground w-6">
                          #{i + 1}
                        </span>
                        <span className="flex-1 truncate">{opSummary(o)}</span>
                        <button
                          className="text-muted-foreground hover:text-foreground"
                          title="Remove from queue"
                          onClick={() => {
                            draft.removeAt(i);
                            onChanged();
                          }}
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ))}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </div>
        {status && (
          <div className={`text-sm tabular-nums ${statusCls}`} role="status">
            {status}
          </div>
        )}
        {drops.length > 0 && <DropNotice drops={drops} />}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={draft.size === 0}
            title="Discard the whole queue"
            onClick={() => {
              draft.clear();
              onChanged();
            }}
          >
            Discard all
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={draft.size === 0 || running || busy}
            onClick={confirm}
          >
            {running ? 'Flashing…' : 'Confirm flash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
