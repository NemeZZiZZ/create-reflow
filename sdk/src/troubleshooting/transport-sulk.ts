import type { TroubleEntry } from "./index";

export default {
  id: "transport-sulk",
  title: "Device stopped answering mid-session",
  summary: "The CDC engine occasionally wedges after rapid write/read cycles.",
  details: [
    "Typical trigger: an aborted multipart read leaves the device cursor mid-stream.",
    "FW 3.28.7 wedges hard after a write longer than 2 frames (3+ frames) and stays wedged until a re-plug — this app chunks writes on record boundaries to stay under that.",
    "A power switch OFF/ON while on USB resets only that one half — measured safe, halves are independent.",
    "ee/10ce drops the port instantly and the half answers again in a few seconds (allow up to ~30 s on slow hosts). Windows quirk: the 3rd consecutive software restart can drop the USB device — re-plug.",
  ],
  steps: [
    "Safe reboot (button below), wait a few seconds, then Connect again.",
    "If a reboot does not clear it, flip the power switch off/on, or re-plug USB.",
  ],
  actions: [
    {
      label: "Safe reboot (ee/10ce)",
      side: "left",
      confirm:
        "Reboot the LEFT half? It drops for ~30 s and reconnects automatically.",
      steps: [
        {
          t: 0xee,
          c0: 0x10,
          c1: 0xce,
          params: [0],
          tolerateNoReply: true,
          note: "safe reboot",
        },
      ],
    },
  ],
} satisfies TroubleEntry;
