/* Module binding editor (Phase 5b Task 3): None / Mouse M1-M5 / Key via an
 * embedded ActionPalette. Mounted ONCE at the ModulesTab level with
 * controlled state — the ColorDialog pattern (radix Dialog, open +
 * onOpenChange); the target (profile + gesture + optional split half) rides
 * in `target`, null = closed. */

import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../../ui/dialog';
import ActionPalette from '../../ActionPalette';
import { codeFrom, describeBinding, keyActionFilter, pickedIdFor } from './bindings';
import type { ProfileBinding } from '@create-reflow/sdk';

export interface BindingEditorTarget {
  profileId: string;
  gesture: string;
  /** null = the row's own binding; '-' / '+' = one half of an open split. */
  half: '-' | '+' | null;
}

const MOUSE_CODES = ['M1', 'M2', 'M3', 'M4', 'M5'] as const;

export default function ModuleBindingDialog({
  target,
  current,
  onClose,
  onPick,
}: {
  /** null = closed (the ColorDialog controlled-open idiom). */
  target: BindingEditorTarget | null;
  /** The binding the editor started from (the row's, or the half's). */
  current: ProfileBinding | undefined;
  onClose: () => void;
  /** Uniform pick: actionType 'none' clears (a half pick clears to the
   * unbound half — it writes empty on the wire, same as 'none'). */
  onPick: (pick: { actionType: string; actionCode: string }) => void;
}) {
  const open = target !== null;
  const cur = describeBinding(current);
  const isKey = current !== undefined && ['key', 'modifier'].includes(current.actionType);
  const mouseAt = current?.actionType === 'mouse' ? current.actionCode : null;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogTitle>
          Bind {target?.gesture ?? ''}
          {target?.half != null && (
            <span className="text-muted-foreground">
              {target.half === '-' ? ' — minus half (up / left)' : ' — plus half (down / right)'}
            </span>
          )}
        </DialogTitle>
        <DialogDescription>
          Currently: <span className="font-mono">{cur.label}</span>. Modules store one keypress
          or one mouse button per field — None unbinds, Mouse picks a button, Key opens the
          action palette.
        </DialogDescription>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant={current?.actionType === 'none' || current === undefined ? 'default' : 'outline'}
            size="sm"
            onClick={() => onPick({ actionType: 'none', actionCode: '' })}
          >
            None
          </Button>
          <span className="ml-2 text-xs font-medium text-muted-foreground">Mouse</span>
          {MOUSE_CODES.map((m) => (
            <Button
              key={m}
              variant={mouseAt === m ? 'default' : 'outline'}
              size="sm"
              className="w-12"
              onClick={() => onPick({ actionType: 'mouse', actionCode: m })}
            >
              {m}
            </Button>
          ))}
        </div>

        <div className="text-xs font-medium text-muted-foreground">Key</div>
        <ActionPalette
          filter={keyActionFilter}
          pickedId={isKey ? pickedIdFor(current?.actionCode) : null}
          onPick={(a) => {
            const c = codeFrom(a);
            if (c !== null) onPick(c);
          }}
        />

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
