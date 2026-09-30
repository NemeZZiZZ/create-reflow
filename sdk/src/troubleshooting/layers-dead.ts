import type { TroubleEntry } from "./index";

export default {
  id: "layers-dead",
  title: "Layer switching (hold) stopped working",
  summary:
    "The layer-list store was wiped — always a side effect of the 30/10ca factory format.",
  details: [
    "Keymap/LED restores do not cover the layer list.",
    "Only a stock NayaFlow flash re-adds it (ADD_DEFAULT_DATA); its “Failed verify written data” error is benign — reproducible 2/2.",
    "Alternative (third-party finding, untested by us): rewrite the layer list directly via 30/1003 — each entry is 20 bytes [idx][id][animation][10][uuid16]; a layer-list rewrite also restores lighting after some dark-board states. CAUTION: the animation byte here is 2=spectrum / 3=swirl — the OPPOSITE of ed/1011.",
  ],
  steps: [
    "Flash the left half once from stock NayaFlow.",
    "That flash overwrites 4 custom keys with its stale profile — re-apply them here: Save → Import your backup → Flash (proven twice).",
    "If you cannot run NayaFlow, the 30/1003 layer-list rewrite above is the wire-only alternative (bring your own tooling).",
  ],
} satisfies TroubleEntry;
