import type { TroubleEntry } from "./types";

export default {
  id: "frozen-wireless",
  title: "Board froze after a wireless-output key",
  summary:
    "Pressing a key bound to wireless output while on battery, with no host in range, froze the board.",
  details: [
    "Known firmware state: the wireless path blocks waiting for a host that never answers.",
  ],
  steps: [
    "Power-cycle the board (switch off/on, or re-plug USB).",
    "Avoid wireless-output bindings on layers you use on the go without a paired host in range.",
  ],
} satisfies TroubleEntry;
