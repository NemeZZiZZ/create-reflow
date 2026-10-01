import type { TroubleEntry } from "./index";

export default {
  id: "port-busy",
  title: "“Failed to open serial port” / Resource busy",
  summary: "Another program is holding the CDC port.",
  details: [
    "Serial ports open exclusively — one holder blocks everyone else.",
    "FW 3.28.7 exposes TWO COM ports per half; only one answers and which one is unpredictable. If the first port is deaf, try the other.",
    "After an unclean drop (Windows) a ghost COM port can linger — re-plug USB to clear it.",
    "Linux: add a udev rule for vendor 37d1 so ModemManager ignores the device, or it grabs the port on every plug.",
  ],
  steps: [
    "Quit NayaFlow completely.",
    "Close other browser tabs/windows that opened the keyboard — each open tab holds its port grant.",
    "Click Connect again.",
  ],
} satisfies TroubleEntry;
