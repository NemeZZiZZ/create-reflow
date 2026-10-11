// Shared Save dropdown — lives in the headers of both Keyboard and
// Layout views (exports read from the layer caches, no device traffic).
// One OpenFlow layer doc per layer carries keys AND colors; 'All layers'
// downloads every inventory layer in one go. Stored module profiles each
// get an export item too — theirs reads the profile store (works without
// a read or a connection); the section is omitted when none are stored.
import { Download } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import type { ModuleProfile } from "@create-reflow/sdk";

export default function SaveMenu({
  leftOn,
  layers,
  profiles,
  onExportLayer,
  onExportAll,
  onExportProfile,
  onImport,
  onBackups,
}: {
  leftOn: boolean;
  /** layer idx list to offer (App derives it from the board inventory) */
  layers: number[];
  /** stored module profiles — one export item each */
  profiles: ModuleProfile[];
  onExportLayer: (layer: number) => void;
  onExportAll: () => void;
  onExportProfile: (profile: ModuleProfile) => void;
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
        {profiles.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {profiles.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => onExportProfile(p)}>
                {p.name} (.openflow-module-profile.json)
              </DropdownMenuItem>
            ))}
          </>
        )}
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
