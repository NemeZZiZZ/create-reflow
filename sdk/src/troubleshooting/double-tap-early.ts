import type { TroubleEntry } from "./types";

export default {
  id: "double-tap-early",
  title: "Double-tap fires on the first press",
  summary:
    "A key with a double-tap binding emits the double-tap action immediately — 'aa' instead of 'a' then 'b'.",
  details: [
    "Cause: the double-tap payload sits on a primary record that is NOT a hold-tap (T10) record, so the firmware never waits for the second tap.",
    "This app always builds double-tap as a T10 hold-tap primary — check maps imported from foreign tooling.",
  ],
  steps: [
    "Re-create the binding here: right-click the key → set hold + double-tap in the behavior editor → Flash. That writes a proper T10 primary record.",
  ],
} satisfies TroubleEntry;
