// Shared card-header pattern for the editor views: [Keyboard|Layout] tabs,
// [Layer N] tabs, then a right-aligned slot for view-specific controls.
// Tabs follow the board's layer inventory; before the first read the
// classic 0..2 tabs show (pre-read state) with no add/delete affordances —
// managing layers only makes sense against a known table. Confirm for
// delete lives in the App handler: this component only reports intent.
import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import type { LayerEntry } from '@create-reflow/sdk';
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Button } from "./ui/button";

export type EditorView = "kb" | "table";

export default function ViewLayerTabs({
  view,
  onView,
  layer,
  onLayer,
  layerList = [],
  onAddLayer,
  onDeleteLayer,
  children,
}: {
  view: EditorView;
  onView: (v: EditorView) => void;
  layer: number;
  onLayer: (l: number) => void;
  /** board inventory; empty (pre-read) falls back to the classic 0..2 tabs */
  layerList?: LayerEntry[];
  onAddLayer?: () => void;
  onDeleteLayer?: (idx: number) => void;
  children?: ReactNode;
}) {
  // Sorted ascending: tabs read left-to-right in board order regardless of
  // the wire order the inventory happened to carry.
  const idxs =
    layerList.length > 0
      ? layerList.map((e) => e.idx).sort((a, b) => a - b)
      : [0, 1, 2];
  const managed = layerList.length > 0;
  return (
    <>
      <Tabs value={view} onValueChange={(v) => onView(v as EditorView)}>
        <TabsList>
          <TabsTrigger value="kb">Keyboard</TabsTrigger>
          <TabsTrigger value="table">Layout</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex items-center gap-1">
        <Tabs value={String(layer)} onValueChange={(v) => onLayer(parseInt(v, 10))}>
          <TabsList>
            {idxs.map((idx) => (
              <TabsTrigger key={idx} value={String(idx)}>
                Layer {idx + 1}
                {managed && onDeleteLayer && (
                  // Span, not button: a button nested in the radix trigger
                  // is invalid HTML. stopPropagation keeps the click from
                  // switching tabs; the confirm lives in the App handler.
                  <span
                    role="button"
                    aria-label={`Delete Layer ${idx + 1}`}
                    title={`Delete Layer ${idx + 1}`}
                    className="ml-1 -mr-0.5 rounded-sm text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteLayer(idx);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {managed && onAddLayer && (
          <Button
            variant="outline"
            size="sm"
            title="Add a layer — queues the change, Flash to apply"
            onClick={onAddLayer}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>
      <span className="ml-auto flex items-center gap-2">{children}</span>
    </>
  );
}
