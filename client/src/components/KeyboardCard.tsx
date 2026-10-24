// Keyboard view card: view/layer tabs + refresh/LED-toggle header,
// the fit-scaled keyboard, and the usage hint.
import { RefreshCw } from "lucide-react";
import Keyboard from "./Keyboard";
import ViewLayerTabs from "./ViewLayerTabs";
import type { EditorView } from "./ViewLayerTabs";
import type { LayerEntry } from '@create-reflow/sdk';
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";

export default function KeyboardCard({
  view,
  onView,
  layer,
  onLayer,
  layerList,
  onAddLayer,
  onDeleteLayer,
  leftOn,
  onDump,
  ledMode,
  onLedMode,
  testKeys,
  onTestKeys,
  testKeysDisabled,
  testKeysHint,
  pressedKks,
  kbBoxRef,
  kbStageRef,
  kbScale,
  keymap,
  ledmap,
  selKks,
  onSelect,
  dirtyKks,
  onContext,
  keyNotes,
  onDockActivate,
  dockOpen,
}: {
  view: EditorView;
  onView: (v: EditorView) => void;
  layer: number;
  onLayer: (l: number) => void;
  layerList?: LayerEntry[];
  onAddLayer?: () => void;
  onDeleteLayer?: (idx: number) => void;
  leftOn: boolean;
  onDump: () => void;
  ledMode: boolean;
  onLedMode: (v: boolean) => void;
  /** live keyscan test running (the raw row/col panel lives in BindingsTab) */
  testKeys: boolean;
  onTestKeys: (v: boolean) => void;
  /** disabled while the draft queue is non-empty or the device is busy —
   *  the hook's start() re-checks with a toast (belt and suspenders) */
  testKeysDisabled: boolean;
  /** toggle tooltip: why it's disabled, or the running hedge copy */
  testKeysHint: string;
  /** KK-keyed test-press overlay for the Keyboard (empty today — no
   *  verified row/col→KK mapping exists) */
  pressedKks?: ReadonlySet<number>;
  kbBoxRef: React.RefObject<HTMLDivElement | null>;
  kbStageRef: React.RefObject<HTMLDivElement | null>;
  kbScale: number;
  keymap: Map<number, Uint8Array>;
  ledmap: Map<number, { h: number; s: number }>;
  selKks: Set<number>;
  onSelect: (pos: number, kk: number, additive: boolean, allLayers: boolean) => void;
  dirtyKks: Set<number>;
  onContext?: (kk: number, x: number, y: number) => void;
  keyNotes?: Map<number, string>;
  /** keymap-mode dock click: open the per-side bay menu (BindingsTab owns
   *  the open state) */
  onDockActivate?: (side: "left" | "right", x: number, y: number) => void;
  /** which dock's bay menu is open — drives the dock's aria-expanded */
  dockOpen?: "left" | "right" | null;
}) {
  return (
    <Card className="mb-3">
      <CardHeader className="flex-wrap">
        <ViewLayerTabs
          view={view}
          onView={onView}
          layer={layer}
          onLayer={onLayer}
          layerList={layerList}
          onAddLayer={onAddLayer}
          onDeleteLayer={onDeleteLayer}
        >
          <Button
            variant="secondary"
            size="sm"
            title="Re-read all layers + LED maps from the LEFT half"
            onClick={onDump}
            disabled={!leftOn}
          >
            <RefreshCw /> Refresh
          </Button>
          <Checkbox
            id="ledmode"
            checked={ledMode}
            onCheckedChange={(v) => onLedMode(v === true)}
          />
          <Label htmlFor="ledmode">LED colors on keys</Label>
          <span
            className="ml-2 inline-flex items-center gap-1.5"
            title={testKeysHint}
          >
            <Checkbox
              id="testkeys"
              checked={testKeys}
              onCheckedChange={(v) => onTestKeys(v === true)}
              disabled={testKeysDisabled}
            />
            <Label htmlFor="testkeys">Test keys</Label>
          </span>
        </ViewLayerTabs>
      </CardHeader>
      <CardContent>
        <div
          className="overflow-hidden rounded-sm bg-background p-4 min-h-60"
          ref={kbBoxRef}
        >
          <div
            ref={kbStageRef}
            className="mx-auto max-w-full"
            style={{ width: "fit-content", zoom: kbScale }}
          >
            <Keyboard
              keymap={keymap}
              ledmap={ledmap}
              ledMode={ledMode}
              sel={selKks}
              onSelect={onSelect}
              disabled={!leftOn}
              dirty={dirtyKks}
              pressed={pressedKks}
              onContext={onContext}
              keyNotes={keyNotes}
              onDockActivate={onDockActivate}
              dockOpen={dockOpen}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {testKeys
            ? "Test mode locks other device traffic; keys may still reach your computer. Escape stops the session."
            : leftOn
              ? "Click a key to select it, Shift+click for multi-select, Alt+click selects the key on all layers. Right-click a key to configure it in place — or use the panel below. Changes queue up, nothing writes until Flash."
              : "Connect the LEFT half — legends and colors load automatically."}
        </p>
      </CardContent>
    </Card>
  );
}
