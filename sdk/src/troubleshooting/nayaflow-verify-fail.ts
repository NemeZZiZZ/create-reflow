import type { TroubleEntry } from "./types";

export default {
  id: "nayaflow-verify-fail",
  title: "NayaFlow reports “Failed to verify written data”",
  summary:
    "A stock NayaFlow flash after flashing with this app ends in a verify error — benign, nothing is broken.",
  details: [
    "Our keymap writes carry a second-bank T10 shadow record that NayaFlow's verify profile does not describe, and a tapping term that differs from its expected 200 ms — its read-back comparison trips on both.",
    "The same error is expected when NayaFlow flashes right after a 30/10ca factory format.",
  ],
  steps: [
    "Nothing to fix: keys, layers and lighting work. Ignore the NayaFlow verify error.",
  ],
} satisfies TroubleEntry;
