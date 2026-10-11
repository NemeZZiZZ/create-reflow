/* Keyscan live test mode + host-OS setting — fe/1008 toggle, fe/1009
 * event-stream parse, fe/1005 host-OS op.
 *
 * Wire facts (OpenFlow parity): the fe/1009 event payload is
 * [row, col, state, ...] — ≥3 bytes; parse the FIRST 3 bytes only and log
 * any extra (OF service.py:1493-1516; KB cdc-protocol.md:784-785).
 * GOTCHA: the state byte is the raw switch state — STATE 0 = PRESS,
 * INVERTED vs intuition; any non-zero state means release.
 *
 * fe/1005 TRAP: the host-OS payload byte is 0 = Windows, 1 = macOS —
 * NEVER the 200/201 values the t19 module system uses for host OS.
 * The send path never reads the reply (OF parity) — the ACK frame shape
 * is unproven (moduleCfg precedent). */

import type { SettingsOp } from './draft';

export interface KeyScanEvent {
  row: number;
  col: number;
  pressed: boolean;
}

/** Parse a fe/1009 keyscan event payload: [row, col, state, ...].
 * Returns null for payloads shorter than 3 bytes (all three fields are
 * required); else reads the first three bytes only — extra bytes are
 * OF-parity log material, never parsed. STATE 0 = PRESS (inverted). */
export function parseKeyScanEvent(p: Uint8Array): KeyScanEvent | null {
  if (p.length < 3) return null;
  return { row: p[0]!, col: p[1]!, pressed: p[2] === 0 };
}

/** fe/1005 host-OS wire values — 0 = Windows, 1 = macOS. Not the t19
 * module values (200/201) and never to be confused with them. */
export const HOST_OS = { windows: 0, mac: 1 } as const;

/** fe/1005 host-OS settings op — exactly one payload byte. Rides the
 * existing queueSetting path like the ED ops; reply never inspected
 * (ACK shape unproven). */
export function hostOsOp(os: keyof typeof HOST_OS): SettingsOp {
  return { kind: 'settings', path: 'fe/1005', payload: new Uint8Array([HOST_OS[os]]),
           label: `Set host OS: ${os === 'windows' ? 'Windows' : 'macOS'}` };
}
