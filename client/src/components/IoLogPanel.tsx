// Device I/O forensic log viewer: the per-session wire rings (ses.ioLog)
// merged into one scrollable table. Collapsible, live (subscribes to each
// ring), with Refresh / Clear / Download-JSONL. Forensics only — nothing
// here talks to the device.
import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, Terminal, Trash2 } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./ui/accordion";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { saveText } from "../lib/save";
import type { IoLogEntry, NayaSession, Side } from '@create-reflow/sdk';

type Row = IoLogEntry & { side: Side };

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** be/100c — the verb spelling used everywhere in the log/UI. */
const verbText = (r: IoLogEntry) => `${hex2(r.type)}/${hex2(r.c0)}${hex2(r.c1)}`;

const timeText = (t: number) =>
  `${new Date(t).toLocaleTimeString("en-GB", { hour12: false })}.${String(t % 1000).padStart(3, "0")}`;

export default function IoLogPanel({
  sesRef,
  leftConnected,
  rightConnected,
}: {
  sesRef: React.RefObject<Map<Side, NayaSession>>;
  leftConnected: boolean;
  rightConnected: boolean;
}) {
  const [tick, setTick] = useState(0);
  // Live: re-render on every ring push/clear. Resubscribe when the session
  // set changes (connect/unplug flips the connected flags).
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    for (const ses of sesRef.current.values())
      unsubs.push(ses.ioLog.subscribe(() => setTick((t) => t + 1)));
    return () => unsubs.forEach((u) => u());
  }, [sesRef, leftConnected, rightConnected]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const side of ["left", "right"] as const) {
      const ses = sesRef.current.get(side);
      if (!ses) continue;
      for (const e of ses.ioLog.snapshot()) out.push({ ...e, side });
    }
    return out.sort((a, b) => a.t - b.t || a.seq - b.seq);
  }, [sesRef, leftConnected, rightConnected, tick]);

  const clear = () => {
    for (const ses of sesRef.current.values()) ses.ioLog.clear();
  };

  const download = () => {
    const text = rows
      .map((r) =>
        JSON.stringify({
          side: r.side,
          seq: r.seq,
          t: r.t,
          dir: r.dir,
          type: r.type,
          c0: r.c0,
          c1: r.c1,
          len: r.len,
          hex: r.hex,
          ...(r.ms !== undefined ? { ms: r.ms } : {}),
          ...(r.err !== undefined ? { err: r.err } : {}),
        }),
      )
      .join("\n");
    saveText(
      `reflow-io-log-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
      text + (text ? "\n" : ""),
    );
  };

  return (
    <Card>
      <Accordion type="single" collapsible>
        <AccordionItem value="io-log">
          <AccordionTrigger className="px-4 text-left text-sm font-medium">
            <span className="flex items-center gap-2">
              <Terminal className="size-4" />
              Device I/O log
              <span className="font-mono text-xs text-muted-foreground">
                {rows.length} record{rows.length === 1 ? "" : "s"}
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4">
            <p className="mb-2 text-xs text-muted-foreground">
              Every wire exchange, per half — including the quiet background
              polls. This is where a flash that "failed" but actually landed
              shows what really happened. Rows marked ✗ are exchanges that
              never got an answer.
            </p>
            <div className="mb-2 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setTick((t) => t + 1)}>
                <RefreshCw /> Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={clear} disabled={rows.length === 0}>
                <Trash2 /> Clear
              </Button>
              <Button variant="secondary" size="sm" onClick={download} disabled={rows.length === 0}>
                <Download /> Download JSONL
              </Button>
            </div>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No wire traffic recorded yet this session.
              </p>
            ) : (
              <div className="max-h-80 overflow-auto rounded-md border font-mono text-xs">
                {rows.map((r) => (
                  <div
                    key={`${r.side}:${r.seq}`}
                    className={`flex gap-2 border-b px-2 py-0.5 last:border-b-0 tabular-nums ${
                      r.err !== undefined
                        ? "bg-destructive/10 text-destructive"
                        : r.dir === ">"
                          ? "text-muted-foreground"
                          : ""
                    }`}
                  >
                    <span className="w-10 shrink-0">
                      {r.side === "left" ? "L" : "R"}
                    </span>
                    <span className="w-24 shrink-0">{timeText(r.t)}</span>
                    <span className="w-4 shrink-0">{r.dir}</span>
                    <span className="w-16 shrink-0">{verbText(r)}</span>
                    <span className="w-10 shrink-0 text-right">
                      {r.len}B
                    </span>
                    <span className="w-14 shrink-0 text-right">
                      {r.ms !== undefined ? `${r.ms}ms` : "—"}
                    </span>
                    <span className="truncate">
                      {r.err !== undefined ? `✗ ${r.err}` : r.hex}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  );
}
