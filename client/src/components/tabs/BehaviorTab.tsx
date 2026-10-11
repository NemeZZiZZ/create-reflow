// Behavior tab: Typing / Power / LED settings form (Task 4.2).
//
// Typing: Interrupt Flavor (App-lifted state) rides inside every hold-tap
// record — written on the next behavior write (queueBehaviorSet → t10
// builders), never as a standalone op. Tapping Term is an independent
// slider (10-1000ms) lifted to App — Task 2.2's queueBehaviorSet call
// receives it.
// Power: Idle/Sleep/Deep timeout sliders (0-6000s; 0 = off, 30 s device
// floor enforced by timeoutsPayload). Current values load live via fe/100b
// on mount (left half only); Apply queues one fe/100a op with all three
// values. (Replaces the old Settings dialog.) Host OS below the timeouts:
// an explicit Windows/macOS/Unset select that mirrors the QUEUED fe/1005
// op — picking a value queues hostOsOp, Unset removes it; the device
// never reports host OS back and its ACK shape is unproven (noted in UI).
// LED: Max Brightness / Scan Mode / Action Override queue ED ops on change.
// The device reports none of these back — the queue shows what will be sent.
import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import type { Draft, SettingsOp } from '@create-reflow/sdk';
import { timeoutsPayload } from '@create-reflow/sdk';
import { FLAVORS, flavorById } from '@create-reflow/sdk';
import type { FlavorId } from '@create-reflow/sdk';
import { ledOverrideOp, maxBrtOp, scanModeOp } from '@create-reflow/sdk';
import { hostOsOp, HOST_OS } from '@create-reflow/sdk';
import { queueSetting } from '@create-reflow/sdk';
import type { LogFn } from '../../hooks/useLog';
import { cn } from '../../lib/utils';

export interface TimeoutVals {
  idleMs: number;
  sleepMs: number;
  deepMs: number;
}

// Factory timeouts (see timeoutsMs) shown until a live read lands.
const FACTORY = { idleMs: 90_000, sleepMs: 300_000, deepMs: 30_000 };

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2 tabular-nums">{children}</div>
    </div>
  );
}

export default function BehaviorTab({
  flavor,
  onFlavor,
  tappingTerm,
  onTappingTerm,
  leftOn,
  loadTimeouts,
  draftRef,
  bumpDraft,
  log,
}: {
  flavor: FlavorId;
  onFlavor: (id: FlavorId) => void;
  tappingTerm: number;
  onTappingTerm: (ms: number) => void;
  leftOn: boolean;
  loadTimeouts: () => Promise<TimeoutVals | null>;
  draftRef: { current: Draft };
  bumpDraft: () => void;
  log: LogFn;
}) {
  const [idleS, setIdleS] = useState(FACTORY.idleMs / 1000);
  const [sleepS, setSleepS] = useState(FACTORY.sleepMs / 1000);
  const [deepS, setDeepS] = useState(FACTORY.deepMs / 1000);
  const [liveTimeouts, setLiveTimeouts] = useState(false);
  const [maxBrt, setMaxBrt] = useState(100);
  const [scanMode, setScanMode] = useState(true);
  const [override, setOverride] = useState(0);

  // Current timeouts load live (left half only); factory values until then.
  // `liveTimeouts` latches on a successful read; the render derives whether
  // the shown values are live so the effect never sets state synchronously.
  useEffect(() => {
    if (!leftOn) return;
    let cancelled = false;
    void loadTimeouts().then((t) => {
      if (cancelled || !t) return;
      setIdleS(Math.round(t.idleMs / 1000));
      setSleepS(Math.round(t.sleepMs / 1000));
      setDeepS(Math.round(t.deepMs / 1000));
      setLiveTimeouts(true);
    });
    return () => {
      cancelled = true;
    };
  }, [leftOn, loadTimeouts]);
  const showingLive = leftOn && liveTimeouts;

  // Host OS select mirrors the QUEUED state: the draft's fe/1005 settings
  // op is the only source (the device never reports host OS back). At most
  // one lives in the draft — pushHostOs keeps that invariant.
  const queuedHostOs = draftRef.current.ops.find(
    (o): o is SettingsOp => o.kind === 'settings' && o.path === 'fe/1005',
  );
  const hostOsValue =
    queuedHostOs && queuedHostOs.payload.length > 0 ? String(queuedHostOs.payload[0]) : '';

  function pickFlavor(id: FlavorId) {
    onFlavor(id);
    log('inf', `interrupt flavor → ${flavorById(id)?.name} (rides inside every hold-tap record — applied on the next behavior write)`);
  }

  function applyTimeouts() {
    let payload: Uint8Array;
    try {
      payload = timeoutsPayload(idleS * 1000, sleepS * 1000, deepS * 1000);
    } catch (e) {
      log('err', `timeouts: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    queueSetting(draftRef.current, {
      kind: 'settings',
      path: 'fe/100a',
      payload,
      label: `timeouts idle ${idleS}s sleep ${sleepS}s deep ${deepS}s`,
    });
    bumpDraft();
    log('inf', `queued timeouts idle ${idleS}s / sleep ${sleepS}s / deep ${deepS}s`);
  }

  function pushMaxBrt(v: number) {
    setMaxBrt(v);
    queueSetting(draftRef.current, maxBrtOp(v));
    bumpDraft();
  }

  function pushScanMode(on: boolean) {
    setScanMode(on);
    queueSetting(draftRef.current, scanModeOp(on ? 1 : 0));
    bumpDraft();
  }

  function pushOverride(v: number) {
    setOverride(v);
    queueSetting(draftRef.current, ledOverrideOp(v));
    bumpDraft();
  }

  function pushHostOs(os: keyof typeof HOST_OS | null) {
    // fe/1005's payload byte IS the value, so draft.add's opKey dedup
    // (settings:path:payload[0]) never replaces across values — strip any
    // queued host-OS op first so exactly one lives in the draft and the
    // select's queued-state display stays unambiguous. null = Unset:
    // remove the queued op, queue nothing.
    const cur = draftRef.current.ops.find(
      (o): o is SettingsOp => o.kind === 'settings' && o.path === 'fe/1005',
    );
    if (os !== null && cur !== undefined && cur.payload[0] === HOST_OS[os]) return;
    draftRef.current.ops = draftRef.current.ops.filter(
      (o) => !(o.kind === 'settings' && o.path === 'fe/1005'),
    );
    if (os) {
      queueSetting(draftRef.current, hostOsOp(os));
      log('inf', `queued host OS → ${os === 'windows' ? 'Windows' : 'macOS'} (applied on the next flash)`);
    } else if (cur) {
      log('inf', 'removed the queued host OS op');
    }
    bumpDraft();
  }

  return (
    <div className="grid gap-4 p-4 md:grid-cols-3">
      <Card>
        <CardHeader>Typing</CardHeader>
        <CardContent>
          <div className="py-2">
            <div className="text-sm">Interrupt Flavor</div>
            <div className="text-xs text-muted-foreground">
              Written into every hold-tap record on the next behavior write.
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1">
              {FLAVORS.map((f) => (
                <Button
                  key={f.id}
                  variant={flavor === f.id ? 'default' : 'outline'}
                  size="sm"
                  title={f.blurb}
                  onClick={() => pickFlavor(f.id)}
                >
                  {f.name}
                </Button>
              ))}
            </div>
          </div>
          <Row label="Tapping Term" hint="Independent of flavor; used by new behavior sets.">
            <input
              type="range"
              min={10}
              max={1000}
              step={10}
              value={tappingTerm}
              onChange={(e) => onTappingTerm(Number(e.target.value))}
              className="w-32"
            />
            <span className="w-16 text-right text-sm">{tappingTerm} ms</span>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>Power</CardHeader>
        <CardContent>
          {!leftOn && (
            <div className="text-xs text-muted-foreground">
              Connect the left half to read the current timeouts; factory values shown.
            </div>
          )}
          {leftOn && !showingLive && (
            <div className="text-xs text-muted-foreground">Reading timeouts from the device…</div>
          )}
          <div className="text-xs text-muted-foreground">0 = off; 30 s minimum (device floor).</div>
          <Row label="Idle Timeout" hint={showingLive ? 'Live from the device.' : undefined}>
            <input
              type="range"
              min={0}
              max={6000}
              step={10}
              value={idleS}
              onChange={(e) => setIdleS(Number(e.target.value))}
              className="w-32"
            />
            <span className="w-16 text-right text-sm">{idleS} s</span>
          </Row>
          <Row label="Sleep Timeout" hint={showingLive ? 'Live from the device.' : undefined}>
            <input
              type="range"
              min={0}
              max={6000}
              step={10}
              value={sleepS}
              onChange={(e) => setSleepS(Number(e.target.value))}
              className="w-32"
            />
            <span className="w-16 text-right text-sm">{sleepS} s</span>
          </Row>
          <Row label="Deep Sleep" hint={showingLive ? 'Live from the device.' : undefined}>
            <input
              type="range"
              min={0}
              max={6000}
              step={10}
              value={deepS}
              onChange={(e) => setDeepS(Number(e.target.value))}
              className="w-32"
            />
            <span className="w-16 text-right text-sm">{deepS} s</span>
          </Row>
          <div className="flex justify-end pt-2">
            <Button size="sm" onClick={applyTimeouts}>
              Queue timeouts
            </Button>
          </div>
          <div className="mt-2 border-t pt-1">
            <Row
              label="Host OS"
              hint="Queues a host-OS write for the next flash; Unset removes the queued op."
            >
              <select
                value={hostOsValue}
                onChange={(e) =>
                  pushHostOs(
                    e.target.value === ''
                      ? null
                      : e.target.value === String(HOST_OS.mac)
                        ? 'mac'
                        : 'windows',
                  )
                }
                className={cn('rounded border bg-background px-2 py-1 text-sm')}
              >
                <option value="">Unset</option>
                <option value={String(HOST_OS.windows)}>Windows</option>
                <option value={String(HOST_OS.mac)}>macOS</option>
              </select>
            </Row>
            <div className="text-xs text-muted-foreground">
              Shows the queued op — the device never reports its host OS back. The reply is
              never inspected (ACK shape unproven): a rejected write stays queued and the
              flash reports partial.
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>LED</CardHeader>
        <CardContent>
          <div className="pb-1 text-xs text-muted-foreground">
            Device does not report current values; the queue shows what will be sent.
          </div>
          <Row label="Max Brightness">
            <input
              type="range"
              min={0}
              max={100}
              value={maxBrt}
              onChange={(e) => pushMaxBrt(Number(e.target.value))}
              className="w-32"
            />
            <span className="w-12 text-right text-sm">{maxBrt}%</span>
          </Row>
          <Row label="Scan Mode">
            <Checkbox checked={scanMode} onCheckedChange={(v) => pushScanMode(v === true)} />
          </Row>
          <Row label="Action Override">
            <select
              value={override}
              onChange={(e) => pushOverride(Number(e.target.value))}
              className={cn('rounded border bg-background px-2 py-1 text-sm')}
            >
              <option value={0}>None</option>
              <option value={1}>Layer 1</option>
              <option value={2}>Layer 2</option>
            </select>
          </Row>
        </CardContent>
      </Card>
    </div>
  );
}
