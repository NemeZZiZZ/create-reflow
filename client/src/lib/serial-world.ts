/* SerialWorld — the WebSerial seam the firmware flash procedures drive.
 * The procedures never touch `navigator.serial` directly: port discovery
 * (getPorts polling for the re-enumerated MCUboot PID) and the user-gesture
 * grant path are both behind this interface, so the flash core runs
 * unmodified in node smoke tests over scripted fake ports (§72) and in the
 * browser over the real WebSerial API.
 *
 * PortWithInfo is the shape the core consumes: an openable serial port plus
 * the optional USB identity reader — pidInfo() decodes
 * usbProductId into (side, mode, generation); usbVendorId is checked against
 * NAYA_VID when present. getInfo is optional because the smoke's fake ports
 * are plain objects; real SerialPort always carries it.
 *
 * defaultSerialWorld() is node-safe BY CONSTRUCTION: the navigator lookup
 * happens at call time, not module load, and a missing WebSerial API
 * produces a world whose methods reject lazily with a clear reason —
 * constructing the default world under node never throws. */

import type { SmpSerialPortLike } from '@create-reflow/sdk';

export interface PortWithInfo extends SmpSerialPortLike {
  getInfo?: () => { usbVendorId?: number; usbProductId?: number };
}

export interface SerialWorld {
  getPorts(): Promise<PortWithInfo[]>;
  /* The user-gesture path: the browser picker. Filters narrow the picker to
   * Naya devices (usbVendorId). Rejects when the user cancels. */
  requestPort(filters?: Array<{ usbVendorId?: number }>): Promise<PortWithInfo>;
}

const NO_WEBSERIAL = 'no WebSerial — navigator.serial is unavailable in this context';

export function defaultSerialWorld(): SerialWorld {
  const nav = (globalThis as {
    navigator?: { serial?: { getPorts(): Promise<unknown>; requestPort(o?: unknown): Promise<unknown> } };
  }).navigator;
  const serial = nav?.serial;
  if (serial === undefined) {
    return {
      getPorts: async () => {
        throw new Error(NO_WEBSERIAL);
      },
      requestPort: async () => {
        throw new Error(NO_WEBSERIAL);
      },
    };
  }
  return {
    getPorts: async () => (await serial.getPorts()) as PortWithInfo[],
    requestPort: async (filters) =>
      (await serial.requestPort(filters === undefined ? undefined : { filters })) as PortWithInfo,
  };
}
