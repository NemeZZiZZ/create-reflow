// Per-half Bluetooth (BLE) card for the Devices tab: identity rows, the
// 5 slot rows (slot 0 = reserved dongle mode, no actions) and the explicit
// "Read BLE" action. Everything here is painted from an EXPLICIT read
// only — opening the tab never touches the wire.
import { RefreshCw } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import type { BleProfileStatus } from '@create-reflow/sdk';
import type { Side } from '@create-reflow/sdk';
import type { BleHalfData } from '../hooks/useBleSlots';

const macText = (m: Uint8Array | null): string =>
  m === null
    ? "—"
    : Array.from(m)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(":");

const timeText = (t: number): string =>
  new Date(t).toLocaleTimeString("en-GB", { hour12: false });

function SlotRow({
  p,
  busy,
  onSelect,
  onClear,
}: {
  p: BleProfileStatus;
  busy: boolean;
  onSelect: (slot: number) => void;
  onClear: (slot: number) => void;
}) {
  if (p.index === 0)
    return (
      <div className="flex items-center gap-2 text-[13px]">
        <span className="w-8 font-mono text-xs">0</span>
        <span className="text-muted-foreground">reserved (dongle)</span>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="w-8 font-mono text-xs">{p.index}</span>
      {p.active && <Badge variant="info">active</Badge>}
      {p.bonded && <Badge variant="default">bonded</Badge>}
      {p.connected && <Badge variant="ok">connected</Badge>}
      {!p.active && !p.bonded && !p.connected && (
        <span className="text-muted-foreground">empty</span>
      )}
      {p.peerAddress && (
        <span className="font-mono text-xs break-all text-muted-foreground">
          → {macText(p.peerAddress)}
        </span>
      )}
      <span className="ml-auto flex gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          title="Same as pressing BT n on the keyboard"
          onClick={() => onSelect(p.index)}
        >
          Select
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          title="Forget whatever is paired in this slot"
          onClick={() => onClear(p.index)}
        >
          Clear &amp; pair
        </Button>
      </span>
    </div>
  );
}

export default function BlePanel({
  side,
  connected,
  data,
  busy,
  onRead,
  onSelect,
  onClear,
}: {
  side: Side;
  connected: boolean;
  data: BleHalfData | null;
  busy: boolean;
  onRead: () => void;
  onSelect: (slot: number) => void;
  onClear: (slot: number) => void;
}) {
  const label = side === "left" ? "Left" : "Right";
  const layout = data?.status?.layout ?? null;
  const degraded = data !== null && layout === null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <b className="text-sm font-semibold">Bluetooth (BLE) — {label}</b>
        <Badge variant={connected ? "ok" : "default"}>
          {connected ? "connected" : "not connected"}
        </Badge>
        {data && (
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            read {timeText(data.at)}
          </span>
        )}
      </div>
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={!connected || busy}
          title={
            connected ? undefined : `Connect the ${side} half first`
          }
          onClick={onRead}
        >
          <RefreshCw />
          {busy ? "Reading…" : "Read BLE"}
        </Button>
      </div>
      {!data && (
        <p className="text-xs text-muted-foreground">
          Nothing read yet — slot state is painted from an explicit read only.
        </p>
      )}
      {data && (
        <>
          <div className="grid grid-cols-[150px_1fr] gap-x-2.5 gap-y-1 text-[13px]">
            <b className="font-semibold text-muted-foreground">BLE address</b>
            <span className="font-mono text-xs break-all">
              {macText(data.address)}
            </span>
            <b className="font-semibold text-muted-foreground">Points at</b>
            <span className="font-mono text-xs break-all">
              {macText(data.pairAddress)}
            </span>
          </div>
          {layout && (
            <div className="flex flex-col gap-1.5">
              {layout.profiles
                .slice()
                .sort((a, b) => a.index - b.index)
                .map((p) => (
                  <SlotRow
                    key={p.index}
                    p={p}
                    busy={busy}
                    onSelect={onSelect}
                    onClear={onClear}
                  />
                ))}
            </div>
          )}
          {degraded && (
            <>
              <p className="text-xs text-amber-500">
                Bluetooth slots need newer firmware — the be/100C status block
                went unanswered, so slot rows are unavailable.
              </p>
              <div className="grid grid-cols-[150px_1fr] gap-x-2.5 gap-y-1 text-[13px]">
                <b className="font-semibold text-muted-foreground">
                  Bond table (be/1005)
                </b>
                <span className="font-mono text-xs break-all">
                  {data.pairs === undefined
                    ? "not read"
                    : data.pairs === null
                      ? "no reply from the keyboard"
                      : data.pairs.count === 0
                        ? "empty"
                        : data.pairs.macs.map(macText).join(", ")}
                </span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
