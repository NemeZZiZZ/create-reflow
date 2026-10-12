import type { TroubleEntry } from "./types";

export default {
  id: "bootloader-parked",
  title: "A half enumerates as a bootloader",
  summary:
    "The half shows up with a bootloader USB PID (0x006F left / 0x00D3 right), stays dark and does not type — parked in MCUBoot, not dead, and it does not leave the bootloader on its own.",
  details: [
    "Common after a firmware update that did not complete the image swap.",
    "Cure is an SMP os reset on the answering port — this app speaks SMP now: a Firmware-tab flash run that strands a half rescues it on its own failure path (find the answering bootloader port, os-reset, wait out the window) before it reports the verdict, so a run started here never needs vendor tooling to clean up after itself.",
    "A power cycle brings a parked half back too (nothing already written is lost) — the cheapest cure when no run is in flight. A fresh flash is not the way out of a park: the keyboard procedure starts from an app-mode half.",
  ],
  steps: [
    "Confirm the PID in the OS device list: 0x006F = left bootloader, 0x00D3 = right bootloader.",
    "If a Firmware-tab flash just ran, read its run log — the rescue step states whether the half came back or still needs a power cycle.",
    "Otherwise power-cycle the half first — cheapest cure.",
  ],
} satisfies TroubleEntry;
