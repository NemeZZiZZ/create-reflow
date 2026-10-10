// Shared Save dropdown — lives in the headers of both Keyboard and
// Layout views (exports read from the layer caches, no device traffic).
// One OpenFlow layer doc per layer carries keys AND colors; 'All layers'
// downloads every inventory layer in one go.
import { Download } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";

export default function SaveMenu({
  leftOn,
  layers,
  onExportLayer,
  onExportAll,
  onImport,
  onBackups,
}: {
  leftOn: boolean;
  /** layer idx list to offer (App derives it from the board inventory) */
  layers: number[];
  onExportLayer: (layer: number) => void;
  onExportAll: () => void;
  onImport: () => void;
  onBackups: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={!leftOn}>
          <Download className="mr-1 h-4 w-4" /> Save
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {layers.map((L) => (
          <DropdownMenuItem
            key={L}
            onClick={() => onExportLayer(L)}
            disabled={!leftOn}
          >
            Layer {L + 1} (.openflow-layer.json)
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onExportAll} disabled={!leftOn}>
          All layers
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onImport} disabled={!leftOn}>
          Import snapshot…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onBackups} disabled={!leftOn}>
          Restore auto-backup…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
