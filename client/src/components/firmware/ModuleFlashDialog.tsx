/* Module firmware dialog — spec §9 surface 3. Presentation only: the
 * procedure lives in useFirmwareFlash.startModule (startModuleRun), the
 * bundle selection in lib/firmware-plan.resolveModulePlan, the gate in
 * lib/firmware-interlocks. The dialog renders what those answer and gates
 * its Start button on the same preconditions the procedure enforces (a
 * refused click would only burn a run).
 *
 * Structure: three STATIC rows (left half — plugged in; module — docked in
 * the left bay; right half — unplugged) with the live snapshot state as
 * chips → the blockers list → version select (bundles a keyboard too old
 * for are disabled, `needs keyboard X or newer`) → force-type selector
 * (NO default — "the wrong type gives it the wrong app") → downgrade
 * consent → expectations → live timeline (the replug prompt is the
 * dialog's largest words while it is the newest event) → verdict panel
 * with JSONL export. The modal is non-dismissable while a run is in
 * flight. */

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import FlashTimeline, { currentAction, currentLabel, stepRows } from './FlashTimeline';
import type { FwCatalog, FwEntry } from '../../lib/firmware-catalog';
import { moduleBundles, stripNayaLeadingZero } from '../../lib/firmware-plan';
import type { Vault } from '../../lib/firmware-fetch';
import type { HalfSnapshot } from '@create-reflow/sdk';
import type { FlashRunStatus, ModuleForceType, StartModuleOpts } from '../../hooks/useFirmwareFlash';
import { FWUP_TYPES } from '../../hooks/useFirmwareFlash';
import type { FirmwareRunLog, RunEvent } from '../../lib/firmware-run-log';
import { cn } from '../../lib/utils';

/* The hook subset the dialog drives (App holds the useFirmwareFlash return;
 * the FirmwareTab passes it through). */
export interface ModuleFlash {
  status: FlashRunStatus;
  events: readonly RunEvent[];
  log: FirmwareRunLog | null;
  startModule: (opts: StartModuleOpts) => Promise<void>;
  exportLog: () => void;
}

/* HalfSnapshot.fw ('v0.3.41.0' Naya form, live-proven 2026-10-13) → a
 * comparable dot-version string ('3.41.0'), null when unreadable
 * (display-side only — the authoritative checks happen in the
 * procedure). */
function kbVersionOf(fw: string): string | null {
  const t = (fw.split('  [')[0] ?? '').trim();
  if (t === '' || t === '—') return null;
  const raw = t.startsWith('v') ? t.slice(1) : t;
  if (!/^\d+(\.\d+)*$/.test(raw)) return null;
  return stripNayaLeadingZero(raw);
}

function tupleOf(v: string): number[] | null {
  const s = stripNayaLeadingZero(v);
  return /^\d+(\.\d+)*$/.test(s) ? s.split('.').map((p) => Number.parseInt(p, 10)) : null;
}

function tupleAtLeast(a: number[], b: number[]): boolean {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

const FORCE_TYPES: readonly ModuleForceType[] = ['Touch', 'Tune', 'Track'];

export default function ModuleFlashDialog({
  open,
  onOpenChange,
  catalog,
  left,
  right,
  vault,
  flash,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  catalog: FwCatalog | null;
  left: HalfSnapshot;
  right: HalfSnapshot;
  vault: Vault;
  flash: ModuleFlash;
}) {
  const running = flash.status === 'running';
  const bundles = catalog !== null ? moduleBundles(catalog) : [];
  const kbTuple = tupleOf(kbVersionOf(left.fw) ?? '');
  const [pickedLabel, setLabel] = useState<string | null>(null);
  const [forceType, setForceType] = useState<ModuleForceType | null>(null);
  const [allowOlder, setAllowOlder] = useState(false);

  // Effective selection: the newest bundle this keyboard can take until
  // the user picks one (a pick that disappeared falls back the same way).
  const bundleEnabled = (keyboardFrom: string | null): boolean => {
    if (keyboardFrom === null) return true;
    const t = tupleOf(keyboardFrom);
    return kbTuple !== null && t !== null && tupleAtLeast(kbTuple, t);
  };
  const autoLabel = bundles.find((b) => bundleEnabled(b.keyboardFrom))?.label ?? null;
  const label =
    pickedLabel !== null && bundles.some((b) => b.label === pickedLabel)
      ? pickedLabel
      : autoLabel;
  const picked = bundles.find((b) => b.label === label) ?? null;
  const entry: FwEntry | null = picked?.entry ?? null;
  const kbFrom = picked?.keyboardFrom ?? null;
  const bundleNewer = kbFrom !== null && (kbTuple === null || !bundleEnabled(kbFrom));

  const dockedType = left.modPresent ? left.modType : 'none';
  /* Dock-reported module fw ('v0.2.3.3' Naya form) → catalog form ('2.3.3')
   * for display; the raw value never compares (dockTuple strips too). */
  const shownModFw =
    left.modFw !== null ? stripNayaLeadingZero(left.modFw.replace(/^v/, '')) : null;
  const typeUnknown = dockedType !== 'Touch' && dockedType !== 'Track' && dockedType !== 'Tune';
  const inVault = entry !== null && vault.has(entry.blobSha256);
  const target = label;
  // Display-side downgrade read: the dock-reported module fw (trailing
  // zeros tolerated) vs the target — the authoritative one runs in the
  // procedure on fresh dock reads.
  const dockTuple = tupleOf((left.modFw ?? '').replace(/^v/, ''));
  const tgtTuple = tupleOf(target ?? '');
  const downgrade =
    dockTuple !== null && tgtTuple !== null && !tupleAtLeast(tgtTuple, dockTuple);

  const blockers: string[] = [];
  if (!left.connected) blockers.push('the left half is not connected');
  if (right.connected) blockers.push('the right half is connected — unplug it');
  if (!left.modPresent) blockers.push('no module is docked — dock it in the left bay');
  else if (typeUnknown && forceType === null) {
    blockers.push('the module type is unknown — pick a Force type (the wrong type gives it the wrong app)');
  }
  if (label === null) blockers.push('no flashable module bundle in the catalog');
  if (bundleNewer && kbFrom !== null) {
    blockers.push(`the ${label} bundle needs keyboard ${kbFrom} or newer — update the keyboard first`);
  }
  if (entry !== null && !inVault) blockers.push(`the ${label} bundle is not downloaded yet`);
  if (downgrade && !allowOlder) blockers.push(`this is a downgrade from ${shownModFw ?? 'the running version'} — consent required`);

  const canStart = blockers.length === 0 && !running && target !== null;

  function closeDialog(): void {
    setForceType(null);
    setAllowOlder(false);
    onOpenChange(false);
  }

  async function start(): Promise<void> {
    if (!canStart || target === null) return;
    await flash.startModule({
      label: target,
      ...(forceType !== null ? { forceType } : {}),
      allowOlder,
    });
  }

  const rows = stepRows(flash.events);
  // The replug prompt is THE headline while it is the newest event — the
  // dialog's largest words (currentAction clears it the moment any step
  // reports after it).
  const actionLive = running ? currentAction(flash.events) : null;
  const headline = currentLabel(rows);
  const endEv =
    flash.log !== null
      ? flash.log.events.find((e) => e.step === 'run.end')
      : undefined;
  const verdict =
    endEv !== undefined
      ? {
          ok: endEv.ok === true,
          summary: typeof endEv.summary === 'string' ? endEv.summary : '',
          failures: (endEv.failures as string[] | undefined) ?? [],
          advisories: (endEv.advisories as string[] | undefined) ?? [],
        }
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (running) return; // non-dismissable while a run is in flight
        if (v) onOpenChange(true);
        else closeDialog();
      }}
    >
      <DialogContent
        className={cn('max-w-xl', running && '[&>button]:hidden')}
        onEscapeKeyDown={(e) => {
          if (running) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (running) e.preventDefault();
        }}
      >
        <DialogTitle>Module firmware</DialogTitle>
        <DialogDescription>
          {running
            ? 'A module update is running — leave it alone until it reports finished.'
            : 'The module programs itself from a bundle stored on its flash; everything is hash-checked first.'}
        </DialogDescription>

        {!running && (
          <>
            <div className="rounded-lg border border-border text-[13px]">
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <span>
                  <span className="font-medium">Left half</span>
                  <span className="text-muted-foreground"> — plugged into USB, running the app</span>
                </span>
                <Badge variant={left.connected ? 'ok' : 'bad'}>
                  {left.connected ? `connected · ${kbVersionOf(left.fw) ?? left.fw}` : 'not connected'}
                </Badge>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                <span>
                  <span className="font-medium">Module</span>
                  <span className="text-muted-foreground"> — docked in the left bay</span>
                </span>
                <Badge variant={left.modPresent ? 'ok' : 'bad'}>
                  {left.modPresent
                    ? `docked · ${dockedType}${shownModFw !== null ? ` · fw ${shownModFw}` : ''}`
                    : 'nothing docked'}
                </Badge>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                <span>
                  <span className="font-medium">Right half</span>
                  <span className="text-muted-foreground"> — unplug it</span>
                </span>
                <Badge variant={right.connected ? 'bad' : 'ok'}>
                  {right.connected ? 'still connected' : 'unplugged'}
                </Badge>
              </div>
            </div>

            {blockers.length > 0 && (
              <div className="rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-[13px]">
                <div className="font-medium text-amber-300">Not ready</div>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                  {blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center gap-2">
              <select
                value={label ?? ''}
                onChange={(e) => setLabel(e.target.value)}
                className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 text-sm"
                aria-label="Target module bundle version"
              >
                {bundles.map((b) => {
                  const enabled = bundleEnabled(b.keyboardFrom);
                  return (
                    <option key={b.label} value={b.label} disabled={!enabled}>
                      {b.label}
                      {!enabled && b.keyboardFrom !== null ? ` · needs keyboard ${b.keyboardFrom} or newer` : ''}
                    </option>
                  );
                })}
              </select>
              <select
                value={forceType ?? ''}
                onChange={(e) => setForceType(e.target.value === '' ? null : (e.target.value as ModuleForceType))}
                className="rounded border bg-background px-2 py-1.5 text-sm"
                aria-label="Force module type"
              >
                <option value="">Force type…</option>
                {FORCE_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            {forceType !== null && (
              <p className="text-[13px] text-amber-300" role="note">
                Forcing {forceType} (code {FWUP_TYPES[forceType]}) — the wrong type gives the module the wrong app.
              </p>
            )}

            {downgrade && (
              <div className="flex items-start gap-2.5 rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-[13px]">
                <Checkbox className="mt-0.5" checked={allowOlder} onCheckedChange={(v) => setAllowOlder(v === true)} />
                <div>
                  <div className="font-medium text-amber-300">This is a downgrade</div>
                  <div className="text-muted-foreground">
                    The dock reports {left.modFw ?? 'a newer version'} — install the older {label} anyway.
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-md border border-border p-3 text-[13px] text-muted-foreground">
              <div className="font-medium text-foreground">What to expect</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                <li>Keep the module docked the whole time. The run takes about 3–6 minutes.</li>
                <li>The left half reboots twice — once for the bundle, once when the module programs itself.</li>
                <li>The module&apos;s lights go out for 10–15 seconds while it programs; the keyboard restarts about half a minute later.</li>
                <li>If the half does not come back on its own, the app will ask you to replug it — that is not a power cycle.</li>
              </ul>
            </div>
          </>
        )}

        {(running || flash.events.length > 0) && (
          <div className="rounded-md border border-border p-3">
            {actionLive !== null ? (
              <p className="text-lg font-semibold leading-snug text-amber-300" role="status">
                {actionLive}
              </p>
            ) : (
              <div className="mb-2 text-[13px]">
                {headline !== '' ? (
                  <span className="font-medium" role="status">{headline}</span>
                ) : (
                  <span className="text-muted-foreground">Timeline</span>
                )}
              </div>
            )}
            <FlashTimeline events={flash.events} />
          </div>
        )}

        {verdict !== null && (
          <div
            className={cn(
              'rounded-md border p-3 text-[13px]',
              verdict.ok
                ? 'border-[#7ee2a8]/30 bg-[#1a472a]/40'
                : 'border-[#ff9d9d]/30 bg-[#5c1a1a]/40',
            )}
          >
            <div className="flex items-center gap-2">
              <Badge variant={verdict.ok ? 'ok' : 'bad'}>{verdict.ok ? 'Finished' : 'Failed'}</Badge>
              <span>{verdict.summary}</span>
            </div>
            {verdict.failures.length > 0 && (
              <div className="mt-2">
                <div className="font-medium text-[#ff9d9d]">Failures</div>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
                  {verdict.failures.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}
            {verdict.advisories.length > 0 && (
              <div className="mt-2">
                <div className="font-medium text-amber-300">Advisories</div>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
                  {verdict.advisories.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            {flash.log !== null && (
              <div className="mt-2 flex items-center gap-2 text-muted-foreground">
                <span>
                  Saved as {flash.log.id}. Keep it if anything looked wrong.
                </span>
                <Button size="sm" variant="outline" className="ml-auto" onClick={flash.exportLog}>
                  Export log
                </Button>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={running} onClick={closeDialog}>
            {running ? 'Running…' : 'Close'}
          </Button>
          {!running && (
            <Button
              variant={forceType !== null ? 'destructive' : 'default'}
              disabled={!canStart}
              title={canStart ? `Run the module update (${target})` : blockers[0] ?? ''}
              onClick={() => void start()}
            >
              {forceType !== null ? `Force ${forceType} update` : `Update ${target ?? 'module'}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
