import type { TroubleEntry } from "./index";

export default {
  id: "layers-dead",
  title: "Layer switching (hold) stopped working",
  summary:
    "The layer-list store was wiped — always a side effect of the 30/10ca factory format.",
  details: [
    "Keymap/LED restores do not cover the layer list.",
    "Only a stock NayaFlow flash re-adds it (ADD_DEFAULT_DATA); its “Failed verify written data” error is benign — reproducible 2/2.",
    "Alternative (third-party, measured on their unit): rewrite the layer list directly — read it via the 30/1001 handshake and echo the entries back via 30/1002. The same rewrite also restores lighting after some dark-board states; see “Lighting wrong after a flash”, which has a button for it.",
  ],
  steps: [
    "Flash the left half once from stock NayaFlow.",
    "That flash overwrites 4 custom keys with its stale profile — re-apply them here: Save → Import your backup → Flash (proven twice).",
    "If you cannot run NayaFlow, the 30/1002 layer-list echo (see “Lighting wrong after a flash”) is the wire-only alternative.",
  ],
} satisfies TroubleEntry;
