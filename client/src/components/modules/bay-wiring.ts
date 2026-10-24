// Dock bay menu wiring (Task 13): the menu's row/item handlers as plain
// functions. Lives outside DockBayMenu.tsx because that file is a component
// file (fast-refresh keeps component files component-only) and because the
// wiring is the smoke-harness-seam: §80 pins that a radio pick maps to
// EXACTLY setBay(layer, pos, pick) — the hook owns the byte mapping
// (live slot / 0x78 inherit / 0x00 disabled) and the busy gate — and that
// "Edit profiles…" navigates BEFORE the menu closes.
import type { useModuleProfiles } from "../../hooks/useModuleProfiles";

/** Radio pick → setBay(layer, pos, pick), nothing else. */
export function bayPickHandler(
  setBay: ReturnType<typeof useModuleProfiles>["setBay"],
  layer: number,
  pos: number,
): (pick: string) => void {
  return (pick) => setBay(layer, pos, pick);
}

/** "Edit profiles…": onManage (jump to the modules tab) first, then the
 *  close — an absent onManage still closes. */
export function bayMenuManage(
  onManage: (() => void) | undefined,
  onClose: () => void,
): () => void {
  return () => {
    onManage?.();
    onClose();
  };
}
