import type { TroubleEntry } from "./types";

export default {
  id: "all-keys-dead",
  title: "Every key stopped working after a keymap write",
  summary:
    "The board powers up and answers CDC, but no key produces output — a stored hold-tap record carries a flavor byte ≥ 4.",
  details: [
    "Firmware understands flavor bytes 0-3 only; a record written with 4+ wedges the whole key engine.",
    "This app only ever emits 0-3 — the offending record arrives via a foreign profile (other tooling or hand-edited JSON).",
  ],
  steps: [
    "Power-cycle the board — that alone clears the wedge.",
    "Find the offending hold-tap record (Bindings tab → Raw view) and rewrite it with a flavor in 0-3 (Behavior tab → pick a flavor → Flash).",
  ],
} satisfies TroubleEntry;
