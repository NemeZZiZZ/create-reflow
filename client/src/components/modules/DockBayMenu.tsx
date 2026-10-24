// Dock bay menu (Task 13): the per-layer module bay picks move onto the
// board's teardrop docks — OF ModuleBayPicker parity (openflow
// ModuleBayPicker.jsx). One menu per side, opened by a keymap-mode dock
// click; it carries the same controls the old Module bays card had for that
// side (profile radios + live badge, inherit, Disabled), collapsed to the
// docked module's type when presence knows it — the dock is physical, an
// empty dock can run nothing.
//
// The choice applies to the LAYER being edited, exactly like the old card:
// the base layer sets what every other layer inherits; picking on a layer
// overrides it for that layer only. Picks ride the hook's setBay mutator —
// the hook owns the byte mapping (live slot / 0x78 inherit / 0x00 disabled)
// and the busy gate, the menu never passes raw bytes.
//
// Positioning is viewport-anchored (beside the click, clamped 8px inside
// the window) because the keyboard's centre column would clip it; close on
// an outside mousedown or Escape, the way a native menu does.
import { useEffect, useMemo, useRef } from "react";
import { Badge } from "../ui/badge";
import { BAY_POSITIONS } from "@create-reflow/sdk";
import type { ModuleType } from "@create-reflow/sdk";
import { bayPickHandler, bayMenuManage } from "./bay-wiring";
import type { useModuleProfiles } from "../../hooks/useModuleProfiles";

export type DockSide = "left" | "right";

/** The slot groups this menu carries: the docked module's type when
 *  presence knows it, all three bays when the dock is empty or unknown. */
function sectionTypes(dockedType: string | null | undefined): ModuleType[] {
  return dockedType === "TOUCH" || dockedType === "TRACK" || dockedType === "TUNE"
    ? [dockedType]
    : ["TOUCH", "TRACK", "TUNE"];
}

export default function DockBayMenu({
  side,
  layer,
  modules,
  dockedType,
  onManage,
  onClose,
  anchor,
}: {
  side: DockSide;
  layer: number;
  modules: ReturnType<typeof useModuleProfiles>;
  /** docked module type when presence knows it ('TOUCH'|'TRACK'), else null */
  dockedType?: string | null;
  onManage?: () => void;
  onClose: () => void;
  anchor: { x: number; y: number };
}) {
  const { profiles, bays, live, reading, setBay } = modules;
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on an outside click or Escape (OF ModuleBayPicker semantics).
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  // slot → matched profile verdicts, collapsed to one entry per profile id
  // (matched beats nothing: only content-matched slots count as live).
  const liveByProfile = useMemo(() => {
    const out = new Map<string, { slot: number; name: string }>();
    for (const v of Object.values(live)) {
      if (v.matched === null || out.has(v.matched.id)) continue;
      out.set(v.matched.id, { slot: v.slot, name: v.matched.name });
    }
    return out;
  }, [live]);

  // Viewport-anchored beside the dock: centered on the click, 6px below,
  // clamped 8px inside the window. Guarded for the smoke harness's static
  // render (no window there — the raw anchor is as good as any).
  const MENU_W = 288;
  const left =
    typeof window === "undefined"
      ? anchor.x
      : Math.max(8, Math.min(anchor.x - MENU_W / 2, window.innerWidth - MENU_W - 8));
  const top =
    typeof window === "undefined"
      ? anchor.y
      : Math.max(8, Math.min(anchor.y + 6, window.innerHeight - 400));

  const idx = side === "left" ? 0 : 1;
  // One text node so the harness (and screen readers) see the whole header.
  const head = `${dockedType ? dockedType[0] + dockedType.slice(1).toLowerCase() : side === "left" ? "Left dock" : "Right dock"} · layer ${layer}`;
  const rowCls = "flex cursor-pointer items-center gap-1.5 text-xs";
  const radioCls = "size-3.5 shrink-0 accent-primary";

  return (
    <div
      ref={ref}
      className="fixed z-50 w-72 rounded-lg border border-border bg-card p-2 shadow-lg"
      style={{ left, top }}
    >
      <div className="mb-1.5 px-1 text-xs font-semibold">{head}</div>
      {sectionTypes(dockedType).map((type) => {
        const pos = BAY_POSITIONS[type][idx];
        const pickFor = bayPickHandler(setBay, layer, pos);
        const current = bays[layer]?.[pos];
        const pickedProfile =
          current !== undefined && current !== "inherit" && current !== "disabled"
            ? (profiles.find((p) => p.id === current) ?? null)
            : null;
        const liveMatch = pickedProfile
          ? liveByProfile.get(pickedProfile.id)
          : undefined;
        const sideProfiles = profiles.filter((p) => p.type === type);
        const radioName = `bay-${layer}-${pos}`;
        return (
          <div key={type} className="mb-2 rounded-md border border-border p-2 last:mb-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs font-medium capitalize">
                {type.toLowerCase()} {side}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {`KK 0x${pos.toString(16)}`}
              </span>
              <span className="ml-auto shrink-0">
                {liveMatch && pickedProfile && (
                  <Badge
                    variant="ok"
                    title={`content-matched on the board at slot ${liveMatch.slot}`}
                  >
                    {liveMatch.name} · slot {liveMatch.slot}
                  </Badge>
                )}
                {pickedProfile && !liveMatch && (
                  <Badge title="Not on the keyboard yet (or not read this session) — read the keyboard, then re-pick to queue the bay write">
                    not on device
                  </Badge>
                )}
              </span>
            </div>
            <div className="mt-1.5 space-y-1">
              {sideProfiles.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  No profiles for this module yet.
                </div>
              )}
              {sideProfiles.map((p) => (
                <label key={p.id} className={rowCls}>
                  <input
                    type="radio"
                    className={radioCls}
                    name={radioName}
                    checked={current === p.id}
                    disabled={reading}
                    onChange={() => pickFor(p.id)}
                  />
                  <span className="truncate">{p.name}</span>
                </label>
              ))}
              {layer > 0 ? (
                <label className={rowCls}>
                  <input
                    type="radio"
                    className={radioCls}
                    name={radioName}
                    checked={current === "inherit"}
                    disabled={reading}
                    onChange={() => pickFor("inherit")}
                  />
                  <span>Inherit from base layer</span>
                </label>
              ) : (
                <div
                  className="text-[10px] text-muted-foreground"
                  title="Inherit points at the BASE layer — there is nothing to inherit on layer 0"
                >
                  —
                </div>
              )}
              {current === "inherit" && (
                <div className="text-[10px] text-muted-foreground">
                  Inherited from the base layer. Picking here overrides it for
                  this layer only.
                </div>
              )}
              <label className={rowCls}>
                <input
                  type="radio"
                  className={radioCls}
                  name={radioName}
                  checked={current === "disabled"}
                  disabled={reading}
                  onChange={() => pickFor("disabled")}
                />
                <span>Disabled on this layer</span>
              </label>
            </div>
          </div>
        );
      })}
      {onManage && (
        <>
          <div className="my-1.5 border-t border-border" />
          <button
            type="button"
            className="w-full rounded px-1 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={bayMenuManage(onManage, onClose)}
          >
            Edit profiles…
          </button>
        </>
      )}
    </div>
  );
}
