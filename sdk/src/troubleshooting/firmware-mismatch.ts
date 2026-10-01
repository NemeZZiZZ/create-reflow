import type { TroubleEntry } from "./types";

export default {
  id: "firmware-mismatch",
  title: "Halves on different firmware versions",
  summary:
    "Both halves type, but the peripheral half is dark and its replies look hollow.",
  details: [
    "Seen when the halves run different firmware: key events still flow (the split link is up), but the peripheral half's lighting desyncs and its aux replies come back thin.",
    "Fix is on the vendor side: this app does not flash firmware.",
  ],
  steps: [
    "Compare the two firmware versions in the Devices tab — they must match.",
    "Flash BOTH halves to the same version with the vendor tooling (NayaFlow / NayaCore).",
    "Reconnect both halves and Refresh.",
  ],
} satisfies TroubleEntry;
