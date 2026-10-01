import type { TroubleEntry } from "./types";

export default {
  id: "split-link-dead",
  title: "Right-half keys never arrive",
  summary:
    "Both halves power up and answer CDC, but keys on the right half do nothing — the split BLE link between the halves is down.",
  details: [
    "Diagnosis (vendor tooling): compare be/1008 (own address) with be/1002 (paired peer address) on each half, and list be/1005 (bonds). Healthy = each half's bond list holds the other's address.",
    "Clearing the bond on the COMPUTER side alone does not restore the split link.",
    "The repair sequence below is the NayaCore recovery order. be/1004 UNPAIR ALL drops EVERY Bluetooth bond — including your computers — which is why it is text-only here (and refused by the wire guard). Save addresses first; re-pair everything afterwards.",
  ],
  steps: [
    "Save both halves' addresses (be/1008) and bond lists (be/1005) — you will re-pair from these.",
    "On the answering half, in order: be/1001 → wait 300 ms → be/1010 → be/1004 → wait 1 s → ee/10ce reboot (bring your own tooling).",
    "Re-pair the halves to each other, then re-pair your computers.",
  ],
} satisfies TroubleEntry;
