/* Keyboard firmware flash dialog — spec §9 surface 2. Presentation only:
 * the procedure lives in useFirmwareFlash.startKeyboard; the plan flags in
 * lib/firmware-plan; the gate in lib/firmware-interlocks. This file renders
 * what those answer and gates its Start button on the same rules the gate
 * enforces (a refused click would only burn a run).
 *
 * Structure: version select (declared vs no-number labels) → per-half
 * checkbox rows (current → target, (already on it)/(older) suffixes, file
 * column only when an image resolves) → download notice (fetchable =
 * button; else the catalog records no source) → undock + unknown-current
 * consent + downgrade states → expectations block → live timeline (action
 * prompts replace the headline) → verdict panel with JSONL export. The
 * modal is non-dismissable while a run is in flight.
 *
 * The device-string → catalog-label alignment (fwLabelOf) is display-side
 * only: the authoritative current-version classification happens inside the
 * procedure, by slot-0 hash against the catalog's plaintext hashes. */

import { useEffect, useRef, useState } from 'react';
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
import type { FwCatalog } from '../../lib/firmware-catalog';
import { keyboardVersions } from '../../lib/firmware-catalog';
import { fetchVersion } from '../../lib/firmware-fetch';
import type { Vault } from '../../lib/firmware-fetch';
import { resolveKeyboardPlan } from '../../lib/firmware-plan';
import type { HalfPlan } from '../../lib/firmware-plan';
import type { SerialWorld } from '../../lib/serial-world';
import { NAYA_VID, pidInfo } from '../../lib/firmware-plat';
import type { HalfSnapshot, Side } from '@create-reflow/sdk';
import type { FlashRunStatus, StartKeyboardOpts } from '../../hooks/useFirmwareFlash';
import type { FirmwareRunLog, RunEvent } from '../../lib/firmware-run-log';
import { cn } from '../../lib/utils';

/* The hook subset the dialog drives (App holds the useFirmwareFlash return;
 * the FirmwareTab passes it through). */
export interface KeyboardFlash {
  status: FlashRunStatus;
  events: readonly RunEvent[];
  log: FirmwareRunLog | null;
  startKeyboard: (opts: StartKeyboardOpts) => Promise<void>;
  exportLog: () => void;
}

/* HalfSnapshot.fw ('v3.41.0.0') → the catalog label that matches it
 * ('3.41.0'). Device strings carry one more all-zero component than the
 * catalog labels, so exact string equality never matches: align by
 * trailing-zero-insensitive tuple compare against the catalog's declared
 * keyboard labels; no hit → the raw string back (the plan reads it as
 * unknown-current — which it honestly is). '—'/unparseable → null. */
function fwLabelOf(fw: string, declared: string[]): string | null {
  const t = (fw.split('  [')[0] ?? '').trim();
  if (t === '' || t === '—') return null;
  const raw = t.startsWith('v') ? t.slice(1) : t;
  const tuple = (s: string): number[] | null =>
    /^\d+(\.\d+)*$/.test(s) ? s.split('.').map((p) => Number.parseInt(p, 10)) : null;
  const cur = tuple(raw);
  if (cur === null) return null;
  for (const d of declared) {
    const dt = tuple(d);
    if (dt === null) continue;
    const len = Math.max(cur.length, dt.length);
    const eq = Array.from({ length: len }, (_, i) => (cur[i] ?? 0) === (dt[i] ?? 0)).every(Boolean);
    if (eq) return d;
  }
  return raw;
}

const SIDES: readonly Side[] = ['left', 'right'];

export default function KeyboardFlashDialog({
  open,
  onOpenChange,
  catalog,
  halves,
  world,
  vault,
  flash,
  grant,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  catalog: FwCatalog | null;
  halves: Record<Side, HalfSnapshot>;
  world: SerialWorld;
  vault: Vault;
  flash: KeyboardFlash;
  grant: { open: boolean; onGrant: () => Promise<void> };
}) {
  const running = flash.status === 'running';
  const versions = catalog !== null ? keyboardVersions(catalog) : [];
  const [pickedLabel, setLabel] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<Side, boolean>>({ left: true, right: true });
  const [allowOlder, setAllowOlder] = useState(false);
  const [consent, setConsent] = useState(false);
  const [pids, setPids] = useState<Record<Side, number | null>>({ left: null, right: null });
  const [dl, setDl] = useState<'idle' | 'fetching' | 'done' | 'failed'>('idle');
  const [dlNote, setDlNote] = useState<string | null>(null);
  // Download token: a fetch that completes after the user switched versions
  // must not stamp its result onto the new selection (its verified bytes
  // still land in the vault — only the notice is dropped).
  const dlToken = useRef(0);

  // Effective selection: the newest catalog version until the user picks one
  // (a stale pick that no longer exists falls back the same way) — derived,
  // so no effect needs to sync it.
  const label =
    pickedLabel !== null && versions.some((v) => v.label === pickedLabel)
      ? pickedLabel
      : (versions[0]?.label ?? null);

  // A different target invalidates the per-attempt consents — event-driven
  // (select onChange), never a standing approval across versions.
  function pickLabel(v: string): void {
    if (v === label) return;
    dlToken.current++;
    setLabel(v);
    setConsent(false);
    setAllowOlder(false);
    setDl('idle');
    setDlNote(null);
  }

  // Closing the dialog un-answers every per-attempt consent: a backed-out
  // session must never reopen with "there is no way back" pre-answered (or
  // with a stale download notice). Event-driven — all close paths (Close
  // button, X, Escape, outside click) funnel through here.
  function closeDialog(): void {
    setConsent(false);
    setAllowOlder(false);
    setDl('idle');
    setDlNote(null);
    onOpenChange(false);
  }

  // Per-half PID (→ generation) comes from the granted app-mode ports while
  // they still speak app mode. Re-listed when the dialog opens or a half's
  // connection flips; a failed listing leaves nulls (the row then reports
  // "no image for this half+generation" rather than guessing).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void world
      .getPorts()
      .then((ports) => {
        if (cancelled) return;
        const next: Record<Side, number | null> = { left: null, right: null };
        for (const p of ports) {
          try {
            const i = p.getInfo?.();
            if (i?.usbProductId === undefined) continue;
            if (i.usbVendorId !== undefined && i.usbVendorId !== NAYA_VID) continue;
            const info = pidInfo(i.usbProductId);
            if (info === null || info.mode !== 'app') continue;
            if (next[info.side] === null) next[info.side] = i.usbProductId;
          } catch {
            /* unidentifiable port — skip */
          }
        }
        setPids(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, world, halves.left.connected, halves.right.connected]);

  // The display plan: what would be written where, per half, right now.
  const declared = new Set<string>();
  if (catalog !== null) {
    for (const e of catalog.images) {
      if (e.target === 'keyboard' && typeof e.createFirmware === 'string') declared.add(e.createFirmware);
    }
  }
  const plan =
    catalog !== null && label !== null
      ? resolveKeyboardPlan(
          catalog,
          SIDES.map((side) => ({
            side,
            pid: pids[side],
            fw: fwLabelOf(halves[side].fw, [...declared]),
          })),
          vault,
          label,
        ).halves
      : null;
  const planBySide = new Map<Side, HalfPlan>(plan?.map((h) => [h.side, h]));

  // A half counts as chosen only when its checkbox is checked AND its plan
  // resolves to an image: a checkbox disabled for "no image for this
  // half+generation" (unidentified half, gen without a catalog row) never
  // becomes a target — the procedure supports target subsets, so flashing
  // exactly the one attached half stays reachable.
  const chosen = (side: Side): boolean => {
    const h = planBySide.get(side);
    return pick[side] && h !== undefined && h.image !== null;
  };
  const selected = plan?.filter((h) => chosen(h.side)) ?? [];
  const missing =
    label !== null &&
    selected.length > 0 &&
    selected.some((h) => h.image !== null && !vault.has(h.image.blobSha256));
  // Whether the catalog records any fetchable source under this label at
  // all — the download notice is a button when yes, and "no record of
  // where to fetch it" when no.
  const labelFetchable =
    catalog !== null &&
    label !== null &&
    catalog.images.some(
      (e) =>
        e.target === 'keyboard' &&
        (e.createFirmware ?? e.versionLabel) === label &&
        typeof e.historyPath === 'string' &&
        e.historyPath !== '',
    );
  const anyUnknown = selected.some((h) => h.unknownCurrent);
  const anyDowngrade = selected.some((h) => h.downgrade);
  const anyDocked = halves.left.modPresent || halves.right.modPresent;
  const disconnected = selected.filter((h) => !halves[h.side].connected);
  const connectedSel = selected.length > 0 && disconnected.length === 0;

  const canStart =
    catalog !== null &&
    label !== null &&
    selected.length > 0 &&
    connectedSel &&
    selected.every((h) => h.image !== null && vault.has(h.image.blobSha256)) &&
    !(anyUnknown && !consent) &&
    !(anyDowngrade && !allowOlder) &&
    !running;

  const startTitle = !connectedSel
    ? `Connect the ${disconnected.map((h) => h.side).join(' and ')} half${disconnected.length === 1 ? '' : 's'} first`
    : missing
      ? 'Download the selected version first'
      : anyUnknown && !consent
        ? 'Consent is required for an unknown running version'
        : anyDowngrade && !allowOlder
          ? 'Downgrades need the older-version consent'
          : 'Run the keyboard flash procedure';

  async function downloadSelected(): Promise<void> {
    if (catalog === null || label === null) return;
    const want = label;
    const token = ++dlToken.current;
    setDl('fetching');
    setDlNote(null);
    const r = await fetchVersion(catalog, want, vault, {
      onOne: (one) => {
        if (one.ok) return;
        setDlNote(one.reason ?? 'fetch failed');
      },
    });
    if (dlToken.current !== token) return; // superseded — the vault keeps the verified bytes
    setDl(r.failed.length === 0 ? 'done' : 'failed');
    if (r.failed.length === 0) setDlNote(`${r.fetched} image${r.fetched === 1 ? '' : 's'} fetched, sha256 verified`);
  }

  async function start(): Promise<void> {
    if (!canStart || label === null) return;
    await flash.startKeyboard({
      targets: selected.map((h) => ({ side: h.side, label })),
      allowOlder,
      acceptUnknown: true,
      consentedUnknown: consent,
    });
  }

  const rows = stepRows(flash.events);
  // The headline: the current step, replaced by the action prompt only
  // while that prompt is the newest event (currentAction resolves it the
  // moment any step reports after it).
  const actionLive = running ? currentAction(flash.events) : null;
  const headline = actionLive ?? currentLabel(rows);
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
        <DialogTitle>Keyboard firmware</DialogTitle>
        <DialogDescription>
          {running
            ? 'A flash is running — leave it alone until it reports finished.'
            : 'Versions come from the catalog; the procedure hash-checks everything it writes.'}
        </DialogDescription>

        {!running && (
          <>
            <div className="flex items-center gap-2">
              <select
                value={label ?? ''}
                onChange={(e) => pickLabel(e.target.value)}
                className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 text-sm"
                aria-label="Target firmware version"
              >
                {versions.map((v) => (
                  <option key={v.label} value={v.label}>
                    {v.declared
                      ? `${v.label}${v.bundle !== undefined ? ` · shipped in ${v.bundle}` : ''}`
                      : `${v.label} · no version number declared`}
                  </option>
                ))}
              </select>
            </div>

            <div className="rounded-lg border border-border">
              {SIDES.map((side, idx) => {
                const h = planBySide.get(side);
                const cur = h?.currentVersion;
                return (
                  <div
                    key={side}
                    className={cn(
                      'flex items-start gap-2.5 px-3 py-2',
                      idx > 0 && 'border-t border-border',
                    )}
                  >
                    <Checkbox
                      className="mt-0.5"
                      // Reflects the EFFECTIVE choice: an unusable half is
                      // disabled and shows unchecked, even though the stored
                      // pick survives (it re-applies automatically if a
                      // version with an image for this half is selected).
                      checked={chosen(side)}
                      disabled={running || h === undefined || h.image === null}
                      onCheckedChange={(v) => setPick((p) => ({ ...p, [side]: v === true }))}
                      aria-label={`Flash the ${side} half`}
                    />
                    <div className="min-w-0 flex-1 text-[13px]">
                      <div>
                        <span className="font-medium capitalize">{side} half</span>
                        <span className="text-muted-foreground">
                          {' '}
                          {cur !== null && cur !== undefined
                            ? `${cur} → ${label ?? ''}`
                            : `→ ${label ?? ''}`}
                        </span>
                        {h?.unchanged === true && (
                          <span className="text-muted-foreground"> (already on it)</span>
                        )}
                        {h?.downgrade === true && (
                          <span className="text-[#ff9d9d]"> (older)</span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {h?.image !== null && h?.image !== undefined ? (
                          <>
                            file <span className="font-mono">{h.image.file}</span>
                            {h.present ? ' · in the vault' : h.fetchable ? '' : ' · no record of where to fetch it'}
                            {h.generation !== null && ` · gen ${h.generation}`}
                          </>
                        ) : (
                          (h?.reason ?? 'half not identified — connect it and reopen')
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {missing && dl !== 'fetching' && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3 text-[13px]">
                <span className="text-muted-foreground">
                  {!labelFetchable
                    ? 'The catalog records no place to fetch this version from.'
                    : `The ${label} images are not downloaded yet.`}
                </span>
                {labelFetchable && (
                  <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void downloadSelected()}>
                    Download {label}
                  </Button>
                )}
              </div>
            )}
            {dl === 'fetching' && (
              <p className="text-[13px] text-muted-foreground" role="status">
                Fetching {label}…{dlNote !== null ? ` last issue: ${dlNote}` : ''}
              </p>
            )}
            {(dl === 'done' || dl === 'failed') && dlNote !== null && (
              <p className={cn('text-[13px]', dl === 'done' ? 'text-[#7ee2a8]' : 'text-[#ff9d9d]')} role="status">
                {dlNote}
              </p>
            )}

            {anyDocked && (
              <div className="rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-[13px]">
                <div className="font-medium text-amber-300">A module is docked</div>
                <div className="text-muted-foreground">
                  Undock it before flashing the keyboard — the procedure refuses
                  to start while a module is docked.
                </div>
              </div>
            )}

            {anyUnknown && (
              <div className="flex items-start gap-2.5 rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-[13px]">
                <Checkbox className="mt-0.5" checked={consent} onCheckedChange={(v) => setConsent(v === true)} />
                <div>
                  <div className="font-medium text-amber-300">Unknown running version</div>
                  <div className="text-muted-foreground">
                    At least one half runs firmware the catalog does not know.
                    I understand, replace it with {label} — there is no way back
                    to the current image.
                  </div>
                </div>
              </div>
            )}

            {anyDowngrade && (
              <div className="flex items-start gap-2.5 rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-[13px]">
                <Checkbox className="mt-0.5" checked={allowOlder} onCheckedChange={(v) => setAllowOlder(v === true)} />
                <div>
                  <div className="font-medium text-amber-300">This is a downgrade</div>
                  <div className="text-muted-foreground">
                    At least one selected half runs a newer version than {label}.
                    Install the older version anyway.
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-md border border-border p-3 text-[13px] text-muted-foreground">
              <div className="font-medium text-foreground">What to expect</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                <li>Each flashed half reboots — it goes dark and drops off USB, then re-appears as a bootloader device.</li>
                <li>The erase and the swap can look like hangs for a few minutes. They are not.</li>
                <li className="font-medium text-foreground">Do not unplug the keyboard until the run reports finished.</li>
                <li>The halves come back on their own; the app reconnects them afterwards.</li>
              </ul>
            </div>
          </>
        )}

        {(running || flash.events.length > 0) && (
          <div className="rounded-md border border-border p-3">
            <div className="mb-2 text-[13px]">
              {headline !== '' ? (
                <span className={cn('font-medium', actionLive !== null && 'text-amber-300')} role="status">
                  {headline}
                </span>
              ) : (
                <span className="text-muted-foreground">Timeline</span>
              )}
            </div>
            <FlashTimeline events={flash.events} />
            {grant.open && running && (
              <div className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/10 p-3">
                <div className="text-[13px] text-muted-foreground">
                  The half did not re-appear on its own — pick it in the browser
                  prompt once it shows up.
                </div>
                <Button size="sm" className="mt-2" onClick={() => void grant.onGrant()}>
                  Grant the bootloader port
                </Button>
              </div>
            )}
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
              variant={anyDowngrade ? 'destructive' : 'default'}
              disabled={!canStart}
              title={startTitle}
              onClick={() => void start()}
            >
              {anyDowngrade ? `Downgrade ${label ?? ''}` : `Flash ${label ?? ''}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
