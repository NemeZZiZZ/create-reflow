/* Runtime never-send guard for troubleshooting wire traffic.
 * Mirrors the AGENTS.md danger list: fa/* (format/erase), ee/10be + ee/10ae
 * (DFU/MCUBoot resets), 30/10ca (factory format — wipes the layer-list
 * store; stays a text-only recipe, never a button), be/1004 (UNPAIR ALL —
 * drops every Bluetooth bond including computers; text-only repair).
 *
 * Firmware flashing (Phase 9) does not ride this guard: its SMP traffic
 * goes over a procedure-only, consent-gated lane — SmpLink writes raw
 * lines on its own port and NayaSession writes never carry SMP frames.
 *
 * Verdicts (checked, allowed — NOT banned):
 * - fe/1008 keyscan test-mode toggle: benign one-byte SET ([0x01] on /
 *   [0x00] off). Reversible by sending the opposite byte; no erase, no
 *   reset, no store wipe. While ON it streams fe/1009 events, but that is
 *   its documented purpose, not a side effect.
 * - fe/1009 keyscan event stream: read-side event frames (row/col/state).
 *   Carries no destructive effect — the device simply reports switches.
 * - fe/1005 host-OS setting: plain one-byte SET (0 = Windows, 1 = macOS;
 *   never the t19 module 200/201 values). An ordinary settings write, no
 *   more destructive than ed/1012-1014. */

const hex = (n: number) => n.toString(16).padStart(2, "0");

export function assertWireAllowed(t: number, c0: number, c1: number): void {
  const path = `${hex(t)}/${hex(c0)}${hex(c1)}`;
  if (t === 0xfa)
    throw new Error(
      `refused ${path}: fa/* format/erase verbs are on the never-send list`,
    );
  if (t === 0xee && (c1 === 0xbe || c1 === 0xae))
    throw new Error(
      `refused ${path}: DFU/MCUBoot reset verbs are on the never-send list`,
    );
  if (t === 0x30 && c1 === 0xca)
    throw new Error(
      `refused ${path}: factory format wipes the layer-list store — text-only recipe, never a button`,
    );
  if (t === 0xbe && c1 === 0x04)
    throw new Error(
      `refused ${path}: UNPAIR ALL drops every bond (computers included) — text-only repair, never a button`,
    );
}
