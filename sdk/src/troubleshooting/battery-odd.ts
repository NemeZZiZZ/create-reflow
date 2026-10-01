import type { TroubleEntry } from "./index";

export default {
  id: "battery-odd",
  title: "Battery percentage looks wrong",
  summary:
    "Both percentages shown here are host-computed from raw millivolts — the device never reports a % itself.",
  details: [
    "Millivolts are the raw truth — see the Devices tab. The % is a calibration on top (same clamp shape as the vendor firmware: 3300–4200 mV → 0–100).",
    "On USB with FW 3.41.0 the halves sit at ~4068–4091 mV, which reads as ~85%. That is NORMAL, not a charging defect.",
    "Expect the module % to jump after dock/undock until it settles.",
    "Empty-dock mirages: the right half reports zeros (invalid), the left can report a phantom 4192 mV marked valid. A docked module is detected via the de/1001 presence verb, never via battery plausibility.",
  ],
  steps: ["Nothing to fix — read millivolts if you need precision."],
} satisfies TroubleEntry;
