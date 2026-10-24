// Dock activation dispatch (Task 13): one click, one meaning. Lives outside
// Keyboard.tsx because Keyboard is a component file (fast-refresh keeps
// component files component-only) and because the dispatch is the
// smoke-harness-seam: §80 pins that LED mode paints the clicked side's bay
// block and keymap mode opens the menu — and that the two never cross.
export function dockActivate(
  mode: {
    ledMode: boolean;
    onBayPaint?: (side: "left" | "right") => void;
    onDockActivate?: (side: "left" | "right", x: number, y: number) => void;
  },
  side: "left" | "right",
  x: number,
  y: number,
): void {
  if (mode.ledMode) {
    mode.onBayPaint?.(side);
    return;
  }
  mode.onDockActivate?.(side, x, y);
}
