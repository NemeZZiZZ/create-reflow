/* Applications pane for the action palette: platform segmented control,
 * categorized app picker (native select), per-app search, and the
 * shortcut rows. Rendering is pure — db/loading/error/platform arrive
 * from ActionPalette, which owns the lazy corpus load (fires only when
 * the user opens the Applications tab) and the persisted platform flag.
 * AppShortcutRow is exported for reuse: the Actions tab's ranked
 * cross-app section renders the same rows.
 *
 * Row gating: a slot filter (e.g. KeyActionMenu's hidOnly in Hold /
 * Double / Tap+Hold modes) DISABLES rows whose synthesized def it
 * rejects — chord defs carry mods ≠ 0, so slot modes dim them (OF
 * shortcut_alias-is-whole-key semantics). Rows are never hidden. */

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ActionDef } from "@create-reflow/sdk";
import {
  appShortcutActionDef,
  bindOf,
  type AppEntry,
  type AppShortcutDb,
  type Platform,
  type ShortcutEntry,
} from "../lib/app-shortcuts";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "./ui/input-group";

/* Rows rendered per app view; beyond this, a refine hint appears. */
const ROW_CAP = 300;

const PLATFORM_LABEL: Record<Platform, string> = {
  windows: "Windows",
  mac: "macOS",
};

/* Full-width palette row: entry name (+ optional context) on the left,
 * the platform chord in mono on the right. */
export function AppShortcutRow({
  app,
  entry,
  platform,
  def,
  onPick,
  filter,
}: {
  app: AppEntry;
  entry: ShortcutEntry;
  platform: Platform;
  def: ActionDef;
  onPick: (a: ActionDef) => void;
  filter?: (a: ActionDef) => boolean;
}) {
  const bind = bindOf(entry, platform);
  if (!bind) return null;
  return (
    <Button
      variant="outline"
      className="h-auto w-full flex justify-between gap-2 text-sm"
      disabled={filter ? !filter(def) : false}
      title={`${app.name} — ${entry.name} (${bind.chord})${entry.ctx ? ` · ${entry.ctx}` : ""}`}
      onClick={() => onPick(def)}
    >
      <span className="truncate text-left">
        {entry.name}
        {entry.ctx && (
          <span className="text-xs text-muted-foreground"> · {entry.ctx}</span>
        )}
      </span>
      <span className="font-mono text-xs whitespace-nowrap">{bind.chord}</span>
    </Button>
  );
}

export default function AppShortcutPane({
  db,
  loading,
  error,
  platform,
  onTogglePlatform,
  onPick,
  filter,
}: {
  db: AppShortcutDb | null;
  loading: boolean;
  error: boolean;
  platform: Platform;
  onTogglePlatform: () => void;
  onPick: (a: ActionDef) => void;
  filter?: (a: ActionDef) => boolean;
}) {
  // Selected app name (null → first app); per-app search needle.
  const [appName, setAppName] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();

  // Category groups sorted by category name (localeCompare — the collation
  // codegen used for cats). The corpus sorts apps globally by NAME, so a
  // plain db.apps walk yields first-appearance category order, not sorted
  // order — hence the explicit sort. Within a group, apps stay in corpus
  // order, which is name-sorted.
  const cats = useMemo(() => {
    const m = new Map<string, AppEntry[]>();
    if (db)
      for (const a of db.apps) {
        const list = m.get(a.cat);
        if (list) list.push(a);
        else m.set(a.cat, [a]);
      }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [db]);

  const app =
    (appName != null && db?.byName.get(appName)) || db?.apps[0] || null;

  if (loading)
    return (
      <div className="text-xs text-muted-foreground py-4 text-center">
        Loading application shortcuts…
      </div>
    );
  if (error)
    return (
      <div className="text-xs text-muted-foreground py-4 text-center">
        Application shortcuts failed to load.
      </div>
    );
  if (!db || !app) return null;

  // Platform-bound entries, needle-filtered, capped for render.
  const bound = app.actions.filter((e) => bindOf(e, platform) !== null);
  const rows = bound.filter((e) => e.name.toLowerCase().includes(needle));
  const shown = rows.slice(0, ROW_CAP);
  const more = rows.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex gap-1"
        title="Shortcuts differ per platform — picks bind the selected platform's key bytes."
      >
        {(["windows", "mac"] as const).map((p) => (
          <Button
            key={p}
            size="sm"
            variant={platform === p ? "default" : "outline"}
            className="text-xs"
            onClick={onTogglePlatform}
          >
            {PLATFORM_LABEL[p]}
          </Button>
        ))}
      </div>
      <select
        value={app.name}
        onChange={(e) => {
          setAppName(e.target.value);
          setQ("");
        }}
        className={cn("rounded border bg-background px-2 py-1 text-sm")}
        aria-label="Application"
      >
        {cats.map(([cat, apps]) => (
          <optgroup key={cat} label={cat}>
            {apps.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <InputGroup className="h-8 text-xs">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          placeholder={`Search in ${app.name}…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="text-xs"
          aria-label={`Search in ${app.name}`}
        />
      </InputGroup>
      <div className="max-h-64 overflow-y-auto pr-1">
        {bound.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4 text-center">
            No {PLATFORM_LABEL[platform]} shortcuts for {app.name}.
          </div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4 text-center">
            No matches in {app.name}.
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {shown.map((e) => {
              const def = appShortcutActionDef(app, e, platform);
              if (!def) return null;
              return (
                <AppShortcutRow
                  key={def.id}
                  app={app}
                  entry={e}
                  platform={platform}
                  def={def}
                  onPick={onPick}
                  filter={filter}
                />
              );
            })}
          </div>
        )}
        {more > 0 && (
          <div className="text-xs text-muted-foreground py-2">
            …{more} more — refine the search.
          </div>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {db.apps.length} apps · MIT-licensed data — see ATTRIBUTION.md
      </div>
    </div>
  );
}
