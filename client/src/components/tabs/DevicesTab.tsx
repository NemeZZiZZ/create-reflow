// Devices tab: two per-half cards + the BLE slot section (explicit-read
// slot manager + pairing verdict) + the Draft stats card + the device I/O
// log viewer, grouped by section.
import { Info } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import DevicePanel from "../DevicePanel";
import BlePanel from "../BlePanel";
import IoLogPanel from "../IoLogPanel";
import type { HalfSnapshot, NayaSession, PairingVerdict, Side } from '@create-reflow/sdk';
import type { Draft } from '@create-reflow/sdk';
import { SECTIONS, opSection, type Section } from '@create-reflow/sdk';
import type { BleSlots } from '../../hooks/useBleSlots';

const SECTION_LABEL: Record<Section, string> = {
  bindings: "Bindings",
  led: "LED map",
  modules: "Modules",
  behavior: "Behavior",
  layers: "Layers",
};

/** Honest 4-state rendering of pairingVerdict. 'unknown' is a real state
 * here, not a fallback: unread tables / missing identities stay unknown. */
const VERDICT_UI: Record<
  PairingVerdict,
  { label: string; variant: "ok" | "bad" | "default"; hint: string }
> = {
  healthy: {
    label: "Paired",
    variant: "ok",
    hint: "Halves point at each other and both bond tables hold the partner.",
  },
  "half-paired": {
    label: "Half-paired",
    variant: "bad",
    hint: "One half lost the other (or neither points anywhere) — re-pair the halves to each other.",
  },
  "bond-missing": {
    label: "Bond missing",
    variant: "bad",
    hint: "Addresses are mutual but a bond table lost its partner — re-pair the halves.",
  },
  unknown: {
    label: "Unknown",
    variant: "default",
    hint: "Evidence incomplete — the verdict stays unknown rather than guessed.",
  },
};

function VerdictRow({
  verdict,
  haveLeft,
  haveRight,
}: {
  verdict: PairingVerdict | null;
  haveLeft: boolean;
  haveRight: boolean;
}) {
  const ui = verdict ? VERDICT_UI[verdict] : VERDICT_UI.unknown;
  const hint =
    verdict === null
      ? "Read BLE on both halves to grade the pairing."
      : verdict === "unknown" && (!haveLeft || !haveRight)
        ? "Read BLE on both halves to grade the pairing."
        : ui.hint;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-[13px]">
      <b className="font-semibold text-muted-foreground">Pairing verdict</b>
      <Badge variant={ui.variant}>{ui.label}</Badge>
      <span className="text-muted-foreground">{hint}</span>
    </div>
  );
}

export default function DevicesTab({
  halves,
  draftRef,
  sesRef,
  ble,
  onDeviceInfo,
}: {
  halves: Record<Side, HalfSnapshot>;
  draftRef: { current: Draft };
  sesRef: React.RefObject<Map<Side, NayaSession>>;
  ble: BleSlots;
  onDeviceInfo: () => void;
}) {
  const ops = draftRef.current.ops;
  const perSection = SECTIONS.map(
    (s) => [s, ops.filter((o) => opSection(o) === s).length] as const,
  );
  const { frames, bytes } = draftRef.current.stats();
  return (
    <div className="flex flex-col gap-3 p-1">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <DevicePanel title="Left half" half={halves.left} />
        <DevicePanel title="Right half" half={halves.right} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Bluetooth slots (BLE)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <BlePanel
              side="left"
              connected={halves.left.connected}
              data={ble.data.left}
              busy={ble.busySide === "left"}
              onRead={() => ble.readBle("left")}
              onSelect={(slot) => ble.selectProfile("left", slot)}
              onClear={(slot) => ble.clearProfile("left", slot)}
            />
            <BlePanel
              side="right"
              connected={halves.right.connected}
              data={ble.data.right}
              busy={ble.busySide === "right"}
              onRead={() => ble.readBle("right")}
              onSelect={(slot) => ble.selectProfile("right", slot)}
              onClear={(slot) => ble.clearProfile("right", slot)}
            />
          </div>
          <VerdictRow
            verdict={ble.verdict}
            haveLeft={ble.data.left !== null}
            haveRight={ble.data.right !== null}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Draft stats{ops.length > 0 ? ` — ${ops.length} pending` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {ops.length === 0 ? (
            <p className="text-sm text-muted-foreground">Draft is empty.</p>
          ) : (
            <>
              <div className="grid grid-cols-[150px_1fr] gap-x-2.5 gap-y-1 text-[13px]">
                {perSection.map(([s, n]) => (
                  <span key={s} className="contents">
                    <b className="font-semibold text-muted-foreground">
                      {SECTION_LABEL[s]}
                    </b>
                    <span className="font-mono text-xs">
                      {n} op{n === 1 ? "" : "s"}
                    </span>
                  </span>
                ))}
              </div>
              <p className="font-mono text-xs text-muted-foreground tabular-nums">
                {ops.length} ops · {frames} frames · {bytes} bytes
              </p>
            </>
          )}
        </CardContent>
      </Card>
      <IoLogPanel
        sesRef={sesRef}
        leftConnected={halves.left.connected}
        rightConnected={halves.right.connected}
      />
      <div>
        <Button variant="secondary" size="sm" onClick={onDeviceInfo}>
          <Info /> Open device info
        </Button>
      </div>
    </div>
  );
}
