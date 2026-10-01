import type { TroubleEntry } from "./types";

export default {
  id: "stuck-layer",
  title: "Stuck on a layer until power cycle",
  summary:
    "A 'toggle to layer 0' binding, pressed from a higher layer, strands the board on that layer.",
  details: [
    "The firmware's layer engine mishandles toggle-to-layer-0 from a non-zero layer.",
    "This app never emits such a binding — its layer ops are momentary MO / hold-layer-2 only. The binding arrives via foreign profiles.",
  ],
  steps: [
    "Power-cycle to unstick.",
    "Replace the toggle-to-layer-0 binding with a momentary (MO) layer key and re-flash.",
  ],
} satisfies TroubleEntry;
