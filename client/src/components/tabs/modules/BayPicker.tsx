// Per-layer bay picker (Phase 5b Task 4): the six module bay positions
// (touch/track/tune × left/right, KK 0x4A-0x4F) as radio groups, one group
// per bay. Each group offers one radio per compatible profile of that bay's
// module type, `Inherit from base layer` (BAY_INHERIT 0x78 — non-base
// layers only: on layer 0 the option is a mute '—', 0x78 points AT the base
// layer), and `Disabled` (0x00). A live badge names the matched profile +
// slot when a read verdict knows it; a stored pick for a profile that is
// not on the keyboard yet says so — the pick is kept, its write joins after
// the next read.
//
// Picks go through the hook's setBay mutator: the store is the planner's
// source of truth and the hook queues the wire op (queueBayAssignment, a
// plain key op riding the existing executor). The BASE-layer gap warning
// (missingBaseBays) is surfaced under the grid — warning text only, it
// never blocks a flash.
import { useMemo } from 'react';
import { Badge } from '../../ui/badge';
import { Card, CardContent, CardHeader } from '../../ui/card';
import { BAY_POSITIONS, missingBaseBays } from '@create-reflow/sdk';
import type { BayValue, ModuleType } from '@create-reflow/sdk';
import type { useModuleProfiles } from '../../../hooks/useModuleProfiles';

/** The six pickable bays: type → its left/right positions. FLOAT has no
 * bays this phase (missingBaseBays exempts 0x50/0x51 too). */
const BAY_ROWS: { type: ModuleType; pos: number; label: string }[] = (
  ['TOUCH', 'TRACK', 'TUNE'] as const
).flatMap((type) => [
  { type, pos: BAY_POSITIONS[type][0], label: `${type.toLowerCase()} left` },
  { type, pos: BAY_POSITIONS[type][1], label: `${type.toLowerCase()} right` },
]);

export default function BayPicker({
  modules,
  layer,
}: {
  modules: ReturnType<typeof useModuleProfiles>;
  layer: number;
}) {
  const { profiles, bays, live, reading, setBay } = modules;

  // slot → matched profile verdicts, collapsed to one entry per profile id
  // (matched beats nothing: only content-matched slots count as live).
  const liveByProfile = useMemo(() => {
    const out = new Map<string, { slot: number; name: string }>();
    for (const v of Object.values(live)) {
      if (v.matched === null || out.has(v.matched.id)) continue;
      out.set(v.matched.id, { slot: v.slot, name: v.matched.name });
    }
    return out;
  }, [live]);

  // BASE-layer gaps straight from the planner's own detector. A stored
  // profile id means "a module is assigned" — missingBaseBays gap-checks
  // only the unassigned forms (undefined / 'inherit' / 'transparent' / ''),
  // so ids pass through harmlessly.
  const baseGaps = useMemo(() => {
    const base = bays[0];
    if (!base) return missingBaseBays({});
    const row: Record<number, BayValue> = {};
    for (const [pos, pick] of Object.entries(base))
      row[Number(pos)] = pick as BayValue;
    return missingBaseBays(row);
  }, [bays]);

  const radioCls = 'size-3.5 shrink-0 accent-primary';
  const rowCls = 'flex cursor-pointer items-center gap-1.5 text-xs';

  return (
    <Card className="mb-3">
      <CardHeader>
        <div className="text-sm font-semibold">
          Module bays <span className="font-normal text-muted-foreground">· layer {layer}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          Which module profile runs at each bay position on this layer. Writes
          queue like key edits — flash to apply.
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {BAY_ROWS.map((row) => {
            const current = bays[layer]?.[row.pos];
            const pickedProfile =
              current !== undefined && current !== 'inherit' && current !== 'disabled'
                ? profiles.find((p) => p.id === current) ?? null
                : null;
            const liveMatch = pickedProfile ? liveByProfile.get(pickedProfile.id) : undefined;
            return (
              <div key={row.pos} className="rounded-md border border-border p-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-xs font-medium capitalize">{row.label}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    KK 0x{row.pos.toString(16)}
                  </span>
                  <span className="ml-auto shrink-0">
                    {liveMatch && pickedProfile && (
                      <Badge variant="ok" title={`content-matched on the board at slot ${liveMatch.slot}`}>
                        {liveMatch.name} · slot {liveMatch.slot}
                      </Badge>
                    )}
                    {pickedProfile && !liveMatch && (
                      <Badge
                        title="Not on the keyboard yet (or not read this session) — the bay write queues after the next read"
                      >
                        not on device
                      </Badge>
                    )}
                  </span>
                </div>
                <div className="mt-1.5 space-y-1">
                  {profiles
                    .filter((p) => p.type === row.type)
                    .map((p) => (
                      <label key={p.id} className={rowCls}>
                        <input
                          type="radio"
                          className={radioCls}
                          name={`bay-${layer}-${row.pos}`}
                          checked={current === p.id}
                          disabled={reading}
                          onChange={() => setBay(layer, row.pos, p.id)}
                        />
                        <span className="truncate">{p.name}</span>
                      </label>
                    ))}
                  {layer > 0 ? (
                    <label className={rowCls}>
                      <input
                        type="radio"
                        className={radioCls}
                        name={`bay-${layer}-${row.pos}`}
                        checked={current === 'inherit'}
                        disabled={reading}
                        onChange={() => setBay(layer, row.pos, 'inherit')}
                      />
                      <span>Inherit from base layer</span>
                    </label>
                  ) : (
                    <div
                      className="text-[10px] text-muted-foreground"
                      title="Inherit points at the BASE layer — there is nothing to inherit on layer 0"
                    >
                      —
                    </div>
                  )}
                  <label className={rowCls}>
                    <input
                      type="radio"
                      className={radioCls}
                      name={`bay-${layer}-${row.pos}`}
                      checked={current === 'disabled'}
                      disabled={reading}
                      onChange={() => setBay(layer, row.pos, 'disabled')}
                    />
                    <span>Disabled</span>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
        {baseGaps.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/10 p-2.5 text-xs">
            <div className="font-medium text-amber-300">
              base layer bay gaps — those modules run unconfigured until assigned:
            </div>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {baseGaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
