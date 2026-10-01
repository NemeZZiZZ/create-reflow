import type { TroubleEntry } from "./types";

export default {
  id: "bootloader-parked",
  title: "A half enumerates as a bootloader",
  summary:
    "The half shows up with a bootloader USB PID (0x006F left / 0x00D3 right), stays dark and does not type — parked in MCUBoot, not dead.",
  details: [
    "Common after a firmware update that did not complete the image swap.",
    "Cure is an SMP os reset on the answering port — this app does not speak SMP; use the vendor tooling (NayaCore / NayaFlow).",
    "A full image re-upload over SMP also works, but is untested by us and high-risk — prefer the plain reset.",
  ],
  steps: [
    "Confirm the PID in the OS device list: 0x006F = left bootloader, 0x00D3 = right bootloader.",
    "If the flashed image is known-good, power-cycle the half first — cheapest cure.",
    "Otherwise use the vendor tooling to send an SMP os reset (or re-flash the image).",
  ],
} satisfies TroubleEntry;
