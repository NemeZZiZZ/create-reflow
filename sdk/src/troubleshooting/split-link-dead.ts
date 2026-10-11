import type { TroubleEntry } from "./types";
import { pairingVerdict, splitLinkVerdict } from "../ble";
import type { PairingVerdict } from "../ble";

const macText = (m: Uint8Array | null): string =>
  m === null
    ? "—"
    : Array.from(m)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(":");

const PAIRING_TEXT: Record<PairingVerdict, string> = {
  healthy: "mutual addresses, both bond tables hold the partner",
  "half-paired": "one half lost the other (or neither points anywhere)",
  "bond-missing": "addresses are mutual but a bond table lost its partner",
  unknown: "not enough evidence (a read is missing or a table unread)",
};

export default {
  id: "split-link-dead",
  title: "Right-half keys never arrive",
  summary:
    "Both halves power up and answer CDC, but keys on the right half do nothing — the split BLE link between the halves is down.",
  details: [
    "Diagnosis is built in: the read-only check below reads be/1008 (own address), be/1002 (paired peer address) and be/1005 (bond list) on BOTH halves and grades them. Healthy = each half's pair address points at the other, AND each half's bond list holds the partner's address (mutual addresses alone are not proof — seen live 2026-09-25 over an empty bond table).",
    "Clearing the bond on the COMPUTER side alone does not restore the split link.",
    "The repair sequence below is the NayaCore recovery order. be/1004 UNPAIR ALL drops EVERY Bluetooth bond — including your computers — which is why it is text-only here (and refused by the wire guard). Save addresses first; re-pair everything afterwards.",
  ],
  steps: [
    "Save both halves' addresses (be/1008) and bond lists (be/1005) — you will re-pair from these.",
    "On the answering half, in order: be/1001 → wait 300 ms → be/1010 → be/1004 → wait 1 s → ee/10ce reboot. The repair stays manual — this app grades but never sends the repair verbs.",
    "Re-pair the halves to each other, then re-pair your computers.",
  ],
  actions: [
    {
      label: "Check split link (read-only)",
      side: "any",
      run: async (ctx) => {
        const r = await ctx.bleSplitReads();
        for (const side of ["left", "right"] as const) {
          const h = r[side];
          ctx.log(
            "cdc",
            `split-link ${side}: ${h.connected ? "connected" : "OFFLINE"}` +
              `, addr ${macText(h.address)}` +
              `, pair → ${macText(h.pairAddress)}` +
              `, bonds ${
                h.pairedPeers === null
                  ? "unread"
                  : `${h.pairedPeers.length} entr${h.pairedPeers.length === 1 ? "y" : "ies"}`
              }`,
          );
        }
        const pairing = pairingVerdict(
          {
            bleAddress: r.left.address,
            pairAddress: r.left.pairAddress,
            pairedPeers: r.left.pairedPeers,
          },
          {
            bleAddress: r.right.address,
            pairAddress: r.right.pairAddress,
            pairedPeers: r.right.pairedPeers,
          },
        );
        // No relay probe exists in this client (probeReached stays unused):
        // partnerProbe null tells splitLinkVerdict to skip link-down and —
        // everything else clean — grade ok. That caveat is surfaced below.
        const verdict = splitLinkVerdict(
          {
            leftConnected: r.left.connected,
            rightConnected: r.right.connected,
            leftFw: r.leftFw,
            rightFw: r.rightFw,
            pairing,
          },
          null,
        );
        ctx.log("inf", `split-link verdict: ${verdict} (pairing: ${pairing})`);
        const pairingNote = `Pairing: ${PAIRING_TEXT[pairing]}.`;
        if (verdict === "connect-both")
          ctx.toast(
            `Split link: connect BOTH halves over USB and re-check. ${pairingNote}`,
          );
        else if (verdict === "firmware-mismatch")
          ctx.toast(
            `Split link: firmware mismatch (${r.leftFw} vs ${r.rightFw}) — flash both halves to the same version, then re-check.`,
            "error",
          );
        else if (verdict === "pairing-repair")
          ctx.toast(
            `Split link: pairing needs repair — ${PAIRING_TEXT[pairing]}. Run the repair order below.`,
            "error",
          );
        else if (verdict === "link-down")
          ctx.toast(
            `Split link: paired but the radio link is down — power-cycle both halves. ${pairingNote}`,
          );
        else
          ctx.toast(
            `Split link looks healthy — ${PAIRING_TEXT[pairing]}. No relay probe in this client: if keys still don't arrive, power-cycle both halves.`,
            "success",
          );
      },
    },
  ],
} satisfies TroubleEntry;
