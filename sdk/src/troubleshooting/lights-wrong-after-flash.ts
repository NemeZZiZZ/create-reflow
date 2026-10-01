import type { TroubleEntry } from "./types";

export default {
  id: "lights-wrong-after-flash",
  title: "Lighting wrong after a flash",
  summary:
    "After a keymap flash or a bootloader pass the board lights white/amber/dim — while the LED maps read back byte-identical.",
  details: [
    "Not a data problem: the stored LED maps are fine. The runtime lighting state is wedged (a stale ed/1011 effect slot is a frequent culprit) — the same rewrite clears that wedge too.",
    "Measured cure (third-party, 2026-09): re-writing the layer list — the 30/1001 handshake entries echoed back via 30/1002 — restores BOTH halves' lighting in a single frame and changes nothing stored.",
    "The left port drives both halves' lighting — run this on the left half even when only the right looks wrong.",
  ],
  steps: [
    "Press the button below (left half connected). It reads the layer list, validates the reply shape, and echoes the same entries back unchanged.",
    "Watch the board: lighting should return immediately. Your keymaps and LED maps are untouched.",
  ],
  actions: [
    {
      label: "Rewrite layer list (restore lighting)",
      side: "left",
      confirm:
        "Rewrite the layer list on the LEFT half (read the current entries, echo them back unchanged)? Measured safe — restores both halves' lighting without touching stored data.",
      run: async (ctx) => {
        await ctx.rewriteLayerList();
        ctx.toast("Layer list rewritten — watch the board", "success");
      },
    },
  ],
} satisfies TroubleEntry;
