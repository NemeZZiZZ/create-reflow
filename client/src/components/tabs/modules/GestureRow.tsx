/* GestureRow (Phase 5b Task 3): one gesture of a module profile.
 *
 * Semantics: the label is the gesture name; the value side is the stored
 * binding (None / mouse / key / motion pair). Locked rows (firmware-driven
 * Touch taps + 1-finger cursor pairs) render inert '<behavior> (firmware)'
 * and are neither selectable nor clearable — the firmware owns them (a
 * written keypress reads back fine and is IGNORED, probed 2026-09-10).
 * Track hold rows are inert 'not settable' (no device field). Live badges
 * come from the hook's read verdicts: 'on device' when the profile
 * content-matches its slot, 'device: X' (decoded bytes) on the rows that
 * drift.
 *
 * Split: axis pairs and the Tune dial get a Split checkbox. Turning it ON
 * seeds each half from the combined code's last two parts and CLEARS the
 * combined code (the halves own the row until unsplit — a stale combined
 * would resurface on close, the capture-rebuild rule). Axes keep the
 * pre-split code in LOCAL state (the open split-set): closing resets the
 * halves to that motion pair (or the table default when the split came
 * from a capture). The dial closes by rebuilding the combined code from
 * the halves ('A - B', minus first).
 *
 * Invert: axis rows only, TRACK profiles only, never while split (a split
 * binds the halves outright — there is nothing left to swap). */

import { useState } from 'react';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { AXIS_HALVES, FIRMWARE_DEFAULTS, splitPair } from '@create-reflow/sdk';
import type { DiffRow, ModuleType, ProfileBinding } from '@create-reflow/sdk';
import type { BindingEdit } from '../../../hooks/useModuleProfiles';
import { describeBinding, driftDeviceLabel, fieldsOfGesture } from './bindings';
import type { GestureRowModel } from './bindings';
import { cn } from '../../../lib/utils';

export interface GestureRowLive {
  /** The profile content-matches its slot — every row reads 'on device'. */
  onDevice: boolean;
  /** Per-gesture first drift row (byte truth from the read verdict). */
  drift: Map<string, DiffRow>;
}

export default function GestureRow({
  row,
  type,
  binding,
  live,
  busy,
  onOpen,
  onSetBinding,
}: {
  row: GestureRowModel;
  type: ModuleType;
  binding: ProfileBinding | undefined;
  live: GestureRowLive;
  /** A read/flash is in flight — the store mutators are gated, so the
   * controls dim instead of silently no-oping. */
  busy: boolean;
  onOpen: (gesture: string, half: '-' | '+' | null) => void;
  onSetBinding: (gesture: string, edit: BindingEdit) => void;
}) {
  // The open split-set: the combined code this session split (null when the
  // split predates the mount — a capture — in which case closing falls back
  // to the axis table's default motion pair).
  const [preSplit, setPreSplit] = useState<string | null>(null);
  const splitOpen = binding?.split !== undefined;
  const half = AXIS_HALVES[type][row.gesture];
  const fields = fieldsOfGesture(type, row.gesture);

  const inert = row.kind === 'locked' || row.kind === 'hold';
  const pairish = row.kind === 'axis' || row.kind === 'pair';
  const showSplit = pairish;
  // Invert ONLY on TRACK axis rows and only while the pair is combined.
  const showInvert = row.kind === 'axis' && type === 'TRACK' && !splitOpen;
  const value = describeBinding(binding);
  const drift = live.drift.get(row.gesture) ?? null;

  function toggleSplit(checked: boolean) {
    if (busy) return;
    if (checked) {
      const baseType = binding?.actionType ?? (half ? 'value' : 'key');
      const combined = binding?.actionCode || half?.default || '';
      const [minus, plus] = splitPair(combined);
      setPreSplit(binding?.actionCode ?? null);
      onSetBinding(row.gesture, {
        actionType: baseType,
        actionCode: '', // combined cleared — the halves own the row
        split: {
          '-': minus !== null ? { actionType: baseType, actionCode: minus } : undefined,
          '+': plus !== null ? { actionType: baseType, actionCode: plus } : undefined,
        },
      });
      return;
    }
    if (half) {
      // Axis close: reset the halves to the motion pair (the remembered
      // pre-split code; the table default when the split came from a read).
      const restore = preSplit ?? half.default;
      onSetBinding(row.gesture, { actionType: 'value', actionCode: restore, split: null, invert: 0 });
    } else {
      // Dial close: rebuild the combined code from the halves ('A - B').
      const minus = binding?.split?.['-']?.actionCode ?? '';
      const plus = binding?.split?.['+']?.actionCode ?? '';
      const code = [minus, plus].filter((s) => s !== '').join(' - ');
      onSetBinding(row.gesture, {
        actionType: code === '' ? 'none' : binding?.actionType === 'none' ? 'key' : binding?.actionType ?? 'key',
        actionCode: code,
        split: null,
      });
    }
    setPreSplit(null);
  }

  function toggleInvert(checked: boolean) {
    if (busy) return;
    const b = binding ?? { actionType: 'value', actionCode: half?.default ?? '' };
    onSetBinding(row.gesture, { ...b, invert: checked ? 1 : 0 });
  }

  const halfDrift = (sign: '-' | '+'): DiffRow | null => {
    if (!splitOpen || drift === null) return null;
    const field = sign === '-' ? fields[0] : fields[1];
    return drift.field === field ? drift : null;
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 py-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn('truncate font-mono text-xs', inert && 'text-muted-foreground opacity-60')}
            title={row.gesture}
          >
            {row.gesture}
          </span>
          {live.onDevice && !drift && <Badge variant="ok">on device</Badge>}
          {drift !== null && !splitOpen && (
            <Badge
              title={`profile wants ${row.gesture} bytes ${drift.want} — the board holds ${drift.got}`}
            >
              device: {driftDeviceLabel(drift)}
            </Badge>
          )}
          {binding !== undefined && !value.writable && <Badge>APP ONLY</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {row.kind === 'locked' && (
            <span className="font-mono text-xs text-muted-foreground">
              {firmwareBehavior(type, row.gesture)}
            </span>
          )}
          {row.kind === 'hold' && (
            <span className="text-xs text-muted-foreground" title="The firmware exposes no hold field for the track buttons">
              not settable
            </span>
          )}
          {showInvert && (
            <label className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
              <Checkbox
                checked={binding?.invert === 1}
                disabled={busy}
                onCheckedChange={(v) => toggleInvert(v === true)}
              />
              Invert
            </label>
          )}
          {showSplit && (
            <label className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
              <Checkbox
                checked={splitOpen}
                disabled={busy}
                onCheckedChange={(v) => toggleSplit(v === true)}
              />
              Split
            </label>
          )}
          {!inert && row.kind === 'field' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="max-w-56 truncate font-mono text-xs"
              title="Edit this binding"
              onClick={() => onOpen(row.gesture, null)}
            >
              {value.label}
            </Button>
          )}
          {!inert && pairish && !splitOpen && (
            <span
              className="max-w-56 truncate font-mono text-xs text-muted-foreground"
              title="A motion pair is edited through Split; Invert swaps its directions"
            >
              {value.label}
            </span>
          )}
        </div>
      </div>
      {splitOpen && (
        <div className="mb-1 ml-5 border-l border-border pl-3">
          {(['-', '+'] as const).map((sign) => {
            const sub = binding?.split?.[sign];
            const subVal = describeBinding(sub);
            const hd = halfDrift(sign);
            return (
              <div key={sign} className="flex items-center justify-between gap-2 py-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {sign === '-' ? '− up/left' : '+ down/right'}
                  </span>
                  {hd !== null && (
                    <Badge title={`profile wants ${hd.want} — the board holds ${hd.got}`}>
                      device: {driftDeviceLabel(hd)}
                    </Badge>
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="max-w-56 truncate font-mono text-xs"
                  title={sub === undefined ? 'Unbound — written empty' : 'Edit this half'}
                  onClick={() => onOpen(row.gesture, sign)}
                >
                  {subVal.label}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The behavior a locked gesture's empty field carries ('M1', 'M2', the
 * cursor motion pairs) — the firmware drives it, never the app. */
function firmwareBehavior(type: ModuleType, gesture: string): string {
  const v = FIRMWARE_DEFAULTS[type]?.[gesture];
  return v !== undefined ? `${v} (firmware)` : '(firmware)';
}
