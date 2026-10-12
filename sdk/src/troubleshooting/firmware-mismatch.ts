import type { TroubleEntry } from "./types";

export default {
  id: "firmware-mismatch",
  title: "Halves on different firmware versions",
  summary:
    "Both halves type, but the peripheral half is dark and its replies look hollow.",
  details: [
    "Seen when the halves run different firmware: key events still flow (the split link is up), but the peripheral half's lighting desyncs and its aux replies come back thin.",
    "Fix: flash both halves to the same version — the Firmware tab does it in one run (both halves picked by default, left first).",
  ],
  steps: [
    "Compare the two firmware versions in the Devices tab — they must match.",
    "Flash both halves to the same version in the Firmware tab — pick the version once; the run flashes each half in turn.",
    "Reconnect both halves and Refresh.",
  ],
} satisfies TroubleEntry;
