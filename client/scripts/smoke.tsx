import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildFrame, toHex, verifyFrame, parseLayer, parseLedmap,
  describeRecord, ledCss, fwVersionText, NayaSession, FrameReader,
  modPresence, modFwText, modRailMv, modPct, batteryMv, batteryPctRough,
  sideFromUsbInfo, hsToHex, hexToHs, isWriteAck,
  hexLuma, readableInk, contrastStroke,
} from '@create-reflow/sdk';
import {
  POS_KEY, POS_SHAPE, SHAPES,
} from '../src/lib/kb-data';
import {
  loadAppShortcuts, detectPlatform, bindOf, appShortcutActionDef, rankAppHits,
} from '../src/lib/app-shortcuts';
import type { AppEntry, ShortcutEntry } from '../src/lib/app-shortcuts';
import {
  loadFirmwareCatalog, parseFirmwareCatalog, keyboardVersions, findKeyboardImage,
} from '../src/lib/firmware-catalog';
import type { FwCatalog, FwEntry } from '../src/lib/firmware-catalog';
import {
  FIRMWARE_SOURCE_BASE, newVault, fetchImage, fetchVersion,
} from '../src/lib/firmware-fetch';
import { NAYA_VID, RECOVERY_PIDS, pidInfo } from '../src/lib/firmware-plat';
import { resolveKeyboardPlan } from '../src/lib/firmware-plan';
import { checkFlashGate } from '../src/lib/firmware-interlocks';
import type { KeyboardGateInput, ModuleGateInput } from '../src/lib/firmware-interlocks';
import { FirmwareRunLog, STEP_LABELS, stableStringify } from '../src/lib/firmware-run-log';
import type { RunEvent } from '../src/lib/firmware-run-log';
import {
  beginFirmwareRun, capturePreflight, endFirmwareRun, firmwareRunActive, startKeyboardRun,
  verifyPreflight,
} from '../src/hooks/useFirmwareFlash';
import { rescanSweep } from '../src/hooks/useSessions';
import { defaultSerialWorld } from '../src/lib/serial-world';
import type { PortWithInfo, SerialWorld } from '../src/lib/serial-world';
import type { Vault } from '../src/lib/firmware-fetch';
import * as fs from 'fs';
import * as path from 'path';
import { keyIconName, shortLabel } from '../src/lib/key-icon-map';
import { ACTIONS, buildRecord, findAction, matchAction } from '@create-reflow/sdk';
import { Draft, opKey, opSection, opSummary, SECTIONS, SECTION_LABELS } from '@create-reflow/sdk';
import type { KeySetOp, LayerListOp } from '@create-reflow/sdk';
import type { KeyRec, LedRec } from '@create-reflow/sdk';
import { parseSnapshotFile, diffSnapshotToDraft, hexToBytes } from '@create-reflow/sdk';
import type { SnapMaps } from '@create-reflow/sdk';
import { timeoutsMs, timeoutsPayload } from '@create-reflow/sdk';
import { parseKeyScanEvent, hostOsOp, sleep } from '@create-reflow/sdk';
import type { KeyScanEvent } from '@create-reflow/sdk';
import {
  SMP, crc16Xmodem, cborEncode, cborDecode, encodeSmpLine, parseSmpChunks, SmpLink,
  SmpDevice, SMP_DEFAULT_TIMEOUTS, resolveUploadImageId,
} from '@create-reflow/sdk';
import type { SmpFrame, SmpSerialPortLike } from '@create-reflow/sdk';
import Keyboard from '../src/components/Keyboard';
import {
  saveAutoBackup,
  listAutoBackups,
  loadAutoBackup,
  deleteAutoBackup,
  hashStr,
} from '@create-reflow/sdk';
import type { StorageLike } from '@create-reflow/sdk';
import { TROUBLES, UNDARK_LADDER, assertWireAllowed } from '@create-reflow/sdk';
import { customHidAction, groupKeyboardCategory, parseCustomHid } from '@create-reflow/sdk';
import { nameToUsage, usageToName, HOST_TABLE_SIZE } from '@create-reflow/sdk';
import { parseOpenFlowLayer, OF_LAYER_UUIDS, buildOpenFlowLayer } from '@create-reflow/sdk';
import {
  parseInventory, encodeLayerListAdd, encodeLayerListDelete, encodeRestorePayload,
  storedAnimOf, storedAnimName, STORED_ANIM_NAMES,
  uuidToBytes, bytesToUuid, mintLayerUuid,
} from '@create-reflow/sdk';
import type { LayerEntry } from '@create-reflow/sdk';
import { queueLayerAdd, queueLayerDelete, pendingLayerAddIdxs } from '@create-reflow/sdk';
import { BAY_LED_RANGES, queueBayColor, queueFillLayer } from '@create-reflow/sdk';
import { chunkStatus, probeDraft } from '@create-reflow/sdk';
import {
  decodeBleStatus, pairingVerdict, splitLinkVerdict, probeReached, parseBlePairs,
  BleCapabilityCache, bleGetPairAddress, bleGetAllPairs, bleGetAddress,
  bleSelectProfile, bleClearProfile, readAux,
} from '@create-reflow/sdk';
import type { BleProfileStatus, SplitLinkReport } from '@create-reflow/sdk';
import { createIoLog, hexHead } from '@create-reflow/sdk';
import {
  MODULE_ADDR, moduleAddr, MODULE_TYPE_CODE,
  encodeListAdd, encodeListDelete, encodeBlankConfig, encodeModuleConfig,
  encodeModuleField, encodeTwoWord, encodeMouseMask, MOUSE_MASK,
  bayRecord, BAY_POSITIONS, BAY_INHERIT,
  fitsChunkBudget, chunkBudget,
} from '@create-reflow/sdk';
import type { DraftDrop, GestureBinding } from '@create-reflow/sdk';
import {
  MODULE_TYPES, FIELD_MAP, AXIS_HALVES, SETTING_FIELDS,
  FIRMWARE_DEFAULTS, LOCKED_GESTURES, PAIRED_GESTURES,
  splitPair, conventionSign, conventionOf, ticksToWire, ticksFromWire,
  halfSelector, gestureField, moduleTypeOfGesture,
  STOCK_PROFILES, StockProfiles,
  overlay, encodeAxisBinding, compareRecords, diffProfile,
  parseModuleProfileFile, buildModuleProfileFile,
} from '@create-reflow/sdk';
import {
  planModuleLayout, planModuleOps, missingBaseBays, orphanGcOps,
  queueModuleConfig, queueModuleListAdd, queueModuleListDelete, queueBayAssignment,
} from '@create-reflow/sdk';
import {
  parseModuleList, recordsFromModuleBlob, matchSlots, captureFromSlots, repointBays,
} from '@create-reflow/sdk';
import type { LayerDump } from '../src/hooks/useLayers';

let n = 0;
function eq(a: unknown, b: unknown, name: string) {
  n++;
  if (a !== b) {
    console.error(`FAIL ${name}: got ${a}, want ${b}`);
    process.exitCode = 1;
  } else console.log(`ok ${n} ${name}`);
}

// 1. fa/1001 request vector (byte-identical to Python cdc-client)
eq(toHex(buildFrame(0x50, 0xfa, 0x10, 0x01, new Uint8Array([0]))),
  'aa 00 50 00 fa 03 10 01 00 11 04', 'fa/1001 frame');
// 2. 30/1004 KK1e->F24 (capture3 exact)
eq(toHex(buildFrame(0x50, 0x30, 0x10, 0x04,
  new Uint8Array([0, 0, 0x1e, 1, 4, 0x73, 0, 7, 0]))),
  'aa 00 50 00 30 0b 10 04 00 00 1e 01 04 73 00 07 00 7b 04', '30/1004 frame');
// 3. 30/100e KK13 H180 S100 (cyan vector, CRC dd)
eq(toHex(buildFrame(0x50, 0x30, 0x10, 0x0e,
  new Uint8Array([0, 0, 0x13, 0xb4, 0x00, 0x64]))),
  'aa 00 50 00 30 08 10 0e 00 00 13 b4 00 64 dd 04', '30/100e frame');
// 4. ACK decode
const ack = verifyFrame(Uint8Array.from([0xaa, 0x50, 0, 0, 0x30, 4, 0x10, 0x0e, 0, 0, 0x1e, 0x04]));
eq(toHex(ack.payload), '00 00', 'ACK payload');
// 5. parseLayer synthetic T01
const pl = parseLayer(new Uint8Array([0x1e, 1, 4, 0x73, 0, 7, 0]));
eq(pl.recs.length === 1 && pl.consumed === 7 ? 'ok' : 'bad', 'ok', 'parseLayer T01');
// 6. describeRecord
eq(describeRecord(new Uint8Array([0x1e, 1, 4, 0x73, 0, 7, 0])), 'F24', 'describe F24');
eq(describeRecord(new Uint8Array([0x2e, 0, 8, 3, 0, 0, 0, 3, 0, 0, 0])), 'BT Device 3', 'describe BTDEV');
// MODMASK suffix (MODMASK = top byte, static Binding::param1 proof)
eq(describeRecord(new Uint8Array([0x1e, 1, 4, 0x1e, 0, 7, 2])), '1 + LShift', 'describe MODMASK');
// T05 family-04 order naming (order 1 = MO layer 1, order 2 = Hold layer 2)
eq(describeRecord(new Uint8Array([0x43, 5, 4, 1, 0, 0, 0])), 'MO layer 1', 'describe MO layer 1');
eq(describeRecord(new Uint8Array([0x3e, 5, 4, 2, 0, 0, 0])), 'Hold layer 2', 'describe Hold layer 2');
// Disabled vs Transparent split (T07 filler vs T0e transparent)
eq(describeRecord(new Uint8Array([0x00, 7, 0])), 'Disabled', 'describe Disabled');
eq(describeRecord(new Uint8Array([0x00, 0x0e, 0])), 'Transparent', 'describe Transparent');
// Mouse Vs (static mouse map: M1 = (3,1) Left, M2 = (3,2) Right, M3 = (3,4) Middle)
eq(describeRecord(new Uint8Array([0x2f, 0x0f, 8, 3, 0, 0, 0, 1, 0, 0, 0])), 'Mouse Left', 'describe mouse left');
eq(describeRecord(new Uint8Array([0x2f, 0x0f, 8, 3, 0, 0, 0, 4, 0, 0, 0])), 'Mouse Middle', 'describe mouse middle');
// T08 output select (static out-map: 1 = USB, 2 = BT)
eq(describeRecord(new Uint8Array([0x00, 8, 4, 1, 0, 0, 0])), 'USB out', 'describe USB out');
eq(describeRecord(new Uint8Array([0x00, 8, 4, 2, 0, 0, 0])), 'BT out', 'describe BT out');
// T06 naya-type (static t19-map, describe-only)
eq(describeRecord(new Uint8Array([0x00, 6, 4, 150, 0, 0, 0])), 'TUNE_MODE_L', 'describe T06');
// T10 27B primary (KK30 probe: hold Y / tap Z) + 10B mini shadow
eq(describeRecord(Uint8Array.from([0x30, 0x10, 0x18, 0xc8, 0, 3, 1, 1, 0, 0xc8, 0, 0x1c, 0, 7, 0, 0, 0, 0, 0, 0x1d, 0, 7, 0, 0, 0, 0, 0])), 'multi: tap Z / hold Y', 'describe T10 primary');
eq(describeRecord(Uint8Array.from([0x74, 0x10, 0x07, 0xc8, 0, 1, 5, 0, 7, 0])), 'multi: double B', 'describe mini shadow');
// T03 24B hold-only multi (KK30 shiftx probe: hold Shift+X / tap Z)
eq(describeRecord(Uint8Array.from([0x30, 0x03, 0x15, 1, 1, 0, 0xc8, 0, 0x1b, 0, 7, 2, 0, 0, 0, 0, 0x1d, 0, 7, 0, 0, 0, 0, 0])), 'multi: tap Z / hold X + LShift', 'describe T03 shiftx');
// LED vendor X-table (static LED map, Y = S|B<<8|H<<16)
eq(describeRecord(new Uint8Array([0x00, 9, 8, 13, 0, 0, 0, 2, 0, 0, 0])), 'LED Swirl', 'describe LED Swirl');
eq(describeRecord(new Uint8Array([0x00, 9, 8, 15, 0, 0, 0, 0x64, 0x46, 0, 0])), 'LED Red', 'describe LED Red');
eq(describeRecord(new Uint8Array([0x00, 9, 8, 15, 0, 0, 0, 0x64, 0, 0, 0])), 'LED White', 'describe LED White');
eq(fwVersionText(new Uint8Array([0, 0, 3, 0x29, 0])), 'v0.3.41.0  [00 00 03 29 00]  ← stock base signature', 'fw text');
eq(ledCss(180, 100), 'hsl(180 100% 50%)', 'ledCss');
// 35. color-picker bridge hex<->H/S
eq(JSON.stringify(hexToHs('#ff0000')), JSON.stringify({ h: 0, s: 100 }), 'hex red');
eq(JSON.stringify(hexToHs('#00ff00')), JSON.stringify({ h: 120, s: 100 }), 'hex green');
eq(JSON.stringify(hexToHs('#0000ff')), JSON.stringify({ h: 240, s: 100 }), 'hex blue');
eq(JSON.stringify(hexToHs('#ffffff')), JSON.stringify({ h: 0, s: 0 }), 'hex white');
eq(String(hexToHs('notacolor')), 'null', 'hex invalid');
eq(hsToHex(0, 100), '#ff0000', 'hs red');
eq(hsToHex(120, 100), '#00ff00', 'hs green');
eq(hsToHex(240, 100), '#0000ff', 'hs blue');
eq(JSON.stringify(hexToHs(hsToHex(38, 100))), JSON.stringify({ h: 38, s: 100 }), 'hs roundtrip amber');
eq(JSON.stringify(hexToHs(hsToHex(300, 70))), JSON.stringify({ h: 300, s: 70 }), 'hs roundtrip magenta');
// 7. parseLedmap synthetic
const lm = parseLedmap(new Uint8Array([0x13, 0xb4, 0, 100, 0x34, 0x2c, 1, 70]));
eq(lm.recs.length === 2 && lm.recs[0].h === 180 && lm.recs[1].h === 300 ? 'ok' : 'bad', 'ok', 'parseLedmap');
// 8. kb-data integrity
eq(String(Object.keys(POS_KEY).length), '74', 'POS_KEY 74');
eq(POS_KEY['0'] === 'LA1' && POS_KEY['48'] === 'LC4' ? 'ok' : 'bad', 'ok', 'POS_KEY spot');
const missing = POS_SHAPE.filter((s) => !(s in SHAPES));
eq(missing.length === 0 ? 'ok' : 'missing ' + missing.join(','), 'ok', 'all shapes defined');
eq(SHAPES['Ve'].w === '44' && SHAPES['Ltt'].w === '112' ? 'ok' : 'bad', 'ok', 'shape sizes');
// 9. Keyboard static render smoke
const html = renderToStaticMarkup(
  createElement(Keyboard, { keymap: new Map(), ledmap: new Map(), ledMode: true, sel: new Set([0]), onSelect: () => {} }),
);
const keys = (html.match(/data-pos="/g) || []).length;
eq(String(keys), '74', 'render 74 keys');
eq(html.includes('LA1') && html.includes('width="112"') ? 'ok' : 'bad', 'ok', 'render legends+wide');
// 10. module decoders (live-proven vectors, see docs/modules.md)
const mp = modPresence(Uint8Array.from([0, 1, 0x10, 0]));
eq(mp !== null && mp.present && mp.type === 'Touch' ? 'ok' : 'bad', 'ok', 'modPresence Touch-L');
const mp2 = modPresence(Uint8Array.from([0, 1, 0x21, 0x63]));
eq(mp2 !== null && mp2.present && mp2.type === 'Track' ? 'ok' : 'bad', 'ok', 'modPresence Track-R');
eq(modPresence(Uint8Array.from([0, 0, 0xf0, 0]))?.present === false ? 'ok' : 'bad', 'ok', 'modPresence absent');
  eq(modFwText(Uint8Array.from([0, 0x10, 0, 0, 2, 3, 3])), 'v0.2.3.3', 'modFwText');
eq(modFwText(Uint8Array.from([0, 0, 0, 0, 0, 0, 0])), null, 'modFwText empty');
eq(String(modRailMv(Uint8Array.from([0, 0x0f, 0x50, 0]))), '3920', 'modRailMv');
eq(String(modPct(3709)), '45', 'modPct lo');
eq(String(modPct(4222)), '100', 'modPct hi');
eq(String(batteryMv(Uint8Array.from([0, 0x0f, 0xf1]))), '4081', 'batteryMv');
eq(String(batteryPctRough(4081)), '85', 'batteryPctRough');
// 11. disabled render: clicks ignored (no onSelect wire) + dimmed
const dhtml = renderToStaticMarkup(
  createElement(Keyboard, { keymap: new Map(), ledmap: new Map(), ledMode: true, sel: new Set(), onSelect: () => {}, disabled: true }),
);
eq(dhtml.includes('opacity-50') ? 'ok' : 'bad', 'ok', 'disabled dimmed');
// 12. already-open port reuse (double-open regression: InvalidStateError
// on port.open must not kill connect when the port is genuinely usable).
const faResp = (() => {
  const pay = new Uint8Array([0x65]);
  const crc = 0x10 ^ 0x01 ^ pay[0];
  return new Uint8Array([0xaa, 0x50, 0, 0, 0xfa, 3, 0x10, 0x01, pay[0], crc, 0x04]);
})();
function mockReader() {
  let cancelled = false;
  return {
    async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
      if (cancelled) return { value: undefined, done: true };
      await new Promise((r) => setTimeout(r, 5));
      if (cancelled) return { value: undefined, done: true };
      return { value: faResp, done: false };
    },
    async cancel() { cancelled = true; },
    releaseLock() {},
  };
}
const mockWriter = { async write(_b: Uint8Array) {}, releaseLock() {} };
// Duplex fake serial port: answers every request frame after delayMs with a
// CRC-valid response echoing TYPE/C0/C1. Logs wire events for atomicity checks.
function duplexFake(delayMs: number) {
  const events: string[] = [];
  let queue: Uint8Array[] = [];
  let waiter: (() => void) | null = null;
  let cancelled = false;
  const tag = (f: Uint8Array) => f[4].toString(16) + '/' + f[6].toString(16) + f[7].toString(16);
  const enqueue = (c: Uint8Array) => {
    if (cancelled) return;
    queue.push(c);
    if (waiter) { const w = waiter; waiter = null; w(); }
  };
  const reader = {
    async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
      for (;;) {
        if (cancelled) return { value: undefined, done: true };
        const c = queue.shift();
        if (c) return { value: c, done: false };
        await new Promise<void>((res) => { waiter = res; });
      }
    },
    async cancel() {
      cancelled = true;
      if (waiter) { const w = waiter; waiter = null; w(); }
    },
    releaseLock() {},
  };
  const writer = {
    async write(b: Uint8Array) {
      const bytes = Uint8Array.from(b);
      const rq = verifyFrame(bytes); // throws on malformed request
      events.push('W' + tag(bytes));
      const resp = buildFrame(0x50, rq.type, rq.c0, rq.c1, new Uint8Array([0x00]));
      verifyFrame(resp);
      setTimeout(() => { events.push('R' + tag(resp)); enqueue(resp); }, delayMs);
    },
    releaseLock() {},
  };
  const port = {
    readable: { locked: false, getReader: () => reader },
    writable: { getWriter: () => writer },
    async open() {}, async setSignals() {}, async close() {},
  };
  return { port, events };
}
let openCalls = 0;
const livePort = {
  readable: { getReader: () => mockReader() }, // non-null = already open
  writable: { getWriter: () => mockWriter },
  async open() { openCalls++; throw new DOMException('already open', 'InvalidStateError'); },
  async setSignals() {},
  async close() {},
};
async function main() {
const ses = await NayaSession.connect(livePort as unknown as SerialPort, 0x50, null);
eq(typeof ses.cmd === 'function' ? 'ok' : 'bad', 'ok', 'reuse connect ok');
eq(String(openCalls), '0', 'open skipped on live port');
await ses.close();
// 13. genuinely dead port still rethrows (no silent swallow)
const deadPort = {
  readable: null, writable: null,
  async open() { throw new Error('no device'); },
  async setSignals() {}, async close() {},
};
let threw = false;
try {
  await NayaSession.connect(deadPort as unknown as SerialPort, 0x50, null);
} catch { threw = true; }
  eq(threw ? 'ok' : 'bad', 'ok', 'dead port rethrows');
  // 45. locked readable (two concurrent connects racing on one port):
  // must throw a clean actionable Error, never a raw TypeError.
  const lockedPort = {
    readable: { locked: true, getReader: () => { throw new TypeError('already locked'); } },
    writable: { getWriter: () => mockWriter },
    async open() {}, async setSignals() {}, async close() {},
  };
  let lockedMsg = '';
  try {
    await NayaSession.connect(lockedPort as unknown as SerialPort, 0x50, null);
  } catch (e) { lockedMsg = (e as Error).message; }
  eq(lockedMsg.includes('locked') && !(lockedMsg.includes('ReadableStream')) ? 'ok' : 'bad', 'ok', 'locked reader clean error');
  // 46. concurrent cmds stay atomic (mutex regression: the 1s presence tick
  // vs dumpAll interleaving used to eat responses -> "sync lost waiting cmd").
  const fx = duplexFake(30);
  const fReader = fx.port.readable.getReader();
  const fWriter = fx.port.writable.getWriter();
  const fFr = new FrameReader(fReader as unknown as ReadableStreamDefaultReader<Uint8Array>);
  const fSes = new NayaSession(
    fx.port as unknown as SerialPort, 0x50, fFr,
    fWriter as unknown as WritableStreamDefaultWriter<Uint8Array>,
    fReader as unknown as ReadableStreamDefaultReader<Uint8Array>,
    async (b) => { await fWriter.write(b); }, null,
  );
  const [ra, rb] = await Promise.all([
    fSes.cmd(0x30, 0x10, 0x01, new Uint8Array([0, 0])),
    fSes.cmd(0xde, 0x10, 0x01, new Uint8Array([0])),
  ]);
  eq(ra.type === 0x30 && ra.c1 === 0x01 ? 'ok' : 'bad', 'ok', 'mutex cmdA matched');
  eq(rb.type === 0xde && rb.c1 === 0x01 ? 'ok' : 'bad', 'ok', 'mutex cmdB matched');
  let atomic = true;
  const openCmds = new Set<string>();
  for (const e of fx.events) {
    const k = e.slice(1);
    if (e[0] === 'W') { if (openCmds.size > 0) atomic = false; openCmds.add(k); }
    else openCmds.delete(k);
  }
  eq(atomic && openCmds.size === 0 ? 'ok' : 'bad', 'ok', 'mutex wire atomicity');
  await fSes.close();
// 14-17. USB PID side hint (no wire needed)
eq(sideFromUsbInfo({ usbVendorId: 0x37d1, usbProductId: 100 }), 'left', 'pid100=left');
eq(sideFromUsbInfo({ usbVendorId: 0x37d1, usbProductId: 200 }), 'right', 'pid200=right');
eq(sideFromUsbInfo({ usbVendorId: 0x37d1, usbProductId: 999 }), null, 'unknown pid=null');
eq(sideFromUsbInfo({ usbVendorId: 0x1234, usbProductId: 100 }), null, 'foreign vid=null');
console.log('done', n, 'checks');
// 49+. keycap icon mapping (pure) + extracted asset integrity (fs)
const iconCases: Array<[string, string | null]> = [
  ['Backspace', 'BACKSPACE'], ['Caps Lock', 'CAPSLOCK'], ['Space', 'SPACE'],
  ['Enter', 'RETURN'], ['Tab', 'TAB'], ['Esc', 'ESC'], ['Delete', 'DELETE'],
  ['LCtrl', 'LCTRL'], ['RGUI', 'RGUI'], ['LAlt', 'LALT'], ['↑', 'UP'],
  ['Page Down', 'PG_DN'], ['Num Lock', 'KP_NUMLOCK'],
  ['Play/Pause', 'C_PLAY_PAUSE'], ['Mute', 'C_MUTE'],
  ['Volume −', 'C_VOL_DOWN'], ['Next Track', 'C_NEXT'],
  ['Prev Track', 'C_PREVIOUS'], ['Mouse Left', 'MOUSE_LEFT'],
  ['Mouse Right', 'MOUSE_RIGHT'], ['BT Device 1', 'BT_DEVICE_1'],
  ['BT Device 5', 'BT_DEVICE_5'],   ['Hold layer 2', 'HOLD_LAYER_2'],
  ['MO layer 1', 'MO_LAYER_1'],
  ['BT Clear', 'BT_CLEAR'],
  ['special 43 05 04 01 00 00 00', 'MO_LAYER_1'],
  ['special 44 05 04 01 00 00 00', 'MO_LAYER_1'],
  ['special 3e 05 04 02 00 00 00', null],
  ['USB out', null], ['BT out', null],
  ['TUNE_MODE_L', null], ['WINDOWS_OS', null],
  ['multi: tap Z / hold Y', null],
  ['Disabled', null], ['Transparent', null],
  ['LED Swirl', null], ['LED Red', null],
  ['A', null], ['LShift', null], ['RShift', null], ['Menu', null],
  ['F13', null],   ['Mouse Middle', null], ['Stop', null], ['Power', null],
  ['LED effect #2', null], ['Disabled', null], ['Transparent', null],
];
for (const [d, want] of iconCases)
  eq(keyIconName(d), want, 'icon ' + JSON.stringify(d));
const iconDir = path.join(
  process.env.SMOKE_ROOT ?? process.cwd(),
  'src', 'assets', 'key-icons',
);
const diskFiles = new Set(fs.readdirSync(iconDir).filter((f) => f.endsWith('.svg')));
  eq(diskFiles.size, 860, '860 icon files on disk (full NayaFlow action set)');
const tsSrc = fs.readFileSync(path.join(
  process.env.SMOKE_ROOT ?? process.cwd(),
  'src', 'lib', 'key-icons.ts',
), 'utf8');
const imported = new Set([...tsSrc.matchAll(/key-icons\/([A-Z0-9_]+)\.svg\?raw/g)].map((m) => m[1] + '.svg'));
  eq(imported.size, 54, '54 ?raw imports (curated keycap subset)');
eq([...imported].every((f) => diskFiles.has(f)) ? 'ok' : 'bad', 'ok', 'all ?raw imports exist on disk');
let iconOk = true;
for (const f of diskFiles) {
  const s = fs.readFileSync(path.join(iconDir, f), 'utf8');
  // Full set: svg root + some viewBox + no #fff + currentColor. 29 NayaFlow
  // originals use non-40x40 viewBoxes (24/48/40x45…) — allowed here; the
  // render-critical curated subset is pinned to 40x40 below.
  if (!s.trimStart().startsWith('<svg') || !/viewBox="0 0 \d+ \d+"/.test(s) ||
      /#fff|#FFF|#ffffff/i.test(s) || !s.includes('currentColor')) { iconOk = false; break; }
}
eq(iconOk ? 'ok' : 'bad', 'ok', 'icons svg + viewBox + currentColor, no #fff');
let icon40Ok = true;
for (const f of imported) {
  const s = fs.readFileSync(path.join(iconDir, f), 'utf8');
  if (!s.includes('viewBox="0 0 40 40"')) { icon40Ok = false; break; }
}
eq(icon40Ok ? 'ok' : 'bad', 'ok', 'curated keycap icons are 40x40');
for (const d of ['Backspace', 'BT Device 3', 'Hold layer 2', 'MO layer 1', 'BT Clear', 'special 43 05 04 01 00 00 00']) {
  const nm = keyIconName(d);
  eq(nm !== null && diskFiles.has(nm + '.svg') ? 'ok' : 'bad', 'ok', 'mapped file exists: ' + d);
}
// palette chain: every catalog action must survive buildRecord(0 dummy KK) +
// describeRecord + keyIconName without throwing.
let paletteOk = true;
for (const a of ACTIONS) {
  try {
    keyIconName(describeRecord(buildRecord(0, a.body())));
  } catch {
    paletteOk = false;
    break;
  }
}
eq(paletteOk ? 'ok' : 'bad', 'ok', 'palette icon chain over catalog');
// palette text fallback = keycap legend: LShift/RShift, not Left/Right Shift.
const shiftL = ACTIONS.find((a) => a.id === 'hid:225')!;
const shiftR = ACTIONS.find((a) => a.id === 'hid:229')!;
eq(shortLabel(buildRecord(0, shiftL.body())), 'LShift', 'palette LShift');
eq(shortLabel(buildRecord(0, shiftR.body())), 'RShift', 'palette RShift');
console.log('done-icons', n, 'checks');

// 14. actions.ts catalog + builders
eq(ACTIONS.length > 110 ? 'ok' : 'bad: ' + ACTIONS.length, 'ok', 'catalog size');
const recQ = buildRecord(0x30, ACTIONS.find((a) => a.id === 'hid:20')!.body());
eq(toHex(recQ), '30 01 04 14 00 07 00', 'build hid Q');
const recBt = buildRecord(0x2e, ACTIONS.find((a) => a.id === 'bt:1')!.body());
eq(toHex(recBt), '2e 00 08 03 00 00 00 01 00 00 00', 'build BT1 (matches probe3)');
eq(matchAction(recBt)?.id, 'bt:1', 'matchAction BT1');
eq(matchAction(recQ)?.id, 'hid:20', 'matchAction Q');
eq(matchAction(new Uint8Array([0x30, 0x05, 0x04, 1, 0, 0, 0]))?.id, 'special:1', 'match MO');
eq(matchAction(new Uint8Array([0x30, 0x05, 0x04, 2, 0, 0, 0]))?.id, 'hold2', 'match Hold2');
eq(matchAction(new Uint8Array([0x30, 0x78, 0x00]))?.id, 'empty', 'match empty');
// out select (T08, static out-map) + BT Clear Vs
eq(matchAction(new Uint8Array([0x00, 8, 4, 1, 0, 0, 0]))?.id, 'out:usb', 'match out:usb');
eq(matchAction(new Uint8Array([0x00, 8, 4, 2, 0, 0, 0]))?.id, 'out:bt', 'match out:bt');
eq(matchAction(new Uint8Array([0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0]))?.id, 'bt-clear', 'match bt-clear');
// LED catalog (X=13 effects, X=15 colors; Y = S|B<<8|H<<16)
eq(matchAction(new Uint8Array([0, 9, 8, 13, 0, 0, 0, 2, 0, 0, 0]))?.id, 'led:13:2', 'match led swirl');
eq(matchAction(new Uint8Array([0, 9, 8, 13, 0, 0, 0, 0, 0, 0, 0]))?.id, 'led:13:0', 'match led solid');
eq(matchAction(new Uint8Array([0, 9, 8, 15, 0, 0, 0, 0x64, 0x46, 0, 0]))?.id, 'led:15:18020', 'match led red');
eq(matchAction(new Uint8Array([0, 9, 8, 15, 0, 0, 0, 0x64, 0, 0, 0]))?.id, 'led:15:100', 'match led white');
eq(matchAction(new Uint8Array([0x30, 0x03, 0x15, 1, 2, 3])), undefined, 'no match T03');

// 15. draft.ts queue logic
const d1 = new Draft();
d1.add({ kind: 'key', layer: 0, kk: 0x30, record: recQ, label: 'Q' });
d1.add({ kind: 'key', layer: 0, kk: 0x30, record: buildRecord(0x30, ACTIONS.find((a) => a.id === 'hid:21')!.body()), label: 'W' });
eq(d1.ops.length, 1, 'latest op wins same kk');
d1.add({ kind: 'led', layer: 0, kk: 0x30, h: 180, s: 100 });
eq(d1.ops.length, 2, 'key+led coexist');
d1.add({ kind: 'led', layer: 1, kk: 0x30, h: 300, s: 70 });
eq(d1.ops.length, 3, 'per-layer led ops');
// reconcile: device already has W at L0 KK30 and cyan at L0 KK30
const dropped = d1.reconcile(
  [[{ kk: 0x30, t: 1, rec: buildRecord(0x30, ACTIONS.find((a) => a.id === 'hid:21')!.body()), offset: 0 }], [], []],
  [[{ kk: 0x30, h: 180, s: 100, offset: 0 }], [], []],
);
eq(dropped, 2, 'reconcile drops satisfied');
eq(d1.ops.length === 1 && d1.ops[0].kind === 'led' && d1.ops[0].layer === 1 ? 'ok' : 'bad', 'ok', 'reconcile keeps unsatisfied');
d1.clear();
eq(d1.size, 0, 'clear');
const d2 = new Draft();
d2.add({ kind: 'key', layer: 0, kk: 0x1e, record: recQ, label: 'Q' });
d2.add({ kind: 'led', layer: 0, kk: 0x1e, h: 38, s: 100 });
const st = d2.stats();
eq(st.ops === 2 && st.frames === 2 && st.bytes === 10 + 2 + 7 + 16 ? 'ok' : 'bad', 'ok', 'stats frames/bytes');

// 16. timeouts codec
const factoryTo = new Uint8Array(13);
{
  const dv = new DataView(factoryTo.buffer);
  dv.setUint32(1, 90000, true); dv.setUint32(5, 300000, true); dv.setUint32(9, 30000, true);
}
eq(JSON.stringify(timeoutsMs(factoryTo)), JSON.stringify({ idleMs: 90000, sleepMs: 300000, deepMs: 30000 }), 'timeoutsMs factory');
const rt = timeoutsPayload(6000000, 6000000, 30000);
eq(rt.length === 13 && timeoutsMs(rt)!.idleMs === 6000000 ? 'ok' : 'bad', 'ok', 'timeouts roundtrip');
eq(timeoutsMs(new Uint8Array([1, 2, 3])), null, 'timeoutsMs rejects short');
}

// 17. write ACK layer echo (live-proven 2026-09-17: device echoes layer)
{
  const u = (s: string) => s.split(' ').map((h) => parseInt(h, 16));
  eq(isWriteAck(u('00 00'), 0), true, 'ack L0');
  eq(isWriteAck(u('00 01'), 1), true, 'ack L1 echo');
  eq(isWriteAck(u('00 02'), 2), true, 'ack L2 echo');
  eq(isWriteAck(u('00 00'), 1), true, 'ack 00 accepted any layer');
  eq(isWriteAck(u('00 03'), 1), false, 'ack wrong layer rejected');
  eq(isWriteAck(u('01 00'), 0), false, 'ack nonzero status rejected');
  eq(isWriteAck(u('00'), 0), false, 'ack short rejected');
  eq(isWriteAck(u('00 00 00'), 0), false, 'ack long rejected');
}

// 18. snapshot import (restore-from-file)
{
  const rec7 = new Uint8Array([0x1e, 0x01, 0x04, 0x73, 0x00, 0x07, 0x00]);
  // TODO(task5/task6): rework — the legacy naya-backup / naya-reflow import
  // formats were removed (clean break, 2026-10), so the two parse asserts
  // ('backup snapshot parses', 'web keymap export parses') are gone. The
  // diffSnapshotToDraft coverage below is unchanged and now runs on literal
  // SnapMaps; OpenFlow parse coverage lives in §48/§50.
  const liveKeys: KeyRec[][] = [[{ kk: 0x1e, t: 1, rec: rec7, offset: 0 }], [], []];
  const liveLeds: LedRec[][] = [[{ kk: 0x1e, h: 180, s: 100, offset: 0 }], [], []];
  const d0 = new Draft();
  const snap0: SnapMaps = {
    keys: [[{ kk: 0x1e, t: 1, rec: rec7, offset: 0 }]],
    leds: [[{ kk: 0x1e, h: 180, s: 100, offset: 0 }]],
    layers: [0],
  };
  const r0 = diffSnapshotToDraft(d0, snap0, liveKeys, liveLeds);
  eq(r0.keysQueued + r0.ledsQueued + d0.size, 0, 'identical snapshot queues nothing');
  const rec7b = new Uint8Array([0x1e, 0x01, 0x04, 0x73, 0x00, 0x08, 0x00]);
  const snap2: SnapMaps = {
    keys: [[{ kk: 0x1e, t: 1, rec: rec7b, offset: 0 }]],
    leds: [[{ kk: 0x1e, h: 180, s: 99, offset: 0 }]],
    layers: [0],
  };
  const d1 = new Draft();
  const r1 = diffSnapshotToDraft(d1, snap2, liveKeys, liveLeds);
  eq(r1.keysQueued === 1 && r1.ledsQueued === 1 && d1.size === 2 ? 'ok' : 'bad', 'ok', 'changed key+led queued');
  const snap3: SnapMaps = {
    keys: [[], [{ kk: 5, t: 1, rec: new Uint8Array([5, 1, 4, 1, 2, 3, 4]), offset: -1 }], []],
    leds: [[], [], []],
    layers: [1],
  };
  const d2 = new Draft();
  const r2 = diffSnapshotToDraft(d2, snap3, [[], [], []], [[], [], []]);
  eq(r2.skippedMissing, 1, 'no live counterpart skipped');
  const d3 = new Draft();
  const rec11 = new Uint8Array([9, 1, 8, 1, 2, 3, 4, 5, 6, 7, 8]);
  const r3 = diffSnapshotToDraft(d3, {
    keys: [[{ kk: 9, t: 1, rec: rec7, offset: 0 }], [], []],
    leds: [[{ kk: 9, h: 10, s: 20, offset: -1 }], [], []], layers: [0],
  }, [[{ kk: 9, t: 1, rec: rec11, offset: 0 }], [], []], [[{ kk: 9, h: 10, s: 20, offset: 0 }], [], []]);
  eq(r3.keysQueued === 1 && d3.size === 1 && d3.ops[0].kind === 'key' ? 'ok' : 'bad',
     'ok', 'plain length change queues a key op (S1: writes apply)');
  eq(d3.ops[0].kind === 'key' && toHex(d3.ops[0].record), toHex(rec7), 'queued record is the snapshot one');
  // live T10 primary + shadow, snapshot plain → keyset downgrade with filler
  const t10p = new Uint8Array(27); t10p[0] = 9; t10p[1] = 0x10; t10p[2] = 0x18;
  const t10s = new Uint8Array(27); t10s[0] = 9 + 0x52; t10s[1] = 0x10; t10s[2] = 0x18;
  const d3b = new Draft();
  const r3b = diffSnapshotToDraft(d3b, {
    keys: [[{ kk: 9, t: 0x10, rec: rec7, offset: 0 }], [], []],
    leds: [[], [], []], layers: [0],
  }, [[{ kk: 9, t: 0x10, rec: t10p, offset: 0 }, { kk: 9 + 0x52, t: 0x10, rec: t10s, offset: 0 }], [], []],
     [[], [], []]);
  eq(r3b.keysQueued === 1 && d3b.size === 1 && d3b.ops[0].kind === 'keyset' ? 'ok' : 'bad',
     'ok', 'T10 live + plain snapshot downgrades via keyset');
  if (d3b.ops[0].kind === 'keyset') {
    eq(d3b.ops[0].records.length, 2, 'downgrade writes primary + shadow filler');
    eq(toHex(d3b.ops[0].records[0]), toHex(rec7), 'primary is the snapshot record');
    eq(toHex(d3b.ops[0].records[1]), '5b 07 00', 'filler clears the shadow slot (NONE type)');
  }
  eq('error' in parseSnapshotFile({ tool: 'nope' }) ? 'err' : 'ok', 'err', 'unknown tool rejected');
}

// 19. draft op model v2 — sections, dedup, stats
{
  const d = new Draft();
  d.add({ kind: 'settings', path: 'ed/1013', payload: new Uint8Array([0, 100]), label: 'max brt 100' });
  d.add({ kind: 'settings', path: 'ed/1013', payload: new Uint8Array([0, 80]), label: 'max brt 80' });
  eq(d.size, 1, 'settings dedup by path');
  eq(d.ops[0].kind === 'settings' && d.ops[0].label, 'max brt 80', 'latest settings op wins');
  eq(opSection(d.ops[0]), 'behavior', 'ed/1013 → behavior section');
  eq(opSection({ kind: 'settings', path: 'ed/1011', payload: new Uint8Array([0, 1]), label: 'anim' }), 'led', 'ed/1011 → led section');
  const ks: KeySetOp = {
    kind: 'keyset', layer: 0, kk: 0x30,
    records: [new Uint8Array(27), new Uint8Array(10)],
    label: 'Z multi',
  };
  d.add(ks);
  eq(opSection(ks), 'bindings', 'keyset → bindings section');
  eq(d.stats().frames, 1 + 2, 'keyset frames = 1 settings + 2 records');
  eq(opKey(ks), 'key:0:48', 'keyset shares the key opKey (latest wins)');
  {
    const dk = new Draft();
    dk.add({ kind: 'key', layer: 0, kk: 0x30, record: new Uint8Array(7), label: 'Z' });
    dk.add({ kind: 'keyset', layer: 0, kk: 0x30, records: [new Uint8Array(7), new Uint8Array(3)], label: 'Z down' });
    eq(dk.size, 1, 'keyset replaces a queued key op on the same key');
    eq(dk.ops[0].kind, 'keyset', 'keyset is the surviving op');
    dk.add({ kind: 'key', layer: 0, kk: 0x30, record: new Uint8Array(7), label: 'Y' });
    eq(dk.size, 1, 'key op replaces a queued keyset (one op)');
    eq(dk.ops[0].kind, 'key', 'surviving op is the key op');
  }
  // keyset reconcile: satisfied only when EVERY record matches device
  // (reconcile looks up device recs by kk === record byte 0)
  const prim = Object.assign(new Uint8Array(27), { 0: 0x30 });
  const shad = Object.assign(new Uint8Array(10), { 0: 0x82 });
  const d2 = new Draft();
  d2.add({ kind: 'keyset', layer: 0, kk: 0x30, records: [prim, shad], label: 'Z multi' });
  const keysLive = [[{ kk: 0x30, rec: prim }, { kk: 0x82, rec: shad }]] as unknown as KeyRec[][];
  eq(d2.reconcile(keysLive, [[]]), 1, 'reconcile drops satisfied keyset');
  eq(d2.size, 0, 'queue empty after keyset reconcile');
  // settings/module opSummary + opKey + stats branches (deferred 1.1 coverage)
  const ds = new Draft();
  ds.add({ kind: 'settings', path: 'ed/1011', payload: new Uint8Array([0, 1]), label: 'Breathe L0' });
  eq(opSummary(ds.ops[0]), 'ed/1011 → Breathe L0', 'settings opSummary');
  ds.add({ kind: 'module', layer: 1, slot: 0, payload: new Uint8Array([0, 1, 1, 0x32]), label: 'Tap → A' });
  eq(opKey(ds.ops[1]), 'module:1:0:00 01 01 32', 'module opKey format');
  eq(opSummary(ds.ops[1]), 'L1 slot 0 → Tap → A', 'module opSummary');
  const sst = ds.stats();
  eq(sst.ops === 2 && sst.frames === 2 && sst.bytes === (10 + 2) + (10 + 2 + 4) ? 'ok' : 'bad',
    'ok', 'stats settings+module branches');
  // has() narrowed to key|led|keyset kinds
  const dh = new Draft();
  dh.add({ kind: 'key', layer: 0, kk: 0x1e, record: new Uint8Array(7), label: 'Q' });
  eq(dh.has('key', 0, 0x1e), true, 'has finds queued key');
  eq(dh.has('led', 0, 0x1e), false, 'has misses other kind');
  eq(dh.has('keyset', 0, 0x1e), false, 'has misses other op shape');
}
// 20. T10/T03 behavior-set records
{
  eq(toHex(t03Record(0x22, 0x09, 0x07)),
     '22 03 15 01 01 00 c8 00 09 00 07 00 00 00 00 00 07 00 07 00 00 00 00 00',
     'T03 24B verbatim (KK22 hold=F tap=D)');
  eq(toHex(t10ShadowMini(0x22, 0x05)), '74 10 07 c8 00 01 05 00 07 00',
     'T10 mini shadow verbatim (KK22 double=B)');
  eq(toHex(t10ShadowFull(0x32, 0x11, 0x05)),
     '84 10 18 c8 00 03 01 01 00 c8 00 11 00 07 00 00 00 00 00 05 00 07 00 00 00 00 00',
     'T10 full shadow verbatim (KK32 pair @84)');
  eq(toHex(t10Primary(0x30, 0x1c, 0x1d)),
     '30 10 18 c8 00 03 01 01 00 c8 00 1c 00 07 00 00 00 00 00 1d 00 07 00 00 00 00 00',
     'T10 primary shape (KK30 hold=Y tap=Z)');
  // parser roundtrips
  const recs = [
    { kk: 0x30, rec: t10Primary(0x30, 0x1c, 0x1d) },
    { kk: 0x82, rec: t10ShadowFull(0x30, 0x1a, 0x1b) },
  ] as unknown as KeyRec[];
  eq(JSON.stringify(behaviorSetOf(recs, 0x30)),
     JSON.stringify({ tap: 0x1d, hold: 0x1c, double: 0x1b, taphold: 0x1a }),
     'behaviorSetOf full set');
  eq(JSON.stringify(behaviorSetOf([{ kk: 0x22, rec: t03Record(0x22, 0x09, 0x07) }] as unknown as KeyRec[], 0x22)),
     JSON.stringify({ tap: 0x07, hold: 0x09, double: null, taphold: null }),
     'behaviorSetOf T03 pair');
  // ops dispatch
  const ops = behaviorSetOps(0x30, { tap: 0x1d, hold: 0x1c, double: 0x1b, taphold: 0x1a }, 0, 'Z multi');
  eq(ops?.records.length, 3, 'full set → primary + full shadow + tail');
  eq(ops?.records[1][0], 0x82, 'shadow at kk+0x52');
  eq(toHex(ops!.records[2]), '4b 02 00', 'T10 tail rides along (S1 writer)');
  const miniOps = behaviorSetOps(0x30, { tap: 0x1d, hold: 0x1c, double: 0x1b, taphold: null }, 0, 'Z');
  eq(miniOps?.records.length, 3, 'double set → primary + mini shadow + tail');
  eq(toHex(miniOps!.records[2]), '4b 02 00', 'mini tail');
  const prevShadow = [
    { kk: 0x30, rec: t10Primary(0x30, 0x1c, 0x1d) },
    { kk: 0x82, rec: t10ShadowFull(0x30, 0x1a, 0x1b) },
  ] as unknown as KeyRec[];
  const downOps = behaviorSetOps(0x30, { tap: 0x1d, hold: 0x1c, double: null, taphold: null }, 0, 'down', prevShadow);
  eq(downOps?.records.length, 2, 'T03 downgrade from T10 → t03 + shadow filler');
  eq(toHex(downOps!.records[1]), '82 07 00', 'stale shadow cleared to filler');
  eq(behaviorSetOps(0x30, { tap: 0x1d, hold: 0x1c, double: null, taphold: null }, 0, 'plain')?.records.length, 1,
     'T03 without prior shadow → single record');
  eq(toHex(plainRecord(0x22, 0x07)), '22 01 04 07 00 07 00', 'plain T01 record (S1 restore shape)');
  eq(behaviorSetOps(0x30, { tap: 0x1d, hold: null, double: null, taphold: null }, 0, 'Z'), null,
     'tap-only → null (downgrade handled by queueBehaviorSet)');
  let threw = false;
  try { behaviorSetOps(0x30, { tap: null, hold: 0x1c, double: null, taphold: null }, 0, 'bad'); }
  catch { threw = true; }
  eq(threw, true, 'chain violation throws');
  // withSlot immutably sets one slot
  const base: BehaviorSet = { tap: 0x1d, hold: null, double: null, taphold: null };
  eq(JSON.stringify(withSlot(base, 'hold', 0x1c)),
     JSON.stringify({ tap: 0x1d, hold: 0x1c, double: null, taphold: null }), 'withSlot sets hold');
  eq(base.hold, null, 'withSlot does not mutate');
  // hidPairOf against the catalog
  const z = findAction('key-z') ?? ACTIONS.find((a) => a.label === 'Z')!;
  eq(hidPairOf(buildRecord(0x30, z.body()))?.hid, 0x1d, 'hidPairOf catalog Z');
}
import {
  t03Record, t10Primary, t10ShadowMini, t10ShadowFull,
  behaviorSetOf, behaviorSetOps, withSlot, hidPairOf,
  plainRecord, hasT10Shadow, cascadeClear,
  behaviorMetaOf, fillerRecord, TAIL_T10,
} from '@create-reflow/sdk';
import type { BehaviorSet } from '@create-reflow/sdk';
import {
  ANIM_NAMES, edTargetValue, animOp, scanModeOp, maxBrtOp, ledOverrideOp,
  parseCmdPath,
} from '@create-reflow/sdk';
import { FLAVORS, flavorById, FLAVOR_BYTES, flavorOfByte } from '@create-reflow/sdk';
import { queueSetting, queueBehaviorSet, describeStatus } from '@create-reflow/sdk';
import { queueModuleGesture } from '@create-reflow/sdk';
import {
  GESTURE_NAMES, gestureName, parseModuleConfig, gesturePayload,
} from '@create-reflow/sdk';

// 21. settings payload builders ([layer, effect] for 1011 per 3.0 spike verdict)
{
  eq(toHex(edTargetValue(0, 100)), '00 64', 'ed [target,value] encoding');
  eq(maxBrtOp(100).path, 'ed/1013', 'maxbrt path');
  eq(toHex(maxBrtOp(100).payload), '00 64', 'maxbrt payload');
  let threw = false;
  try { maxBrtOp(101); } catch { threw = true; }
  eq(threw, true, 'maxbrt range guard');
  eq(toHex(scanModeOp(1).payload), '00 01', 'scanmode payload');
  eq(toHex(ledOverrideOp(2).payload), '00 02', 'override payload');
  eq(toHex(animOp(1, 2).payload), '01 02', 'anim payload [layer,effect]');
  eq(animOp(1, 2).path, 'ed/1011', 'anim path');
  eq(opSection(animOp(1, 2)), 'led', 'anim grouped under LED Map');
  eq(ANIM_NAMES.length, 4, 'four animations');
  threw = false;
  try { animOp(0, 4); } catch { threw = true; }
  eq(threw, true, 'anim range guard');
  // settings opKey carries the target byte: per-layer anims coexist while
  // same-knob values dedup to the latest (fe/100a byte 0 is always 0).
  {
    const d = new Draft();
    d.add(animOp(0, 1));
    d.add(animOp(1, 2));
    eq(d.size, 2, 'anims on different layers coexist');
    d.add(maxBrtOp(90));
    d.add(maxBrtOp(70));
    eq(d.size, 3, 'same path+target deduped');
    eq(opSummary(d.ops[2]).includes('70'), true, 'latest value queued');
  }
  // parseCmdPath: the split('/') trap — '1011' is TWO bytes, not one number
  eq(JSON.stringify(parseCmdPath('ed/1011')), '{"t":237,"c0":16,"c1":17}',
     "parseCmdPath('ed/1011') → ed 10 11");
  eq(JSON.stringify(parseCmdPath('fe/100a')), '{"t":254,"c0":16,"c1":10}',
     "parseCmdPath('fe/100a') → fe 10 0a");
  threw = false;
  try { parseCmdPath('ed/101'); } catch { threw = true; }
  eq(threw, true, 'parseCmdPath rejects a 3-digit body');
  threw = false;
  try { parseCmdPath('ed-1011'); } catch { threw = true; }
  eq(threw, true, 'parseCmdPath rejects a non-slash path');
}
// 22a. Interrupt Flavor policy dictionary (Task 4.1; wire encoding OPEN,
// pending the S1 flavor-diff verdict — display metadata only).
{
  eq(FLAVORS.length, 4, 'four flavor policies');
  eq(FLAVORS.map((f) => f.id).join(','), 'balanced,hold-preferred,tap-preferred,tap-unless-interrupted', 'flavor ids');
  eq(flavorById('balanced')?.name, 'Balanced', 'flavorById balanced');
  eq(flavorById('tap-unless-interrupted')?.name, 'Tap–Unless Interrupted', 'flavorById longest id');
  eq(flavorById('fast'), undefined, 'unknown flavor → undefined');
  eq(new Set(FLAVORS.map((f) => f.id)).size, 4, 'flavor ids unique');
}

// 22b. queueSetting dedups per path
{
  const d = new Draft();
  queueSetting(d, maxBrtOp(90));
  queueSetting(d, maxBrtOp(70));
  eq(d.size, 1, 'same path deduped');
  eq(opSummary(d.ops[0]).includes('70'), true, 'latest value queued');
}

// 22c. queueBehaviorSet tap-only downgrade → plain T01 (+ shadow cleanup)
{
  const d = new Draft();
  const r1 = queueBehaviorSet(d, 0, 0x22, { tap: 0x07, hold: null, double: null, taphold: null }, 200, 'clear hold');
  eq(r1.queued, true, 'tap-only downgrade queues');
  eq(d.ops[0].kind, 'key', 'downgrade without shadow → plain key op');
  eq(toHex((d.ops[0] as { record: Uint8Array }).record), '22 01 04 07 00 07 00',
     'downgrade record = plain T01');
  const prev = [
    { kk: 0x22, rec: t10Primary(0x22, 0x09, 0x07) },
    { kk: 0x74, rec: t10ShadowFull(0x22, 0x1a, 0x1b) },
  ] as unknown as KeyRec[];
  const r2 = queueBehaviorSet(d, 0, 0x22, { tap: 0x07, hold: null, double: null, taphold: null }, 200, 'clear all', prev);
  eq(r2.queued, true, 'downgrade from T10 queues');
  eq(d.size, 1, 'keyset replaces the earlier plain key op (shared opKey)');
  eq(d.ops[0].kind, 'keyset', 'downgrade with shadow → keyset op');
  const recs = (d.ops[0] as { records: Uint8Array[] }).records;
  eq(recs.length, 2, 'plain + filler records');
  eq(toHex(recs[0]), '22 01 04 07 00 07 00', 'primary back to T01');
  eq(toHex(recs[1]), '74 07 00', 'shadow back to filler');
  eq(hasT10Shadow(prev, 0x22), true, 'hasT10Shadow detects stale shadow');
  eq(hasT10Shadow(undefined, 0x22), false, 'hasT10Shadow without cache');
}

// 22d. cascadeClear — clearing a chain slot prunes its dependents
{
  const full: BehaviorSet = { tap: 0x07, hold: 0x09, double: 0x1a, taphold: 0x1b };
  const c1 = cascadeClear(full, 'hold');
  eq(c1.set.hold, null, 'hold cleared');
  eq(c1.set.double, null, 'double cascaded');
  eq(c1.set.taphold, null, 'taphold cascaded');
  eq(c1.set.tap, 0x07, 'tap untouched');
  eq(c1.dropped.join('+'), 'Double Tap+Tap+Hold', 'dropped names reported');
  const c2 = cascadeClear(full, 'double');
  eq(c2.set.hold, 0x09, 'hold kept when clearing double');
  eq(c2.set.taphold, null, 'taphold cascaded with double');
  eq(c2.dropped.join('+'), 'Tap+Hold', 'one dependent dropped');
  const c3 = cascadeClear(full, 'taphold');
  eq(c3.dropped.length, 0, 'leaf slot clears alone');
  eq(c3.set.double, 0x1a, 'double kept');
  // end-to-end: cascade from a full set → tap-only downgrade path
  const d = new Draft();
  const r = queueBehaviorSet(d, 0, 0x22, cascadeClear(full, 'hold').set, 200, 'clear hold (cascade)');
  eq(r.queued, true, 'cascade result queues via downgrade path');
  eq(d.ops[0].kind, 'key', 'no shadow cache → plain key op');
  // reconcile with a stale-shadow downgrade: the device compacts the empty
  // shadow slot out of its dump — filler [kk,00,00] is satisfied by ABSENCE.
  const dS = new Draft();
  const primS = plainRecord(0x22, 0x07);
  const fillS = new Uint8Array([0x74, 0x07, 0x00]);
  dS.add({ kind: 'keyset', layer: 0, kk: 0x22, records: [primS, fillS], label: 'downgrade' });
  eq(dS.reconcile([[{ kk: 0x22, rec: primS }]] as unknown as KeyRec[][], [[]]), 1,
    'keyset reconcile: filler satisfied by absent slot');
  // but a NON-filler record (real shadow) still requires presence
  const dT = new Draft();
  dT.add({ kind: 'keyset', layer: 0, kk: 0x22, records: [primS, new Uint8Array(10)], label: 'multi' });
  eq(dT.reconcile([[{ kk: 0x22, rec: primS }]] as unknown as KeyRec[][], [[]]), 0,
    'missing real shadow keeps op queued');
}

// 23. 30/100b module-config parser (Task 5.1). Fixture = S2 post-restore
// read-back blobs (research/dumps/left-100b-20260918-084110.json:
// L1 205B S2-verified, L0 120B factory zeros).
function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
{
  const L1 = '0001010a0101010a020101320301010104010100050f0801000000ffffffff060f080100000001000000070f0800000000ffffffff080f080000000001000000090f0804000000010000000a0f0804000000ffffffff0b0f0803000000010000000c0f0803000000040000000d0f0803000000020000000e0f0803000000080000000f00001000001100001200001300001400001500001600001700001800001900001a00001b00001c00001d00001e00001f0000200000210000220000230000240000250000260000270000';
  const L2 = '0001010a010101320201011403010101040101000507000607000707000807000907000a07000b07000c07000d0f0804000000ffffffff0e0f0804000000010000000f0f0806000000ffffffff100f0806000000010000001107001207001307001407001507001607001707001807001907001a07001b07001c07001d07001e07001f0000200000210000220000230000240000250000260000270000';
  const cfg = parseModuleConfig(hexBytes(L1), 0);
  eq(cfg !== null, true, 'L1 blob parses');
  eq(cfg!.gestures.length, 40, 'L1 has 40 slots (00..27)');
  eq(cfg!.gestures.map((g) => g.slot).join(','), Array.from({ length: 40 }, (_, i) => i).join(','), 'slots sequential');
  eq(GESTURE_NAMES.length, 9, 'nine host gestures');
  eq(cfg!.gestures[0].gesture, 'MOUSE_HORIZONTAL', 'slot 0 gesture id');
  eq(cfg!.gestures[2].gesture, 'MOUSE_STATIC', 'slot 2 gesture id');
  eq(cfg!.gestures[8].gesture, 'STATIC_ZOOM', 'slot 8 gesture id');
  eq(gestureName(41), 'slot 41', 'unknown slot fallback label');
  eq(toHex(cfg!.gestures[0].actionRaw), '00 01 01 0a', 'slot 0 raw record');
  eq(toHex(cfg!.gestures[2].actionRaw), '02 01 01 32', 'slot 2 raw record');
  eq(cfg!.gestures.slice(0, 5).every((g) => g.flashable), true, 'family-01 slots flashable');
  eq(cfg!.gestures.slice(5).every((g) => !g.flashable), true, '0f/00 families read-only');
  // S2-proven swap rebuild: slot 0 with slot 2 donor byte.
  eq(toHex(gesturePayload(cfg!.gestures[0], [0x32])), '00 01 01 32', 'gesturePayload rebuild');
  let threw = false;
  try { gesturePayload(cfg!.gestures[0], [0x32, 0x00]); } catch { threw = true; }
  eq(threw, true, 'same-length rule enforced');
  threw = false;
  try { gesturePayload(cfg!.gestures[5], [0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]); } catch { threw = true; }
  eq(threw, true, 'unproven family rejected');
  const cfg2 = parseModuleConfig(hexBytes(L2), 1);
  eq(cfg2!.gestures.length, 40, 'L2 has 40 slots');
  eq(toHex(cfg2!.gestures[1].actionRaw), '01 01 01 32', 'L2 slot 1 differs per layer');
  eq(cfg2!.gestures[5].gesture, 'STATIC_SCROLL_VERTICAL', 'L2 slot 5 gesture id');
  eq(cfg2!.gestures[5].flashable, false, '07-family slot read-only');
  eq(parseModuleConfig(new Uint8Array([0x00, 0x01]), 0), null, 'truncated blob → null');
  eq(parseModuleConfig(new Uint8Array(0), 0), null, 'empty blob → null');
}

// 24. queueModuleGesture: S2-proven path only, latest-wins per (layer, slot)
{
  const g = {
    slot: 0,
    gesture: 'MOUSE_HORIZONTAL',
    actionRaw: Uint8Array.from([0x00, 0x01, 0x01, 0x0a]),
    flashable: true,
  };
  const d = new Draft();
  let r = queueModuleGesture(d, 1, g, [0x32]);
  eq(r.queued, true, 'gesture write queued');
  eq(d.size, 1, 'one op');
  eq(d.ops[0].kind, 'module', 'module op kind');
  if (d.ops[0].kind === 'module') {
    eq(d.ops[0].layer, 1, 'op carries layer (30/100c params need it)');
    eq(toHex(d.ops[0].payload), '00 01 01 32', 'op payload = rebuilt record');
  }
  eq(opSummary(d.ops[0]).includes('L1 slot 0'), true, 'summary shows layer+slot');
  // latest-wins: re-queue same target with other bytes replaces, not appends
  r = queueModuleGesture(d, 1, g, [0x14]);
  eq(r.queued, true, 're-queue ok');
  eq(d.size, 1, 'still one op');
  if (d.ops[0].kind === 'module') eq(toHex(d.ops[0].payload), '00 01 01 14', 'payload replaced');
  // same slot on another layer is a separate write
  queueModuleGesture(d, 0, g, [0x32]);
  eq(d.size, 2, 'other layer coexists');
  // guards: unproven family + length change rejected
  r = queueModuleGesture(d, 1, { ...g, flashable: false }, [0x32]);
  eq(r.queued, false, 'non-flashable rejected');
  eq(typeof r.error, 'string', 'rejection explains why');
  r = queueModuleGesture(d, 1, g, [0x32, 0x00]);
  eq(r.queued, false, 'length change rejected');
  eq(d.size, 2, 'rejections queue nothing');
}
// 25. partMatcher — multipart staleness defense: all part replies share the
// t/c0/c1 triple, so stale/duplicate frames from earlier part requests must
// be rejected (layer echo + once-per-raw) instead of splicing a seam into
// the assembled blob ("truncated" re-dump bug after ED writes).
import { partMatcher } from '@create-reflow/sdk';
import type { Frame } from '@create-reflow/sdk';
{
  const mk = (layer: number, data: number[]): Frame => ({
    src: 0,
    dst: 0x50,
    id: 0,
    type: 0x30,
    c0: 0x10,
    c1: 0x03,
    payload: Uint8Array.from([1, layer, ...data]),
    raw: buildFrame(0x50, 0x30, 0x10, 0x03, Uint8Array.from([1, layer, ...data])),
  });
  const match = partMatcher(0);
  eq(match(mk(0, [0xaa])), true, 'fresh L0 part accepted');
  eq(match(mk(1, [0xaa])), false, 'wrong layer echo rejected');
  eq(match(mk(0, [0xaa])), false, 'byte-identical duplicate rejected');
  eq(match(mk(0, [0xbb])), true, 'different-raw L0 part accepted');
  eq(
    match({ ...mk(0, [0xcc]), payload: Uint8Array.from([1]) }),
    false,
    'short payload rejected',
  );
}
// 26. queueAction length handling — the old same-length skip is refuted
// (S1 proved 7B↔27B applies via 30/1004); only missing live records skip,
// and T10 keys downgrade through the keyset+filler path.
import { queueAction } from '@create-reflow/sdk';
{
  const z = findAction('key-z') ?? ACTIONS.find((a) => a.label === 'Z')!;
  const zRec = buildRecord(0x30, z.body());
  // same length → plain key op
  {
    const d = new Draft();
    const r = queueAction(d, [{ layer: 0, kk: 0x30 }], z,
      [[{ kk: 0x30, t: 1, rec: new Uint8Array(7), offset: 0 }], [], []]);
    eq(r.queued === 1 && r.skipped === 0 && d.size === 1 && d.ops[0].kind === 'key' ? 'ok' : 'bad',
       'ok', 'same-length pick queues a key op');
  }
  // length change on a plain key → key op with the new record
  {
    const d = new Draft();
    const vendor11 = new Uint8Array([0x30, 0x01, 0x08, 1, 2, 3, 4, 5, 6, 7, 8]);
    const r = queueAction(d, [{ layer: 1, kk: 0x30 }], z,
      [[], [{ kk: 0x30, t: 1, rec: vendor11, offset: 0 }], []]);
    eq(r.queued === 1 && r.skipped === 0 && d.ops[0].kind === 'key' ? 'ok' : 'bad',
       'ok', 'plain length change queues (no skip)');
    if (d.ops[0].kind === 'key') eq(toHex(d.ops[0].record), toHex(zRec), 'record is the new body');
  }
  // live T10 primary → keyset downgrade with shadow filler
  {
    const d = new Draft();
    const t10p = new Uint8Array(27); t10p[0] = 0x30; t10p[1] = 0x10; t10p[2] = 0x18;
    const r = queueAction(d, [{ layer: 0, kk: 0x30 }], z,
      [[{ kk: 0x30, t: 0x10, rec: t10p, offset: 0 }], [], []]);
    eq(r.queued === 1 && d.size === 1 && d.ops[0].kind === 'keyset' ? 'ok' : 'bad',
       'ok', 'T10 pick downgrades via keyset');
    if (d.ops[0].kind === 'keyset') {
      eq(toHex(d.ops[0].records[0]), toHex(zRec), 'primary is the picked action');
      eq(toHex(d.ops[0].records[1]), '82 07 00', 'filler clears shadow @0x82');
    }
  }
  // plain primary but lingering T10 shadow → still keyset+filler
  {
    const d = new Draft();
    const t10s = new Uint8Array(27); t10s[0] = 0x82; t10s[1] = 0x10; t10s[2] = 0x18;
    const r = queueAction(d, [{ layer: 2, kk: 0x30 }], z,
      [[], [], [{ kk: 0x30, t: 1, rec: new Uint8Array(7), offset: 0 },
                 { kk: 0x82, t: 0x10, rec: t10s, offset: 0 }]]);
    eq(r.queued === 1 && d.ops[0].kind === 'keyset' ? 'ok' : 'bad',
       'ok', 'lingering shadow also downgrades via keyset');
  }
  // no live record → skipped
  {
    const d = new Draft();
    const r = queueAction(d, [{ layer: 0, kk: 0x30 }], z, [[], [], []]);
    eq(r.queued === 0 && r.skipped === 1 && d.size === 0 ? 'ok' : 'bad',
       'ok', 'missing live record still skips');
  }
}
// §27 auto-backups + schema version + golden round-trip (UHK adoption)
{
  const mkStorage = (): StorageLike => {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
    };
  };
  const mkRec = (kk: number, bytes: number[]): KeyRec => ({
    kk,
    t: bytes[1],
    rec: Uint8Array.from(bytes),
    offset: -1,
  });
  // Records are canonical builder output so the save→load round-trip is
  // byte-identical (parse rebuilds the same builders); cache order mirrors
  // parse emission (a chain's records stay together, tail last).
  const keys: KeyRec[][] = [
    [
      mkRec(0x30, [0x30, 0x01, 0x04, 0x1d, 0x00, 0x07, 0x00]), // T01 Z
      mkRec(0x31, Array.from(t03Record(0x31, 0x1b, 0x1d))), // T03 hold X / tap Z
      mkRec(0x32, Array.from(t10Primary(0x32, 0x1b, 0x1d))), // T10 hold X / tap Z
      mkRec(0x84, Array.from(t10ShadowMini(0x32, 0x14))), // double T (@+0x52)
      mkRec(0x4b, Array.from(TAIL_T10)), // chain tail rides the cache
    ],
    [], // layer 1: LED-only cache (either cache alone is restorable state)
    [mkRec(0x1e, [0x1e, 0x01, 0x04, 0x73, 0x00, 0x07, 0x00])], // T01 F24
  ];
  // LED values are hsToHex/hexToHs-exact (8-bit quantization is lossy for
  // some hues) so colors round-trip faithfully.
  const leds: LedRec[][] = [
    [
      { kk: 0x30, h: 240, s: 100, offset: -1 },
      { kk: 0x31, h: 30, s: 100, offset: -1 },
    ],
    [{ kk: 0x2e, h: 0, s: 0, offset: -1 }],
    [{ kk: 0x1e, h: 300, s: 70, offset: -1 }],
  ];
  const blobKeys = keys.map((l) => l.reduce((a, r) => a + r.rec.length, 0));
  const blobLeds = leds.map((l) => l.length * 4);

  const st = mkStorage();
  const r1 = saveAutoBackup(keys, leds, blobKeys, blobLeds, undefined, st);
  eq(r1.status, 'saved', '27 backup saved');
  if (r1.status === 'saved')
    eq(r1.meta.bytes, blobKeys.reduce((a, b) => a + b, 0) + blobLeds.reduce((a, b) => a + b, 0), '27 meta bytes = blob totals');

  const r2 = saveAutoBackup(keys, leds, blobKeys, blobLeds, undefined, st);
  eq(r2.status === 'skipped' && r2.reason, 'unchanged', '27 identical backup deduped');
  eq(listAutoBackups(st).length, 1, '27 list still 1');

  keys[0][0].rec[3] = 0x14; // Z -> T
  const r3 = saveAutoBackup(keys, leds, blobKeys, blobLeds, undefined, st);
  eq(r3.status, 'saved', '27 changed state saved');
  const metas = listAutoBackups(st);
  eq(metas.length, 2, '27 list 2, newest first');
  eq(metas[0].hash !== metas[1].hash, true, '27 hashes differ');

  // save → load round-trip: the container holds per-layer OpenFlow docs,
  // load merges them back into whole-file maps (records byte-identical —
  // the fixture records are canonical builder output; the OF-doc-level
  // round-trip itself lives in §49).
  const snap = loadAutoBackup(metas[0].id, st);
  eq('error' in snap ? 'err' : 'ok', 'ok', '27 load parses');
  if (!('error' in snap)) {
    eq(String(snap.maps.layers), '0,1,2', '27 backup layers');
    eq(toHex(snap.maps.keys[0][0].rec), '30 01 04 14 00 07 00', '27 backup rec is the CHANGED one (newest)');
    eq(snap.maps.leds[0][1].h, 30, '27 backup led hue');
    eq(
      snap.maps.keys[0].map((r) => `${r.kk}:${toHex(r.rec)}`).join('|'),
      keys[0].map((r) => `${r.kk}:${toHex(r.rec)}`).join('|'),
      '27 layer-0 recs round-trip byte-identical (T01+T03+T10 chain+tail)',
    );
    eq(
      snap.maps.leds[0].map((l) => `${l.kk}:${l.h}/${l.s}`).join('|'),
      '48:240/100|49:30/100',
      '27 layer-0 leds round-trip',
    );
    eq(toHex(snap.maps.keys[2][0].rec), '1e 01 04 73 00 07 00', '27 layer-2 rec round-trips');
    eq(snap.maps.leds[2][0].h, 300, '27 layer-2 led hue');
    // Strips round-trip and bays skip silently now — a canonical machine-
    // built backup parses warning-free (the old strip/bay skip warnings are
    // gone by design); the pass-through itself is asserted below.
    eq(snap.warnings.length, 0, '27 canonical backup round-trips warning-free');
    eq(snap.warnings.every((w) => /^layer [0-2]: /.test(w)), true, '27 warnings carry the layer prefix');
  }
  // Pass-through with the layer prefix: an unknown animationId in a stored
  // layer doc surfaces verbatim (loadAutoBackup → parse warnings joined).
  const stW = mkStorage();
  saveAutoBackup(keys, leds, blobKeys, blobLeds, undefined, stW, { 0: 'not-an-anim' });
  const snapW = loadAutoBackup(listAutoBackups(stW)[0].id, stW);
  eq(
    !('error' in snapW) &&
      snapW.warnings.length === 1 &&
      /^layer 0: unknown animationId 'not-an-anim'/.test(snapW.warnings[0]),
    true,
    '27 parse warnings surface with layer prefix (pass-through)',
  );
  eq(deleteAutoBackup(metas[0].id, st), true, '27 delete works');
  eq(deleteAutoBackup(metas[0].id, st), false, '27 delete idempotent-false');
  eq('error' in loadAutoBackup(metas[0].id, st), true, '27 deleted id errors');

  // backup container version peek-guard (the OF doc version>1 guard is §50)
  const stV = mkStorage();
  const inject = (id: string, doc: Record<string, unknown>) =>
    stV.setItem(
      'naya-auto-backups',
      JSON.stringify([{ meta: { id, ts: '', hash: '', bytes: 0 }, doc }]),
    );
  inject('v2', { tool: 'create-reflow', kind: 'backup', v: 2, exportedAt: '', layers: [] });
  const g = loadAutoBackup('v2', stV);
  eq('error' in g && g.error.includes('newer') ? 'newer' : 'other', 'newer', '27 future container version rejected');
  inject('nov', { tool: 'create-reflow', kind: 'backup', exportedAt: '', layers: [] });
  eq('error' in loadAutoBackup('nov', stV) ? 'err' : 'ok', 'ok', '27 container missing v treated as v1');

  // node without storage arg: localStorage undefined -> storage-skip
  const rn = saveAutoBackup(keys, leds, blobKeys, blobLeds);
  eq(rn.status === 'skipped' && rn.reason, 'storage', '27 no storage env skips gracefully');

  // hash sanity
  eq(hashStr('abc') === hashStr('abc'), true, '27 hash deterministic');
  eq(hashStr('abc') !== hashStr('abd'), true, '27 hash separates input');
  eq(/^[0-9a-f]{8}$/.test(hashStr('x')), true, '27 hash 8 hex chars');

  // anims: the param lands as animationId in the stored docs, comes back
  // via load's anims (index into ANIM_NAMES)
  const stA = mkStorage();
  saveAutoBackup(keys, leds, blobKeys, blobLeds, undefined, stA, { 0: 'breathe' });
  const rawA = JSON.parse(stA.getItem('naya-auto-backups') ?? '[]') as Array<{
    meta: { id: string };
    doc: { layers?: Array<{ layer?: { animationId?: string } }> };
  }>;
  eq(rawA[0]?.doc?.layers?.[0]?.layer?.animationId, 'breathe', '27 anims land as animationId');
  eq(rawA[0]?.doc?.layers?.[1]?.layer?.animationId, 'solid', '27 missing anim falls back to solid');
  const snapA = loadAutoBackup(rawA[0]?.meta?.id ?? 'missing', stA);
  eq(!('error' in snapA) && snapA.anims[0], 1, '27 anim byte comes back via load');
  eq(!('error' in snapA) && snapA.anims[1], 0, '27 solid comes back as anim byte 0');

  // notes ride only in the container (OF layer docs carry none) and load back
  const stN = mkStorage();
  saveAutoBackup(keys, leds, blobKeys, blobLeds, { '0:48': 'hello' }, stN);
  const rawN = JSON.parse(stN.getItem('naya-auto-backups') ?? '[]') as Array<{
    meta: { id: string };
    doc: { notes?: Record<string, string> };
  }>;
  eq(rawN[0]?.doc?.notes?.['0:48'], 'hello', '27 notes land in the container');
  const snapN = loadAutoBackup(rawN[0]?.meta?.id ?? 'missing', stN);
  eq(!('error' in snapN) && snapN.maps.notes?.['0:48'], 'hello', '27 notes come back via load');

  // wipe-once: legacy stored content reads as empty; the next save overwrites
  const stL = mkStorage();
  stL.setItem(
    'naya-auto-backups',
    JSON.stringify([
      {
        meta: { id: 'legacy', ts: '', hash: '', bytes: 0 },
        doc: { tool: 'naya-reflow', kind: 'naya-full-backup', v: 2 },
      },
    ]),
  );
  eq(listAutoBackups(stL).length, 0, '27 legacy store reads as empty');
  eq(saveAutoBackup(keys, leds, blobKeys, blobLeds, undefined, stL).status, 'saved', '27 save after legacy wipe succeeds');
  eq(listAutoBackups(stL).length, 1, '27 next save overwrites the legacy store');

  // empty layer caches contribute no doc; an all-empty save skips entirely
  const stE = mkStorage();
  eq(
    saveAutoBackup([[], [keys[0][0]], []], [[], [leds[0][0]], []], [0, blobKeys[0], 0], [0, 4, 0], undefined, stE)
      .status,
    'saved',
    '27 single-layer backup saved',
  );
  const rawE = JSON.parse(stE.getItem('naya-auto-backups') ?? '[]') as Array<{
    doc: { layers?: unknown[] };
  }>;
  eq(rawE[0]?.doc?.layers?.length, 1, '27 empty layer caches skipped in container');
  const st0 = mkStorage();
  eq(
    saveAutoBackup([[], [], []], [[], [], []], [0, 0, 0], [0, 0, 0], undefined, st0).status,
    'skipped',
    '27 all-empty backup skipped',
  );

  // Inventory-width caches: a 5-layer fixture stores 5 layer docs — the
  // pre-Phase-2 fixed-3 loop silently dropped layers 3+.
  const st5 = mkStorage();
  const keys5: KeyRec[][] = [0, 1, 2, 3, 4].map((L) => [
    mkRec(0x30 + L, [0x30 + L, 0x01, 0x04, 0x04, 0x00, 0x07, 0x00]),
  ]);
  const leds5: LedRec[][] = [0, 1, 2, 3, 4].map((L) => [
    { kk: 0x30 + L, h: 30 * L, s: 100, offset: -1 },
  ]);
  const blobK5 = keys5.map((l) => l.reduce((a, r) => a + r.rec.length, 0));
  const blobL5 = leds5.map((l) => l.length * 4);
  const r5 = saveAutoBackup(keys5, leds5, blobK5, blobL5, undefined, st5);
  eq(r5.status, 'saved', '27 5-layer backup saved');
  const raw5 = JSON.parse(st5.getItem('naya-auto-backups') ?? '[]') as Array<{
    meta: { id: string };
    doc: { layers?: unknown[] };
  }>;
  eq(raw5[0]?.doc?.layers?.length, 5, '27 5-layer fixture → 5 layer docs (inventory width, not 3)');
  const snap5 = loadAutoBackup(raw5[0]?.meta?.id ?? 'missing', st5);
  eq(!('error' in snap5) && snap5.maps.layers.join(','), '0,1,2,3,4', '27 5-layer backup loads back layers 0-4');
}

// §32 per-key notes (UHK #8): notes ride ONLY in the backup container —
// OpenFlow layer docs carry no notes field anywhere (assert both facts);
// backups round-trip them and the content hash sees them.
{
  const mkNoteRec = (kk: number): KeyRec => ({
    kk,
    t: 0x01,
    rec: Uint8Array.from([kk, 0x01, 0x04, 0x1d, 0x00, 0x07, 0x00]),
    offset: -1,
  });
  const keys: KeyRec[][] = [
    [mkNoteRec(0x30)],
    [mkNoteRec(0x31)],
    [mkNoteRec(0x32)],
  ];
  const leds: LedRec[][] = [
    [{ kk: 0x30, h: 100, s: 100, offset: -1 }],
    [{ kk: 0x31, h: 100, s: 100, offset: -1 }],
    [{ kk: 0x32, h: 100, s: 100, offset: -1 }],
  ];
  const blobKeys = keys.map((l) => l.reduce((a, r) => a + r.rec.length, 0));
  const blobLeds = leds.map((l) => l.length * 4);
  const notes: Record<string, string> = { '0:48': 'x', '2:48': 'y' };

  // OF layer export: no notes field — not at the top level, not nested.
  const ofDoc = buildOpenFlowLayer(keys[0], leds[0], 0, null).data as Record<string, unknown>;
  eq('notes' in ofDoc, false, '32 OF layer export carries no notes field');
  eq(JSON.stringify(ofDoc).includes('"notes"'), false, '32 OF layer doc has no notes nested either');
  const back = parseSnapshotFile(ofDoc);
  eq('error' in back ? 'err' : 'ok', 'ok', '32 OF export reparses');
  if (!('error' in back)) eq(back.maps.notes, undefined, '32 OF parse yields no notes');

  // backups: notes land at container level only — every stored layer doc
  // stays note-free.
  const mkSt = (): StorageLike => {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
    };
  };
  const st = mkSt();
  const b1 = saveAutoBackup(keys, leds, blobKeys, blobLeds, notes, st);
  eq(b1.status, 'saved', '32 backup with notes saved');
  const raw = JSON.parse(st.getItem('naya-auto-backups') ?? '{}') as Array<{
    doc: { notes?: Record<string, string>; layers?: unknown[] };
  }>;
  eq(raw[0]?.doc?.notes?.['0:48'], 'x', '32 note 0:48 in the container');
  eq(raw[0]?.doc?.notes?.['2:48'], 'y', '32 out-of-layer note 2:48 in the container');
  const layerDocs = raw[0]?.doc?.layers;
  eq(
    Array.isArray(layerDocs) &&
      layerDocs.every((l) => !JSON.stringify(l).includes('"notes"')),
    true,
    '32 stored layer docs stay note-free',
  );
  // notes join the content hash: same notes dedupe, changed notes don't
  const b2 = saveAutoBackup(keys, leds, blobKeys, blobLeds, notes, st);
  eq(b2.status === 'skipped' && b2.reason, 'unchanged', '32 same notes deduped');
  const b3 = saveAutoBackup(keys, leds, blobKeys, blobLeds, { ...notes, '0:48': 'z' }, st);
  eq(b3.status, 'saved', '32 changed note breaks dedupe');
  const metas = listAutoBackups(st);
  const loaded = metas[0] ? loadAutoBackup(metas[0].id, st) : { error: 'none' };
  eq('error' in loaded ? 'err' : 'ok', 'ok', '32 backup load parses');
  if (!('error' in loaded)) {
    eq(loaded.maps.notes?.['0:48'], 'z', '32 backup note round-trips');
  }
}

// §33 cross-source findings: flavor/flag preservation, NONE filler,
// status decode, 30 s timeouts floor.
{
  // NayaFlow-written Z record (research/dumps, all backups): bodyFlags 0,
  // holdFlags 2 (unknown hold-quad byte — preserve verbatim), term 200 LE.
  const Z = hexToBytes(
    '30 03 15 01 01 00 c8 00 1b 00 07 02 00 00 00 00 1d 00 07 00 00 00 00 00',
  );
  const meta = behaviorMetaOf([{ kk: 0x30, rec: Z }], 0x30);
  eq(meta?.bodyFlags ?? -1, 0, '33 meta reads bodyFlags 0');
  eq(meta?.holdFlags ?? -1, 2, '33 meta reads holdFlags 2');
  eq(meta?.termHold ?? -1, 200, '33 meta reads termHold 200');
  eq(behaviorMetaOf([{ kk: 0x31, rec: plainRecord(0x31, 0x1d) }], 0x31), null, '33 meta null on plain record');
  eq(toHex(t03Record(0x30, 0x1b, 0x1d, 200, { bodyFlags: 0, holdFlags: 2 })), toHex(Z), '33 t03Record reproduces Z byte-exact with opts');
  // behaviorSetOps preserves meta from prevRecs when opts omit flags
  const set: BehaviorSet = { tap: 0x1d, hold: 0x1b, double: null, taphold: null };
  const kept = behaviorSetOps(0x30, set, 0, 'z', [{ kk: 0x30, rec: Z }]);
  eq(kept.records.length, 1, '33 T03 set = 1 record');
  eq(toHex(kept.records[0]), toHex(Z), '33 set preserves Z flags through rewrite');
  const over = behaviorSetOps(0x30, set, 0, 'z', [{ kk: 0x30, rec: Z }], { bodyFlags: 1 });
  eq(over.records[0][5], 1, '33 explicit bodyFlags override wins');
  // t10Primary opts wiring (term/body/hold slots)
  const p = t10Primary(0x22, 0x1b, 0x1d, 200, 250, { bodyFlags: 1, holdFlags: 2 });
  eq(p[8], 1, '33 t10 bodyFlags byte');
  eq(p[14], 2, '33 t10 holdFlags byte');
  eq(p[9] | (p[10] << 8), 250, '33 t10 termDouble LE');
  // flavor byte mapping (cross-source; 3 = inferred)
  eq(FLAVOR_BYTES['hold-preferred'], 0, '33 flavor hp=0');
  eq(FLAVOR_BYTES['balanced'], 1, '33 flavor bal=1');
  eq(FLAVOR_BYTES['tap-preferred'], 2, '33 flavor tp=2');
  eq(FLAVOR_BYTES['tap-unless-interrupted'], 3, '33 flavor tui=3');
  eq(flavorOfByte(FLAVOR_BYTES['tap-preferred']), 'tap-preferred', '33 flavor roundtrip');
  eq(flavorOfByte(0x7f), 'hold-preferred', '33 unknown flavor byte -> hp');
  // NONE-type filler (type 07; legacy 00 = zero-length bluetooth record)
  eq(toHex(fillerRecord(0x82)), '82 07 00', '33 filler is [kk, 07, 00]');
  // status-byte decode
  eq(describeStatus(0x16), 'nothing stored', '33 status 16');
  eq(describeStatus(0xea), 'value refused', '33 status ea');
  eq(describeStatus(0x2a), 'status 0x2a', '33 unknown status');
  // 30 s floor: 0 = off allowed, sub-30s refused
  eq(timeoutsPayload(0, 30000, 30000)[4], 0, '33 zero idle allowed');
  eq(toHex(timeoutsPayload(30000, 30000, 30000)).length > 0, true, '33 exactly 30s allowed');
  let threw33 = false;
  try { timeoutsPayload(5000, 30000, 30000); } catch { threw33 = true; }
  eq(threw33, true, '33 sub-30s idle rejected');
}

// §28 version surface: package.json must stay present and versioned
// (the legacy naya.snapshotVersion matrix died with the legacy snapshot
// schema in the OpenFlow clean break).
{
  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(process.env.SMOKE_ROOT ?? process.cwd(), 'package.json'),
      'utf8',
    ),
  ) as { version?: string };
  eq(typeof pkg.version, 'string', '28 pkg version present');
}

// §29 keycap contrast helpers (UHK #9): ink/ring picked by fill luminance.
{
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  eq(near(hexLuma('#ffffff'), 1), true, '29 white luma 1');
  eq(near(hexLuma('#000000'), 0), true, '29 black luma 0');
  eq(hexLuma('#ffff00') > 0.55, true, '29 yellow is bright');
  eq(hexLuma('#0000ff') < 0.55, true, '29 blue is dark');
  eq(readableInk('#ffff00'), '#111315', '29 bright fill -> dark ink');
  eq(readableInk('#0000ff'), '#f4f4f5', '29 dark fill -> light ink');
  eq(contrastStroke('#ff0000'), '#ffffff', '29 dark red -> white ring');
  eq(contrastStroke('#00ff00'), '#000000', '29 bright green -> black ring');
  eq(hexLuma('nonsense'), 0.5, '29 invalid hex -> neutral');
  // full path: ledCss colors flow through the helpers (S0 renders mid-gray
  // at L=50, so light ink; saturated blue stays dark -> light ink too)
  eq(readableInk(ledCss(0, 0)), '#f4f4f5', '29 ledCss mid-gray -> light ink');
  eq(readableInk(ledCss(60, 100)), '#111315', '29 ledCss yellow -> dark ink');
}

// §30 troubleshooting recipes: entries sane, plugin shape, wire-guarded.
{
  const throws = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  eq(TROUBLES.length >= 20, true, '30 at least 20 entries');
  eq(
    new Set(TROUBLES.map((t) => t.id)).size === TROUBLES.length,
    true,
    '30 unique ids',
  );
  eq(
    TROUBLES.every(
      (t) =>
        t.title.length > 0 &&
        t.summary.length > 0 &&
        t.steps.length > 0 &&
        t.details.length > 0,
    ),
    true,
    '30 every entry has title/summary/details/steps',
  );
  // plugin shape: side valid, label set, steps XOR run, declarative steps
  // wire-guarded, right-side ladders confirmed (parking incident 2026-09-22)
  eq(
    TROUBLES.every(
      (t) =>
        !t.actions ||
        t.actions.every(
          (a) =>
            (a.side === 'left' || a.side === 'right' || a.side === 'any') &&
            a.label.length > 0 &&
            (a.steps ? !a.run : !!a.run) &&
            (!a.steps ||
              a.steps.every((st) => !throws(() => assertWireAllowed(st.t, st.c0, st.c1)))) &&
            (a.side !== 'right' || !!a.confirm),
        ),
    ),
    true,
    '30 actions shaped + wire-allowed + right side confirmed',
  );
  const dark = TROUBLES.find((t) => t.id === 'dark-half');
  const undarkLeft = dark?.actions?.find((a) => a.label.includes('LEFT'));
  eq(!!undarkLeft?.steps && undarkLeft.steps.length === 9, true, '30 dark-half LEFT ladder 9 steps');
  eq(
    undarkLeft?.steps?.map((s) => s.c1).join(',') ??
      '',
    [0x13, 0x10, 0x03, 0x12, 0x14, 0x50, 0x08, 0x11, 0x03].join(','),
    '30 dark-half c1 sequence (naya-undark.py verbatim)',
  );
  eq(
    JSON.stringify(undarkLeft?.steps?.find((s) => s.c1 === 0x50)?.params),
    JSON.stringify([0xff, 255, 255, 255, 100]),
    '30 dark-half RGB step params (0xff target + RGB,100)',
  );
  eq(
    undarkLeft?.steps?.every((s) => s.tolerateNoReply === true) ?? false,
    true,
    '30 dark-half steps tolerate no-reply',
  );
  eq(UNDARK_LADDER.length, 9, '30 ladder 9 steps');
  // runtime guard: banned verbs blocked, proven-safe ones allowed
  eq(throws(() => assertWireAllowed(0xfa, 0x10, 0x02)), true, '30 guard blocks fa/1002');
  eq(throws(() => assertWireAllowed(0xfa, 0x10, 0x06)), true, '30 guard blocks fa/1006');
  eq(throws(() => assertWireAllowed(0xee, 0x10, 0xbe)), true, '30 guard blocks ee/10be');
  eq(throws(() => assertWireAllowed(0xee, 0x10, 0xae)), true, '30 guard blocks ee/10ae');
  eq(throws(() => assertWireAllowed(0x30, 0x10, 0xca)), true, '30 guard blocks 30/10ca');
  eq(throws(() => assertWireAllowed(0xed, 0x10, 0x13)), false, '30 guard allows ed/1013');
  eq(throws(() => assertWireAllowed(0xee, 0x10, 0xce)), false, '30 guard allows ee/10ce');
  eq(throws(() => assertWireAllowed(0xfe, 0x10, 0x0a)), false, '30 guard allows fe/100a');
  eq(throws(() => assertWireAllowed(0x30, 0x10, 0x04)), false, '30 guard allows 30/1004');
  // KB update 2026-10: right-half undark is a single ceiling write (the
  // 9-step ff-ladder parked the right render once, 2026-09-22)
  const undarkRight = dark?.actions?.find((a) => a.side === 'right');
  eq(undarkRight?.steps?.length, 1, '30 dark-half RIGHT = 1 ceiling step');
  eq(
    undarkRight?.steps?.[0]
      ? `${undarkRight.steps[0].t.toString(16)}/${undarkRight.steps[0].c0.toString(16)}${undarkRight.steps[0].c1.toString(16)} ${JSON.stringify(undarkRight.steps[0].params)}`
      : '',
    'ed/1013 [255,100]',
    '30 dark-half RIGHT step = ed/1013 [0xff,100]',
  );
  eq(!!undarkRight?.confirm, true, '30 dark-half RIGHT confirmed');
  // R5 echo-back: lights-wrong entry carries a scripted left-side action
  const lwf = TROUBLES.find((t) => t.id === 'lights-wrong-after-flash');
  const lwfAct = lwf?.actions?.[0];
  eq(
    !!lwfAct && lwfAct.side === 'left' && !lwfAct.steps && !!lwfAct.run && !!lwfAct.confirm,
    true,
    '30 lights-wrong: left scripted action, confirmed',
  );
  // guard: UNPAIR ALL banned, layer-list rewrite allowed
  eq(throws(() => assertWireAllowed(0xbe, 0x10, 0x04)), true, '30 guard blocks be/1004');
  eq(throws(() => assertWireAllowed(0x30, 0x10, 0x02)), false, '30 guard allows 30/1002');
}

// §31 palette physical rows + custom HID escape hatch (UHK #7)
{
  const kb = ACTIONS.filter((a) => a.category === 'Keyboard');
  const g = groupKeyboardCategory(kb);
  eq(g.rows[0].map((a) => a.label).join(''), '1234567890', '31 digits row order');
  eq(g.rows[1].map((a) => a.label).join(''), 'QWERTYUIOP', '31 letters row 1');
  eq(g.rows[2].map((a) => a.label).join(''), 'ASDFGHJKL', '31 letters row 2');
  eq(g.rows[3].map((a) => a.label).join(''), 'ZXCVBNM', '31 letters row 3');
  eq(g.rows.length, 15, `31 row count (${g.rows.length})`);
  eq(g.rest.length, 0, `31 rest empty (got: ${g.rest.map((a) => a.label).join(',')})`);
  const flat = [...g.rows.flat(), ...g.rest];
  eq(flat.length, kb.length, `31 partition covers all (${flat.length}/${kb.length})`);
  eq(new Set(flat.map((a) => a.id)).size, flat.length, '31 partition no dup ids');
  eq(parseCustomHid('4f'), 0x4f, '31 parse 4f');
  eq(parseCustomHid('0x1E'), 0x1e, '31 parse 0x1E');
  eq(parseCustomHid(''), null, '31 parse empty null');
  eq(parseCustomHid('zz'), null, '31 parse non-hex null');
  eq(parseCustomHid('1f2'), null, '31 parse 3-digit null');
  const c = customHidAction(0x39);
  eq(c.id, 'hid-custom:57', `31 custom id (${c.id})`);
  eq(
    JSON.stringify(c.body()),
    JSON.stringify([1, 4, 0x39, 0, 7, 0]),
    '31 custom body = hid() bytes',
  );
  eq(
    c.body().join(),
    ACTIONS.find((a) => a.label === 'Caps Lock')!.body().join(),
    '31 custom 0x39 == Caps Lock bytes',
  );
}

// §47 OpenFlow core: host table (vendored from naya-reflow research)
{
  eq(HOST_TABLE_SIZE >= 282, true, '47 table size');
  eq(
    nameToUsage('A')?.page === 0x0007 && nameToUsage('A')?.usage === 0x04,
    true,
    '47 A',
  );
  eq(
    nameToUsage('SYS_PWR')?.usage === 0x81 && nameToUsage('SYSTEM_POWER')?.page === 0x0001,
    true,
    '47 alias',
  );
  eq(usageToName(0x0007, 0x04), 'A', '47 reverse A');
  eq(nameToUsage('NO_SUCH_KEY'), null, '47 unknown null');
  eq(usageToName(0x0007, 0xff), null, '47 reverse unknown null');
}

// §48 OpenFlow import: parse layer doc
{
  const OF_TEST_UUID1 = '6e726600-0000-4000-8000-0000000000a1';
  const OF_TEST_UUID2 = '6e726600-0000-4000-8000-0000000000b2';
  const OF_TEST_UUID3 = '6e726600-0000-4000-8000-0000000000c3'; // absent from layerRefs
  const bind = (behavior: string, actionType: string, actionCode: string) => ({
    behavior,
    actionType,
    actionCode,
    context: null,
  });
  const doc = {
    version: 1,
    kind: 'layer',
    layer: {
      srcId: OF_TEST_UUID1,
      name: 'Layer 1',
      orderId: 1,
      iconId: null,
      animationId: 'breathe',
      keys: [
        { positionId: 0, colorHex: null, bindings: [bind('press', 'key', 'A')] },
        { positionId: 7, colorHex: null, bindings: [bind('press', 'key', 'A'), bind('hold', 'key', 'B')] },
        { positionId: 9, colorHex: null, bindings: [bind('tap', 'key', 'C'), bind('hold', 'key', 'D'), bind('double_tap', 'key', 'E')] },
        { positionId: 12, colorHex: null, bindings: [bind('tap', 'key', 'C'), bind('hold', 'key', 'D'), bind('double_tap', 'key', 'E'), bind('tap_hold', 'key', 'F')] },
        { positionId: 20, colorHex: null, bindings: [bind('press', 'key', 'G'), bind('double_tap', 'key', 'H')] },
        { positionId: 25, colorHex: null, bindings: [bind('press', 'layer_polite_hold', 'MO_LAYER_' + OF_TEST_UUID1)] },
        { positionId: 30, colorHex: null, bindings: [bind('press', 'layer_polite_hold', 'TOGGLE_LAYER_' + OF_TEST_UUID1)] },
        { positionId: 31, colorHex: null, bindings: [bind('press', 'layer_polite_hold', 'MO_LAYER_' + OF_TEST_UUID3)] },
        { positionId: 35, colorHex: null, bindings: [bind('press', 'key', 'NO_SUCH_KEY')] },
        { positionId: 40, colorHex: null, bindings: [bind('press', 'key', 'A'), bind('tap', 'key', 'C')] },
        { positionId: 97, colorHex: null, bindings: [bind('press', 'key', 'A')] },
        { positionId: 2, colorHex: null, bindings: [bind('press', 'key', 'A')] },
        { positionId: 2, colorHex: null, bindings: [bind('press', 'key', 'B')] },
        { positionId: 74, colorHex: '#ff0000', bindings: [] },
        { positionId: 88, colorHex: '#xxxxxx', bindings: [] },
        { positionId: 1, colorHex: '#3366ff', bindings: [] },
      ],
    },
    macros: [{ any: 1 }],
    layerRefs: { [OF_TEST_UUID1]: 1, [OF_TEST_UUID2]: 2 },
  };
  eq(
    OF_LAYER_UUIDS.join(','),
    '6e726600-0000-4000-8000-000000000000,6e726600-0000-4000-8000-000000000001,' +
      '6e726600-0000-4000-8000-000000000002,6e726600-0000-4000-8000-000000000003,' +
      '6e726600-0000-4000-8000-000000000004,6e726600-0000-4000-8000-000000000005,' +
      '6e726600-0000-4000-8000-000000000006,6e726600-0000-4000-8000-000000000007',
    '48 layer uuids deterministic',
  );
  const r = parseOpenFlowLayer(doc);
  eq('error' in r ? 'err' : 'ok', 'ok', '48 layer doc parses');
  if (!('error' in r)) {
    const k1 = r.maps.keys[1];
    const at = (kk: number) => k1.find((x) => x.kk === kk);
    eq(r.maps.layers.join(','), '1', '48 doc layer is 1');
    eq(r.maps.notes, undefined, '48 parser never sets notes');
    eq(toHex(at(0)!.rec), '00 01 04 04 00 07 00', '48 press → T01');
    eq(at(0)!.t, 1, '48 KeyRec.t = record type byte');
    eq(
      toHex(at(7)!.rec),
      '07 03 15 01 01 00 c8 00 05 00 07 00 00 00 00 00 04 00 07 00 00 00 00 00',
      '48 press+hold → T03',
    );
    eq(
      toHex(at(9)!.rec),
      '09 10 18 c8 00 03 01 01 00 c8 00 07 00 07 00 00 00 00 00 06 00 07 00 00 00 00 00',
      '48 tap/hold/double → T10 primary',
    );
    eq(toHex(at(0x5b)!.rec), '5b 10 07 c8 00 01 08 00 07 00', '48 shadow mini at kk+0x52');
    eq(
      toHex(at(12)!.rec),
      '0c 10 18 c8 00 03 01 01 00 c8 00 07 00 07 00 00 00 00 00 06 00 07 00 00 00 00 00',
      '48 four-slot → T10 primary',
    );
    eq(
      toHex(at(0x5e)!.rec),
      '5e 10 18 c8 00 03 01 01 00 c8 00 09 00 07 00 00 00 00 00 08 00 07 00 00 00 00 00',
      '48 shadow full at kk+0x52',
    );
    eq(at(0x4b) !== undefined ? toHex(at(0x4b)!.rec) : 'missing', '4b 02 00', '48 T10 tail record');
    eq(toHex(at(20)!.rec), '14 01 04 0a 00 07 00', '48 clamp keeps press, drops double');
    eq(toHex(at(25)!.rec), '19 05 04 01 00 00 00', '48 MO_LAYER_ → T05 order 1');
    eq(at(30), undefined, '48 TOGGLE_LAYER_ skipped');
    eq(at(31), undefined, '48 unlisted layer ref skipped');
    eq(at(35), undefined, '48 unknown actionCode skipped');
    eq(toHex(at(40)!.rec), '28 01 04 06 00 07 00', '48 tap set wins over press');
    eq(at(97), undefined, '48 positionId 97 skipped');
    eq(toHex(at(2)!.rec), '02 01 04 05 00 07 00', '48 duplicate positionId last wins');
    const led1 = r.maps.leds[1].find((x) => x.kk === 1);
    const wantHs = hexToHs('#3366ff')!;
    eq(led1 !== undefined && led1.h === wantHs.h && led1.s === wantHs.s, true, '48 colorHex → led h/s');
    eq(r.maps.leds[1].length, 2, '48 led recs: key 1 + strip 74 (strips round-trip now)');
    eq(r.anim, 1, '48 animationId breathe → anim 1');
    const w = r.warnings.join('\n');
    eq(/Double Tap dropped/.test(w), true, '48 clamp warning');
    eq(/press dropped/.test(w), true, '48 press-vs-tap warning');
    eq(/TOGGLE_LAYER_/.test(w), true, '48 TOGGLE warning names the prefix');
    eq(/not in layerRefs/.test(w), true, '48 unlisted ref warning');
    eq(/NO_SUCH_KEY/.test(w), true, '48 unknown actionCode warning');
    eq(/out of range/.test(w), true, '48 positionId range warning');
    eq(/duplicated/.test(w), true, '48 duplicate positionId warning');
    eq(/skipped 1 LED strip/.test(w), false, '48 strips no longer warn (round-trip now)');
    eq(/module bay/.test(w), false, '48 bays silent (no bay warning)');
    eq(/1 macro/.test(w), true, '48 macros count warning');
  }
  const rNull = parseOpenFlowLayer({ ...doc, layer: { ...doc.layer, animationId: null } });
  eq(!('error' in rNull) && rNull.anim === null, true, '48 null animationId → anim null');
  const eV2 = parseOpenFlowLayer({ ...doc, version: 2 });
  eq('error' in eV2 && /version 2 is newer/.test(eV2.error), true, '48 version 2 rejected as newer');
  const eV3 = parseOpenFlowLayer({ ...doc, version: 3 });
  eq('error' in eV3 && /version 3 is newer/.test(eV3.error), true, '48 version 3 rejected as newer');
  const eKind = parseOpenFlowLayer({ ...doc, kind: 'profile' });
  eq('error' in eKind && /unsupported kind/.test(eKind.error), true, '48 kind profile rejected');
  const eOrder = parseOpenFlowLayer({ ...doc, layer: { ...doc.layer, orderId: 8 } });
  eq('error' in eOrder && /window/.test(eOrder.error), true, '48 orderId 8 rejected (window 0-7)');
  const eKeys = parseOpenFlowLayer({ version: 1, kind: 'layer', layer: { orderId: 1 } });
  eq('error' in eKeys && /keys/.test(eKeys.error), true, '48 missing keys rejected');
  // Final-review regression: a consumer-page base used to be embedded into
  // the page-7-only T03/T10 quads (silent corruption, laundered by round-trip
  // as a different valid key). Now the chain is dropped, the base-only
  // consumer record survives, and a warning names it (spec §0.2 clamp style).
  eq(
    nameToUsage('C_VOL_UP')?.page === 0x000c && nameToUsage('C_VOL_UP')?.usage === 0xe9,
    true,
    '48 C_VOL_UP is consumer 0xe9',
  );
  const consLayer = {
    version: 1,
    kind: 'layer',
    layer: {
      srcId: OF_TEST_UUID1,
      name: 'Layer 1',
      orderId: 1,
      iconId: null,
      animationId: 'breathe',
      keys: [] as { positionId: number; colorHex: null; bindings: ReturnType<typeof bind>[] }[],
    },
    macros: [] as unknown[],
    layerRefs: { [OF_TEST_UUID1]: 1, [OF_TEST_UUID2]: 2 },
  };
  // T03 variant: consumer press + hold.
  const consA = parseOpenFlowLayer({
    ...consLayer,
    layer: {
      ...consLayer.layer,
      keys: [
        {
          positionId: 7,
          colorHex: null,
          bindings: [bind('press', 'key', 'C_VOL_UP'), bind('hold', 'key', 'B')],
        },
      ],
    },
  });
  eq('error' in consA ? 'err' : 'ok', 'ok', '48 consumer+hold doc parses');
  if (!('error' in consA)) {
    const atA = (kk: number) => consA.maps.keys[1].find((x) => x.kk === kk);
    eq(
      toHex(atA(7)!.rec),
      '07 01 04 e9 00 0c 00',
      '48 consumer base + hold → base-only consumer record (no T03)',
    );
    eq(consA.maps.keys[1].length, 1, '48 clamped key emits no extra records');
    eq(
      (consA.warnings.join('\n').match(/hold chain dropped/g) ?? []).length,
      1,
      '48 exactly one hold-chain-dropped warning',
    );
    const expA = buildOpenFlowLayer(consA.maps.keys[1], [], 1, null);
    eq(expA.counts.unknown, 0, '48 roundtrip: consumer key exports, counts.unknown stays 0');
    const reA = parseOpenFlowLayer(expA.data);
    eq(
      !('error' in reA) &&
        reA.maps.keys[1].length === 1 &&
        toHex(reA.maps.keys[1][0].rec) === '07 01 04 e9 00 0c 00',
      true,
      '48 roundtrip: re-parse gives back the same consumer record bytes',
    );
  }
  // T10 variant: hold + double_tap chain. The tap slot cannot carry a
  // consumer usage (parse guard skips it), so the consumer base enters via
  // press; press+hold+double_tap is the T10-primary path (base = press when
  // tap is absent).
  const consB = parseOpenFlowLayer({
    ...consLayer,
    layer: {
      ...consLayer.layer,
      keys: [
        {
          positionId: 9,
          colorHex: null,
          bindings: [
            bind('press', 'key', 'C_VOL_UP'),
            bind('hold', 'key', 'D'),
            bind('double_tap', 'key', 'E'),
          ],
        },
      ],
    },
  });
  eq('error' in consB ? 'err' : 'ok', 'ok', '48 consumer+hold+double doc parses');
  if (!('error' in consB)) {
    const atB = (kk: number) => consB.maps.keys[1].find((x) => x.kk === kk);
    eq(toHex(atB(9)!.rec), '09 01 04 e9 00 0c 00', '48 T10 variant clamps to consumer record');
    eq(consB.maps.keys[1].length, 1, '48 T10 variant emits no shadow or tail');
    eq(/hold chain dropped/.test(consB.warnings.join('\n')), true, '48 T10 variant chain dropped warning');
    const expB = buildOpenFlowLayer(consB.maps.keys[1], [], 1, null);
    eq(expB.counts.unknown, 0, '48 T10 variant roundtrip: counts.unknown stays 0');
    const reB = parseOpenFlowLayer(expB.data);
    eq(
      !('error' in reB) &&
        reB.maps.keys[1].length === 1 &&
        toHex(reB.maps.keys[1][0].rec) === '09 01 04 e9 00 0c 00',
      true,
      '48 T10 variant roundtrip: same consumer record bytes',
    );
  }
}

// §49 OpenFlow export + roundtrip
{
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const recs: KeyRec[] = [];
  const push = (kk: number, rec: Uint8Array) =>
    recs.push({ kk, t: rec[1], rec, offset: recs.length });
  push(0, plainRecord(0, 0x04)); // T01 A
  push(7, t03Record(7, 0x05, 0x04)); // T03 hold B / tap A
  push(9, t10Primary(9, 0x07, 0x06)); // T10 hold D / tap C
  push(0x5b, t10ShadowMini(9, 0x08)); // double E
  push(0x4b, new Uint8Array(TAIL_T10));
  push(12, t10Primary(12, 0x07, 0x06)); // T10 hold D / tap C
  push(0x5e, t10ShadowFull(12, 0x09, 0x08)); // taphold F / double E
  push(25, buildRecord(25, findAction('special:1')!.body())); // MO layer
  push(30, buildRecord(30, findAction('bt:1')!.body())); // BT family → dropped
  push(40, plainRecord(40, 0xe1)); // modifier (Left Shift)
  const leds49: LedRec[] = [{ kk: 1, h: 30, s: 100, offset: 0 }];

  const r = buildOpenFlowLayer(recs, leds49, 1, 'swirl');
  eq(r.fileName, 'Layer_1.openflow-layer.json', '49 fileName');
  const doc = r.data as any;
  const keys49 = doc.layer.keys as any[];
  eq(doc.version === 1 && doc.kind === 'layer', true, '49 version/kind');
  eq(
    doc.layer.srcId === OF_LAYER_UUIDS[1] &&
      doc.layer.name === 'Layer 1' &&
      doc.layer.orderId === 1 &&
      doc.layer.iconId === null,
    true,
    '49 layer header',
  );
  eq(doc.layer.animationId, 'swirl', '49 animationId passthrough');
  eq(keys49.length, 97, '49 97 key entries');
  eq(
    keys49.every((k: any, i: number) => k.positionId === i),
    true,
    '49 entries ordered by positionId',
  );
  eq(
    JSON.stringify(doc.layerRefs),
    JSON.stringify({ [OF_LAYER_UUIDS[1]]: 1, [OF_LAYER_UUIDS[2]]: 2 }),
    '49 layerRefs deterministic',
  );
  eq(Array.isArray(doc.macros) && doc.macros.length === 0, true, '49 macros empty');
  const jb = (k: any) => JSON.stringify(k.bindings);
  eq(
    jb(keys49[0]),
    JSON.stringify([{ behavior: 'press', actionType: 'key', actionCode: 'A', context: null }]),
    '49 T01 → press key',
  );
  eq(
    jb(keys49[7]),
    JSON.stringify([
      { behavior: 'press', actionType: 'key', actionCode: 'A', context: null },
      { behavior: 'hold', actionType: 'key', actionCode: 'B', context: null },
    ]),
    '49 T03 → press+hold',
  );
  eq(
    jb(keys49[9]),
    JSON.stringify([
      { behavior: 'tap', actionType: 'key', actionCode: 'C', context: null },
      { behavior: 'hold', actionType: 'key', actionCode: 'D', context: null },
      { behavior: 'double_tap', actionType: 'key', actionCode: 'E', context: null },
    ]),
    '49 T10 mini → tap/hold/double_tap',
  );
  eq(
    jb(keys49[12]),
    JSON.stringify([
      { behavior: 'tap', actionType: 'key', actionCode: 'C', context: null },
      { behavior: 'hold', actionType: 'key', actionCode: 'D', context: null },
      { behavior: 'double_tap', actionType: 'key', actionCode: 'E', context: null },
      { behavior: 'tap_hold', actionType: 'key', actionCode: 'F', context: null },
    ]),
    '49 T10 full → all four slots',
  );
  eq(
    jb(keys49[40]),
    JSON.stringify([
      {
        behavior: 'press',
        actionType: 'modifier',
        actionCode: usageToName(0x0007, 0xe1),
        context: null,
      },
    ]),
    '49 usage 0xe1 → modifier',
  );
  eq(
    jb(keys49[25]),
    JSON.stringify([
      {
        behavior: 'press',
        actionType: 'layer_polite_hold',
        actionCode: 'MO_LAYER_' + OF_LAYER_UUIDS[1],
        context: null,
      },
    ]),
    '49 special ORDER 1 → MO ref',
  );
  eq(jb(keys49[30]), '[]', '49 BT record → empty bindings');
  eq(
    'colorHex' in keys49[74] === false && keys49[74].bindings.length === 0,
    true,
    '49 strip 74: no colorHex, empty bindings',
  );
  eq(
    'colorHex' in keys49[88] === false && keys49[88].bindings.length === 0,
    true,
    '49 bay 88: no colorHex, empty bindings',
  );
  eq('colorHex' in keys49[96] === false, true, '49 bay 96: no colorHex');
  eq(keys49[1].colorHex, hsToHex(30, 100), '49 led → colorHex');
  eq('colorHex' in keys49[0], false, '49 no led → no colorHex field');
  eq(r.counts.keys, 6, '49 counts.keys');
  eq(r.counts.leds, 1, '49 counts.leds');
  eq(r.counts.unknown, 1, '49 counts.unknown (BT dropped)');
  const rNullAnim = buildOpenFlowLayer(recs, leds49, 1, null);
  eq(
    (rNullAnim.data as any).layer.animationId,
    'solid',
    '49 null animId → solid',
  );
  eq(
    JSON.stringify(buildOpenFlowLayer(recs, leds49, 1, 'swirl').data),
    JSON.stringify(r.data),
    '49 deterministic: two builds deep-equal',
  );
  const rEmpty = buildOpenFlowLayer([], [], 2, null);
  eq(
    (rEmpty.data as any).layer.keys.length === 97 &&
      (rEmpty.data as any).layer.orderId === 2,
    true,
    '49 empty caches → valid 97-key doc',
  );
  eq(
    rEmpty.counts.keys === 0 && rEmpty.counts.leds === 0 && rEmpty.counts.unknown === 0,
    true,
    '49 empty caches → zero counts',
  );
  // Roundtrip: export → parse → byte-equal records (BT record unrepresentable).
  const p = parseOpenFlowLayer(JSON.parse(JSON.stringify(r.data)));
  eq('error' in p ? 'err' : 'ok', 'ok', '49 export re-parses');
  if (!('error' in p)) {
    const k1 = p.maps.keys[1];
    const at = (kk: number) => k1.find((x) => x.kk === kk);
    eq(
      recs
        .filter((x) => x.kk !== 30)
        .every((x) => {
          const got = at(x.kk);
          return got !== undefined && toHex(got.rec) === toHex(x.rec);
        }),
      true,
      '49 roundtrip record bytes equal',
    );
    eq(at(30), undefined, '49 roundtrip drops BT record');
    const led1 = p.maps.leds[1].find((x) => x.kk === 1);
    eq(led1 !== undefined && led1.h === 30 && led1.s === 100, true, '49 roundtrip led h/s');
    eq(p.anim, 2, '49 roundtrip anim swirl → 2');
  }
  const pNull = parseOpenFlowLayer(JSON.parse(JSON.stringify(rNullAnim.data)));
  eq(!('error' in pNull) && pNull.anim === 0, true, '49 null anim → solid → anim 0');
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// §50 import accepts only OpenFlow
{
  const bind50 = (behavior: string, actionType: string, actionCode: string) => ({
    behavior,
    actionType,
    actionCode,
    context: null,
  });
  const doc50 = {
    version: 1,
    kind: 'layer',
    layer: {
      srcId: OF_LAYER_UUIDS[1],
      name: 'Layer 1',
      orderId: 1,
      iconId: null,
      animationId: 'breathe',
      keys: [
        { positionId: 0, colorHex: '#3366ff', bindings: [bind50('press', 'key', 'A')] },
      ],
    },
    macros: [],
    layerRefs: { [OF_LAYER_UUIDS[1]]: 1, [OF_LAYER_UUIDS[2]]: 2 },
  };
  const ok50 = parseSnapshotFile(doc50);
  eq('error' in ok50 ? 'err' : 'ok', 'ok', '50 OpenFlow layer doc parses');
  if (!('error' in ok50)) {
    eq(ok50.maps.layers.join(','), '1', '50 doc layer is 1');
    eq(toHex(ok50.maps.keys[1][0].rec), '00 01 04 04 00 07 00', '50 press A → T01');
    eq(ok50.anims[1], 1, '50 anim keyed by the doc layer');
    eq(
      ok50.maps.leds[1].length === 1 && ok50.maps.leds[1][0].kk === 0,
      true,
      '50 colorHex → led',
    );
    eq(Array.isArray(ok50.warnings), true, '50 warnings array present');
  }
  const v50 = parseSnapshotFile({ ...doc50, version: 2 });
  eq('error' in v50 && /newer/.test(v50.error), true, '50 version 2 rejected as newer');
  const legBk = parseSnapshotFile({ tool: 'naya-backup', version: 1, keymap: {}, ledmap: {} });
  eq(
    'error' in legBk && /clean break/.test(legBk.error),
    true,
    '50 naya-backup rejected (clean break)',
  );
  const legRf = parseSnapshotFile({ tool: 'naya-reflow', kind: 'keymap-layer', layers: {} });
  eq(
    'error' in legRf && /clean break/.test(legRf.error),
    true,
    '50 naya-reflow export rejected (clean break)',
  );
  const prof50 = parseSnapshotFile({ version: 1, kind: 'profile' });
  eq('error' in prof50 && /unsupported kind/.test(prof50.error), true, '50 kind profile rejected');
}

// §51 layer list: inventory + encoders
{
  const throws51 = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  // Real board table — byte-exact 30/1001 reply payload (fw 3.41.0),
  // from the owner's capture research/dumps/aux-left.txt (identical in
  // all six aux-left* captures): [status][index echo] + three 20-byte
  // entries [idx][id][anim][0x10][uuid16]. TWO leading bytes before the
  // first entry (62 B payload = 2 + 3×20); the second byte is NOT a count.
  const tableHex51 =
    '00 00' +
    ' 00 00 00 10 3b 19 05 55 02 e0 4b 29 8b c9 ea c0 67 0f 11 36' +
    ' 01 01 00 10 e6 b7 0e c8 75 ad 46 63 a1 f4 9f a2 94 c7 de 9a' +
    ' 02 02 00 10 8e e3 ff fe 78 94 40 1e b9 b5 3e 94 ea 8a a5 35';
  const inv51 = parseInventory(hexToBytes(tableHex51)!);
  eq(inv51.length === 3, true, '51 board table → 3 entries');
  eq(
    JSON.stringify(inv51.map((e) => [e.idx, e.uuid, e.animStored])),
    JSON.stringify([
      [0, '3b19055502e04b298bc9eac0670f1136', 0],
      [1, 'e6b70ec875ad4663a1f49fa294c7de9a', 0],
      [2, '8ee3fffe7894401eb9b53e94ea8aa535', 0],
    ]),
    '51 board table entries',
  );
  // The real capture carries anim 0 on every entry; a patched variant
  // (entry-2 anim byte → 03) pins the animStored parse position.
  const anim51 = parseInventory(
    hexToBytes(tableHex51.replace('02 02 00 10', '02 02 03 10'))!,
  );
  eq(anim51[2].animStored === 3, true, '51 layer2 animStored 3 (patched variant)');
  eq(storedAnimName(3), 'Swirl', '51 storedAnimName(3)');
  // The two leading bytes (status + index echo) are discarded — a
  // non-zero index echo parses identically (it is NOT a layer count).
  const invCount51 = parseInventory(hexToBytes('00 03' + tableHex51.slice(5))!);
  eq(
    JSON.stringify(invCount51) === JSON.stringify(inv51),
    true,
    '51 status+index-echo bytes discarded (echo 03 variant)',
  );
  // Tolerance: uuid-length byte ≠ 0x10 skips the entry.
  const corrupt51 = hexToBytes(tableHex51.replace('01 01 00 10', '01 01 00 08'))!;
  eq(parseInventory(corrupt51).length === 2, true, '51 len≠0x10 entry skipped');
  // Trailing bytes that don't form a full 20-byte block are ignored.
  const garbage51 = hexToBytes(tableHex51 + ' de ad be')!;
  eq(parseInventory(garbage51).length === 3, true, '51 trailing garbage tolerated');
  // Empty / short payloads → [].
  eq(parseInventory(new Uint8Array(0)).length === 0, true, '51 empty payload → []');
  eq(
    parseInventory(hexToBytes('00 00 00 00 00 10 3b 19')!).length === 0,
    true,
    '51 short payload → []',
  );
  // Wire guard: 30/1002 is a legal layer-list channel.
  eq(throws51(() => assertWireAllowed(0x30, 0x10, 0x02)), false, '51 guard allows 30/1002');
  // Stored-anim map (data + lookups).
  eq(STORED_ANIM_NAMES.join(','), 'Solid,Breathe,Spectrum,Swirl', '51 stored anim names');
  eq(storedAnimOf('swirl') === 3, true, '51 storedAnimOf lowercase');
  eq(storedAnimOf('Swirl') === 3, true, '51 storedAnimOf mixed case');
  eq(storedAnimOf('nope') === -1, true, '51 storedAnimOf unknown');
  eq(storedAnimName(0), 'Solid', '51 storedAnimName(0)');
  eq(storedAnimName(9), null, '51 storedAnimName out of range');
  // Anim discriminator (review gap): a queued 'Swirl' add must land the
  // STORED anim byte 3 in the op payload entry — bytes 0/1 (flag+index)
  // are identical for every anim; the anim byte is what discriminates
  // STORED vs RUNTIME mappings.
  {
    const d51s = new Draft();
    queueLayerAdd(d51s, 5, '8ee3fffe7894401eb9b53e94ea8aa535', 'Swirl');
    const pay51s = (d51s.ops[0] as LayerListOp).payload;
    eq(
      pay51s[0] === 0 && pay51s[1] === 0 && pay51s[4] === 3,
      true,
      '51 Swirl add → stored anim byte 3 in op payload',
    );
  }
  // Add encode (measured wire form, KB LY-07 style: `00 00 0303 00 10 <uuid>`
  // — every 30/1002 write opens with flag byte + index byte 0x00, the same
  // [00, index, data] convention as writeKey/writeLed).
  const add51: LayerEntry[] = [
    { idx: 3, uuid: '3b19055502e04b298bc9eac0670f1136', animStored: 0 },
    { idx: 4, uuid: 'e6b70ec875ad4663a1f49fa294c7de9a', animStored: 0 },
  ];
  eq(
    toHex(encodeLayerListAdd(add51)),
    '00 00 03 03 00 10 3b 19 05 55 02 e0 4b 29 8b c9 ea c0 67 0f 11 36' +
      ' 04 04 00 10 e6 b7 0e c8 75 ad 46 63 a1 f4 9f a2 94 c7 de 9a',
    '51 add byte-exact (00 00 flag+index prefix)',
  );
  eq(toHex(encodeLayerListAdd([])), '00 00', '51 empty add = flag+index prefix only');
  // Delete encode: whole set sent TWICE (measured, KB LY-08 style:
  // `00 00 03000000 04000000 03000000 04000000`).
  eq(
    toHex(encodeLayerListDelete([3, 4])),
    '00 00 03 00 00 00 04 00 00 00 03 00 00 00 04 00 00 00',
    '51 delete byte-exact (00 00 prefix, set twice)',
  );
  // Restore = add over the full sorted table.
  eq(
    toHex(
      encodeRestorePayload([
        { idx: 4, uuid: 'e6b70ec875ad4663a1f49fa294c7de9a', animStored: 1 },
        { idx: 3, uuid: '3b19055502e04b298bc9eac0670f1136', animStored: 2 },
      ]),
    ),
    '00 00 03 03 02 10 3b 19 05 55 02 e0 4b 29 8b c9 ea c0 67 0f 11 36' +
      ' 04 04 01 10 e6 b7 0e c8 75 ad 46 63 a1 f4 9f a2 94 c7 de 9a',
    '51 restore sorts by idx',
  );
  // uuid ↔ bytes helpers (plain hex, no dashes).
  eq(
    toHex(uuidToBytes('3b19055502e04b298bc9eac0670f1136')),
    '3b 19 05 55 02 e0 4b 29 8b c9 ea c0 67 0f 11 36',
    '51 uuidToBytes hex',
  );
  eq(
    bytesToUuid(uuidToBytes('3b19055502e04b298bc9eac0670f1136')),
    '3b19055502e04b298bc9eac0670f1136',
    '51 uuid roundtrip',
  );
  // Minted uuids: 32 lowercase hex, unique per call.
  const m51a = mintLayerUuid();
  const m51b = mintLayerUuid();
  eq(/^[0-9a-f]{32}$/.test(m51a), true, '51 mint uuid shape');
  eq(m51a !== m51b, true, '51 mint uuid unique');
  // Draft op kind 'layers': carries a pre-encoded payload from the layer
  // encoders; keyed by payload hex so identical edits dedup while add and
  // delete (different payloads) coexist in one flash plan.
  const pAdd51 = encodeLayerListAdd(add51);
  const pDel51 = encodeLayerListDelete([3, 4]);
  const d51 = new Draft();
  d51.add({ kind: 'layers', payload: pAdd51, label: 'Add 2 layers' });
  d51.add({ kind: 'layers', payload: pDel51, label: 'Delete 2 layers' });
  eq(d51.size, 2, '51 layer add + delete coexist');
  eq(
    opKey(d51.ops[0]),
    'layers:' + Array.from(pAdd51, (b) => b.toString(16).padStart(2, '0')).join(''),
    '51 opKey layers:<hex payload>',
  );
  d51.add({ kind: 'layers', payload: pAdd51, label: 'Add 2 layers (again)' });
  eq(d51.size, 2, '51 identical layer payload dedups');
  eq(d51.ops[0].label, 'Add 2 layers (again)', '51 layer dedup keeps latest');
  eq(opSection(d51.ops[0]) === 'layers', true, '51 opSection → layers');
  const st51 = d51.stats();
  eq(st51.frames, 2, '51 stats frames count layer ops');
  eq(st51.bytes, 20 + pAdd51.length + pDel51.length, '51 stats bytes = 10 + payload per op');
  eq(opSummary(d51.ops[1]), 'Delete 2 layers', '51 opSummary prints label');
  // No readback path for layer lists — reconcile leaves them alone; the
  // flash executor drops them right after ACK (like settings/module).
  const d51r = new Draft();
  d51r.add({ kind: 'layers', payload: pAdd51, label: 'Add 2 layers' });
  eq(d51r.reconcile([[], [], []], [[], [], []]), 0, '51 reconcile drops nothing for layers');
  eq(d51r.size, 1, '51 layer op survives reconcile');
  eq(SECTIONS.includes('layers'), true, '51 SECTIONS includes layers');
  eq(SECTION_LABELS.layers, 'Layers', '51 SECTION_LABELS.layers = Layers');
  // Task 5 flash tail — restore echo is byte-transparent to add over the
  // same parsed inventory (the board echoes back what add would send).
  eq(
    toHex(encodeRestorePayload(inv51)) === toHex(encodeLayerListAdd(inv51)),
    true,
    '51 restore = add over inventory (echo transparency)',
  );
  // Single-frame budget: a 4-entry restore payload (00 00 prefix + 4×20B)
  // must stay ≤ 250 bytes so one 30/1002 frame carries it.
  const inv4_51 = parseInventory(
    hexToBytes(
      tableHex51 +
        ' 03 03 02 10 aa bb cc dd ee ff 00 11 22 33 44 55 66 77 88 99',
    )!,
  );
  eq(encodeRestorePayload(inv4_51).length <= 250, true, '51 restore 4-entry payload single frame');
}

// §52 OpenFlow layer window 0..7 (Phase 2: the board stores 8 layer slots)
{
  const bind52 = (behavior: string, actionType: string, actionCode: string) => ({
    behavior,
    actionType,
    actionCode,
    context: null,
  });
  const doc52 = (
    orderId: number,
    keys: { positionId: number; colorHex: null; bindings: ReturnType<typeof bind52>[] }[],
    layerRefs: Record<string, number>,
  ) => ({
    version: 1,
    kind: 'layer',
    layer: {
      srcId: OF_LAYER_UUIDS[orderId] ?? 'unset',
      name: 'Layer ' + orderId,
      orderId,
      iconId: null,
      animationId: 'solid',
      keys,
    },
    macros: [] as unknown[],
    layerRefs,
  });

  // 8 deterministic uuids — same pattern as Phase 1, now ...000 through ...007.
  eq(
    OF_LAYER_UUIDS.join(','),
    '6e726600-0000-4000-8000-000000000000,6e726600-0000-4000-8000-000000000001,' +
      '6e726600-0000-4000-8000-000000000002,6e726600-0000-4000-8000-000000000003,' +
      '6e726600-0000-4000-8000-000000000004,6e726600-0000-4000-8000-000000000005,' +
      '6e726600-0000-4000-8000-000000000006,6e726600-0000-4000-8000-000000000007',
    '52 8 layer uuids, pattern 000..007',
  );
  // Window widened: orderId 5 parses, records land in keys[5].
  const r52 = parseOpenFlowLayer(
    doc52(5, [{ positionId: 0, colorHex: null, bindings: [bind52('press', 'key', 'A')] }], {}),
  );
  eq(
    !('error' in r52) &&
      r52.maps.layers.join(',') === '5' &&
      r52.maps.keys[5].length === 1 &&
      toHex(r52.maps.keys[5][0].rec) === '00 01 04 04 00 07 00',
    true,
    '52 orderId 5 parses → layers [5], keys[5]',
  );
  // Window edge: orderId 7 still parses.
  const r7 = parseOpenFlowLayer(doc52(7, [], {}));
  eq(!('error' in r7) && r7.maps.layers[0] === 7, true, '52 orderId 7 parses (window edge)');
  // Beyond the window: actionable error naming the app's window.
  const e8 = parseOpenFlowLayer(doc52(8, [], {}));
  eq(
    'error' in e8 && /layer index 8 is outside this app's window \(0-7\)/.test(e8.error),
    true,
    '52 orderId 8 rejected with window error',
  );
  const eNeg = parseOpenFlowLayer(doc52(-1, [], {}));
  eq('error' in eNeg && /window \(0-7\)/.test(eNeg.error), true, '52 orderId -1 rejected');
  // Build side: a layer-5 doc carries the pattern uuid as srcId.
  const b5 = buildOpenFlowLayer([], [], 5, null);
  const b5d = b5.data as { layer: { srcId: string; orderId: number } };
  eq(
    b5.fileName === 'Layer_5.openflow-layer.json' &&
      b5d.layer.srcId === '6e726600-0000-4000-8000-000000000005' &&
      b5d.layer.orderId === 5,
    true,
    '52 build layer 5 → srcId ...005 pattern',
  );
  // layerRefs {uuid: 5} resolves a MO_LAYER_ ref to special ORDER 5.
  const mo5 = parseOpenFlowLayer(
    doc52(
      0,
      [
        {
          positionId: 3,
          colorHex: null,
          bindings: [bind52('press', 'layer_polite_hold', 'MO_LAYER_' + OF_LAYER_UUIDS[5])],
        },
      ],
      { [OF_LAYER_UUIDS[5]]: 5 },
    ),
  );
  eq(
    !('error' in mo5) &&
      mo5.maps.keys[0].length === 1 &&
      toHex(mo5.maps.keys[0][0].rec) === '03 05 04 05 00 00 00',
    true,
    '52 layerRefs {uuid5:5} → MO resolves to T05 ORDER 5',
  );
  // Targets outside 1..7 stay skipped (0 = self; 8+ beyond the window) with
  // a named warning.
  const moBad = parseOpenFlowLayer(
    doc52(
      0,
      [
        {
          positionId: 3,
          colorHex: null,
          bindings: [bind52('press', 'layer_polite_hold', 'MO_LAYER_' + OF_LAYER_UUIDS[3])],
        },
        {
          positionId: 4,
          colorHex: null,
          bindings: [bind52('press', 'layer_polite_hold', 'MO_LAYER_' + OF_LAYER_UUIDS[4])],
        },
      ],
      { [OF_LAYER_UUIDS[3]]: 8, [OF_LAYER_UUIDS[4]]: 0 },
    ),
  );
  const wBad = 'error' in moBad ? '' : moBad.warnings.join('\n');
  eq(
    !('error' in moBad) &&
      moBad.maps.keys[0].length === 0 &&
      /target layer 8 invalid/.test(wBad) &&
      /target layer 0 invalid/.test(wBad) &&
      /writable targets are 1-7/.test(wBad),
    true,
    '52 MO targets 8 and 0 → skipped, window warning',
  );
  // Build refuses beyond the window explicitly (closes the Phase-1 minor).
  let msg52: string | null = null;
  try {
    buildOpenFlowLayer([], [], 8, null);
  } catch (e) {
    msg52 = e instanceof Error ? e.message : String(e);
  }
  eq(
    msg52 !== null && /layer index 8 is outside this app's window \(0-7\)/.test(msg52),
    true,
    '52 build layer 8 throws window error',
  );
  // Roundtrip at layer 4: build → parse is byte-equal (records, led, anim).
  const recs52: KeyRec[] = [];
  const push52 = (kk: number, rec: Uint8Array) =>
    recs52.push({ kk, t: rec[1], rec, offset: recs52.length });
  push52(0, plainRecord(0, 0x04)); // T01 A
  push52(7, t03Record(7, 0x05, 0x04)); // T03 hold B / tap A
  push52(9, t10Primary(9, 0x07, 0x06)); // T10 hold D / tap C
  push52(0x5b, t10ShadowMini(9, 0x08)); // double E
  push52(0x4b, new Uint8Array(TAIL_T10));
  const leds52: LedRec[] = [{ kk: 1, h: 30, s: 100, offset: 0 }];
  const b4 = buildOpenFlowLayer(recs52, leds52, 4, 'breathe');
  const p4 = parseOpenFlowLayer(JSON.parse(JSON.stringify(b4.data)));
  eq(
    !('error' in p4) && p4.maps.layers.join(',') === '4',
    true,
    '52 layer-4 roundtrip parses → layers [4]',
  );
  eq(
    !('error' in p4) &&
      recs52.every((x) => {
        const got = p4.maps.keys[4].find((k) => k.kk === x.kk);
        return got !== undefined && toHex(got.rec) === toHex(x.rec);
      }),
    true,
    '52 layer-4 roundtrip records byte-equal',
  );
  eq(
    !('error' in p4) &&
      p4.maps.leds[4].length === 1 &&
      p4.maps.leds[4][0].h === 30 &&
      p4.maps.leds[4][0].s === 100 &&
      p4.anim === 1,
    true,
    '52 layer-4 roundtrip led + anim',
  );
  // Layer 0 (self-doc layer) is inside the window on both directions.
  const b0 = buildOpenFlowLayer([], [], 0, null);
  const p0 = parseOpenFlowLayer(JSON.parse(JSON.stringify(b0.data)));
  eq(
    (b0.data as { layer: { srcId: string } }).layer.srcId ===
      '6e726600-0000-4000-8000-000000000000' &&
      !('error' in p0) &&
      p0.maps.layers[0] === 0,
    true,
    '52 build layer 0 works + reparses',
  );
}

// §53 layer add/delete queue helpers
{
  const u53 = '3b19055502e04b298bc9eac0670f1136'; // real captured uuid
  const u53b = 'e6b70ec875ad4663a1f49fa294c7de9a'; // real captured uuid
  // Add: ONE layers op, payload = single-entry encodeLayerListAdd.
  const d53 = new Draft();
  const a53 = queueLayerAdd(d53, 3, u53);
  eq(a53.queued, true, '53 add queued');
  eq(d53.size, 1, '53 add → exactly one op');
  eq(d53.ops[0].kind === 'layers', true, '53 add op kind layers');
  const lop53 = d53.ops[0] as LayerListOp;
  eq(
    toHex(lop53.payload),
    toHex(encodeLayerListAdd([{ idx: 3, uuid: u53, animStored: 0 }])),
    '53 add payload = single-entry encode',
  );
  eq(lop53.label, 'add layer 3 (Solid)', '53 add label default Solid');
  // Anim name resolves through storedAnimOf.
  const d53b = new Draft();
  queueLayerAdd(d53b, 4, u53, 'Breathe');
  eq(
    toHex((d53b.ops[0] as LayerListOp).payload),
    toHex(encodeLayerListAdd([{ idx: 4, uuid: u53, animStored: 1 }])),
    '53 Breathe → anim byte 1',
  );
  eq((d53b.ops[0] as LayerListOp).label, 'add layer 4 (Breathe)', '53 Breathe label');
  // Unknown anim name: refused, nothing queued (no byte-255 garbage).
  const d53c = new Draft();
  const badAnim53 = queueLayerAdd(d53c, 4, u53, 'Nope');
  eq(badAnim53.queued === false && !!badAnim53.error, true, '53 unknown anim refused');
  eq(d53c.size, 0, '53 unknown anim queues nothing');
  // Window guard: idx must sit in 0..7 (same wording as the OpenFlow window).
  const d53d = new Draft();
  const g853 = queueLayerAdd(d53d, 8, u53);
  eq(
    g853.queued === false && /window \(0-7\)/.test(g853.error ?? ''),
    true,
    '53 add idx 8 → window error',
  );
  eq(queueLayerAdd(d53d, -1, u53).queued, false, '53 add idx -1 refused');
  eq(d53d.size, 0, '53 add guard queues nothing');
  // Two adds with different uuids → different payloads → coexist.
  const d53e = new Draft();
  queueLayerAdd(d53e, 3, u53);
  queueLayerAdd(d53e, 4, u53b);
  eq(d53e.size, 2, '53 two adds coexist');
  // Delete: the layers op goes FIRST, then the layer's keymap span is
  // blanked via ONE keyset op of [pos][07][00] fillers (absent-satisfied
  // in reconcile), then h0 s0 per known LED kk — a re-add can't inherit
  // ghosts (OF F:888-896 semantics).
  const keys53: KeyRec[] = [];
  for (let kk = 0; kk < 74; kk++)
    keys53.push({ kk, t: 1, rec: plainRecord(kk, 0x04), offset: kk });
  const leds53: LedRec[] = [
    { kk: 1, h: 30, s: 100, offset: 0 },
    { kk: 5, h: 0, s: 0, offset: 1 },
    { kk: 9, h: 200, s: 50, offset: 2 },
  ];
  const d53f = new Draft();
  const del53 = queueLayerDelete(d53f, 2, keys53, leds53, 156, 3);
  eq(del53.queued, true, '53 delete queued');
  eq(
    del53.frames,
    1 + 156 + 3,
    '53 delete frames = 1 layers + 156 filler recs + 3 leds',
  );
  eq(d53f.ops[0].kind === 'layers', true, '53 delete layers op comes first');
  const dlop53 = d53f.ops[0] as LayerListOp;
  eq(
    toHex(dlop53.payload),
    toHex(encodeLayerListDelete([2])),
    '53 delete payload = encodeLayerListDelete([2])',
  );
  eq(dlop53.label, 'delete layer 2', '53 delete label');
  eq(
    dlop53.payload.length === 10 &&
      dlop53.payload[0] === 0 &&
      dlop53.payload[1] === 0 &&
      dlop53.payload[2] === 2 &&
      dlop53.payload[6] === 2,
    true,
    '53 delete ×2 repeat pattern present (00 00 + [idx]000000 ×2 = 10 B)',
  );
  const ks53 = d53f.ops.find((o): o is KeySetOp => o.kind === 'keyset');
  eq(ks53 !== undefined, true, '53 blank keyset op present');
  eq(ks53?.layer, 2, '53 blank keyset on deleted layer');
  // Record count from the op itself (each filler is 3 bytes) — NOT
  // draft.stats frames, which count per-record frames.
  eq(ks53?.records.length, 156, '53 blank covers totalKeys slots (156 > 150)');
  eq(
    ks53?.records.every((r) => r.length === 3 && r[1] === 0x07 && r[2] === 0x00),
    true,
    '53 blanks are [pos][07][00] fillers',
  );
  eq(
    keys53.every((k) => ks53?.records.some((r) => r[0] === k.kk) ?? false),
    true,
    '53 every known key kk blanked',
  );
  const w53 = d53f.ops.filter((o) => o.kind === 'led');
  eq(w53.length, 3, '53 led wipe count = leds.length');
  eq(
    w53.every((o) => o.kind === 'led' && o.layer === 2 && o.h === 0 && o.s === 0),
    true,
    '53 led wipe h0 s0 on layer 2',
  );
  eq(
    leds53.every((l) => w53.some((o) => o.kind === 'led' && o.kk === l.kk)),
    true,
    '53 led wipe per known kk',
  );
  // Only-layer guard: fires only when the caller passes layerCount.
  const d53g = new Draft();
  const one53 = queueLayerDelete(d53g, 0, keys53, leds53, 156, 1);
  eq(
    one53.queued === false &&
      one53.error === 'cannot delete the only layer' &&
      one53.frames === 0,
    true,
    '53 only-layer guard fires',
  );
  eq(d53g.size, 0, '53 only-layer guard queues nothing');
  const d53h = new Draft();
  eq(queueLayerDelete(d53h, 0, [], [], 156).queued, true, '53 guard only when layerCount given');
  // Add + delete coexist in one draft (payload-addressed ops).
  const d53i = new Draft();
  queueLayerAdd(d53i, 5, u53);
  queueLayerDelete(d53i, 2, keys53, leds53, 156, 3);
  eq(
    d53i.ops[0].kind === 'layers' && (d53i.ops[1] as LayerListOp).label === 'delete layer 2',
    true,
    '53 coexist: both layers ops kept',
  );
  eq(d53i.size, 6, '53 coexist total ops = 2 layers + 1 keyset + 3 leds');
  // Double-add guard: pendingLayerAddIdxs decodes the queued add idxs
  // from the draft (the inventory only changes after a flash, so a
  // second click must see the first add still queued). Delete payloads
  // never match the [idx][idx][anim][0x10] add signature.
  const d53j = new Draft();
  queueLayerAdd(d53j, 5, u53);
  queueLayerAdd(d53j, 6, u53b);
  queueLayerDelete(d53j, 2, keys53, leds53, 156, 3);
  eq(
    JSON.stringify(pendingLayerAddIdxs(d53j)),
    '[5,6]',
    '53 pendingLayerAddIdxs → queued add idxs only',
  );
  eq(
    pendingLayerAddIdxs(new Draft()).length,
    0,
    '53 pendingLayerAddIdxs empty draft → []',
  );
}

// §54 LED strips round-trip + bay block helper + fill range gate
{
  // Bay block spans pinned: left 88..111, right 112..135 (24 blocks each).
  eq(
    BAY_LED_RANGES.left.first === 88 && BAY_LED_RANGES.left.last === 111,
    true,
    '54 bay range left = 88..111',
  );
  eq(
    BAY_LED_RANGES.right.first === 112 && BAY_LED_RANGES.right.last === 135,
    true,
    '54 bay range right = 112..135',
  );

  // Import: strip colorHex lands in maps.leds (round-trips now); bays stay
  // silent — no record, no warning. Invalid strip hex is null-safe.
  const doc54 = {
    version: 1,
    kind: 'layer',
    layer: {
      srcId: OF_LAYER_UUIDS[1],
      name: 'Layer 1',
      orderId: 1,
      iconId: null,
      animationId: 'solid',
      keys: [
        { positionId: 0, colorHex: null, bindings: [{ behavior: 'press', actionType: 'key', actionCode: 'A', context: null }] },
        { positionId: 74, colorHex: '#ff0000', bindings: [] },
        { positionId: 75, colorHex: '#zzzzzz', bindings: [] },
        { positionId: 87, colorHex: '#00ff00', bindings: [] },
        { positionId: 88, colorHex: '#123456', bindings: [] },
        { positionId: 96, colorHex: '#abcdef', bindings: [] },
      ],
    },
    macros: [],
    layerRefs: {},
  };
  const r54 = parseOpenFlowLayer(doc54);
  eq('error' in r54 ? 'err' : 'ok', 'ok', '54 strip/bay doc parses');
  if (!('error' in r54)) {
    const hs74 = hexToHs('#ff0000')!;
    const hs87 = hexToHs('#00ff00')!;
    const led74 = r54.maps.leds[1].find((x) => x.kk === 74);
    const led87 = r54.maps.leds[1].find((x) => x.kk === 87);
    eq(
      led74 !== undefined && led74.h === hs74.h && led74.s === hs74.s,
      true,
      '54 strip 74 #ff0000 → LedRec with h/s',
    );
    eq(
      led87 !== undefined && led87.h === hs87.h && led87.s === hs87.s,
      true,
      '54 strip 87 #00ff00 → LedRec with h/s',
    );
    eq(
      r54.maps.leds[1].find((x) => x.kk === 75) === undefined,
      true,
      '54 strip invalid hex → no record (null-safe)',
    );
    eq(r54.maps.keys[1].length, 1, '54 strips emit no key records');
    eq(
      r54.maps.leds[1].every((x) => x.kk < 88),
      true,
      '54 bays 88-96 never become led records',
    );
    const w54 = r54.warnings.join('\n');
    eq(/strip/i.test(w54), false, '54 strips parse silently (no strip warning)');
    eq(/bay/i.test(w54), false, '54 bays skip silently (no bay warning)');
  }

  // Round-trip: parse(strip colors) → build → reparse gives the same h/s back.
  if (!('error' in r54)) {
    const rt2 = buildOpenFlowLayer(r54.maps.keys[1], r54.maps.leds[1], 1, 'solid');
    const rt3 = parseOpenFlowLayer(JSON.parse(JSON.stringify(rt2.data)));
    eq('error' in rt3 ? 'err' : 'ok', 'ok', '54 roundtrip reparse ok');
    if (!('error' in rt3)) {
      const want74 = hexToHs('#ff0000')!;
      const want87 = hexToHs('#00ff00')!;
      const back74 = rt3.maps.leds[1].find((x) => x.kk === 74);
      const back87 = rt3.maps.leds[1].find((x) => x.kk === 87);
      eq(
        back74 !== undefined && back74.h === want74.h && back74.s === want74.s,
        true,
        '54 roundtrip strip 74 h/s equal',
      );
      eq(
        back87 !== undefined && back87.h === want87.h && back87.s === want87.s,
        true,
        '54 roundtrip strip 87 h/s equal',
      );
    }
  }

  // Export: strips 74-87 emit colorHex from the leds cache (same as keys),
  // bindings stay empty; bays 88-96 keep placeholder rows with NO colorHex.
  const leds54: LedRec[] = [
    { kk: 74, h: 0, s: 100, offset: 0 },
    { kk: 87, h: 120, s: 100, offset: 1 },
  ];
  const b54 = buildOpenFlowLayer([], leds54, 1, 'solid');
  const k54 = (b54.data as { layer: { keys: { colorHex?: string; bindings: unknown[] }[] } })
    .layer.keys;
  eq(k54[74].colorHex === '#ff0000', true, '54 export strip 74 emits colorHex');
  eq(k54[87].colorHex === '#00ff00', true, '54 export strip 87 emits colorHex');
  eq('colorHex' in k54[75] === false, true, '54 export strip 75 (no cache) → no colorHex');
  eq(k54[74].bindings.length === 0, true, '54 export strip bindings stay empty');
  eq(
    k54.slice(88, 97).every((k) => 'colorHex' in k === false),
    true,
    '54 export bays 88-96 never carry colorHex',
  );
  eq(b54.counts.leds, 2, '54 counts.leds counts strip colorHex');

  // Fill range gate: a full 136-LED dump fills keys+strips ONLY — exactly
  // 88 ops, all kk ≤ 87 (regression trap: it used to queue all 136).
  const ledsFull: LedRec[] = [];
  for (let kk = 0; kk <= 135; kk++) ledsFull.push({ kk, h: 0, s: 0, offset: kk });
  const dF = new Draft();
  const filled = queueFillLayer(dF, 1, ledsFull, { h: 45, s: 80 });
  const opsF = dF.ops.filter((o) => o.kind === 'led');
  eq(
    dF.size === 88 && filled === 88 && opsF.length === 88,
    true,
    '54 fill on 136-rec input queues exactly 88 ops',
  );
  eq(
    opsF.every((o) => o.kind === 'led' && o.kk <= 87),
    true,
    '54 fill ops all kk ≤ 87 (bays excluded)',
  );
  eq(
    opsF.every((o) => o.kind === 'led' && o.kk >= 0 && o.h === 45 && o.s === 80) &&
      Math.max(...opsF.map((o) => o.kk)) === 87,
    true,
    '54 fill max kk 87, h/s carried',
  );

  // queueBayColor: exactly 24 led ops per side, same h/s across the block,
  // routed through the existing queueColor gate (kk ≤ 0x87).
  const dL = new Draft();
  queueBayColor(dL, 1, 'left', 30, 90);
  const ledL = dL.ops.filter((o) => o.kind === 'led');
  eq(
    dL.size === 24 && ledL.length === 24,
    true,
    '54 queueBayColor left queues exactly 24 led ops',
  );
  eq(
    ledL.every((o) => o.kind === 'led' && o.layer === 1 && o.h === 30 && o.s === 90),
    true,
    '54 left ops all layer 1 h30 s90',
  );
  eq(
    ledL.every((o) => o.kk >= 88 && o.kk <= 111) &&
      new Set(ledL.map((o) => o.kk)).size === 24,
    true,
    '54 left span 88..111, 24 distinct kk',
  );
  const dR = new Draft();
  queueBayColor(dR, 2, 'right', 200, 50);
  const ledR = dR.ops.filter((o) => o.kind === 'led');
  eq(
    dR.size === 24 && ledR.length === 24,
    true,
    '54 queueBayColor right queues exactly 24 led ops',
  );
  eq(
    ledR.every((o) => o.kk >= 112 && o.kk <= 135) &&
      new Set(ledR.map((o) => o.kk)).size === 24,
    true,
    '54 right span 112..135, 24 distinct kk',
  );
  eq(
    ledR.every((o) => o.kind === 'led' && o.layer === 2 && o.h === 200 && o.s === 50),
    true,
    '54 right ops all layer 2 h200 s50',
  );
}

// §55 flash capability model: drops ledger + probeDraft + counts.unknown deflation
{
  const u55 = '3b19055502e04b298bc9eac0670f1136';

  // --- Queue-time refusal ledger --------------------------------------
  // Behavior-set chain violation: the {queued:false,error} return is
  // unchanged AND a drop lands in draft.drops with the validator message
  // verbatim + an honest effect sentence.
  const d55 = new Draft();
  const r55a = queueBehaviorSet(
    d55, 1, 0x1e,
    { tap: null, hold: 0x0b, double: null, taphold: null },
    200, 'bad chain',
  );
  eq(r55a.queued, false, '55 chain violation refused');
  eq(r55a.error, 'behavior chain: Tap is required first', '55 chain error message verbatim');
  eq(d55.size, 0, '55 chain violation queues nothing');
  eq(d55.drops.length, 1, '55 chain refusal → one drop');
  const drop55a: DraftDrop | undefined = d55.drops[0];
  eq(
    drop55a?.reason,
    'behavior chain: Tap is required first',
    '55 drop reason = chain message verbatim',
  );
  eq(drop55a?.at, 'queue', '55 drop at=queue');
  eq(drop55a?.layer === 1 && drop55a?.kk === 0x1e, true, '55 drop addresses layer+kk');
  eq(
    /keeps whatever the keyboard already had/i.test(drop55a?.effect ?? ''),
    true,
    '55 drop effect = key keeps current binding',
  );
  // Dedup: the same refusal twice is ONE ledger entry…
  queueBehaviorSet(
    d55, 1, 0x1e,
    { tap: null, hold: 0x0b, double: null, taphold: null },
    200, 'bad chain',
  );
  eq(d55.drops.length, 1, '55 same refusal twice dedups to one drop');
  // …but a DIFFERENT violation coexists.
  queueBehaviorSet(
    d55, 2, 0x30,
    { tap: 0x04, hold: 0x0b, double: null, taphold: 0x06 },
    200, 'bad chain 2',
  );
  eq(
    d55.drops.length === 2 &&
      d55.drops[1]!.reason === 'behavior chain: Double Tap required before Tap+Hold',
    true,
    '55 distinct refusal reason coexists',
  );

  // Module gesture refusals (family not proven writable / same-length rule).
  const d55m = new Draft();
  const g55: GestureBinding = {
    slot: 2, gesture: 'press', flashable: false,
    actionRaw: Uint8Array.from([2, 0x0f, 0x08, 3, 0, 0, 0, 1, 0, 0, 0]),
  };
  const r55m = queueModuleGesture(d55m, 0, g55, [3, 0, 0, 0, 1, 0, 0, 0]);
  eq(
    r55m.queued === false && /family not proven writable/.test(r55m.error ?? ''),
    true,
    '55 module family refusal',
  );
  eq(
    d55m.drops.length === 1 && /family not proven writable/.test(d55m.drops[0]!.reason),
    true,
    '55 module family drop recorded',
  );
  const g55len: GestureBinding = { ...g55, flashable: true };
  queueModuleGesture(d55m, 0, g55len, [9, 9]);
  eq(
    d55m.drops.length === 2 && /same-length rule/.test(d55m.drops[1]!.reason),
    true,
    '55 module length refusal drop',
  );

  // Layer add/delete refusals: window + anim + only-layer, reasons verbatim.
  const d55l = new Draft();
  const r55w = queueLayerAdd(d55l, 8, u55);
  eq(r55w.queued === false && d55l.size === 0, true, '55 window refusal (existing)');
  eq(
    d55l.drops.length === 1 &&
      d55l.drops[0]!.reason === "layer index 8 is outside this app's window (0-7)",
    true,
    '55 window drop reason verbatim',
  );
  queueLayerAdd(d55l, 8, u55);
  eq(d55l.drops.length, 1, '55 window refusal dedups');
  queueLayerAdd(d55l, 4, u55, 'Nope');
  eq(
    d55l.drops.length === 2 && d55l.drops[1]!.reason === 'unknown stored animation: Nope',
    true,
    '55 anim refusal drop',
  );
  queueLayerDelete(d55l, 0, [], [], 156, 1);
  eq(
    d55l.drops.length === 3 &&
      d55l.drops[2]!.reason === 'cannot delete the only layer' &&
      d55l.drops[2]!.layer === 0,
    true,
    '55 only-layer drop',
  );
  eq(d55l.size, 0, '55 layer refusals queue nothing');

  // queueAction no-live-record skip: the {queued,skipped} return shape is
  // unchanged, plus a ledger drop (controller binding resolution #1) so
  // the flash dialog can say WHY the key was left alone.
  const d55s = new Draft();
  const keys55: KeyRec[][] = [[]];
  const r55s = queueAction(d55s, [{ layer: 0, kk: 0x1e }], ACTIONS[0]!, keys55);
  eq(
    r55s.queued === 0 && r55s.skipped === 1,
    true,
    '55 no-live-record skip (return shape unchanged)',
  );
  eq(d55s.size, 0, '55 skip queues nothing');
  eq(
    d55s.drops.length === 1 && d55s.drops[0]!.layer === 0 && d55s.drops[0]!.kk === 0x1e,
    true,
    '55 skip appends drop (binding resolution #1)',
  );
  eq(
    /no live record/i.test(d55s.drops[0]!.reason) &&
      /keeps whatever the keyboard already had/i.test(d55s.drops[0]!.effect),
    true,
    '55 skip drop reason/effect pair',
  );

  // Draft.clear empties the ledger along with the ops.
  d55s.clear();
  eq(d55s.ops.length === 0 && d55s.drops.length === 0, true, '55 clear empties drops too');

  // --- probeDraft: pure re-validation walk ----------------------------
  const p55 = new Draft();
  p55.add({ kind: 'key', layer: 0, kk: 0x1e, record: plainRecord(0x1e, 0x04), label: 'A' });
  p55.add({ kind: 'led', layer: 0, kk: 0x1e, h: 180, s: 100 });
  p55.add({
    kind: 'keyset', layer: 1, kk: 0x20,
    records: [plainRecord(0x20, 0x05), fillerRecord(0x20 + 0x52)], label: 'set',
  });
  p55.add({
    kind: 'module', layer: 0, slot: 3,
    payload: Uint8Array.from([3, 0x0f, 4, 1, 0, 0, 0]), label: 'g',
  });
  p55.add({
    kind: 'layers', label: 'add',
    payload: encodeLayerListAdd([{ idx: 3, uuid: u55, animStored: 0 }]),
  });
  eq(JSON.stringify(probeDraft(p55)), '[]', '55 probe healthy draft → []');

  const p55b = new Draft();
  p55b.add({ kind: 'key', layer: 0, kk: 999, record: plainRecord(0x1e, 0x04), label: 'ghost' });
  const f55a = probeDraft(p55b);
  eq(
    f55a.length === 1 && f55a[0]!.layer === 0 && f55a[0]!.kk === 999,
    true,
    '55 probe hand-built key op kk 999 → 1 finding',
  );
  eq(/kk 999/.test(f55a[0]!.reason), true, '55 probe finding names the op');

  const p55c = new Draft();
  p55c.add({ kind: 'led', layer: 0, kk: 200, h: 0, s: 0 });
  const f55b = probeDraft(p55c);
  eq(
    f55b.length === 1 && /LED map/.test(f55b[0]!.reason),
    true,
    '55 probe led kk 200 → bounds finding',
  );

  const p55d = new Draft();
  p55d.add({
    kind: 'layers', label: 'hand-built',
    payload: encodeLayerListAdd([{ idx: 9, uuid: u55, animStored: 0 }]),
  });
  eq(
    /window \(0-7\)/.test(probeDraft(p55d)[0]!.reason),
    true,
    '55 probe re-checks the layers window',
  );

  const p55e = new Draft();
  p55e.add({
    kind: 'module', layer: 0, slot: 3,
    payload: Uint8Array.from([7, 0x0f, 4, 1]), label: 'x',
  });
  eq(probeDraft(p55e).length === 1, true, '55 probe module payload[0] ≠ slot → finding');

  // Purity: unchanged input → deep-equal output, draft untouched.
  const f55a2 = probeDraft(p55b);
  eq(JSON.stringify(f55a) === JSON.stringify(f55a2), true, '55 probe is pure: identical twice');
  eq(
    p55b.ops.length === 1 && p55b.drops.length === 0,
    true,
    '55 probe never mutates ops or ledger',
  );

  // --- counts.unknown deflation ---------------------------------------
  // Filler [kk,07,00], legacy [kk,00,00], and the 'empty' catalog action
  // are KNOWN-EMPTY slots: they export bindings [] WITHOUT bumping
  // counts.unknown. A genuine miss (BT record) still counts.
  const recs55: KeyRec[] = [];
  const push55 = (kk: number, rec: Uint8Array) =>
    recs55.push({ kk, t: rec[1], rec, offset: recs55.length });
  push55(0, fillerRecord(0));
  push55(1, new Uint8Array([1, 0, 0]));
  push55(2, buildRecord(2, findAction('empty')!.body()));
  const e55 = buildOpenFlowLayer(recs55, [], 1, null);
  eq(e55.counts.unknown, 0, '55 deflation: empty families → unknown stays 0');
  eq(e55.counts.keys, 0, '55 deflated slots never count as keys');
  const k55doc = (e55.data as { layer: { keys: { bindings: unknown[] }[] } }).layer.keys;
  eq(JSON.stringify(k55doc[0].bindings), '[]', '55 filler exports empty bindings');
  eq(JSON.stringify(k55doc[1].bindings), '[]', '55 legacy blank exports empty bindings');
  eq(JSON.stringify(k55doc[2].bindings), '[]', '55 empty-action record exports empty bindings');
  push55(3, buildRecord(3, findAction('bt:1')!.body()));
  const e55b = buildOpenFlowLayer(recs55, [], 1, null);
  eq(e55b.counts.unknown, 1, '55 genuine miss still counts unknown');
}

// §56 read-status taxonomy: chunkStatus classifies the device's bare status
// byte so a multipart READ answers {blob, status} — "unreadable" never
// masquerades as data, and a no-data reply stops cleanly instead of walking
// into the 'runaway parts' throw.
{
  const cs56 = (b: number[]) => chunkStatus(Uint8Array.from(b));
  eq(cs56([0x16]), 'empty', '56 chunkStatus 0x16 nothing stored → empty');
  eq(cs56([0x18]), 'empty', '56 chunkStatus bare 0x18 continuation → empty');
  eq(cs56([0x11]), 'unsupported', '56 chunkStatus 0x11 → unsupported');
  eq(cs56([0x00, 0x00, 0x10, 0x2a]), 'ok', '56 chunkStatus multi-byte body → ok');
  eq(cs56([0x16, 0x00]), 'ok', '56 chunkStatus 2-byte body is data, not status → ok');
  eq(cs56([0x55]), 'unknown:0x55', '56 chunkStatus bare 0x55 → unknown:0x55');
  eq(cs56([0x2a]), 'unknown:0x2a', '56 chunkStatus bare 0x2a → unknown:0x2a');
  eq(cs56([0x00]), 'unknown:0x00', '56 chunkStatus bare 0x00 → unknown:0x00 (two-digit pad)');
}

// End-to-end: drive readMultipart through a scripted device (duplexFake's
// wire shape, per-request response body) — the no-data single-frame reply
// must return {blob: 0B, status} without throwing.
void (async () => {
  const scripted56 = (reply: (rq: Frame) => Uint8Array) => {
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    const reader = {
      async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
        for (;;) {
          const c = queue.shift();
          if (c) return { value: c, done: false };
          await new Promise<void>((res) => { waiter = res; });
        }
      },
      cancel() { const w = waiter; waiter = null; w?.(); },
      releaseLock() {},
    };
    const writer = {
      async write(b: Uint8Array) {
        const rq = verifyFrame(Uint8Array.from(b));
        const resp = buildFrame(0x50, rq.type, rq.c0, rq.c1, reply(rq));
        verifyFrame(resp);
        setTimeout(() => { queue.push(resp); const w = waiter; waiter = null; w?.(); }, 5);
      },
      releaseLock() {},
    };
    const port = {
      readable: { locked: false, getReader: () => reader },
      writable: { getWriter: () => writer },
      async open() {}, async setSignals() {}, async close() {},
    };
    return {
      session() {
        const r = port.readable.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
        const w = port.writable.getWriter() as unknown as WritableStreamDefaultWriter<Uint8Array>;
        return new NayaSession(
          port as unknown as SerialPort, 0x50,
          new FrameReader(r), w, r,
          async (b) => { await w.write(b); }, null,
        );
      },
    };
  };

  // Bare [0x16] "nothing stored": {blob: 0B, status: 'empty'} — no throw,
  // no runaway walk, no 30 s sync-lost stall the old partMatcher produced
  // on a 1-byte payload.
  let respond56: (rq: Frame) => Uint8Array = () => Uint8Array.from([0x16]);
  const dev56 = scripted56((rq) => respond56(rq));
  const ses56 = dev56.session();
  let blob56: Uint8Array | null = null;
  let status56 = '';
  let err56 = '';
  try { ({ blob: blob56, status: status56 } = await ses56.readLayer(0)); }
  catch (e) { err56 = (e as Error).message; }
  eq(err56, '', '56 bare 0x16 read → no throw (no runaway, no sync lost)');
  eq(blob56 !== null && blob56.length === 0, true, '56 empty read → 0-byte blob');
  eq(status56, 'empty', '56 empty read → status empty');

  // Same session, healthy two-part stream next: proves the no-data reply
  // left the family clean (a wrongly-dirty cursor would drain first and
  // the part-0/part-1 request count would double).
  let reqs56 = 0;
  respond56 = (rq) => {
    reqs56++;
    const layer = rq.payload[1] ?? 0;
    if (rq.payload[0] === 0)
      return Uint8Array.from([0x01, layer, 0x10, 0x20, 0x30, 0x40]);
    return Uint8Array.from([0x00, layer, 0x50, 0x60, 0x70, 0x80]);
  };
  const ok56 = await ses56.readLayer(0);
  eq(reqs56, 2, '56 clean family: exactly part 0 + part 1 requested');
  eq(ok56.status, 'ok', '56 healthy multipart read → status ok');
  eq(ok56.blob.length, 8, '56 healthy read → 2 parts × 4B body');
  eq(toHex(ok56.blob), '10 20 30 40 50 60 70 80', '56 healthy blob = part bodies in order');

  // 'unsupported' and 'unknown' classifications also stop clean: empty
  // blob + verbatim status, callers decide.
  respond56 = () => Uint8Array.from([0x11]);
  const uns56 = await ses56.readLayer(1);
  eq(uns56.blob.length === 0 && uns56.status === 'unsupported', true,
    '56 bare 0x11 read → {0B, unsupported} no throw');

  respond56 = () => Uint8Array.from([0x2a]);
  const unk56 = await ses56.readLedmap(0);
  eq(unk56.blob.length === 0 && unk56.status === 'unknown:0x2a', true,
    '56 bare 0x2a ledmap read → {0B, unknown:0x2a} no throw');

  // Body-less terminal ONLY ([0x00, layer] with zero data bytes): the
  // stitched blob is 0B — must classify 'empty' (OF parity: body-less
  // terminal = empty), never surface as an 'ok' 0B blob that trips the
  // callers' parse-shape tripwires (recs !== 156 / total !== 544).
  respond56 = (rq) => Uint8Array.from([0x00, rq.payload[1] ?? 0]);
  const term56 = await ses56.readLayer(2);
  eq(term56.blob.length === 0 && term56.status === 'empty', true,
    '56 body-less terminal-only multipart → {0B, empty}');

  // Padding end-to-end: a single bare [0x00] reply reports the status
  // string exactly 'unknown:0x00' (two hex digits, OF {flag:02x} parity).
  respond56 = () => Uint8Array.from([0x00]);
  const pad56 = await ses56.readLayer(3);
  eq(pad56.status, 'unknown:0x00', '56 bare 0x00 read → status exactly unknown:0x00');
  eq(pad56.blob.length, 0, '56 bare 0x00 read → 0-byte blob');

  await ses56.close();

  // Wrapper shapes: readLayer/readLedmap/readModuleConfig all surface
  // {blob, status} (compile-time); runtime spot-check on the reads above.
  const shapes56: [
    Awaited<ReturnType<NayaSession['readLayer']>>,
    Awaited<ReturnType<NayaSession['readLedmap']>>,
    Awaited<ReturnType<NayaSession['readModuleConfig']>>,
  ] = [ok56, uns56, { blob: new Uint8Array(0), status: 'ok' }];
  eq(shapes56[0]!.status === 'ok' && shapes56[2]!.blob.length === 0, true,
    '56 read wrappers carry {blob, status}');

  // LayerDump carries the per-layer read-status map for a synthetic
  // inventory: healthy layers 'ok', an empty slot honestly 'empty'.
  const dump56: LayerDump = {
    keys: [[], [], []],
    leds: [[], [], []],
    status: { 0: 'ok', 1: 'empty', 2: 'unsupported' },
  };
  eq(dump56.status[0], 'ok', '56 LayerDump.status: healthy layer → ok');
  eq(dump56.status[1], 'empty', '56 LayerDump.status: empty slot → empty');
})();

// §57 module wire encoders: 30/100A module-list add/delete payloads, 100C
// blank config, per-field config records and layer-data bay records — all
// byte-exact against captured writes. MODULE_ADDR is the single seam where
// layer-vs-slot addressing lives (see sdk/src/module-wire.ts header).
{
  eq(MODULE_ADDR.prefix.join(','), '0', '57 MODULE_ADDR prefix = single 0x00 byte');
  eq(moduleAddr(5).join(','), '0,5', '57 moduleAddr(5) seam returns [0x00, 5]');
  eq(toHex(encodeListAdd(5, 5, MODULE_TYPE_CODE.TRACK, '00112233445566778899aabbccddeeff')),
    '00 05 05 01 10 00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff',
    '57 list add slot 5 Track (captured 00 05 05 01 10 <uuid16>)');
  eq(toHex(encodeListDelete(5)), '00 05 00 00 00', '57 list delete slot 5 (captured 00 05 00 00 00)');
  const blank57 = encodeBlankConfig(3);
  eq(blank57.length, 121, '57 blank 100C payload = 121 bytes (slot + 40 records)');
  eq(blank57[0], 3, '57 blank opens with the slot byte');
  eq(toHex(blank57.slice(1, 4)), '00 00 00', '57 blank first record [0, 0, 0]');
  eq(toHex(blank57.slice(118)), '27 00 00', '57 blank last record [0x27, 0, 0]');
  eq(toHex(encodeModuleConfig(5, [Uint8Array.from([0x00, 0x01, 0x01, 0x0a])])), '05 00 01 01 0a',
    '57 encodeModuleConfig = bare slot byte + records joined (the 100C seam)');
  eq(toHex(blank57),
    toHex(encodeModuleConfig(3, Array.from({ length: 40 }, (_, f) => Uint8Array.from([f, 0, 0])))),
    '57 blank config = encodeModuleConfig + 40 empty records (single source)');
  eq(toHex(encodeModuleField(0x00, 'none')), '00 07 00', '57 none record = type 0x07 empty');
  eq(toHex(encodeModuleField(0x00, 'setting', 72)), '00 01 01 48', '57 setting record 00 01 01 48 (=72)');
  eq(toHex(encodeModuleField(0x05, 'keypress', Uint8Array.from([0x01, 0x04, 0x04, 0x00, 0x07, 0x00]))),
    '05 04 06 01 04 04 00 07 00', '57 keypress record carries action body bytes verbatim');
  eq(toHex(encodeTwoWord(0x05, 4, -1)), '05 0f 08 04 00 00 00 ff ff ff ff',
    '57 twoWord 0f 08 + cat u32LE + selector i32LE (-1 two-complement)');
  eq(toHex(encodeMouseMask(0x0b, MOUSE_MASK.M5)), '0b 0f 08 03 00 00 00 10 00 00 00',
    '57 mouseMask M5: 0f 08 + 03 u32LE + mask 16 i32LE');
  eq(`${MOUSE_MASK.M1},${MOUSE_MASK.M2},${MOUSE_MASK.M3},${MOUSE_MASK.M4},${MOUSE_MASK.M5}`,
    '1,2,4,8,16', '57 MOUSE_MASK M1..M5 = 1/2/4/8/16');
  eq(toHex(bayRecord(0x4c, 5)), '4c 05 00', '57 bay record slot 5 (captured 4c 05 00)');
  eq(toHex(bayRecord(0x4c, BAY_INHERIT)), '4c 78 00', '57 bay record inherit 0x78 (resolves to BASE)');
  eq(toHex(bayRecord(0x4c, 0)), '4c 00 00', '57 bay record disabled 0x00');
  eq(toHex(Uint8Array.from([
    ...BAY_POSITIONS.TOUCH, ...BAY_POSITIONS.TRACK,
    ...BAY_POSITIONS.TUNE, ...BAY_POSITIONS.FLOAT,
  ])), '4a 4b 4c 4d 4e 4f 50 51', '57 BAY_POSITIONS TOUCH/TRACK/TUNE/FLOAT');
  eq(fitsChunkBudget(new Uint8Array(483)), true, '57 483B payload fits the chunk budget');
  eq(fitsChunkBudget(new Uint8Array(484)), false, '57 484B payload over budget (3rd frame hangs fw 3.28.7)');
  eq(chunkBudget(new Uint8Array(300)), 2, '57 chunkBudget 300B = 2 frames under 242B chunking');
}

// §58 module field maps + profile model: vendored FIELD_MAP/AXIS_HALVES
// tables, tick conversion (SCRUM-50 degrees-per-detent), firmware locks,
// pair splitting, the convention flip, stock profiles, overlay/compare/
// diff, and openflow.module-profile v1 io. Facts are vendor-captured
// (see sdk/src/module-fields.ts provenance header).
{
  // FIELD_MAP — the vendor-captured per-field tables.
  eq(MODULE_TYPES.join(','), 'TOUCH,TRACK,TUNE,FLOAT', '58 MODULE_TYPES');
  const b1 = FIELD_MAP.TRACK[0x0b];
  eq(b1.kind === 'mouse_button' && b1.mask === 1 && b1.gesture === 'tap:track:button_1', true,
    '58 Track 0x0b = button 1, mask 1 (M1)');
  eq(FIELD_MAP.TRACK[0x0c].mask, 4, '58 Track 0x0c mask 4 (M3)');
  eq(FIELD_MAP.TRACK[0x0d].mask, 2, '58 Track 0x0d mask 2 (M2)');
  eq(FIELD_MAP.TRACK[0x0e].mask, 8, '58 Track 0x0e mask 8 (M4)');
  const ta = FIELD_MAP.TUNE[0x0a];
  eq(`${ta.axis}/${ta.direction}/${ta.gesture}`, '4/-1/vertical:tune:1_finger',
    '58 Tune 0x0a = cat 4, selector -1, VERTICAL (axes the other way round from field order)');
  const t13 = FIELD_MAP.TOUCH[0x13];
  eq(t13.kind === 'mouse_button' && t13.mask === 4 && t13.gesture === 'tap:touch:3_fingers', true,
    '58 Touch 0x13 = 3-finger tap, M3 mask (cat-3 shape like a Track button)');
  eq(Object.keys(FIELD_MAP.FLOAT).length, 0, '58 FLOAT has no field map yet (no device read)');

  // AXIS_HALVES — explicit per gesture (a category is NOT unique within a
  // module); selector belongs to the HALF, not the sign.
  const tv = AXIS_HALVES.TUNE['vertical:tune:1_finger'];
  eq(`${tv.minus.toString(16)}/${tv.plus.toString(16)}/${tv.category}`, 'a/b/4',
    '58 Tune vertical = 0x0a/0x0b cat 4');
  const th = AXIS_HALVES.TUNE['horizontal:tune:1_finger'];
  eq(`${th.minus.toString(16)}/${th.plus.toString(16)}/${th.category}`, 'c/d/6',
    '58 Tune horizontal = 0x0c/0x0d cat 6');
  const tr = AXIS_HALVES.TRACK['rotate:track'];
  eq(`${tr.minus.toString(16)}/${tr.plus.toString(16)}/${tr.category}`, 'a/9/4',
    '58 Track rotate = 0x0a(-)/0x09(+) cat 4 — field order reversed vs sign');
  const tv2 = AXIS_HALVES.TOUCH['vertical:touch:2_fingers'];
  const th2 = AXIS_HALVES.TOUCH['horizontal:touch:2_fingers'];
  eq(`${tv2.minus.toString(16)}/${tv2.plus.toString(16)}/${tv2.category} ${th2.minus.toString(16)}/${th2.plus.toString(16)}/${th2.category}`,
    'd/e/4 f/10/6', '58 Touch 2-finger vert 0x0d/0x0e cat 4, horiz 0x0f/0x10 cat 6');
  eq(halfSelector(tv, '-') === -1 && halfSelector(tv, '+') === 1 && tv.selectors === undefined,
    true, '58 halfSelector defaults to the sign (vendored halves are ordinary)');

  // SETTING_FIELDS + tick conversion: the app stores detents per turn, the
  // wire byte is DEGREES per detent = round(360/n) (SCRUM-50, live 2026-09-16).
  eq(SETTING_FIELDS.TUNE.ticks_per_rotation, 0x05, '58 Tune ticks_per_rotation = field 0x05');
  eq(Object.keys(SETTING_FIELDS.FLOAT).length, 0, '58 FLOAT has no writable settings');
  eq(ticksToWire(5), 72, '58 ticksToWire(5) = 72 (5 detents = 72 deg/detent)');
  eq(ticksToWire(10), 36, '58 ticksToWire(10) = 36');
  eq(ticksToWire(4), 90, '58 ticksToWire(4) = 90');
  eq(ticksFromWire(72), 5, '58 ticksFromWire(72) = 5 detents');
  eq(ticksFromWire(0), null, '58 ticksFromWire(0) = null (0 degrees means nothing)');

  // FIRMWARE_DEFAULTS + LOCKED — Touch 1/2-finger tap + 1-finger cursor:
  // empty IS the default on the wire; always written empty; drift never counted.
  eq(FIRMWARE_DEFAULTS.TOUCH?.['tap:touch:1_finger'], 'M1', '58 firmware default: 1-finger tap = M1');
  eq(FIRMWARE_DEFAULTS.TOUCH?.['vertical:touch:1_finger'], 'mouse - MOUSE_DOWN - MOUSE_UP',
    '58 firmware default: 1-finger cursor vertical');
  eq(LOCKED_GESTURES.TOUCH.size === 4 && LOCKED_GESTURES.TOUCH.has('tap:touch:2_fingers')
    && LOCKED_GESTURES.TOUCH.has('horizontal:touch:1_finger'), true,
    '58 LOCKED_TOUCH = the 4 firmware-driven gestures');
  eq(LOCKED_GESTURES.TRACK.size === 0 && LOCKED_GESTURES.TUNE.size === 0, true,
    '58 Track/Tune have no locked gestures');

  // splitPair — LAST TWO parts, both spellings; PAIRED dial halves.
  eq(JSON.stringify(splitPair('mouse - SCROLL_UP - SCROLL_DOWN')),
    JSON.stringify(['SCROLL_UP', 'SCROLL_DOWN']), '58 splitPair drops the leading kind');
  eq(JSON.stringify(splitPair('C_VOL_DOWN - C_VOL_UP')),
    JSON.stringify(['C_VOL_DOWN', 'C_VOL_UP']), '58 splitPair parses the dial form (no leading kind)');
  eq(JSON.stringify(splitPair('M1')), JSON.stringify([null, null]), '58 splitPair: no pair → nulls');
  eq(gestureField('TUNE', PAIRED_GESTURES.TUNE!['rotate:tune:dial'].minus) === 0x23
    && gestureField('TUNE', PAIRED_GESTURES.TUNE!['rotate:tune:dial'].plus) === 0x22, true,
    '58 dial pair: minus half = 0x23 (CCW), plus half = 0x22 (CW)');
  eq(moduleTypeOfGesture('vertical:track') === 'TRACK' && moduleTypeOfGesture('no:such:gesture') === null,
    true, '58 moduleTypeOfGesture claims and unknowns');

  // Convention flip (SCRUM-62): FLIPPED_ON_WINDOWS = {4} only.
  eq(conventionSign(4, 1, 'windows'), -1, '58 conventionSign cat 4 flips on windows');
  eq(conventionSign(4, -1, 'mac'), -1, '58 conventionSign cat 4 untouched on mac');
  eq(conventionSign(8, 1, 'windows') === 1 && conventionSign(6, -1, 'windows') === -1, true,
    '58 cat 6 and cat 8 are NOT flipped (zoom is measured unflipped)');
  eq(conventionOf({ scroll_convention: 1 }) === 'windows' && conventionOf({}) === 'mac', true,
    '58 conventionOf: 1 = windows, absent = mac');

  // Stock profiles — 4, ported verbatim from the vendored stock source.
  eq(STOCK_PROFILES.length, 4, '58 four stock profiles');
  eq(Object.keys(StockProfiles).join(','), 'TOUCH_WINDOWS,TRACK_LEFT,TRACK_RIGHT,TUNE',
    '58 StockProfiles keyed by id');
  eq(Object.keys(StockProfiles.TOUCH_WINDOWS.bindings).length, 16,
    '58 TOUCH_WINDOWS ships 16 bindings');
  const tuneStock = StockProfiles.TUNE;
  eq(Object.keys(tuneStock.bindings).length === 13
    && tuneStock.bindings['rotate:tune:dial'].actionCode === 'C_VOL_DOWN - C_VOL_UP', true,
    '58 TUNE ships 13 bindings incl the combined dial row');
  eq(['tap:track:button_1', 'tap:track:button_2', 'tap:track:button_3', 'tap:track:button_4']
    .map((g) => StockProfiles.TRACK_LEFT.bindings[g].actionCode).join(','),
    'M1,M3,M2,M4', '58 TRACK_LEFT buttons M1/M3/M2/M4');
  eq(['tap:track:button_1', 'tap:track:button_2', 'tap:track:button_3', 'tap:track:button_4']
    .map((g) => StockProfiles.TRACK_RIGHT.bindings[g].actionCode).join(','),
    'M4,M2,M3,M1', '58 TRACK_RIGHT buttons M4/M2/M3/M1 (asymmetric module)');
  const ledSwipe = tuneStock.bindings['swipe_up:tune:3_fingers'];
  eq(ledSwipe.actionType === 'LED' && ledSwipe.actionCode === 'LED_BRIGHTNESS_UP', true,
    '58 TUNE 3-finger up swipe = LED brightness');

  // encodeAxisBinding — invert = SELECTOR SWAP (no flag on the device).
  eq(toHex(encodeAxisBinding(4, -1, 0)), '04 00 00 00 ff ff ff ff',
    '58 axis half (4, -1) twoWord value');
  eq(toHex(encodeAxisBinding(4, -1, 1)), '04 00 00 00 01 00 00 00',
    '58 axis invert swaps the selector (writes +1)');

  // compareRecords — byte truth.
  const tuneOverlay = overlay(new Map<number, Uint8Array>(), tuneStock, 'TUNE');
  eq(compareRecords(tuneOverlay, new Map(tuneOverlay)), true, '58 compareRecords: same bytes → true');
  const corrupted58 = new Map(tuneOverlay);
  corrupted58.set(0x00, Uint8Array.from([0x00, 0x01, 0x01, 0x0b]));
  eq(compareRecords(tuneOverlay, corrupted58), false, '58 compareRecords: one byte off → false');
  corrupted58.delete(0x23);
  eq(compareRecords(tuneOverlay, corrupted58), false, '58 compareRecords: missing record → false');

  // overlay — template-copy + modeled fields only; never invents fields.
  const template58 = new Map<number, Uint8Array>([
    [0x30, Uint8Array.from([0x30, 0x01, 0x01, 0x2a])], // beyond every Tune field
  ]);
  const over58 = overlay(template58, tuneStock, 'TUNE');
  eq(toHex(over58.get(0x30)!), '30 01 01 2a', '58 overlay carries unmodeled records byte-exact');
  eq(over58.has(0x08), false, '58 overlay never invents fields (unbound 0x08 stays absent)');
  eq(toHex(over58.get(0x0a)!), '0a 0f 08 04 00 00 00 ff ff ff ff',
    '58 overlay: vertical minus half = twoWord (4, -1) under mac');
  eq(toHex(over58.get(0x23)!), '23 04 06 01 04 ea 00 0c 00',
    '58 dial minus half: 0x23 = keypress C_VOL_DOWN');
  eq(toHex(over58.get(0x22)!), '22 04 06 01 04 e9 00 0c 00',
    '58 dial plus half: 0x22 = keypress C_VOL_UP');
  eq(toHex(over58.get(0x05)!), '05 01 01 05',
    '58 overlay: ticks 72 detents → wire byte 5 (degrees per detent)');
  eq(toHex(over58.get(0x00)!), '00 01 01 0a', '58 overlay: pointer speed 10 → 00 01 01 0a');

  // Locked rows are written EMPTY even when the profile binds them and the
  // template holds garbage.
  const touchTemplate58 = new Map<number, Uint8Array>([
    [0x0b, Uint8Array.from([0x0b, 0x04, 0x06, 0x01, 0x04, 0x04, 0x00, 0x07, 0x00])],
  ]);
  const touchOver58 = overlay(touchTemplate58, StockProfiles.TOUCH_WINDOWS, 'TOUCH');
  eq(toHex(touchOver58.get(0x0b)!), '0b 07 00',
    '58 locked tap field written EMPTY over template garbage (profile binds M1 there)');

  // Convention flip reaches the wire through overlay.
  const winTune58: typeof tuneStock = {
    ...tuneStock,
    settings: { ...tuneStock.settings, scroll_convention: 1 },
  };
  const winOver58 = overlay(new Map<number, Uint8Array>(), winTune58, 'TUNE');
  eq(toHex(winOver58.get(0x0a)!), '0a 0f 08 04 00 00 00 01 00 00 00',
    '58 windows convention: vertical minus half carries +1');
  eq(toHex(winOver58.get(0x0c)!), '0c 0f 08 06 00 00 00 ff ff ff ff',
    '58 windows convention: horizontal (cat 6) untouched');

  // diffProfile — byte truth under a convention; locks never count.
  eq(diffProfile(tuneStock, tuneOverlay, 'mac').length, 0, '58 diff: stock vs own overlay → no drift');
  const drift58 = new Map(tuneOverlay);
  drift58.set(0x0e, Uint8Array.from([0x0e, 0x04, 0x06, 0x01, 0x04, 0x2c, 0x00, 0x0c, 0x00]));
  const rows58 = diffProfile(tuneStock, drift58, 'mac');
  eq(rows58.length === 1 && rows58[0].gesture === 'tap:tune:2_fingers' && rows58[0].field === 0x0e,
    true, '58 diff: keypress drift counted, row names gesture + field');
  const touchDrift58 = new Map(touchOver58);
  touchDrift58.set(0x0b, Uint8Array.from([0x0b, 0x04, 0x06, 0x01, 0x04, 0x04, 0x00, 0x07, 0x00]));
  eq(diffProfile(StockProfiles.TOUCH_WINDOWS, touchDrift58, 'mac').length, 0,
    '58 diff: locked row drift NEVER counted');
  const maskDrift58 = new Map(touchOver58);
  maskDrift58.set(0x13, Uint8Array.from([0x13, 0x07, 0x00]));
  const maskRows58 = diffProfile(StockProfiles.TOUCH_WINDOWS, maskDrift58, 'mac');
  eq(maskRows58.length === 1 && maskRows58[0].gesture === 'tap:touch:3_fingers', true,
    '58 diff: mask (3-finger tap M3) drift counted');
  const convRows58 = diffProfile(tuneStock, tuneOverlay, 'windows');
  eq(convRows58.length === 1 && convRows58[0].gesture === 'vertical:tune:1_finger', true,
    '58 diff: comparing mac bytes under windows flags only the cat-4 axis');
  const emptyRows58 = diffProfile(tuneStock, new Map(), 'mac');
  eq(emptyRows58.length, 11, '58 diff: empty slot → 11 encodable bindings drift (LED rows not judged)');
  eq(emptyRows58.some((r) => r.gesture === 'tap:tune:2_fingers' && r.got === '(absent)'), true,
    '58 diff: missing record reported as (absent)');

  // openflow.module-profile v1 io — parse validates, never infers, round-trips.
  eq('error' in parseModuleProfileFile(null), true, '58 parse: not an object → error');
  eq('error' in parseModuleProfileFile({ format: 'nope' }), true, '58 parse: foreign format → error');
  const mtMissing58 = parseModuleProfileFile({ format: 'openflow.module-profile', version: 1 });
  eq('error' in mtMissing58 && mtMissing58.error === 'unknown module type — this app reads TOUCH/TRACK/TUNE/FLOAT',
    true, '58 parse: missing moduleType → exact refusal message');
  const mtUnknown58 = parseModuleProfileFile({ format: 'openflow.module-profile', version: 1, moduleType: 'KEYPAD' });
  eq('error' in mtUnknown58 && mtUnknown58.error === 'unknown module type — this app reads TOUCH/TRACK/TUNE/FLOAT',
    true, '58 parse: unknown moduleType → same refusal (never inferred)');
  const touchFile58 = buildModuleProfileFile(StockProfiles.TOUCH_WINDOWS);
  const misfiled58 = parseModuleProfileFile({ ...touchFile58, moduleType: 'TRACK' });
  eq('error' in misfiled58 && misfiled58.error.includes('belongs to another type'), true,
    '58 parse: Touch gestures filed as TRACK → refused (all-foreign)');
  const partial58 = parseModuleProfileFile({
    format: 'openflow.module-profile',
    version: 1,
    moduleType: 'TUNE',
    bindings: {
      'tap:tune:2_fingers': { actionType: 'key', actionCode: 'C_PLAY_PAUSE' },
      'tap:touch:1_finger': { actionType: 'mouse', actionCode: 'M1' },
      'bogus:gesture': { actionType: 'key', actionCode: 'X' },
    },
  });
  eq('profile' in partial58 && Object.keys(partial58.profile.bindings).length === 1
    && JSON.stringify(partial58.skipped) === JSON.stringify(['tap:touch:1_finger', 'bogus:gesture']),
    true, '58 parse: partial foreign gestures kept out via skipped list');
  const round58 = parseModuleProfileFile(buildModuleProfileFile(tuneStock));
  eq('profile' in round58
    && round58.profile.id === 'TUNE'
    && round58.profile.name === 'Naya Tune Mac/Win'
    && round58.profile.type === 'TUNE'
    && round58.profile.settings.ticks_per_rotation === 72
    && round58.profile.bindings['rotate:tune:dial'].actionCode === 'C_VOL_DOWN - C_VOL_UP'
    && round58.skipped.length === 0, true,
    '58 round-trip: stock TUNE file parses back identical');
  const splitProfile58 = {
    ...tuneStock,
    id: 'split-dial',
    name: 'Split dial',
    bindings: {
      ...tuneStock.bindings,
      'rotate:tune:dial': {
        actionType: 'value',
        actionCode: 'C_VOL_DOWN - C_VOL_UP',
        split: {
          '-': { actionType: 'key', actionCode: 'F23' },
          '+': { actionType: 'key', actionCode: 'F24' },
        },
      },
    },
  };
  const splitFile58 = buildModuleProfileFile(splitProfile58);
  eq(splitFile58.bindings!['rotate:tune:dial'].split?.['-']?.actionCode === 'F23'
    && splitFile58.bindings!['rotate:tune:dial'].split?.['+']?.actionCode === 'F24', true,
    '58 build: split halves nest under split (F23/F24)');
  const splitBack58 = parseModuleProfileFile(splitFile58);
  eq('profile' in splitBack58
    && splitBack58.profile.bindings['rotate:tune:dial'].split?.['-']?.actionCode === 'F23', true,
    '58 parse: split nesting survives into the profile');
  eq('profile' in splitBack58
    && JSON.stringify(buildModuleProfileFile(splitBack58.profile)) === JSON.stringify(splitFile58),
    true, '58 round-trip: build∘parse∘build is byte-stable (split + settings + order)');
  // Split dial reaches the WIRE through overlay (the PAIRED_GESTURES branch
  // honors split like the axis branch): 0x23/0x22 carry the F23/F24
  // keypress halves from split, NOT the combined C_VOL_DOWN/C_VOL_UP pair.
  // Usages derived from the host table, not hand-typed (0x72/0x73 page 7).
  const splitOver58 = overlay(new Map<number, Uint8Array>(), splitProfile58, 'TUNE');
  const f23u58 = nameToUsage('F23')!;
  const f24u58 = nameToUsage('F24')!;
  eq(f23u58.usage === 0x72 && f23u58.page === 0x07 && f24u58.usage === 0x73 && f24u58.page === 0x07,
    true, '58 host-table: F23/F24 = 0x0072/0x0073 on page 7');
  eq(toHex(splitOver58.get(0x23)!), '23 04 06 01 04 72 00 07 00',
    '58 split dial: minus half 0x23 = keypress F23 (split beats combined)');
  eq(toHex(splitOver58.get(0x22)!), '22 04 06 01 04 73 00 07 00',
    '58 split dial: plus half 0x22 = keypress F24 (no consumer record)');
  eq(toHex(over58.get(0x23)!) === '23 04 06 01 04 ea 00 0c 00'
    && toHex(over58.get(0x22)!) === '22 04 06 01 04 e9 00 0c 00', true,
    '58 unsplit dial (regression): overlay still writes the combined C_VOL pair');
  const coerced58 = parseModuleProfileFile({
    format: 'openflow.module-profile',
    version: 1,
    moduleType: 'TUNE',
    settings: { pointer_speed: '50', pointer_accel_on: 'true', scroll_convention: 'windows' },
    bindings: { 'tap:tune:2_fingers': { actionType: 'key', actionCode: 'C_PLAY_PAUSE' } },
  });
  eq('profile' in coerced58
    && coerced58.profile.settings.pointer_speed === 50
    && coerced58.profile.settings.pointer_accel_on === 1
    && conventionOf(coerced58.profile.settings) === 'windows', true,
    '58 parse: string settings coerce (number / true / windows)');
}

// §59 module planner: slot lifecycle (uuid-keep, capture-claim, lowest-free
// allocation, reclaim-when-full, >8 refusal, template sources), BASE-layer
// bay gap detection, orphan-GC ordering (bay mutations → list deletes →
// FULL blanks last), and the moduleCfg/moduleList draft ops + bay
// assignment through the existing key path. Wire bytes ride the Task-1
// encoders unchanged; module verbs must route the never-send guard
// (30/1009, 30/100A pass).
{
  /* --- planner: uuid-keep ------------------------------------------------- */
  const keepA = planModuleLayout(
    [{ id: 'u-a', type: 'TRACK' }],
    [{ slot: 3, uuid: 'u-a', type: 'TRACK' }],
    [],
  );
  eq('error' in keepA, false, '59 uuid-keep: plan succeeds');
  if (!('error' in keepA)) {
    eq(keepA.assignments.length === 1 && keepA.assignments[0].slot === 3, true,
      '59 uuid-keep: the profile whose id is on the device keeps its slot');
    const entryA = keepA.assignments[0].listEntry;
    eq(entryA.slot === 3 && entryA.id === 3 && entryA.flag === MODULE_TYPE_CODE.TRACK
      && entryA.uuid16 === 'u-a', true,
      '59 list entry: slot, mirrored id, type flag, uuid16');
    eq(keepA.templateSources['u-a'], null,
      '59 kept slot needs no template (templateSources null)');
  }

  /* --- planner: capture-claim --------------------------------------------- */
  const keepB = planModuleLayout(
    [{ id: 'p-new', type: 'TUNE', capturedFrom: 'u-cap' }],
    [{ slot: 5, uuid: 'u-cap', type: 'TUNE' }],
    [],
  );
  eq('error' in keepB, false, '59 capture-claim: plan succeeds');
  if (!('error' in keepB)) {
    eq(keepB.assignments.length === 1 && keepB.assignments[0].slot === 5, true,
      "59 capture-claim: capturedFrom uuid claims that module's slot");
    eq(keepB.assignments[0].listEntry.uuid16, 'p-new',
      "59 claimed slot's list entry carries the NEW uuid");
    eq(keepB.templateSources['p-new'], null,
      '59 captured slot holds its own records (templateSources null)');
  }

  /* --- planner: allocate lowest free 1..7, slot 0 never -------------------- */
  const keepC = planModuleLayout(
    [{ id: 'n1', type: 'TRACK' }, { id: 'n2', type: 'TRACK' }],
    [
      { slot: 0, uuid: 'blank-template', type: 'TRACK' },
      { slot: 1, uuid: 'u-1', type: 'TRACK' },
    ],
    [],
  );
  eq('error' in keepC, false, '59 allocation: plan succeeds');
  if (!('error' in keepC)) {
    const slotOf = (id: string) => keepC.assignments.find((a) => a.profileId === id)?.slot;
    eq(`${slotOf('n1')}/${slotOf('n2')}`, '2/3',
      '59 allocation: lowest free from 1..7 — slot 0 (blank template) never allocated');
    eq(keepC.templateSources['n1'], 1,
      '59 template source: smallest same-type slot on the device (slot 0 excluded)');
  }

  /* --- planner: reclaim when full ------------------------------------------ */
  const fullList59 = [1, 2, 3, 4, 5, 6, 7].map((s) => ({
    slot: s, uuid: `u-${s}`, type: 'TOUCH' as const,
  }));
  const keepD = planModuleLayout([{ id: 'new-guy', type: 'TOUCH' }], fullList59, []);
  eq('error' in keepD, false, '59 reclaim: plan succeeds on a full board');
  if (!('error' in keepD)) {
    eq(keepD.reclaimed.join(','), '1', '59 reclaim: lowest unreferenced slot reported');
    eq(keepD.assignments[0].slot, 1, '59 reclaim: the new profile takes the reclaimed slot');
    eq(keepD.templateSources['new-guy'], 2,
      '59 reclaim: template source skips the slot being reclaimed');
  }
  const keepE = planModuleLayout([{ id: 'new-guy', type: 'TOUCH' }], fullList59, ['u-1', 'u-2']);
  eq('error' in keepE, false, '59 reclaim (referenced): plan succeeds');
  if (!('error' in keepE)) {
    eq(keepE.reclaimed.join(','), '3',
      '59 reclaim: bay-referenced slots (u-1, u-2) are skipped');
  }

  /* --- planner: refusals ----------------------------------------------------- */
  const tooMany59 = planModuleLayout(
    Array.from({ length: 9 }, (_, i) => ({ id: `p-${i}`, type: 'TOUCH' as const })),
    [],
    [],
  );
  eq('error' in tooMany59, true,
    '59 refusal: 9 distinct profiles exceed the 8-entry module list');
  const noTemplate59 = planModuleLayout([{ id: 'lone-tune', type: 'TUNE' }], [], []);
  eq('error' in noTemplate59 && noTemplate59.error === 'Dock the module and read the keyboard first',
    true, '59 refusal: new slot with no same-type source → exact dock-module error');

  /* --- missingBaseBays -------------------------------------------------------- */
  const fullBays59: Record<number, number> = { 0x4a: 1, 0x4b: 1, 0x4c: 2, 0x4d: 3, 0x4e: 4, 0x4f: 5 };
  eq(missingBaseBays(fullBays59).length, 0,
    '59 base bays: six required filled, float bays absent → no gaps (float exempt)');
  const tuneR59: Record<number, number> = { ...fullBays59 };
  delete tuneR59[0x4f];
  const tuneRGaps = missingBaseBays(tuneR59);
  eq(tuneRGaps.length, 1, '59 base bays: missing tune right → exactly one gap');
  eq(tuneRGaps[0]?.includes('tune right') === true && tuneRGaps[0]?.includes('0x4f') === true,
    true, '59 base bays: the gap names the bay and its position');
  eq(missingBaseBays({ ...fullBays59, 0x4e: 'inherit' }).length, 1,
    '59 base bays: inherit on the BASE layer is a gap (nothing to inherit)');
  eq(missingBaseBays({ ...fullBays59, 0x4d: 'transparent' }).length, 1,
    '59 base bays: transparent is a gap');
  eq(missingBaseBays({ ...fullBays59, 0x4e: 'disabled' }).length, 0,
    '59 base bays: disabled is a deliberate empty, not a gap');
  eq(missingBaseBays({ ...fullBays59, 0x50: 'inherit', 0x51: 2 }).length, 0,
    '59 base bays: float bays (0x50/0x51) are exempt');

  /* --- orphanGcOps ordering ----------------------------------------------------- */
  const gc59 = orphanGcOps([3], { 0: { 0x4c: 3, 0x4a: 1 }, 1: { 0x4b: 3 } });
  eq(gc59.length, 4, '59 orphan GC: 2 bay mutations + 1 delete + 1 blank');
  eq(gc59[0].kind === 'bay' && gc59[0].layer === 0 && gc59[0].pos === 0x4c, true,
    '59 orphan GC: bay mutations FIRST (layer 0, lowest pos)');
  eq(gc59[1].kind === 'bay' && gc59[1].layer === 1 && gc59[1].pos === 0x4b, true,
    '59 orphan GC: then layer 1 — every bay op precedes any delete');
  eq(toHex(gc59[0].payload), '4c 00 00', '59 orphan GC: bay record disabled 0x00');
  eq(gc59[2].kind === 'listDelete' && gc59[2].slot === 3, true,
    '59 orphan GC: list deletes MIDDLE');
  eq(toHex(gc59[2].payload), '00 03 00 00 00', '59 orphan GC: Task-1 delete payload');
  eq(gc59[3].kind === 'blank' && gc59[3].slot === 3, true, '59 orphan GC: blanks LAST');
  eq(gc59[3].kind === 'blank' && gc59[3].payload.length === 121
    && toHex(gc59[3].payload.slice(118)) === '27 00 00', true,
    '59 orphan GC: blank IN FULL (121B ending at record 0x27 — never short)');
  const gc2 = orphanGcOps([5, 2], {});
  eq(gc2.filter((o) => o.kind === 'listDelete').map((o) => o.slot).join(','), '2,5',
    '59 orphan GC: multi-orphan deletes sorted ascending');

  /* --- queueModuleConfig ---------------------------------------------------------- */
  const recA59 = Uint8Array.from([0x00, 0x01, 0x01, 0x0a]);
  const recB59 = Uint8Array.from([0x05, 0x01, 0x01, 0x05]);
  const qd59 = new Draft();
  eq(queueModuleConfig(qd59, 4, [recA59, recB59], 'tune config').queued, true,
    '59 queueModuleConfig: queued');
  const cfg59 = qd59.ops[0];
  eq(cfg59.kind === 'moduleCfg' && cfg59.slot === 4, true,
    '59 moduleCfg op carries the slot');
  eq(toHex(cfg59.kind === 'moduleCfg' ? cfg59.payload : new Uint8Array(0)),
    '04 00 01 01 0a 05 01 01 05',
    '59 moduleCfg payload = slot byte + records joined');
  eq(opKey(cfg59), 'moduleCfg:4:040001010a05010105',
    '59 moduleCfg opKey = slot + payload hex (latest-wins per write)');
  eq(opSection(cfg59), 'modules', '59 moduleCfg sits in the modules section');
  eq(JSON.stringify(qd59.stats()), '{"ops":1,"frames":1,"bytes":19}',
    '59 moduleCfg stats: frames via chunkBudget, bytes = 10 + payload');
  const qdFat59 = new Draft();
  const fat59 = queueModuleConfig(
    qdFat59, 1,
    Array.from({ length: 161 }, (_, f) => Uint8Array.from([f & 0xff, 0x01, 0x01])),
    'too big',
  );
  eq(fat59.queued === false && fat59.error === 'module config exceeds the 483-byte two-frame ceiling',
    true, '59 queueModuleConfig: 484B payload refused with the exact ceiling reason');
  eq(qdFat59.size, 0, '59 queueModuleConfig: refusal queues nothing');
  eq(qdFat59.drops.length === 1
    && qdFat59.drops[0].effect === 'the module keeps its stored configuration', true,
    '59 queueModuleConfig: drop recorded with the honest effect');
  const qdEdge59 = new Draft();
  eq(queueModuleConfig(qdEdge59, 1, [new Uint8Array(482)], 'edge').queued, true,
    '59 queueModuleConfig: exactly 483B (slot + record) still fits');

  /* --- reconcile keeps module ops (no readback path) ---------------------- */
  const qr59 = new Draft();
  queueModuleConfig(qr59, 2, [recA59], 'cfg keep');
  queueModuleListAdd(qr59, {
    slot: 2, id: 2, flag: MODULE_TYPE_CODE.TRACK, uuid16: '00112233445566778899aabbccddeeff',
  });
  eq(qr59.reconcile([], []) === 0 && qr59.size === 2
    && qr59.ops.some((o) => o.kind === 'moduleCfg')
    && qr59.ops.some((o) => o.kind === 'moduleList'), true,
    '59 reconcile keeps moduleCfg + moduleList (no readback — both kinds survive)');

  /* --- queueModuleListAdd/Delete ----------------------------------------------------- */
  const ql59 = new Draft();
  eq(queueModuleListAdd(ql59, {
    slot: 5, id: 5, flag: MODULE_TYPE_CODE.TRACK, uuid16: '00112233445566778899aabbccddeeff',
  }).queued, true, '59 queueModuleListAdd: queued');
  eq(toHex(ql59.ops[0].payload),
    '00 05 05 01 10 00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff',
    '59 list add payload byte-pinned (Task-1 capture 00 05 05 01 10 <uuid16>)');
  eq(opSection(ql59.ops[0]), 'modules', '59 moduleList sits in the modules section');
  eq(queueModuleListDelete(ql59, 5).queued, true, '59 queueModuleListDelete: queued');
  eq(toHex(ql59.ops[1].payload), '00 05 00 00 00',
    '59 list delete payload byte-pinned (Task-1 capture 00 05 00 00 00)');
  eq(ql59.size, 2, '59 add and delete coexist (payload-addressed opKeys)');
  eq(opKey(ql59.ops[0]) !== opKey(ql59.ops[1]), true,
    '59 moduleList opKeys are payload-hex addressed');
  queueModuleListAdd(ql59, {
    slot: 5, id: 5, flag: MODULE_TYPE_CODE.TRACK, uuid16: '00112233445566778899aabbccddeeff',
  });
  eq(ql59.size, 2, '59 identical re-add replaces (latest-wins), size stays 2');

  /* --- queueBayAssignment --------------------------------------------------------------- */
  const qb59 = new Draft();
  queueBayAssignment(qb59, 1, 0x4c, 5);
  const bayOp59 = qb59.ops[0];
  eq(bayOp59.kind === 'key' && bayOp59.layer === 1 && bayOp59.kk === 0x4c, true,
    '59 bay assignment rides the EXISTING key op at KK 0x4c');
  eq(toHex(bayOp59.kind === 'key' ? bayOp59.record : new Uint8Array(0)), '4c 05 00',
    '59 bay record 4c 05 00 (Task-1 bytes)');
  queueBayAssignment(qb59, 1, 0x4c, 'inherit');
  eq(toHex(qb59.ops[0].kind === 'key' ? qb59.ops[0].record : new Uint8Array(0)), '4c 78 00',
    '59 bay inherit → 0x78 (resolves to BASE)');
  queueBayAssignment(qb59, 1, 0x4c, 'disabled');
  eq(toHex(qb59.ops[0].kind === 'key' ? qb59.ops[0].record : new Uint8Array(0)), '4c 00 00',
    '59 bay disabled → 0x00');
  eq(qb59.size, 1, '59 bay latest-wins per layer+kk (shared key opKey)');
  eq(opKey(qb59.ops[0]), 'key:1:76', '59 bay opKey = key:layer:kk (0x4c = 76)');

  /* --- bay window guard (Task-4 hardening, 5a BINDING a) ---------------- */
  const qdBad59 = new Draft();
  const bad9 = queueBayAssignment(qdBad59, 1, 0x4c, 9);
  const bad200 = queueBayAssignment(qdBad59, 2, 0x4d, 200);
  eq(
    bad9.queued === false && bad200.queued === false &&
      bad9.error === 'bay value 9 is outside the writable window (0, 0x78 inherit, 1-7)' &&
      qdBad59.size === 0 &&
      qdBad59.drops.length === 2 &&
      qdBad59.drops.every((d) => d.reason.includes('outside the writable window')) &&
      qdBad59.drops[0].effect === 'this bay keeps its current assignment' &&
      qdBad59.drops[0].at === 'queue',
    true,
    '59 bay window guard: 9 + 200 refuse-with-drop (window reason, honest effect), nothing queued',
  );

  /* --- orphanGcOps slot-0 skip (Task-4 hardening, 5a BINDING a) ---------- */
  eq(
    orphanGcOps([0], { 0: { 0x4a: 0 }, 1: { 0x4c: 0 } }).length === 0 &&
      orphanGcOps([0, 3], {}).every((o) => o.slot !== 0) &&
      orphanGcOps([0, 3], {}).some((o) => o.kind === 'listDelete' && o.slot === 3),
    true,
    '59 orphan GC: slot 0 (the blank template) is never GCd — skipped silently, slot 3 still reclaimed',
  );

  /* --- the guard routes module verbs (review condition a) -------------------------------- */
  let guarded59 = 0;
  try { assertWireAllowed(0x30, 0x10, 0x09); } catch { guarded59++; }
  try { assertWireAllowed(0x30, 0x10, 0x0a); } catch { guarded59++; }
  eq(guarded59, 0,
    '59 module verbs route the guard: 30/1009 + 30/100A pass (never-send list untouched)');

  /* --- probeDraft -------------------------------------------------------------------------- */
  const pq59 = new Draft();
  pq59.add({
    kind: 'moduleCfg', slot: 8, records: [recA59],
    payload: Uint8Array.from([8, 0, 1, 1, 0x0a]), label: 'bad slot',
  });
  const probeBad59 = probeDraft(pq59);
  eq(probeBad59.length === 1 && probeBad59[0].reason.includes('slot 8'), true,
    '59 probe: moduleCfg at slot 8 flagged (window 0-7)');
  const pqFat = new Draft();
  pqFat.add({
    kind: 'moduleCfg', slot: 1, records: [new Uint8Array(484)],
    payload: new Uint8Array(485), label: 'fat',
  });
  const probeFat59 = probeDraft(pqFat);
  eq(probeFat59.length === 1 && probeFat59[0].reason.includes('483'), true,
    '59 probe: moduleCfg payload over the 483 ceiling flagged');
  const pqMany = new Draft();
  pqMany.add({
    kind: 'moduleCfg', slot: 1,
    records: Array.from({ length: 41 }, () => Uint8Array.from([0, 7, 0])),
    payload: Uint8Array.from([1, ...Array.from({ length: 123 }, () => 0)]),
    label: 'many',
  });
  const probeMany59 = probeDraft(pqMany);
  eq(probeMany59.length === 1 && probeMany59[0].reason.includes('40'), true,
    '59 probe: moduleCfg over 40 record slots flagged');
  const pqList = new Draft();
  pqList.add({
    kind: 'moduleList',
    payload: Uint8Array.from([0x00, 0x08, 0x08, 0x01, 0x10, ...Array.from({ length: 16 }, () => 0xaa)]),
    label: 'bad entry',
  });
  eq(probeDraft(pqList).length === 1, true,
    '59 probe: moduleList entry naming slot 8 flagged');
  const pqClean = new Draft();
  queueModuleConfig(pqClean, 1, [recA59, recB59], 'fine');
  queueModuleListDelete(pqClean, 1);
  eq(probeDraft(pqClean).length, 0, '59 probe: in-window moduleCfg/moduleList are clean');
}

// §60 module read path: 30/1009 list parse (byte-exact literal), per-slot
// record mapping, content match (the uuid only orders equals — content
// decides, each candidate compared under its OWN convention), capture-on-
// read (numbered naming, device overrides, no inherited drift rows), bay
// repoint scoped to one profile, and readModuleList through a scripted
// device (request params ride the MODULE_ADDR seam: [0x00, 0x00]).
const UUID60 = 'aabbccddeeff00112233445566778899';
// Read-form entry = the write form minus its 00 flag byte:
// [slot][id][flag][0x10][uuid16] — 20 bytes, the layer-list shape.
const entry60 = (slot: number, flag: number, uuid: string) =>
  encodeListAdd(slot, slot, flag as 0 | 1 | 2 | 3, uuid).slice(1);
{
  const list60 = Uint8Array.from([
    0x00, 0x00, // [status][index echo] header — the 30/1001 model
    ...entry60(5, MODULE_TYPE_CODE.TRACK, UUID60),
    ...entry60(2, MODULE_TYPE_CODE.TUNE, '11223344556677889900aabbccddeeff'),
    ...entry60(0, MODULE_TYPE_CODE.TOUCH, '00ff00ff00ff00ff00ff00ff00ff00ff'),
    ...entry60(7, 0x7a, 'deadbeefdeadbeefdeadbeefdeadbeef'),
  ]);

  const parsed60 = parseModuleList(list60);
  eq(parsed60.length, 4, '60 parse: header skipped, four entries');
  const s5_60 = parsed60.find((e) => e.slot === 5)!;
  eq(`${s5_60.id}/${s5_60.typeFlag}/${s5_60.type}/${s5_60.uuid}`,
    `5/${MODULE_TYPE_CODE.TRACK}/TRACK/${UUID60}`,
    '60 parse: slot 5 entry byte-exact ([05][05][01][10]<uuid16>, plain-hex uuid)');
  const s2_60 = parsed60.find((e) => e.slot === 2)!;
  eq(`${s2_60.type}/${s2_60.uuid}`, 'TUNE/11223344556677889900aabbccddeeff',
    '60 parse: TUNE entry carries its list type');
  const s7_60 = parsed60.find((e) => e.slot === 7)!;
  eq(`${s7_60.type}/${s7_60.typeFlag}`, 'FLOAT/122',
    '60 parse: unknown flag 0x7a → FLOAT fallback, raw byte carried');
  eq(parsed60.some((e) => e.slot === 0 && e.uuid === '00ff00ff00ff00ff00ff00ff00ff00ff'), true,
    '60 parse: slot 0 (blank template) parses like any entry');
  eq(parseModuleList(Uint8Array.from([...list60, 0x99])).length, 4,
    '60 parse: trailing fragment that forms no entry is ignored');
  eq(parseModuleList(Uint8Array.from([
    0x00, 0x00, 0x05, 0x05, 0x01, 0x08, ...Array.from({ length: 16 }, () => 0xaa),
  ])).length, 0,
    '60 parse: uuid-length byte ≠ 0x10 → entry skipped');

  // Slot config blob → ConfigRecords: same universal record walk as
  // parseModuleConfig ([field][type][len][body]), keyed by field.
  const blob60 = Uint8Array.from([
    0x00, 0x01, 0x01, 0x1e, // field 0x00, setting 30
    0x05, 0x01, 0x01, 0x24, // field 0x05, setting 36 (ticks wire)
    0x0e, 0x04, 0x06, 0x01, 0x04, 0xea, 0x00, 0x0c, 0x00, // field 0x0e keypress
    0x0f, 0x07, 0x00, // field 0x0f empty
    0x0f, // truncated tail — ignored
  ]);
  const recs60 = recordsFromModuleBlob(blob60);
  eq(recs60.size, 4, '60 records: four records keyed by field');
  eq(toHex(recs60.get(0x0e)!), '0e 04 06 01 04 ea 00 0c 00',
    '60 records: record bytes kept verbatim ([field][type][len][body])');

  /* --- matchSlots --------------------------------------------------------- */
  const trackL60 = StockProfiles.TRACK_LEFT;
  const trackR60 = StockProfiles.TRACK_RIGHT;
  const leftOver60 = overlay(new Map<number, Uint8Array>(), trackL60, 'TRACK');
  const rightOver60 = overlay(new Map<number, Uint8Array>(), trackR60, 'TRACK');
  const driftOrig60 = { ...trackL60, id: 'u-orig', name: 'Drifted Left' };

  const matchA60 = matchSlots(
    [{ slot: 3, id: 3, typeFlag: MODULE_TYPE_CODE.TRACK, uuid: 'u-orig', type: 'TRACK' }],
    { 3: leftOver60 },
    [trackL60, trackR60, driftOrig60],
  );
  eq(matchA60.length === 1 && matchA60[0].slot === 3, true, '60 match: one slot in, one match out');
  eq(matchA60[0].matched?.id, 'u-orig',
    '60 match: the drifted original names its own entry (uuid tie among equal content)');
  eq(`${matchA60[0].ranked[0].differs}/${matchA60[0].ranked[0].tie}`, '0/0',
    '60 match: ranking is (differs, tie, name) — content first, uuid share only orders equals');

  const matchB60 = matchSlots(
    [{ slot: 4, id: 4, typeFlag: MODULE_TYPE_CODE.TRACK, uuid: 'u-foreign-uuid', type: 'TRACK' }],
    { 4: rightOver60 },
    [trackL60, trackR60],
  );
  eq(matchB60[0].matched?.id, 'TRACK_RIGHT',
    '60 match: a uuid the app never wrote still matches by CONTENT (type from the list byte)');
  eq(matchB60[0].uuid, 'u-foreign-uuid', '60 match: the entry carries the device uuid verbatim');

  const uuidShared60 = {
    ...trackL60,
    id: 'u-tie-a',
    name: 'Uuid Left',
    bindings: {
      ...trackL60.bindings,
      'tap:track:button_1': { actionType: 'mouse', actionCode: 'M2' },
    },
  };
  const matchC60 = matchSlots(
    [{ slot: 6, id: 6, typeFlag: MODULE_TYPE_CODE.TRACK, uuid: 'u-tie-a', type: 'TRACK' }],
    { 6: leftOver60 },
    [uuidShared60, trackL60],
  );
  eq(matchC60[0].matched?.id, 'TRACK_LEFT',
    '60 match: uuid never decides content — a drifted uuid-sharer loses to the matching profile');
  eq(matchC60[0].ranked[0].tie, 2, '60 match: the content match ranks first even at tie 2');
  eq(matchC60[0].differs, 0, '60 match: closest differs 0 → matched');

  const byId60 = { ...trackL60, id: 'u-left', name: 'AAA One' };
  const byFrom60 = { ...trackL60, id: 'zzz-id', name: 'Zzz One', capturedFrom: 'u-left' };
  const matchD60 = matchSlots(
    [{ slot: 1, id: 1, typeFlag: MODULE_TYPE_CODE.TRACK, uuid: 'u-left', type: 'TRACK' }],
    { 1: leftOver60 },
    [byFrom60, byId60],
  );
  eq(matchD60[0].ranked.map((r) => r.profile.id).join(','), 'u-left,zzz-id',
    '60 match: among equal content the uuid sharer (tie 0) beats captured-from (tie 1)');

  const matchE60 = matchSlots(
    [{ slot: 1, id: 1, typeFlag: MODULE_TYPE_CODE.TRACK, uuid: 'nobody', type: 'TRACK' }],
    { 1: leftOver60 },
    [
      { ...trackL60, id: 'm2', name: 'Mmm Two' },
      { ...trackL60, id: 'a2', name: 'Aaa Two' },
    ],
  );
  eq(matchE60[0].ranked[0].profile.name, 'Aaa Two',
    '60 match: name breaks a full (differs, tie) tie — deterministic');

  const winLeft60 = {
    ...trackL60,
    id: 'win',
    name: 'Win Left',
    settings: { ...trackL60.settings, scroll_convention: 1 },
  };
  const matchF60 = matchSlots(
    [{ slot: 2, id: 2, typeFlag: MODULE_TYPE_CODE.TRACK, uuid: 'mac-slot', type: 'TRACK' }],
    { 2: leftOver60 },
    [winLeft60, trackL60],
  );
  eq(matchF60[0].matched?.id, 'TRACK_LEFT',
    '60 match: each candidate compares under its OWN scroll convention');
  eq(matchF60[0].ranked.find((r) => r.profile.id === 'win')!.differs > 0, true,
    '60 match: the windows candidate sees cat-4 drift in mac bytes (not matched)');

  const matchG60 = matchSlots(
    [
      { slot: 0, id: 0, typeFlag: MODULE_TYPE_CODE.TRACK, uuid: 'tpl', type: 'TRACK' },
      { slot: 7, id: 7, typeFlag: MODULE_TYPE_CODE.TRACK, uuid: 'lonely', type: 'TRACK' },
    ],
    {},
    [trackL60],
  );
  eq(matchG60.map((m) => m.slot).join(','), '7',
    '60 match: slot 0 (blank template) is never matched');
  eq(matchG60[0].matched === null && matchG60[0].differs > 0 && matchG60[0].closest !== null,
    true, '60 match: no records → every row absent, nothing matched, closest still named');

  /* --- captureFromSlots ----------------------------------------------------- */
  const tuneStock60 = StockProfiles.TUNE;
  const tuneOver60 = overlay(new Map<number, Uint8Array>(), tuneStock60, 'TUNE');
  const muteUsage60 = nameToUsage('C_MUTE')!;
  const driftedTune60 = new Map(tuneOver60);
  driftedTune60.set(0x00, encodeModuleField(0x00, 'setting', 30));
  driftedTune60.set(0x05, encodeModuleField(0x05, 'setting', 36)); // 36°/detent = 10 detents
  driftedTune60.set(0x0e, encodeModuleField(0x0e, 'keypress', Uint8Array.from([
    0x01, 0x04,
    muteUsage60.usage & 0xff, (muteUsage60.usage >> 8) & 0xff,
    muteUsage60.page & 0xff, (muteUsage60.page >> 8) & 0xff,
  ])));

  const capProfiles60 = [
    tuneStock60,
    { ...tuneStock60, id: 'aaa-capture', name: 'Aaa (on board) 5' },
    { ...tuneStock60, id: 'nnn-capture', name: 'Naya Tune Mac/Win (on board)' },
    { ...tuneStock60, id: 'nnn2-capture', name: 'Naya Tune Mac/Win (on board) 2' },
  ];
  const capEntries60 = [
    { slot: 2, id: 2, typeFlag: MODULE_TYPE_CODE.TUNE, uuid: 'u-cap-tune', type: 'TUNE' },
    { slot: 6, id: 6, typeFlag: MODULE_TYPE_CODE.TUNE, uuid: 'u-cap2', type: 'TUNE' },
    { slot: 7, id: 7, typeFlag: MODULE_TYPE_CODE.TUNE, uuid: 'u-cap3', type: 'TUNE' },
  ];
  const cap60 = captureFromSlots(
    capEntries60,
    { 2: driftedTune60, 6: driftedTune60, 7: driftedTune60 },
    capProfiles60,
  );
  eq(cap60.length, 3, '60 capture: three drifting slots, three captures');
  eq(cap60.map((c) => c.slot).join(','), '2,6,7', '60 capture: slots carried');
  const cap1_60 = cap60[0].profile;
  eq(`${cap1_60.capturedFrom}/${cap1_60.type}`, 'u-cap-tune/TUNE',
    '60 capture: capturedFrom = the device uuid, type from the list byte');
  eq(/^[0-9a-f]{32}$/.test(cap1_60.id) && cap1_60.id !== 'u-cap-tune', true,
    '60 capture: NEW uuid (mintLayerUuid shape), never the device one');
  eq(cap60.map((c) => c.profile.name).join('|'),
    'Aaa (on board) 2|Aaa (on board) 3|Aaa (on board) 4',
    '60 capture: "<closest name> (on board)" numbered from the STRIPPED base — a capture of a capture counts on, never doubles the suffix');
  eq(cap1_60.variant, 'TUNE', '60 capture: variant carried from the closest');
  eq(`${cap1_60.settings.pointer_speed}/${cap1_60.settings.ticks_per_rotation}/${cap1_60.settings.pointer_accel}`,
    '30/10/50',
    '60 capture: device settings adopted (30 reads as 30; ticks wire 36 = 10 detents; agreed values carried)');
  eq(cap1_60.settings.scroll_convention, undefined,
    "60 capture: convention stays the closest profile's (never a device field)");
  eq(`${cap1_60.bindings['tap:tune:2_fingers'].actionType}/${cap1_60.bindings['tap:tune:2_fingers'].actionCode}`,
    'key/C_MUTE',
    '60 capture: divergent rows rebuilt FROM THE DEVICE (keypress decodes back to its action)');
  const agreeDial60 = cap1_60.bindings['rotate:tune:dial'];
  eq(`${agreeDial60.actionCode}/${agreeDial60.split === undefined}`, 'C_VOL_DOWN - C_VOL_UP/true',
    '60 capture: agreeing dial halves keep the seed row verbatim (combined kept, no split bolted on)');
  eq(diffProfile(cap1_60, driftedTune60, conventionOf(cap1_60.settings)).length, 0,
    '60 capture: the captured profile inherits NO drift rows');
  eq(compareRecords(overlay(new Map<number, Uint8Array>(), cap1_60, 'TUNE'), driftedTune60), true,
    '60 capture: byte truth — the capture re-encodes to exactly what the slot stores');

  // Dial drift: gesturesOfType must YIELD the paired row, or a divergent
  // dial keeps the seed binding verbatim and the capture inherits a diff
  // row. The halves (0x23 CCW / 0x22 CW) hold C_MUTE / C_NEXT — the seed's
  // combined C_VOL pair names neither.
  const nextUsage60 = nameToUsage('C_NEXT')!;
  const driftedDial60 = new Map(tuneOver60);
  driftedDial60.set(0x23, encodeModuleField(0x23, 'keypress', Uint8Array.from([
    0x01, 0x04,
    muteUsage60.usage & 0xff, (muteUsage60.usage >> 8) & 0xff,
    muteUsage60.page & 0xff, (muteUsage60.page >> 8) & 0xff,
  ])));
  driftedDial60.set(0x22, encodeModuleField(0x22, 'keypress', Uint8Array.from([
    0x01, 0x04,
    nextUsage60.usage & 0xff, (nextUsage60.usage >> 8) & 0xff,
    nextUsage60.page & 0xff, (nextUsage60.page >> 8) & 0xff,
  ])));
  const capDial60 = captureFromSlots(
    [{ slot: 3, id: 3, typeFlag: MODULE_TYPE_CODE.TUNE, uuid: 'u-cap-dial', type: 'TUNE' }],
    { 3: driftedDial60 },
    [tuneStock60],
  );
  eq(capDial60.length === 1 && capDial60[0].slot === 3, true,
    '60 capture: the dial-drifted slot differs from the seed and is captured');
  const dialB60 = capDial60[0].profile.bindings['rotate:tune:dial'];
  eq(dialB60.split?.['-']?.actionCode, 'C_MUTE',
    '60 capture: a divergent dial is REBUILT from its half fields (0x23 minus half → C_MUTE)');
  eq(dialB60.split?.['+']?.actionCode, 'C_NEXT',
    '60 capture: dial plus half 0x22 → C_NEXT');
  eq(`${dialB60.actionType}/${dialB60.actionCode}`, 'value/C_MUTE - C_NEXT',
    '60 capture: the rebuilt dial row reads the device halves combined (seed code replaced)');
  eq(diffProfile(capDial60[0].profile, driftedDial60, conventionOf(capDial60[0].profile.settings)).length, 0,
    '60 capture: dial drift does not survive the capture (0 diff rows)');
  eq(compareRecords(overlay(new Map<number, Uint8Array>(), capDial60[0].profile, 'TUNE'), driftedDial60), true,
    "60 capture: byte truth — the rebuilt dial re-encodes to exactly the slot's halves");

  const driftedTrack60 = new Map(leftOver60);
  driftedTrack60.set(0x0b, encodeModuleField(0x0b, 'mouseMask', MOUSE_MASK.M2));
  const capSkip60 = captureFromSlots(
    [
      { slot: 0, id: 0, typeFlag: MODULE_TYPE_CODE.TRACK, uuid: 'tpl', type: 'TRACK' },
      { slot: 4, id: 4, typeFlag: MODULE_TYPE_CODE.TRACK, uuid: 'u-foreign-uuid', type: 'TRACK' },
      { slot: 5, id: 5, typeFlag: MODULE_TYPE_CODE.TRACK, uuid: 'u-drift', type: 'TRACK' },
    ],
    { 4: rightOver60, 5: driftedTrack60 },
    [trackL60, trackR60],
  );
  eq(capSkip60.length === 1 && capSkip60[0].slot === 5, true,
    '60 capture: content-matched slots (and slot 0) capture NOTHING');
  eq(diffProfile(capSkip60[0].profile, driftedTrack60, 'mac').length, 0,
    '60 capture: a mask drift decodes back too (mouse M2)');
  eq(capSkip60[0].profile.name, 'Naya Track Left (on board)',
    '60 capture: the name follows the closest by rank (here the drifted-from stock)');

  const swappedTrack60 = new Map(leftOver60);
  // A real swap moves the VALUE between the fields — each record keeps its
  // own field byte ([field][type][len][body] is keyed by that byte).
  swappedTrack60.set(0x0a, Uint8Array.from([0x0a, ...leftOver60.get(0x09)!.slice(1)]));
  swappedTrack60.set(0x09, Uint8Array.from([0x09, ...leftOver60.get(0x0a)!.slice(1)]));
  const capSwap60 = captureFromSlots(
    [{ slot: 3, id: 3, typeFlag: MODULE_TYPE_CODE.TRACK, uuid: 'u-swap', type: 'TRACK' }],
    { 3: swappedTrack60 },
    [trackL60, trackR60],
  );
  eq(capSwap60.length, 1, '60 capture: an inverted axis is drift too');
  eq(capSwap60[0].profile.bindings['rotate:track']?.invert, 1,
    '60 capture: swapped selector halves rebuild as invert (a selector swap — no flag on the device)');
  eq(diffProfile(capSwap60[0].profile, swappedTrack60, 'mac').length, 0,
    '60 capture: the invert rebuild is byte-exact');

  /* --- repointBays ----------------------------------------------------------- */
  const bays60 = { 0: { 0x4a: 'dead-id', 0x4b: 'other-id' }, 1: { 0x4c: 'dead-id' } };
  const rp60 = repointBays(bays60, 'dead-id', 'live-id');
  eq(rp60.moved, 2, '60 repoint: both dead references move');
  eq(`${rp60.bays[0][0x4a]}/${rp60.bays[0][0x4b]}/${rp60.bays[1][0x4c]}`,
    'live-id/other-id/live-id',
    "60 repoint: ONE profile scope — fromId follows the board, other profiles' picks untouched");
  eq(bays60[0][0x4a], 'dead-id', '60 repoint: the input is never mutated');
  const rpSelf60 = repointBays(bays60, 'dead-id', 'dead-id');
  eq(rpSelf60.moved === 0 && rpSelf60.bays[0][0x4a] === 'dead-id', true,
    '60 repoint: fromId === toId moves nothing');
}

// End-to-end: readModuleList through a scripted device (the §56 harness
// shape) — request params must be MODULE_ADDR(0) = [0x00, 0x00], the part
// byte advancing, the two reply parts stitching byte-exact.
void (async () => {
  const listBytes60 = Uint8Array.from([
    0x00, 0x00,
    ...entry60(5, MODULE_TYPE_CODE.TRACK, UUID60),
    ...entry60(2, MODULE_TYPE_CODE.TUNE, '11223344556677889900aabbccddeeff'),
  ]);
  const reqs60: Frame[] = [];
  const scripted60 = (reply: (rq: Frame) => Uint8Array) => {
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    const reader = {
      async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
        for (;;) {
          const c = queue.shift();
          if (c) return { value: c, done: false };
          await new Promise<void>((res) => { waiter = res; });
        }
      },
      cancel() { const w = waiter; waiter = null; w?.(); },
      releaseLock() {},
    };
    const writer = {
      async write(b: Uint8Array) {
        const rq = verifyFrame(Uint8Array.from(b));
        const resp = buildFrame(0x50, rq.type, rq.c0, rq.c1, reply(rq));
        verifyFrame(resp);
        setTimeout(() => { queue.push(resp); const w = waiter; waiter = null; w?.(); }, 5);
      },
      releaseLock() {},
    };
    const port = {
      readable: { locked: false, getReader: () => reader },
      writable: { getWriter: () => writer },
      async open() {}, async setSignals() {}, async close() {},
    };
    return {
      session() {
        const r = port.readable.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
        const w = port.writable.getWriter() as unknown as WritableStreamDefaultWriter<Uint8Array>;
        return new NayaSession(
          port as unknown as SerialPort, 0x50,
          new FrameReader(r), w, r,
          async (b) => { await w.write(b); }, null,
        );
      },
    };
  };
  const dev60 = scripted60((rq) => {
    reqs60.push(rq);
    if (rq.c1 !== 0x09) return Uint8Array.from([0x11]);
    return rq.payload[0] === 0
      ? Uint8Array.from([0x01, 0x00, ...listBytes60.slice(0, 8)])
      : Uint8Array.from([0x00, 0x00, ...listBytes60.slice(8)]);
  });
  const ses60 = dev60.session();
  let blobR60: Uint8Array | null = null;
  let err60 = '';
  try { blobR60 = await ses60.readModuleList(); } catch (e) { err60 = (e as Error).message; }
  eq(err60, '', '60 readModuleList: no throw');
  eq(blobR60 !== null && toHex(blobR60) === toHex(listBytes60), true,
    '60 readModuleList: the two reply parts stitch byte-exact');
  eq(reqs60.length, 2, '60 readModuleList: exactly part 0 + part 1 requested');
  eq(toHex(Uint8Array.from([reqs60[0].type, reqs60[0].c0, reqs60[0].c1])), '30 10 09',
    '60 readModuleList rides 30/10/09');
  eq(toHex(reqs60[0].payload), '00 00',
    '60 readModuleList part 0 params = MODULE_ADDR(0) — [flag, index] from the addressing seam');
  eq(toHex(reqs60[1].payload), '01 00',
    '60 readModuleList: the part byte advances, the seam index byte stays 0');
  const liveList60 = parseModuleList(blobR60 ?? new Uint8Array(0));
  eq(liveList60.length === 2 && liveList60[0].slot === 5 && liveList60[0].type === 'TRACK'
    && liveList60[1].type === 'TUNE', true,
    '60 readModuleList: the live blob parses into list entries');
  await ses60.close();
})();

// §61 chunk budget ↔ stats frames parity (5a binding condition [c]): the
// executor's write and draft.stats() must count CDC frames with the SAME
// formula — chunkBudget = ceil((len+1)/242), one framing byte per frame —
// or the plan's frame total drifts from what the wire actually carries.
// 483 stays the two-frame ceiling (a 3rd frame hangs fw 3.28.7).
{
  const lens61 = [1, 242, 243, 483, 484];
  const want61 = [1, 2, 2, 2, 3]; // ceil((len+1)/242) at each length
  const payloads61 = lens61.map((len) => new Uint8Array(len));
  const drafts61 = payloads61.map((payload) => {
    const d = new Draft();
    d.ops.push({
      kind: 'moduleCfg', slot: 2, records: [],
      payload, label: '61 budget parity',
    });
    return d;
  });
  for (let i = 0; i < lens61.length; i++) {
    eq(drafts61[i].stats().frames, want61[i],
      `61 chunkBudget↔stats parity: ${lens61[i]}B moduleCfg payload → ${want61[i]} frame(s)`);
  }
  eq(
    drafts61.every(
      (_, i) =>
        drafts61[i].stats().frames === chunkBudget(payloads61[i]) &&
        drafts61[i].stats().frames === Math.ceil((lens61[i] + 1) / 242),
    ),
    true,
    '61 chunkBudget↔stats parity: stats === chunkBudget === ceil((len+1)/242) at every length',
  );
  const dl61 = new Draft();
  queueModuleListDelete(dl61, 5);
  eq(
    dl61.ops[0].kind === 'moduleList' && dl61.stats().frames === 1 &&
      dl61.stats().frames === chunkBudget(encodeListDelete(5)),
    true,
    '61 chunkBudget↔stats parity: a 5B moduleList delete counts 1 frame — same formula',
  );
}

// §62 module flash producer (final fix F1): planModuleOps turns a plan +
// the live slot records into the structural ops the flash pre-step injects
// into the draft — list deletes for reclaimed slots, list adds where the
// slot's device uuid is not the assigned profile id (uuid-keep slots are
// already labeled; capture-claimed slots still hold capturedFrom), and
// per-slot config writes ONLY where the profile overlaid onto its template
// differs from the live records (byte truth via compareRecords; zero diff
// → zero ops). Payload bytes ride the §57 encoders; op shapes are exactly
// what the useFlash drift validator accepts, and the landed queue helpers
// re-encode to the same bytes.
{
  const U62 = {
    a: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001', // TRACK profile, on board at slot 3
    b: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb0002', // TUNE profile, planned onto slot 4
    c: 'cccccccccccccccccccccccccccc0003', // old TUNE module on slot 2 (template source)
    d: 'dddddddddddddddddddddddddddd0004', // old module on slot 4 (reclaimed)
  };
  const bytes62 = (u: string) => (u.match(/../g) ?? []).join(' ');

  const profA62 = {
    id: U62.a, name: 'Fix A', type: 'TRACK' as const,
    settings: { pointer_speed: 10, scroll_speed: 10, pointer_accel: 50, pointer_accel_on: 1 },
    bindings: { 'tap:track:button_1': { actionType: 'mouse', actionCode: 'M1' } },
  };
  // Slot 3's live records = the projection of profA62 + one unmodeled
  // record overlay must carry through untouched.
  const liveA62 = overlay(new Map<number, Uint8Array>(), profA62, 'TRACK');
  liveA62.set(0x2a, Uint8Array.from([0x2a, 0x00, 0x00]));
  const live62 = { 3: { uuid: U62.a, records: liveA62 } };
  const plan62 = {
    assignments: [{
      profileId: U62.a, slot: 3,
      listEntry: { slot: 3, id: 3, flag: MODULE_TYPE_CODE.TRACK, uuid16: U62.a },
    }],
    reclaimed: [] as number[],
    templateSources: { [U62.a]: null } as Record<string, number | null>,
  };

  /* --- uuid-keep + zero diff → zero ops ------------------------------------ */
  const none62 = planModuleOps(plan62, [profA62], live62);
  eq(none62.length, 0, '62 zero-diff keep: a uuid-kept byte-identical slot generates ZERO ops');
  eq(none62.some((o) => o.kind === 'config'), false,
    '62 zero-diff keep: no cfg op where the overlay equals the live records');

  /* --- kept slot with an overlay diff → one cfg op, bytes pinned ----------- */
  const profA2_62 = { ...profA62, settings: { ...profA62.settings, pointer_speed: 20 } };
  const cfg62 = planModuleOps(plan62, [profA2_62], live62);
  eq(cfg62.length, 1, '62 cfg diff: exactly one op for an edited kept slot');
  eq(cfg62[0].kind === 'config' && cfg62[0].slot === 3, true,
    '62 cfg diff: the op is a config write at the kept slot');
  eq(cfg62[0].kind === 'config' && toHex(cfg62[0].payload),
    '03 00 01 01 14 01 01 01 0a 02 01 01 32 03 01 01 01 0b 0f 08 03 00 00 00 01 00 00 00 2a 00 00',
    '62 cfg diff: payload = slot byte + overlaid records (speed 20=0x14, M1 mask, unmodeled 2a carried)');
  eq(cfg62[0].kind === 'config' && cfg62[0].records.length, 6,
    '62 cfg diff: the desc carries 6 records (4 settings + M1 mask + unmodeled)');

  /* --- reclaim + new slot: delete → add → cfg, in send order --------------- */
  const profB62 = {
    id: U62.b, name: 'Fix B', type: 'TUNE' as const,
    settings: {
      pointer_speed: 10, scroll_speed: 10, pointer_accel: 50, pointer_accel_on: 1,
      ticks_per_rotation: 72, tick_strength: 75, toggle_ticks: 1,
    },
    bindings: {},
  };
  const tuneRecs62 = overlay(new Map<number, Uint8Array>(), profB62, 'TUNE');
  const junk62 = new Map<number, Uint8Array>([
    [0x00, Uint8Array.from([0x00, 0x07, 0x00])],
    [0x01, Uint8Array.from([0x01, 0x01, 0x63])],
  ]);
  const planB62 = {
    assignments: [{
      profileId: U62.b, slot: 4,
      listEntry: { slot: 4, id: 4, flag: MODULE_TYPE_CODE.TUNE, uuid16: U62.b },
    }],
    reclaimed: [4],
    templateSources: { [U62.b]: 2 } as Record<string, number | null>,
  };
  const gen62 = planModuleOps(planB62, [profB62], {
    2: { uuid: U62.c, records: tuneRecs62 },
    4: { uuid: U62.d, records: junk62 },
  });
  eq(gen62.length, 3, '62 reclaim: three ops (delete, add, cfg)');
  eq(`${gen62[0].kind}/${gen62[1].kind}/${gen62[2].kind}`, 'listDelete/listAdd/config',
    '62 reclaim: send order is delete → add → cfg');
  eq(gen62[0].kind === 'listDelete' && gen62[0].slot === 4 && toHex(gen62[0].payload) === '00 04 00 00 00',
    true, '62 reclaim: delete payload is the captured 00 [slot] 00 00 00 form');
  eq(gen62[1].kind === 'listAdd' && gen62[1].entry.slot === 4 && gen62[1].entry.id === 4 &&
      gen62[1].entry.flag === MODULE_TYPE_CODE.TUNE && gen62[1].entry.uuid16 === U62.b,
    true, '62 reclaim: add entry mirrors slot, TUNE flag, profile uuid');
  eq(gen62[1].kind === 'listAdd' &&
      toHex(gen62[1].payload) === `00 04 04 02 10 ${bytes62(U62.b)}`,
    true, '62 reclaim: add payload is the captured 00 [slot][id][flag] 10 <uuid16> form');
  eq(gen62[2].kind === 'config' && toHex(gen62[2].payload),
    '04 00 01 01 0a 01 01 01 0a 02 01 01 32 03 01 01 01 05 01 01 05 06 01 01 4b 07 01 01 01',
    '62 reclaim: cfg payload = slot 4 + template-overlaid TUNE records (72 detents → wire 5)');

  /* --- byte-equal reused slot: delete + add but NO cfg (zero diff) --------- */
  const same62 = planModuleOps(planB62, [profB62], {
    2: { uuid: U62.c, records: tuneRecs62 },
    4: { uuid: U62.d, records: new Map(tuneRecs62) },
  });
  eq(same62.length, 2, '62 zero-diff reuse: byte-equal slot → delete + add only');
  eq(same62.some((o) => o.kind === 'config'), false,
    '62 zero-diff reuse: no cfg op even though the slot changes identity');

  /* --- shapes the flash pre-step's drift validator accepts + the landed
       queue helpers re-encode to the same bytes ----------------------------- */
  eq(gen62.every((o) =>
    (o.kind === 'listAdd' && o.payload.length === 21 && o.payload[4] === 0x10) ||
    (o.kind === 'listDelete' && o.payload.length === 5 && o.payload[2] === 0 && o.payload[3] === 0 && o.payload[4] === 0) ||
    (o.kind === 'config' && o.payload[0] === o.slot),
  ), true, '62 shapes: add 21B with 0x10 marker, delete 5B zeros, cfg opens with the slot byte');
  eq(gen62[1].kind === 'listAdd' && toHex(gen62[1].payload.slice(5)) === toHex(uuidToBytes(gen62[1].entry.uuid16)),
    true, '62 shapes: add carries the entry uuid16 bytes verbatim (drift validator equality)');
  eq(planB62.reclaimed.includes(gen62[0].slot), true,
    '62 shapes: delete targets a slot the plan reclaims (drift validator allow-list)');
  const d62 = new Draft();
  for (const op of gen62) {
    if (op.kind === 'listAdd') queueModuleListAdd(d62, op.entry, op.label);
    else if (op.kind === 'listDelete') queueModuleListDelete(d62, op.slot, op.label);
    else queueModuleConfig(d62, op.slot, op.records, op.label);
  }
  eq(`${d62.ops[0].kind},${d62.ops[1].kind},${d62.ops[2].kind}`,
    'moduleList,moduleList,moduleCfg',
    '62 injection: the landed queue helpers file the ops as moduleList/moduleList/moduleCfg');
  eq(d62.ops.length === 3 &&
      toHex(d62.ops[0].payload) === toHex(gen62[0].payload) &&
      toHex(d62.ops[1].payload) === toHex(gen62[1].payload) &&
      toHex(d62.ops[2].payload) === toHex(gen62[2].payload),
    true, '62 injection: queue-helper payloads are byte-identical to the producer payloads');
}

// §63 BLE: verbs, 239B decode, verdicts, capability cache
// Synthesized 239B status fixture — layout per sdk/src/ble.ts: header 15B +
// 5×37B profiles @15 + split 39B @200, multi-byte ints BIG-ENDIAN. Profiles
// self-validate (blk[0] = their own index); flag bytes discriminate every
// documented bit. BLE GETs carry the [0x00] param — OUR answered aux
// convention (OpenFlow sends EMPTY payloads; discrepancy unresolved, the
// Phase-10 live probe settles it — see the ble.ts header note).
void (async () => {
  /* ---- fixtures ----------------------------------------------------------- */
  const macA63 = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
  const macB63 = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f];
  const prof63 = (
    i: number, flags: number, peer: number[] | null, extra: Record<number, number>,
  ): Uint8Array => {
    const b = new Uint8Array(37);
    b[0] = i;
    b[1] = flags;
    b[2] = 0x00; b[3] = 0x01; b[4] = 0x02; // constant prefix — NOT state
    if (peer) for (let k = 0; k < 6; k++) b[6 + k] = peer[k]!;
    for (const k of Object.keys(extra)) b[Number(k)] = extra[Number(k)]!;
    return b;
  };
  const mkStatus63 = (): Uint8Array => {
    const u = new Uint8Array(239);
    u[0] = 0x00; u[1] = 0x01; u[2] = 0x02; u[3] = 0x03; // revision u32BE → 66051
    u[4] = 3; // profileCount
    u[5] = 2; // activeProfile
    u[6] = 0x05; // flags: advertising | localAddrValid (hostConnected OFF)
    u[7] = 0xab; u[8] = 0xcd; // raw unknown
    [0x84, 0x2e, 0x14, 0x36, 0x58, 0x70].forEach((v, i) => { u[9 + i] = v; });
    u.set(prof63(0, 0x00, null, {}), 15);
    u.set(prof63(1, 0x7f, macA63, {}), 15 + 37);
    u.set(prof63(2, 0x2a, [1, 2, 3, 4, 5, 6], {}), 15 + 74);
    u.set(prof63(3, 0x00, null, { 36: 0x77 }), 15 + 111);
    u.set(prof63(4, 0x00, null, {}), 15 + 148);
    [0xaa, 0x55, 0xaa, 0x55, ...macB63, 0x00, 0x10, 0x00, 0x04, 0x01, 0x90]
      .forEach((v, i) => { u[200 + i] = v; });
    for (let i = 16; i < 39; i++) u[200 + i] = 0xee; // unknown tail
    return u;
  };
  const S239_63 = mkStatus63();

  /* ---- (a) 239B decode, byte-pinned --------------------------------------- */
  const st63 = decodeBleStatus(S239_63);
  const L63 = st63.layout;
  eq(L63 !== null, true, '63 decode: 239B → layout parsed');
  if (L63) {
    eq(L63.revision, 66051, '63 header: revision u32BE 00 01 02 03 → 66051');
    eq(L63.profileCount, 3, '63 header: profileCount [4]');
    eq(L63.activeProfile, 2, '63 header: activeProfile [5]');
    eq(L63.advertising, true, '63 header: flags.0x01 advertising');
    eq(L63.hostConnected, false, '63 header: flags.0x02 hostConnected off');
    eq(L63.localAddrValid, true, '63 header: flags.0x04 localAddrValid');
    eq(toHex(L63.unknownBytes), 'ab cd', '63 header: bytes [7:9] kept raw-unknown');
    eq(toHex(L63.localAddress), '84 2e 14 36 58 70', '63 header: localAddress MAC [9:15]');
    eq(L63.profiles.length, 5, '63 layout: 5×37B profiles');
    eq(L63.profiles.every((p, i) => p.index === i), true,
      '63 profiles: self-validating indices 0..4');
    const fl63 = (p: BleProfileStatus): string =>
      [p.configured, p.bonded, p.connected, p.active, p.hasPeerAddr, p.encrypted, p.authenticated]
        .map((b) => (b ? '1' : '0')).join('');
    eq(fl63(L63.profiles[0]!), '0000000', '63 prof0: flags 0x00 → all 7 bits false');
    eq(fl63(L63.profiles[1]!), '1111111', '63 prof1: flags 0x7f → all 7 bits true');
    eq(fl63(L63.profiles[2]!), '0101010', '63 prof2: flags 0x2a → bonded+active+encrypted only');
    eq(L63.profiles[0]!.peerAddress, null, '63 prof0: pristine slot → peerAddress null');
    eq(toHex(L63.profiles[1]!.peerAddress ?? new Uint8Array(0)), '11 22 33 44 55 66',
      '63 prof1: peerAddress = blk[6:12]');
    eq(L63.profiles[2]!.peerAddress, null, '63 prof2: 0x2a lacks 0x10 → peerAddress null despite bytes');
    eq(L63.profiles.every((p) => toHex(p.constantPrefix) === '00 01 02'), true,
      '63 profiles: blk[2:5] constant prefix 00 01 02 (not state)');
    eq(L63.profiles[0]!.securityLevel, 0, '63 profiles: securityLevel = blk[2]');
    eq(L63.profiles[0]!.hasPeerData, false, '63 prof0: zero tail → hasPeerData false');
    eq(L63.profiles[1]!.hasPeerData, true, '63 prof1: peer bytes make blk[5:] nonzero');
    eq(L63.profiles[2]!.hasPeerData, true, '63 prof2: stray peer bytes at blk[6:12] count as data');
    eq(L63.profiles[3]!.hasPeerData, true, '63 prof3: LAST tail byte blk[36]=0x77 → hasPeerData (any over blk[5:])');
    eq(L63.profiles[4]!.hasPeerData, false, '63 prof4: pristine empty slot → hasPeerData false');
    eq(toHex(L63.profiles[1]!.raw.slice(0, 12)), '01 7f 00 01 02 00 11 22 33 44 55 66',
      '63 prof1: raw 37B kept, byte-pinned head (index, flags, prefix, peer MAC)');
    eq(toHex(L63.split.peerAddress), 'aa bb cc dd ee 0f', '63 split: peerAddress [4:10]');
    eq(L63.split.connectionIntervalMs, 20, '63 split: u16BE 16 × 1.25 → 20ms');
    eq(L63.split.connectionLatency, 4, '63 split: latency u16BE');
    eq(L63.split.supervisionTimeoutMs, 4000, '63 split: u16BE 400 × 10 → 4000ms');
    eq(toHex(L63.split.unknownHead), 'aa 55 aa 55', '63 split: leading [0:4] kept raw-unknown');
    eq(L63.split.unknownTail.length, 23, '63 split: trailing [16:] kept (23B)');
    eq(st63.raw.length, 239, '63 decode: raw kept beside decode');
    eq(st63.rawHex, toHex(S239_63), '63 decode: rawHex kept beside decode');
  }

  /* ---- (b) wrong-length passthrough (never raises) ------------------------ */
  const bad63 = decodeBleStatus(new Uint8Array(100));
  eq(bad63.layout, null, '63 decode: wrong length 100B → layout null');
  eq(bad63.raw.length, 100, '63 decode: wrong length → raw passthrough');
  eq(bad63.rawHex.split(' ').length, 100, '63 decode: wrong length → rawHex passthrough');
  eq(decodeBleStatus(new Uint8Array(0)).layout, null, '63 decode: empty payload → layout null, never raises');

  /* ---- (c) be/1005 table parse guard --------------------------------------- */
  const empty63 = parseBlePairs(Uint8Array.from([0x00]));
  eq(empty63 !== null && empty63.count === 0 && empty63.macs.length === 0, true,
    '63 pairs: [0] is a valid EMPTY table — distinct from null');
  eq(parseBlePairs(Uint8Array.from([9, ...new Array(54).fill(0)])), null,
    '63 pairs: count>8 → null (guard)');
  eq(parseBlePairs(Uint8Array.from([2, ...macA63])), null,
    '63 pairs: truncated (len < 1+6·count) → null');
  const one63 = parseBlePairs(Uint8Array.from([1, ...macA63, 0xff]));
  eq(one63 !== null && one63.count === 1 &&
      toHex(one63.macs[0]!) === toHex(Uint8Array.from(macA63)), true,
    '63 pairs: [1][6B] parses to one exact MAC');

  /* ---- (d) pairingVerdict (pure) -------------------------------------------
   * CRITICAL SEMANTICS: a half's pairAddress is its PEER's address —
   * left.pairAddress === right.bleAddress means LEFT points at RIGHT. */
  const A63 = Uint8Array.from([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
  const B63 = Uint8Array.from([0xbb, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb]);
  const Z63 = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const h63 = (ble: Uint8Array | null, pair: Uint8Array | null,
    peers?: Uint8Array[] | null): { bleAddress: Uint8Array | null; pairAddress: Uint8Array | null; pairedPeers?: Uint8Array[] | null } =>
    ({ bleAddress: ble, pairAddress: pair, pairedPeers: peers });
  eq(pairingVerdict(h63(A63, B63), h63(B63, A63)), 'unknown',
    '63 verdict: mutual pairAddresses + UNREAD tables → unknown (healthy needs READ tables)');
  eq(pairingVerdict(h63(A63, B63, [B63]), h63(B63, A63, [A63])), 'healthy',
    '63 verdict: mutual + both read tables hold the partner → healthy');
  eq(pairingVerdict(h63(A63, B63), h63(B63, A63, [A63])), 'unknown',
    '63 verdict: mutual + right READ, left UNREAD → unknown (no read ≠ evidence of a bond)');
  eq(pairingVerdict(h63(A63, B63, [Z63]), h63(B63, A63)), 'bond-missing',
    '63 verdict: mutual + LEFT read table missing the partner → bond-missing');
  eq(pairingVerdict(h63(A63, B63), h63(B63, A63, [Z63])), 'bond-missing',
    '63 verdict: mutual + RIGHT read table missing the partner → bond-missing');
  eq(pairingVerdict(h63(A63, B63), h63(B63, Z63)), 'half-paired',
    '63 verdict: exactly one direction → half-paired');
  eq(pairingVerdict(h63(A63, B63), h63(B63, Z63, [B63])), 'half-paired',
    '63 verdict: address dimension first — one direction beats table content');
  eq(pairingVerdict(h63(A63, Z63), h63(B63, Z63)), 'half-paired',
    '63 verdict: zero directions (fresh 00:.. pairAddresses) → pairing incomplete, half-paired group');
  eq(pairingVerdict(h63(Z63, Z63), h63(Z63, Z63)), 'half-paired',
    '63 verdict: degenerate all-zero identity never grades healthy');
  eq(pairingVerdict(h63(A63, B63, null), h63(B63, A63)), 'unknown',
    '63 verdict: mutual + left UNANSWERED (null) table → unknown (asked ≠ answered)');
  eq(pairingVerdict(h63(null, B63), h63(B63, A63)), 'unknown',
    '63 verdict: missing bleAddress → unknown');
  eq(pairingVerdict(h63(A63, null), h63(B63, A63)), 'unknown',
    '63 verdict: missing pairAddress → unknown');

  /* ---- (e) splitLinkVerdict (pure, ordered — first match wins) ------------- */
  const rep63 = (over: Partial<SplitLinkReport>): SplitLinkReport => ({
    leftConnected: true, rightConnected: true,
    leftFw: 'v1.2.3.4', rightFw: 'v1.2.3.4', pairing: 'healthy', ...over,
  });
  eq(splitLinkVerdict(rep63({ leftConnected: false }), { reached: false }), 'connect-both',
    '63 split: either half missing → connect-both (first rule wins)');
  eq(splitLinkVerdict(
      rep63({ pairing: 'half-paired', leftFw: 'v1', rightFw: 'v2' }), { reached: true },
    ), 'firmware-mismatch',
    '63 split: fw mismatch beats pairing-repair (repair refuses on mismatch — fw first)');
  eq(splitLinkVerdict(rep63({ leftFw: 'v1', rightFw: 'v2' }), { reached: true }), 'firmware-mismatch',
    '63 split: differing fw strings → firmware-mismatch');
  eq(splitLinkVerdict(rep63({ pairing: 'half-paired' }), { reached: false }), 'pairing-repair',
    '63 split: half-paired → pairing-repair (before link-down)');
  eq(splitLinkVerdict(rep63({ pairing: 'bond-missing' }), { reached: true }), 'pairing-repair',
    '63 split: bond-missing → pairing-repair');
  eq(splitLinkVerdict(rep63(), { reached: false }), 'link-down',
    '63 split: healthy pairing but partner-via-left unreached → link-down');
  eq(splitLinkVerdict(rep63(), null), 'ok',
    '63 split: probe not run → rule skipped → ok');
  eq(splitLinkVerdict(rep63(), { reached: true }), 'ok',
    '63 split: everything good → ok');
  eq(probeReached(new Uint8Array(0)), false,
    '63 probe: EMPTY payload reply is NOT an answer (a linkless half still replies)');
  eq(probeReached(null), false, '63 probe: no reply frame → not reached');
  eq(probeReached(Uint8Array.from([0x00])), true, '63 probe: non-empty payload → reached');

  /* ---- (f) verb frames byte-exact over a scripted session ------------------ */
  const scripted63 = (reply: (rq: Frame) => Uint8Array) => {
    const reqs: Frame[] = [];
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    const reader = {
      async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
        for (;;) {
          const c = queue.shift();
          if (c) return { value: c, done: false };
          await new Promise<void>((res) => { waiter = res; });
        }
      },
      cancel() { const w = waiter; waiter = null; w?.(); },
      releaseLock() {},
    };
    const writer = {
      async write(b: Uint8Array) {
        const rq = verifyFrame(Uint8Array.from(b));
        reqs.push(rq);
        const resp = buildFrame(0x50, rq.type, rq.c0, rq.c1, reply(rq));
        verifyFrame(resp);
        setTimeout(() => { queue.push(resp); const w = waiter; waiter = null; w?.(); }, 5);
      },
      releaseLock() {},
    };
    const port = {
      readable: { locked: false, getReader: () => reader },
      writable: { getWriter: () => writer },
      async open() {}, async setSignals() {}, async close() {},
    };
    return {
      reqs,
      session() {
        const r = port.readable.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
        const w = port.writable.getWriter() as unknown as WritableStreamDefaultWriter<Uint8Array>;
        return new NayaSession(
          port as unknown as SerialPort, 0x50,
          new FrameReader(r), w, r,
          async (b) => { await w.write(b); }, null,
        );
      },
    };
  };
  const verbReply63 = (rq: Frame): Uint8Array => {
    if (rq.c1 === 0x02) return Uint8Array.from([0x84, 0x2e, 0x14, 0x36, 0x58, 0x71]);
    if (rq.c1 === 0x05) return Uint8Array.from([2, ...macA63, ...macB63]);
    if (rq.c1 === 0x08) return Uint8Array.from([0x84, 0x2e, 0x14, 0x36, 0x58, 0x70]);
    if (rq.c1 === 0x0c) return S239_63;
    return Uint8Array.from([0x00]); // 1009/100A write acks
  };
  const dev63 = scripted63(verbReply63);
  const ses63 = dev63.session();

  const pair63 = await bleGetPairAddress(ses63);
  eq(pair63 !== null && toHex(pair63) === '84 2e 14 36 58 71', true,
    '63 verb 1002: pairAddress MAC decoded');
  eq(toHex(dev63.reqs[0]!.raw), 'aa 00 50 00 be 03 10 02 00 12 04',
    '63 verb 1002: request byte-exact — be 10 02 + [0x00] GET param');
  const pairs63 = await bleGetAllPairs(ses63);
  eq(pairs63 !== null && pairs63.count === 2 &&
      toHex(pairs63.macs[0]!) === toHex(Uint8Array.from(macA63)) &&
      toHex(pairs63.macs[1]!) === toHex(Uint8Array.from(macB63)), true,
    '63 verb 1005: two-MAC table parsed from scripted reply');
  eq(toHex(dev63.reqs[1]!.raw), 'aa 00 50 00 be 03 10 05 00 15 04',
    '63 verb 1005: request byte-exact — be 10 05 + [0x00]');
  const self63 = await bleGetAddress(ses63);
  eq(self63 !== null && toHex(self63) === '84 2e 14 36 58 70', true,
    '63 verb 1008: own address decoded');
  eq(toHex(dev63.reqs[2]!.raw), 'aa 00 50 00 be 03 10 08 00 18 04',
    '63 verb 1008: request byte-exact — be 10 08 + [0x00]');

  // select 2 → write be/1009 [02], then read-back be/100C [00]; active is 2 → ok
  const sel63 = await bleSelectProfile(ses63, 2);
  eq(sel63.ok, true, '63 verb 1009: read-back activeProfile === slot → ok');
  eq(sel63.activeProfile, 2, '63 verb 1009: read-back reports activeProfile');
  eq(sel63.bonded, true, '63 verb 1009: read-back carries the slot hasPeerData');
  eq(toHex(dev63.reqs[3]!.raw), 'aa 00 50 00 be 03 10 09 02 1b 04',
    '63 verb 1009: request byte-exact — be 10 09 [slot]');
  eq(toHex(dev63.reqs[4]!.raw), 'aa 00 50 00 be 03 10 0c 00 1c 04',
    '63 verb 100C: read-back request byte-exact — be 10 0c + [0x00] (OUR convention)');
  // clear 2 → be/100A [02] + read-back; slot 2 holds stray data → bonded
  const clr63 = await bleClearProfile(ses63, 2);
  eq(clr63.ok, true, '63 verb 100A: write acked (no confirm logic in SDK — caller confirms)');
  eq(clr63.bonded, true, '63 verb 100A: read-back reports the slot hasPeerData as bonded');
  eq(toHex(dev63.reqs[5]!.raw), 'aa 00 50 00 be 03 10 0a 02 18 04',
    '63 verb 100A: request byte-exact — be 10 0a [slot]');
  // select 3 → read-back still 2 → ok=false (mismatch surfaced, not swallowed)
  eq((await bleSelectProfile(ses63, 3)).ok, false,
    '63 verb 1009: read-back mismatch → ok=false');

  // wire-guard pass-through: the BLE verbs are NOT on the never-send list
  let guardOk63 = true;
  for (const c1 of [0x02, 0x05, 0x08, 0x09, 0x0a, 0x0c]) {
    try { assertWireAllowed(0xbe, 0x10, c1); } catch { guardOk63 = false; }
  }
  eq(guardOk63, true, '63 wire-guard: 1002/1005/1008/1009/100A/100C pass unblocked');
  let blocked63 = '';
  try { assertWireAllowed(0xbe, 0x10, 0x04); } catch (e) { blocked63 = (e as Error).message; }
  eq(blocked63.includes('be/1004'), true, '63 wire-guard: be/1004 UNPAIR ALL stays blocked');

  // refusals: slot 0 reserved (dongle) + 5 out of range — BEFORE any wire traffic
  const preRefusal63 = dev63.reqs.length;
  let err0a = '';
  try { await bleSelectProfile(ses63, 0); } catch (e) { err0a = (e as Error).message; }
  let err0b = '';
  try { await bleClearProfile(ses63, 0); } catch (e) { err0b = (e as Error).message; }
  let err5 = '';
  try { await bleSelectProfile(ses63, 5); } catch (e) { err5 = (e as Error).message; }
  eq(err0a.includes('slot 0'), true, '63 refusal: select names reserved slot 0');
  eq(err0b.includes('slot 0'), true, '63 refusal: clear names reserved slot 0');
  eq(err5 !== '' && err5.includes('5'), true, '63 refusal: slot 5 out of range');
  eq(dev63.reqs.length, preRefusal63, '63 refusal: zero frames sent pre-wire');
  await ses63.close();

  // short pair-address reply → null contract (no throw)
  let respond63: (rq: Frame) => Uint8Array = verbReply63;
  const dev63b = scripted63((rq) => respond63(rq));
  const ses63b = dev63b.session();
  respond63 = () => Uint8Array.from([0x01, 0x02]);
  eq(await bleGetPairAddress(ses63b), null, '63 verb 1002: short reply → null (no throw)');
  await ses63b.close();

  /* ---- (g) capability cache: negative-only, fw-keyed + aux seam ------------ */
  const cache63 = new BleCapabilityCache();
  let calls63 = 0;
  const negFn63 = async (): Promise<Frame | null> => { calls63++; return null; };
  eq(await cache63.ask('left', 'v1', 0x06, negFn63), null, '63 cache: first ask goes to fn → null');
  eq(await cache63.ask('left', 'v1', 0x06, negFn63), null, '63 cache: negative remembered');
  eq(calls63, 1, '63 cache: second ask skipped fn (no wire)');
  const posFrame63 = (): Frame => ({
    src: 0, dst: 0x50, id: 0, type: 0xbe, c0: 0x10, c1: 0x06,
    payload: Uint8Array.from([0x00]), raw: new Uint8Array(0),
  });
  let callsPos63 = 0;
  const posFn63 = async (): Promise<Frame | null> => { callsPos63++; return posFrame63(); };
  eq(await cache63.ask('left', 'v9', 0x06, posFn63) !== null, true,
    '63 cache: positive answer passes through (fresh key — the v1 negative stays put)');
  eq(await cache63.ask('left', 'v9', 0x06, posFn63) !== null, true,
    '63 cache: positive re-asked (negative-only memory)');
  eq(callsPos63, 2, '63 cache: positive never cached — fn ran both times');
  eq(await cache63.ask('left', 'v2', 0x06, negFn63), null, '63 cache: new fw key asks again');
  eq(calls63, 2, '63 cache: new fw key → fresh probe (old negative not consulted)');

  // Seam wiring: readAux must route be/1006 + be/100f through the cache and
  // leave every other verb untouched. Negatives are pre-seeded WITHOUT wire,
  // then two sweeps run over a scripted session that counts frames per verb.
  // be/1006 seeds under '' (no fw seen yet); be/100f under 'v1.2.3.4' — the
  // fw the scripted fe/1002 will report (rememberFw fires mid-sweep, before
  // the be/100f ask).
  const auxReply63 = (rq: Frame): Uint8Array => {
    const k = `${rq.type.toString(16)}/${rq.c1.toString(16)}`;
    if (k === 'fa/1') return Uint8Array.from([0x00, 0x2a]);
    if (k === 'be/6') return Uint8Array.from([0x00, 0x4e, 0x61, 0x79, 0x61]); // 'Naya'
    if (k === 'fe/2') return Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04]); // v1.2.3.4
    if (k === 'fe/6') return Uint8Array.from([0x00, 0x0f, 0xa2]);
    if (k === 'be/f') return Uint8Array.from([0x00, 0x02, 0x07]);
    if (k === 'de/1') return Uint8Array.from([0x00, 0x00, 0x10, 0x00]); // module absent
    return Uint8Array.from([0x00]);
  };
  const cnt63 = (d: { reqs: Frame[] }, t: number, c1: number): number =>
    d.reqs.filter((r) => r.type === t && r.c1 === c1).length;
  const capDev63 = scripted63(auxReply63);
  const capSes63 = capDev63.session();
  const caps63 = new BleCapabilityCache();
  await caps63.ask('left', '', 0x06, async () => null); // seed: be/1006 unanswered
  await caps63.ask('left', 'v1.2.3.4', 0x0f, async () => null); // seed: be/100f unanswered
  const snap63 = await readAux(capSes63, 'left', undefined, caps63); // sweep 1
  const snap63b = await readAux(capSes63, 'left', undefined, caps63); // sweep 2
  eq(cnt63(capDev63, 0xbe, 0x06), 1,
    '63 seam: be/1006 skipped sweep 1 (cached negative), probed sweep 2 (fw key changed)');
  eq(cnt63(capDev63, 0xbe, 0x0f), 0,
    '63 seam: be/100f never hits the wire (negative remembered across sweeps)');
  eq(cnt63(capDev63, 0xfa, 0x01), 2, '63 seam: non-cacheable fa/1001 unchanged — every sweep');
  eq(cnt63(capDev63, 0xfe, 0x02), 2, '63 seam: non-cacheable fe/1002 unchanged — fw key source');
  eq(snap63.devRows.some((r) => r[1].includes('cached unanswered')), true,
    '63 seam: cached-negative rows surface in devRows');
  eq(snap63b.bleName, 'Naya', '63 seam: positive re-probe still parses (name from sweep 2)');
  await capSes63.close();
})();

// §64 device I/O log — roundtrip tap (TX before write, RX per frame, error
// record on the sync-lost throw), bounded 500 ring, subscribe/clear, hex
// truncation. The tap lives INSIDE roundtrip, so traffic is captured even
// when the client onFrame handler is suppressed (null) — forensics for
// aux-polling suppression is the whole point.
void (async () => {
  /* ---- (a) pure ring: subscribe/unsubscribe, bound 500, clear, hex -------- */
  const log64 = createIoLog();
  let fires64 = 0;
  const un64 = log64.subscribe(() => { fires64++; });
  log64.push({ dir: '>', type: 0xfa, c0: 0x10, c1: 0x01, len: 1, hex: '00' });
  eq(fires64, 1, '64 ring: subscribe fires on push');
  un64();
  log64.push({ dir: '<', type: 0xfa, c0: 0x10, c1: 0x01, len: 1, hex: '65' });
  eq(fires64, 1, '64 ring: unsubscribe stops the callbacks');

  const ring64 = createIoLog();
  for (let i = 0; i < 520; i++)
    ring64.push({ dir: '>', type: i & 0xff, c0: 0, c1: 0, len: 0, hex: '' });
  eq(ring64.snapshot().length, 500, '64 ring: 520 pushes → snapshot holds the bound 500');
  eq(ring64.snapshot()[0]!.seq, 20, '64 ring: oldest evicted (first kept is push #20)');
  eq(ring64.snapshot()[499]!.seq, 519, '64 ring: newest kept is push #519');
  eq(ring64.snapshot().every((e, i, a) => i === 0 || e.seq === a[i - 1]!.seq + 1), true,
    '64 ring: seq strictly monotonic across eviction');
  ring64.clear();
  eq(ring64.snapshot().length, 0, '64 ring: clear() empties the ring');

  eq(hexHead(Uint8Array.from([0xde, 0xad, 0xbe, 0xef])), 'DE AD BE EF',
    '64 hex: uppercase space-separated bytes');
  eq(hexHead(new Uint8Array(50).fill(0xab)).split(' ').length, 49,
    '64 hex: 50B payload → 48 hex bytes + one length-note token');
  eq(hexHead(new Uint8Array(50).fill(0xab)).startsWith('AB AB AB '), true,
    '64 hex: truncation keeps the FIRST bytes');
  eq(hexHead(new Uint8Array(50).fill(0xab)).endsWith('…+2'), true,
    '64 hex: length note names the dropped tail (…+2)');
  eq(hexHead(new Uint8Array(48).fill(9)).split(' ').length, 48,
    '64 hex: exactly 48B payload → no note');
  eq(hexHead(Uint8Array.from([1, 2, 3]), 2), '01 02 …+1',
    '64 hex: cap parameter honored');

  /* ---- (b) scripted exchange: TX+RX byte-pinned shape, seq order, ms ------ */
  const scripted64 = (reply: (rq: Frame) => Uint8Array | null) => {
    const reqs: Frame[] = [];
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    const reader = {
      async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
        for (;;) {
          const c = queue.shift();
          if (c) return { value: c, done: false };
          await new Promise<void>((res) => { waiter = res; });
        }
      },
      cancel() { const w = waiter; waiter = null; w?.(); },
      releaseLock() {},
    };
    const writer = {
      async write(b: Uint8Array) {
        const rq = verifyFrame(Uint8Array.from(b));
        reqs.push(rq);
        const resp = reply(rq);
        if (resp === null) return; // device stays silent → sync-lost path
        const frame = buildFrame(0x50, rq.type, rq.c0, rq.c1, resp);
        verifyFrame(frame);
        setTimeout(() => { queue.push(frame); const w = waiter; waiter = null; w?.(); }, 5);
      },
      releaseLock() {},
    };
    const port = {
      readable: { locked: false, getReader: () => reader },
      writable: { getWriter: () => writer },
      async open() {}, async setSignals() {}, async close() {},
    };
    return {
      reqs,
      session(fr?: FrameReader) {
        const r = port.readable.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
        const w = port.writable.getWriter() as unknown as WritableStreamDefaultWriter<Uint8Array>;
        return new NayaSession(
          port as unknown as SerialPort, 0x50,
          fr ?? new FrameReader(r), w, r,
          async (b) => { await w.write(b); }, null,
        );
      },
    };
  };
  const dev64 = scripted64(() => Uint8Array.from([0x00, 0x2a]));
  const ses64 = dev64.session();
  eq(ses64.ioLog !== undefined && typeof ses64.ioLog.snapshot === 'function', true,
    '64 tap: every session carries an ioLog from the constructor');
  eq(ses64.onFrame, null, '64 tap: client onFrame handler suppressed (null) in this harness');

  await ses64.cmd(0xfa, 0x10, 0x01, Uint8Array.from([0]));
  const snap64 = ses64.ioLog.snapshot();
  eq(snap64.length, 2, '64 tap: one cmd → exactly one TX + one RX record');
  const tx64 = snap64[0]!;
  const rx64 = snap64[1]!;
  eq(tx64.dir, '>', '64 TX: dir ">"');
  eq(tx64.type, 0xfa, '64 TX: type = request t byte');
  eq(tx64.c0, 0x10, '64 TX: c0');
  eq(tx64.c1, 0x01, '64 TX: c1');
  eq(tx64.len, 1, '64 TX: len = payload byte count');
  eq(tx64.hex, '00', '64 TX: hex = payload bytes, uppercase');
  eq(rx64.dir, '<', '64 RX: dir "<"');
  eq(rx64.type, 0xfa, '64 RX: type echoed');
  eq(rx64.c0, 0x10, '64 RX: c0 echoed');
  eq(rx64.c1, 0x01, '64 RX: c1 echoed');
  eq(rx64.len, 2, '64 RX: len = reply payload byte count');
  eq(rx64.hex, '00 2A', '64 RX: hex byte-pinned (uppercase, space-separated)');
  eq(rx64.seq, tx64.seq + 1, '64 tap: RX seq immediately follows its TX');
  eq(typeof tx64.t === 'number' && tx64.t <= Date.now(), true,
    '64 TX: t = wall clock ms (Date.now)');
  eq(tx64.ms !== undefined && tx64.ms >= 0, true,
    '64 ms: completed exchange carries elapsed ms on the TX record');
  eq(toHex(dev64.reqs[0]!.raw), 'aa 00 50 00 fa 03 10 01 00 11 04',
    '64 tap: strictly observational — wire frame byte-identical to the untapped vector');
  await ses64.close();

  /* ---- (c) sync-lost timeout → error record -------------------------------- */
  // A FrameReader whose readFrame fails fast (ms, not the 5s deadline): the
  // device never answers, roundtrip burns its tries and throws sync-lost.
  class SilentReader64 extends FrameReader {
    constructor() {
      super({ read: () => new Promise(() => {}) } as unknown as ReadableStreamDefaultReader<Uint8Array>);
    }
    async readFrame(): Promise<Frame> { throw new Error('read timeout'); }
  }
  const dev64b = scripted64(() => Uint8Array.from([0x00]));
  const ses64b = dev64b.session(new SilentReader64());
  let threw64 = '';
  try { await ses64b.cmd(0x30, 0x10, 0x63, Uint8Array.from([0])); }
  catch (e) { threw64 = (e as Error).message; }
  eq(threw64.startsWith('sync lost waiting cmd 30/1063'), true,
    '64 err: silent device → cmd throws sync-lost naming the verb');
  const err64 = ses64b.ioLog.snapshot().find((e) => e.err !== undefined);
  eq(err64?.dir, '<', '64 err: record dir "<" (wire-side outcome, nothing came back)');
  eq(err64?.err, 'sync lost waiting cmd 30/1063', '64 err: text byte-pinned');
  eq(err64?.type, 0x30, '64 err: expected verb t byte recorded');
  eq(err64?.c0, 0x10, '64 err: expected c0 recorded');
  eq(err64?.c1, 0x63, '64 err: expected c1 recorded');
  eq(err64?.len, 0, '64 err: no payload arrived — len 0');
  eq(err64?.hex, '', '64 err: no payload arrived — hex empty');
  await ses64b.close();
})();

// §65 keyscan test mode, part 1 (SDK layer): fe/1009 event parse +
// fe/1005 host-OS op + wire-guard verdicts. fe/1009 payload is
// [row, col, state, ...]: state 0 = PRESS (INVERTED vs intuition — the
// device reports the raw switch state, 0 = closed). fe/1005 host-OS rides
// a 1-byte payload with 0 = Windows, 1 = macOS — NOT the 200/201 values
// the module system uses for host OS. All three verbs are benign
// (test-mode toggle, event stream, plain setting write): the wire guard
// must let them through.
{
  const throws65 = (fn: () => unknown) => {
    try { fn(); return false; } catch { return true; }
  };
  const ev650 = parseKeyScanEvent(Uint8Array.from([3, 5, 0]));
  eq(JSON.stringify(ev650), JSON.stringify({ row: 3, col: 5, pressed: true }),
    '65 keyscan: [3,5,0] → {row:3,col:5,pressed:true} (state 0 = PRESS, inverted)');
  eq(parseKeyScanEvent(Uint8Array.from([3, 5, 1]))!.pressed, false,
    '65 keyscan: [3,5,1] → pressed:false (non-zero state = release)');
  eq(parseKeyScanEvent(Uint8Array.from([3, 5, 2]))!.pressed, false,
    '65 keyscan: [3,5,2] → pressed:false (any non-zero state = release)');
  eq(parseKeyScanEvent(Uint8Array.of()), null, '65 keyscan: 0 bytes → null (no row/col/state)');
  eq(parseKeyScanEvent(Uint8Array.from([3])), null, '65 keyscan: 1 byte → null');
  eq(parseKeyScanEvent(Uint8Array.from([3, 5])), null, '65 keyscan: 2 bytes → null (state byte required)');

  eq(toHex(hostOsOp('windows').payload), '00',
    '65 hostOsOp: windows → payload 00 (1 byte, NOT the module 200 value)');
  eq(toHex(hostOsOp('mac').payload), '01',
    '65 hostOsOp: mac → payload 01 (1 byte, NOT the module 201 value)');

  eq(throws65(() => assertWireAllowed(0xfe, 0x10, 0x08)), false,
    '65 guard allows fe/1008 (keyscan test-mode toggle — benign SET)');
  eq(throws65(() => assertWireAllowed(0xfe, 0x10, 0x09)), false,
    '65 guard allows fe/1009 (keyscan event stream — read-side, no destructive effect)');
  eq(throws65(() => assertWireAllowed(0xfe, 0x10, 0x05)), false,
    '65 guard allows fe/1005 (host-OS setting — plain SET write)');
}

// §65 part 2 — keyscanListen end-to-end on a scripted §56-style device:
// ON/OFF bytes at the writer, state inversion on pushed events, stray-frame
// immunity, guaranteed OFF on a mid-stream abort, and the tail mutex held
// for the WHOLE session (a concurrent cmd() must stay parked — its RX flush
// would eat queued events, which is exactly what the mutex prevents).
void (async () => {
  // §56 duplex fake: writer verifyFrame's each request and answers after 5 ms;
  // onReq lets the test push UNSOLICITED frames into the RX queue (keyscan
  // events arrive without a matching request). Unsolicited frames flow AFTER
  // the ack — a real device starts streaming once ON is acked, not before.
  const scripted65 = (
    reply: (rq: Frame) => Uint8Array,
    onReq?: (rq: Frame, push: (f: Uint8Array) => void) => void,
  ) => {
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    const push = (f: Uint8Array) => {
      queue.push(f);
      const w = waiter; waiter = null; w?.();
    };
    const reader = {
      async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
        for (;;) {
          const c = queue.shift();
          if (c) return { value: c, done: false };
          await new Promise<void>((res) => { waiter = res; });
        }
      },
      cancel() { const w = waiter; waiter = null; w?.(); },
      releaseLock() {},
    };
    const writer = {
      async write(b: Uint8Array) {
        const rq = verifyFrame(Uint8Array.from(b));
        const resp = buildFrame(0x50, rq.type, rq.c0, rq.c1, reply(rq));
        verifyFrame(resp);
        setTimeout(() => { push(resp); onReq?.(rq, push); }, 5);
      },
      releaseLock() {},
    };
    const port = {
      readable: { locked: false, getReader: () => reader },
      writable: { getWriter: () => writer },
      async open() {}, async setSignals() {}, async close() {},
    };
    return {
      session() {
        const r = port.readable.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
        const w = port.writable.getWriter() as unknown as WritableStreamDefaultWriter<Uint8Array>;
        return new NayaSession(
          port as unknown as SerialPort, 0x50,
          new FrameReader(r), w, r,
          async (b) => { await w.write(b); }, null,
        );
      },
    };
  };
  const isToggle65 = (rq: Frame) => rq.type === 0xfe && rq.c0 === 0x10 && rq.c1 === 0x08;
  const evFrame65 = (p: number[]) =>
    buildFrame(0x50, 0xfe, 0x10, 0x09, Uint8Array.from(p));

  // --- A: normal session — ON, events parsed with inversion, a stray
  // fe/1002 ignored mid-stream, OFF at the deadline, mutex held throughout.
  {
    const reqs65: Frame[] = [];
    const events65: KeyScanEvent[] = [];
    const dev = scripted65(
      () => Uint8Array.from([0x00]),
      (rq, push) => {
        reqs65.push(rq);
        if (isToggle65(rq) && rq.payload[0] === 0x01) {
          push(evFrame65([3, 5, 0]));
          push(buildFrame(0x50, 0xfe, 0x10, 0x02, Uint8Array.from([0x00]))); // stray
          push(evFrame65([3, 5, 1]));
          push(evFrame65([9, 9, 0, 0xff])); // extra 4th byte — log, never parse
        }
      },
    );
    const ses = dev.session();
    let err65 = '';
    const listenP = ses.keyscanListen((ev) => { events65.push(ev); }, { durationMs: 350 });
    // Concurrent probe: cmd() must stay parked while the listen holds the
    // tail mutex, and run once the session releases it.
    let probeDone = false;
    const probe = ses.cmd(0x30, 0x10, 0x01, new Uint8Array([0, 0]))
      .then(() => { probeDone = true; }, () => {});
    await sleep(200); // mid-session: events delivered, probe still parked
    eq(probeDone, false,
      '65 listen: tail mutex held during session (concurrent cmd() parked)');
    eq(events65.length, 3,
      '65 listen: events stream past the parked probe (a cmd() flush would kill them)');
    try { await listenP; } catch (e) { err65 = (e as Error).message; }
    await probe;
    eq(err65, '', '65 listen: session ends cleanly at the deadline (no throw)');
    eq(probeDone, true, '65 listen: mutex released after session (parked cmd() ran)');
    eq(events65.length, 3,
      '65 listen: stray fe/1002 mid-stream ignored (no event, no crash)');
    eq(JSON.stringify(events65), JSON.stringify([
      { row: 3, col: 5, pressed: true },
      { row: 3, col: 5, pressed: false },
      { row: 9, col: 9, pressed: true },
    ]), '65 listen: [3,5,0]→pressed:true, [3,5,1]→pressed:false (inverted); 4th byte logged, never parsed');
    const toggles = reqs65.filter(isToggle65);
    eq(toggles.length >= 2, true, '65 listen: writer saw ON and OFF fe/1008');
    eq(toHex(toggles[0]!.payload), '01', '65 listen: first fe/1008 write is ON [01]');
    eq(toHex(toggles[toggles.length - 1]!.payload), '00', '65 listen: last fe/1008 write is OFF [00]');
    const rx65 = ses.ioLog.snapshot().filter((r) => r.dir === '<');
    eq(rx65.some((r) => r.type === 0xfe && r.c1 === 0x09 && r.len === 3), true,
      '65 listen: event frames logged to ioLog RX (manual tap — stream bypasses roundtrip)');
    eq(rx65.some((r) => r.type === 0xfe && r.c1 === 0x02), true,
      '65 listen: stray fe/1002 frame logged to ioLog RX, ignored silently');
    eq(rx65.some((r) => r.type === 0xfe && r.c1 === 0x09 && r.len === 4), true,
      '65 listen: extra-byte event logged whole (len 4) — parsed first-3 only');
  }

  // --- B: mid-stream abort — onEvent throws on the 2nd event; the session
  // must stop dispatching, STILL send OFF, and RESOLVE (caller abort is a
  // normal end, not a rejection).
  {
    const reqs65b: Frame[] = [];
    const events65b: KeyScanEvent[] = [];
    const dev = scripted65(
      () => Uint8Array.from([0x00]),
      (rq, push) => {
        reqs65b.push(rq);
        if (isToggle65(rq) && rq.payload[0] === 0x01) {
          push(evFrame65([7, 1, 0]));
          push(evFrame65([7, 2, 0]));
          push(evFrame65([7, 3, 0]));
        }
      },
    );
    const ses = dev.session();
    let err65b = '';
    const t065b = Date.now();
    try {
      await ses.keyscanListen((ev) => {
        events65b.push(ev);
        if (events65b.length === 2) throw new Error('caller abort');
      }, { durationMs: 5000 });
    } catch (e) { err65b = (e as Error).message; }
    const elapsed65b = Date.now() - t065b;
    eq(err65b, '', '65 listen: caller abort (onEvent throws) RESOLVES, not rejects');
    eq(elapsed65b < 2000, true,
      '65 listen: abort ends the session early (well before the 5000ms deadline)');
    eq(events65b.length, 2,
      '65 listen: abort stops dispatch after the throwing call (3rd event never delivered)');
    const toggles = reqs65b.filter(isToggle65);
    eq(toggles.length >= 2 && toggles[0]!.payload[0] === 0x01, true,
      '65 listen: abort session saw ON [01] first');
    eq(toHex(toggles[toggles.length - 1]!.payload), '00',
      '65 listen: mid-stream abort STILL sends OFF [00]');
  }
})();

// §66 app-shortcuts dictionary, part 1 (loader lib): corpus integrity,
// bytes→body equivalence, platform swap, slot gate, ranker pins.
void (async () => {
  const db66 = await loadAppShortcuts();
  eq(db66.apps.length, 150, '66 corpus: 150 apps');
  eq(new Set(db66.apps.map((a) => a.cat)).size, 16, '66 corpus: 16 unique categories');
  eq(db66.byName.size, 150, '66 corpus: byName index covers all 150 apps');
  eq(db66.apps.reduce((t, a) => t + a.actions.length, 0), 19853,
    '66 corpus: 19853 actions total');

  const pw66 = db66.byName.get('1Password');
  eq(pw66?.cat, 'Productivity', "66 corpus: 1Password cat 'Productivity'");
  eq(pw66?.actions.length, 58, '66 corpus: 1Password has 58 actions');

  const sqa66 = pw66!.actions.find((e) => e.name === 'Show Quick Access')!;
  eq(bindOf(sqa66, 'windows')!.bytes, '2c000703', "66 binds: Show Quick Access win bytes '2c000703'");
  eq(bindOf(sqa66, 'mac')!.bytes, '2c00070a', "66 binds: Show Quick Access mac bytes '2c00070a'");

  const def66 = appShortcutActionDef(pw66!, sqa66, 'windows')!;
  eq(JSON.stringify(def66.body()), JSON.stringify([0x01, 0x04, 0x2c, 0x00, 0x07, 0x03]),
    '66 body: windows [01 04 2c 00 07 03] — OF param [usageLo,usageHi,page,mods] byte-identity');
  const defMac66 = appShortcutActionDef(pw66!, sqa66, 'mac')!;
  eq(JSON.stringify(defMac66.body()), JSON.stringify([0x01, 0x04, 0x2c, 0x00, 0x07, 0x0a]),
    '66 body: mac [01 04 2c 00 07 0a]');
  eq(JSON.stringify(defMac66.body().slice(0, 5)), JSON.stringify(def66.body().slice(0, 5)),
    '66 body: mac ≡ windows through the page byte');
  eq(defMac66.body()[5] !== def66.body()[5], true,
    '66 body: windows/mac bodies differ only at the mods byte');

  eq(def66.label, 'Show Quick Access (LCTRL + LSHIFT + SPACE)',
    '66 def: label = entry name + chord');
  eq(def66.id, 'app:windows:1Password::Show Quick Access',
    '66 def: id app:windows:1Password::Show Quick Access');
  eq(def66.category, 'Applications', "66 def: category 'Applications'");

  eq(describeRecord(buildRecord(0, def66.body())).includes('Space'), true,
    '66 readback: describeRecord(buildRecord(0, body)) contains Space (page 0x0007 + mods suffix)');
  eq(hidPairOf(buildRecord(0, def66.body())), null,
    '66 slot gate: hidPairOf(app record) null — mods ≠ 0 never feeds behavior slots');

  let nullApp66: AppEntry | undefined;
  let nullEntry66: ShortcutEntry | undefined;
  for (const a of db66.apps) {
    const e = a.actions.find((x) => x.win === null);
    if (e) { nullApp66 = a; nullEntry66 = e; break; }
  }
  eq(bindOf(nullEntry66!, 'windows'), null, '66 null path: mac-only entry → windows bind null');
  eq(appShortcutActionDef(nullApp66!, nullEntry66!, 'windows'), null,
    '66 null path: mac-only entry → windows ActionDef null');

  const hitsQA = rankAppHits(db66, 'quick access', 'windows');
  eq(hitsQA[0]?.entry.name, 'Show Quick Access', "66 rank: 'quick access' top hit = Show Quick Access");
  eq(hitsQA.every((h) => bindOf(h.entry, 'windows') !== null), true,
    '66 rank: every hit carries a windows bind');

  eq(rankAppHits(db66, 'zzz-no-such-shortcut', 'windows').length, 0,
    "66 rank: 'zzz-no-such-shortcut' → no hits");

  eq(rankAppHits(db66, 'ripple delete', 'windows')[0]?.entry.name, 'Ripple Delete',
    "66 rank pin: 'ripple delete' top hit = Ripple Delete (Adobe Premiere Pro)");

  eq(detectPlatform(), 'windows', '66 platform: node (no navigator) → windows guard');
})();

// §67 smp codecs + line link (SDK layer): CRC16-XMODEM vectors, the CBOR
// subset mcumgr speaks (uint/negint head forms, bytes/text/bool/null,
// sorted-key maps, indefinite-length arrays), the base64 line framing
// (\x06\x09 start / \x04\x14 continue, CRC+len verified, bad frames dropped
// without ever throwing), and SmpLink end-to-end on a scripted line-port
// (matching reply resolves, stale-seq frame skipped, timeout throws,
// idempotent close). No Naya wake/handshake — a bootloader answers the
// first frame it sees; the link owns a plain TextDecoder accumulation loop.
void (async () => {
  // --- constants + CRC16-XMODEM vectors -----------------------------------
  eq(
    JSON.stringify([SMP.OP_READ, SMP.OP_READ_RSP, SMP.OP_WRITE, SMP.GROUP_OS,
      SMP.GROUP_IMAGE, SMP.ID_ECHO, SMP.ID_IMAGE_STATE, SMP.ID_IMAGE_UPLOAD,
      SMP.ID_OS_RESET, SMP.ID_SLOT_INFO]),
    '[0,1,2,0,1,0,0,1,5,6]', '67 SMP: op/group/id constants');
  eq(crc16Xmodem(new Uint8Array(0)), 0, '67 crc: empty → 0 (init 0)');
  eq(crc16Xmodem(new TextEncoder().encode('123456789')), 0x31c3,
    '67 crc: "123456789" → 0x31C3 (XMODEM check vector)');
  eq(crc16Xmodem(new TextEncoder().encode('A')), 0x58e5, '67 crc: "A" → 0x58E5');

  // --- CBOR encode: integer head forms (major 0/1 boundaries) -------------
  eq(toHex(cborEncode(0)), '00', '67 cbor: 0 → 00');
  eq(toHex(cborEncode(23)), '17', '67 cbor: 23 → 17 (immediate top)');
  eq(toHex(cborEncode(24)), '18 18', '67 cbor: 24 → 18 18 (1-byte form starts)');
  eq(toHex(cborEncode(255)), '18 ff', '67 cbor: 255 → 18 ff');
  eq(toHex(cborEncode(256)), '19 01 00', '67 cbor: 256 → 19 0100 (2-byte form)');
  eq(toHex(cborEncode(65535)), '19 ff ff', '67 cbor: 65535 → 19 ffff');
  eq(toHex(cborEncode(65536)), '1a 00 01 00 00', '67 cbor: 65536 → 1a 00010000 (4-byte form)');
  eq(toHex(cborEncode(4294967295)), '1a ff ff ff ff', '67 cbor: u32 max → 1a ffffffff');
  eq(toHex(cborEncode(4294967296)), '1b 00 00 00 01 00 00 00 00',
    '67 cbor: u32 max+1 → 1b (8-byte form)');
  eq(toHex(cborEncode(-1)), '20', '67 cbor: -1 → 20 (negint arg 0)');
  eq(toHex(cborEncode(-24)), '37', '67 cbor: -24 → 37 (immediate top)');
  eq(toHex(cborEncode(-25)), '38 18', '67 cbor: -25 → 38 18');
  eq(toHex(cborEncode(-256)), '38 ff', '67 cbor: -256 → 38 ff');
  eq(toHex(cborEncode(-257)), '39 01 00', '67 cbor: -257 → 39 0100');
  eq(toHex(cborEncode(-65536)), '39 ff ff', '67 cbor: -65536 → 39 ffff');
  eq(toHex(cborEncode('hi')), '62 68 69', "67 cbor: 'hi' → 62 6869");
  eq(toHex(cborEncode(true)), 'f5', '67 cbor: true → f5');
  eq(toHex(cborEncode(null)), 'f6', '67 cbor: null → f6');
  eq(toHex(cborEncode(Uint8Array.from([0xaa, 0xbb]))), '42 aa bb', '67 cbor: bytes → 42 aabb');
  // map keys sorted by UTF-8 bytes: data < image < off (insertion order isn't)
  eq(
    toHex(cborEncode({ image: 0, off: 512, data: Uint8Array.from([0xaa, 0xbb]) })),
    'a3 64 64 61 74 61 42 aa bb 65 69 6d 61 67 65 00 63 6f 66 66 19 02 00',
    '67 cbor: {image,off,data} → map(3), keys sorted data<image<off, exact bytes');

  // --- CBOR decode: round-trips + next cursor ------------------------------
  eq(cborDecode(cborEncode(0)).value, 0, '67 cbor: decode 0');
  eq(cborDecode(cborEncode(255)).value, 255, '67 cbor: decode 255');
  eq(cborDecode(cborEncode(65536)).value, 65536, '67 cbor: decode 65536');
  eq(cborDecode(cborEncode(4294967296)).value, 4294967296,
    '67 cbor: decode 8-byte uint → number when safe');
  eq(cborDecode(cborEncode(-1)).value, -1, '67 cbor: decode -1');
  eq(cborDecode(cborEncode(-65536)).value, -65536, '67 cbor: decode -65536');
  eq(cborDecode(cborEncode('hello world')).value, 'hello world', "67 cbor: decode 'hello world'");
  eq(cborDecode(cborEncode(true)).value, true, '67 cbor: decode true');
  eq(cborDecode(cborEncode(null)).value, null, '67 cbor: decode null');
  eq(toHex(cborDecode(cborEncode(Uint8Array.from([1, 2, 3]))).value as Uint8Array),
    '01 02 03', '67 cbor: decode bytes round-trip');
  const nested67 = cborEncode([1, [2, 3]]);
  eq(cborDecode(nested67).next, nested67.length,
    '67 cbor: next = full length on a nested array');
  eq(cborDecode(Uint8Array.from([...nested67, 0xff])).next, nested67.length,
    '67 cbor: next stops after the value (trailing byte unconsumed)');
  const mapDec67 = cborDecode(
    cborEncode({ image: 0, off: 512, data: Uint8Array.from([0xaa, 0xbb]) }),
  ).value as { image: number; off: number; data: Uint8Array };
  eq(mapDec67.image, 0, '67 cbor: decoded map .image');
  eq(mapDec67.off, 512, '67 cbor: decoded map .off');
  eq(toHex(mapDec67.data), 'aa bb', '67 cbor: decoded map .data');
  eq(
    JSON.stringify(cborDecode(Uint8Array.from([0x9f, 0x01, 0x02, 0x03, 0xff])).value),
    '[1,2,3]', '67 cbor: indefinite-length array 9F…FF decodes');

  // --- encodeSmpLine → parseSmpChunks round-trip ---------------------------
  const line67 = encodeSmpLine(SMP.OP_READ, SMP.GROUP_OS, 7, SMP.ID_ECHO);
  eq(line67.startsWith('\x06\x09'), true, '67 line: starts \\x06\\x09');
  eq(line67.endsWith('\n'), true, '67 line: ends \\n');
  const pLine67 = parseSmpChunks(line67);
  eq(pLine67.frames.length, 1, '67 line: single line → 1 frame');
  const fLine67 = pLine67.frames[0]!;
  eq(fLine67.op, SMP.OP_READ, '67 line: frame op READ');
  eq(fLine67.group, SMP.GROUP_OS, '67 line: frame group OS');
  eq(fLine67.seq, 7, '67 line: frame seq');
  eq(fLine67.cmdId, SMP.ID_ECHO, '67 line: frame cmdId');
  eq(fLine67.flags, 0, '67 line: frame flags 0');
  eq(toHex(fLine67.payload), 'a0', '67 line: default payload → single 0xA0 (empty CBOR map)');
  eq(pLine67.rest, '', '67 line: complete frame consumed (rest empty)');

  // multi-KB payload split across \x04\x14 continuation lines
  const big67 = new Uint8Array(4096);
  for (let i = 0; i < big67.length; i++) big67[i] = i & 0xff;
  const bigLine67 = encodeSmpLine(SMP.OP_READ_RSP, SMP.GROUP_IMAGE, 9, SMP.ID_IMAGE_UPLOAD, big67);
  const bigB6467 = bigLine67.slice(2, -1);
  let wired67 = '';
  for (let i = 0; i < bigB6467.length; i += 72) {
    wired67 += (i === 0 ? '\x06\x09' : '\x04\x14') + bigB6467.slice(i, i + 72) + '\n';
  }
  eq(wired67.split('\n').length - 1, Math.ceil(bigB6467.length / 72),
    '67 line: multi-KB response arrives as multiple lines');
  const pBig67 = parseSmpChunks(wired67);
  eq(pBig67.frames.length, 1, '67 line: continuation lines reassemble into 1 frame');
  const fBig67 = pBig67.frames[0]!;
  eq(fBig67.payload.length, 4096, '67 line: reassembled payload is whole (4096B)');
  eq(toHex(fBig67.payload.slice(0, 4)), '00 01 02 03', '67 line: reassembled payload head intact');
  eq(toHex(fBig67.payload.slice(-4)), 'fc fd fe ff', '67 line: reassembled payload tail intact');
  eq(fBig67.seq, 9, '67 line: reassembled frame seq');
  eq(fBig67.group, SMP.GROUP_IMAGE, '67 line: reassembled frame group');
  eq(pBig67.rest, '', '67 line: multi-line frame fully consumed');

  // bad CRC → dropped, never throws
  const goodB6467 = line67.slice(2, -1);
  let flip67 = goodB6467.length - 1;
  while (goodB6467[flip67] === '=') flip67--;
  const badLine67 = '\x06\x09' + goodB6467.slice(0, flip67)
    + (goodB6467[flip67] === 'A' ? 'B' : 'A') + goodB6467.slice(flip67 + 1) + '\n';
  let badThrew67 = false;
  let badFrames67 = -1;
  let badRest67 = 'unset';
  try {
    const r = parseSmpChunks(badLine67);
    badFrames67 = r.frames.length;
    badRest67 = r.rest;
  } catch { badThrew67 = true; }
  eq(badThrew67, false, '67 line: bad CRC never throws');
  eq(badFrames67, 0, '67 line: bad-CRC frame dropped');
  eq(badRest67, '', '67 line: dropped frame consumes its lines');

  // partial (unterminated) line stays in rest; frame completes when fed on
  const pPartial67 = parseSmpChunks('\x06\x09' + goodB6467.slice(0, 10));
  eq(pPartial67.frames.length, 0, '67 line: unterminated partial line → no frame');
  eq(pPartial67.rest, '\x06\x09' + goodB6467.slice(0, 10),
    '67 line: partial line preserved in rest verbatim');
  const pStart67 = parseSmpChunks('\x06\x09' + goodB6467.slice(0, 8) + '\n');
  eq(pStart67.frames.length, 0, '67 line: decodable-but-short frame not yielded early');
  eq(pStart67.rest, '\x06\x09' + goodB6467.slice(0, 8) + '\n',
    '67 line: pending frame lines preserved in rest');
  const pDone67 = parseSmpChunks(pStart67.rest + '\x04\x14' + goodB6467.slice(8) + '\n');
  eq(pDone67.frames.length, 1, '67 line: continuation completes the pending frame');
  eq(toHex(pDone67.frames[0]!.payload), 'a0', '67 line: completed frame payload intact');

  // --- SmpLink end-to-end on a scripted line-port --------------------------
  // Fake line-port §56/§65-style, line-shaped: the writer collects written
  // lines; a scripted responder parses each request line and answers after
  // ~5 ms via a controller-readable push. Block-scoped to §67.
  const scriptedSmp67 = (
    respond: (rq: SmpFrame, push: (t: string) => void) => void,
  ) => {
    const linesWritten: string[] = [];
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const readable = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });
    const push = (t: string) => {
      controller!.enqueue(new TextEncoder().encode(t));
    };
    let pending = '';
    const writable = new WritableStream<Uint8Array>({
      write(b) {
        pending += new TextDecoder().decode(b);
        for (;;) {
          const i = pending.indexOf('\n');
          if (i < 0) break;
          const line = pending.slice(0, i + 1);
          pending = pending.slice(i + 1);
          linesWritten.push(line);
          const rq = parseSmpChunks(line).frames[0];
          if (rq) respond(rq, push);
        }
      },
    });
    let closed = 0;
    const port = {
      readable,
      writable,
      open() { /* port already open (readable present) */ },
      setSignals: () => { /* DTR/RTS sink */ },
      close() { closed++; },
    };
    return {
      linesWritten,
      closedCount: () => closed,
      open: () => SmpLink.open(port as unknown as SmpSerialPortLike, { settleMs: 2 }),
    };
  };

  // --- A: matching reply resolves; wire shape round-trips
  {
    const reqsA: SmpFrame[] = [];
    const devA = scriptedSmp67((rq, push) => {
      reqsA.push(rq);
      setTimeout(() => {
        push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId,
          Uint8Array.from([0xde, 0xad])));
      }, 5);
    });
    const linkA = await devA.open();
    const rspA = await linkA.transceive(SMP.OP_READ, SMP.GROUP_OS, SMP.ID_ECHO,
      Uint8Array.from([1, 2, 3]));
    eq(reqsA.length, 1, '67 link: responder saw exactly one request line');
    eq(reqsA[0]!.op, SMP.OP_READ, '67 link: request op READ');
    eq(reqsA[0]!.group, SMP.GROUP_OS, '67 link: request group OS');
    eq(reqsA[0]!.cmdId, SMP.ID_ECHO, '67 link: request cmdId ECHO');
    eq(reqsA[0]!.seq, 1, '67 link: first transceive seq 1 (internal counter ++ & 0xFF)');
    eq(reqsA[0]!.flags, 0, '67 link: request flags 0');
    eq(toHex(reqsA[0]!.payload), '01 02 03', '67 link: request payload survives the wire');
    eq(devA.linesWritten[0]!.startsWith('\x06\x09'), true, '67 link: TX line starts \\x06\\x09');
    eq(devA.linesWritten[0]!.endsWith('\n'), true, '67 link: TX line ends \\n');
    eq(rspA.op, SMP.OP_READ_RSP, '67 link: reply op READ_RSP');
    eq(rspA.seq, 1, '67 link: reply seq echoes the request');
    eq(rspA.group, SMP.GROUP_OS, '67 link: reply group OS');
    eq(rspA.cmdId, SMP.ID_ECHO, '67 link: reply cmdId ECHO');
    eq(toHex(rspA.payload), 'de ad', '67 link: matching reply payload resolves');
    const rspA2 = await linkA.transceive(SMP.OP_WRITE, SMP.GROUP_OS, SMP.ID_OS_RESET);
    eq(reqsA.length, 2, '67 link: second transceive seen');
    eq(toHex(reqsA[1]!.payload), 'a0', '67 link: transceive without payload sends 0xA0');
    eq(reqsA[1]!.seq, 2, '67 link: seq counter advances');
    eq(rspA2.cmdId, SMP.ID_OS_RESET, '67 link: reply matched on (group, cmdId, seq)');
    await linkA.close();
  }

  // --- B: stale/mismatched-seq frame discarded silently, correct reply still
  // resolves (late replies must never satisfy a live exchange)
  {
    const devB = scriptedSmp67((rq, push) => {
      push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, 0xf7, rq.cmdId,
        Uint8Array.from([0x33]))); // stale seq — discarded
      setTimeout(() => {
        push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId,
          Uint8Array.from([0x07])));
      }, 5);
    });
    const linkB = await devB.open();
    const rspB = await linkB.transceive(SMP.OP_READ, SMP.GROUP_IMAGE,
      SMP.ID_IMAGE_STATE, undefined, { timeoutMs: 2000 });
    eq(toHex(rspB.payload), '07', '67 link: stale-seq frame skipped, correct reply still resolves');
    eq(rspB.group, SMP.GROUP_IMAGE, '67 link: image-state reply group');
    await linkB.close();
  }

  // --- C: timeout throws
  {
    const devC = scriptedSmp67(() => { /* silent device */ });
    const linkC = await devC.open();
    const t067 = Date.now();
    let errC67 = '';
    try {
      await linkC.transceive(SMP.OP_WRITE, SMP.GROUP_OS, SMP.ID_OS_RESET,
        undefined, { timeoutMs: 50 });
    } catch (e) { errC67 = (e as Error).message; }
    eq(errC67 !== '', true, '67 link: timeout throws (50ms, silent responder)');
    eq(Date.now() - t067 < 3000, true, '67 link: custom timeoutMs honored (not the 5s default)');
    await linkC.close();
  }

  // --- D: close() idempotent — every step swallowed
  {
    const devD = scriptedSmp67(() => { /* silent */ });
    const linkD = await devD.open();
    let closeErr67 = '';
    try {
      await linkD.close();
      await linkD.close();
    } catch (e) { closeErr67 = (e as Error).message; }
    eq(closeErr67, '', '67 link: close() idempotent — double close never throws');
    eq(devD.closedCount(), 1, '67 link: port closed exactly once (second close is a no-op)');
  }
})();

// §68 smp device ops (SDK layer): echo / imageState / slot-info / setPending /
// osReset on stateful scripted devices, the upload loop (chunk 512, first
// chunk carries len+sha, later chunk neither, device-off authoritative,
// rc-abort, erase-vs-chunk timeout classes, shouldContinue), the
// resolveUploadImageId numbering matrix, and the enterMcuboot() wire pin —
// exactly ONE ee/10ae frame, a bounded ~1500 ms wait resolving on any reply
// or none (never the roundtrip retry ladder). §68-wide tripwire: no fixture
// write log carries c0=0x10 c1=0xBE — RESET_DFU (ee/10be) is a different,
// never-sent op.
void (async () => {
  const smpLines68: string[] = []; // every TX line across the §68 SMP fixtures
  const nayaWrites68: Uint8Array[] = []; // every §68 Naya write (enterMcuboot)
  const b64Bytes68 = (line: string): Uint8Array =>
    new Uint8Array(Buffer.from(line.slice(2).replace(/\n$/, ''), 'base64'));

  // Stateful scripted SMP device — §67's line-port shape plus a stateful
  // closure (upload offset / post-upload flag) and an injectable reply delay
  // (the erase-classification test). TX lines feed the §68-wide tripwire.
  const mkSmp68 = (
    respond: (rq: SmpFrame, push: (t: string, delayMs?: number) => void) => void,
  ) => {
    const linesWritten: string[] = [];
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const readable = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const push = (t: string, delayMs = 5) => {
      setTimeout(() => { controller!.enqueue(new TextEncoder().encode(t)); }, delayMs);
    };
    let pending = '';
    const writable = new WritableStream<Uint8Array>({
      write(b) {
        pending += new TextDecoder().decode(b);
        for (;;) {
          const i = pending.indexOf('\n');
          if (i < 0) break;
          const line = pending.slice(0, i + 1);
          pending = pending.slice(i + 1);
          linesWritten.push(line);
          smpLines68.push(line);
          const rq = parseSmpChunks(line).frames[0];
          if (rq) respond(rq, push);
        }
      },
    });
    const port = { readable, writable, open() {}, setSignals() {}, close() {} };
    return {
      linesWritten,
      open: () => SmpLink.open(port as unknown as SmpSerialPortLike, { settleMs: 2 }),
    };
  };

  // Fixture hashes/bytes: patterns chosen so no adjacent 0x10 0xBE byte pair
  // ever lands in a TX log — keeps the §68-wide DFU tripwire meaningful.
  const pre0A68 = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i);
  const old1A68 = Uint8Array.from({ length: 32 }, (_, i) => 0x90 + i);
  // stateful image-state bodies: pre = old slot 1, post = uploaded sha in slot 1
  const images68 = (
    post: boolean,
    pre0: Uint8Array,
    uploaded: Uint8Array,
    extraFlags?: string[],
  ): { images: { slot: number; hash: Uint8Array; flags: string[] }[] } => ({
    images: [
      { slot: 0, hash: pre0, flags: extraFlags ?? ['active', 'confirmed'] },
      { slot: 1, hash: post ? uploaded : old1A68, flags: [] },
    ],
  });
  const rspLine68 = (
    rq: SmpFrame,
    payload: Uint8Array,
    push: (t: string, delayMs?: number) => void,
    delayMs = 5,
  ): void => {
    push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, payload), delayMs);
  };

  // --- (a) echo round-trip --------------------------------------------------
  {
    const reqs68a: SmpFrame[] = [];
    const dev68a = mkSmp68((rq, push) => {
      reqs68a.push(rq);
      rspLine68(rq, cborEncode({ rc: 0 }), push);
    });
    const link68a = await dev68a.open();
    await new SmpDevice(link68a).echo();
    eq(reqs68a.length, 1, '68 echo: one request on the wire');
    eq(reqs68a[0]!.op, SMP.OP_READ, '68 echo: op READ');
    eq(reqs68a[0]!.group, SMP.GROUP_OS, '68 echo: group OS');
    eq(reqs68a[0]!.cmdId, SMP.ID_ECHO, '68 echo: id ECHO');
    eq(toHex(reqs68a[0]!.payload), 'a0', '68 echo: default empty-map payload');
    await link68a.close();
  }

  // --- (b) imageState parse: 2 slots, all four flags pinned ------------------
  {
    const slot0Hash68 = Uint8Array.from({ length: 32 }, (_, i) => 0x30 + i);
    const slot1Hash68 = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
    const dev68b = mkSmp68((rq, push) => {
      rspLine68(rq, cborEncode({
        rc: 0,
        images: [
          { slot: 0, hash: slot0Hash68, version: '1.2.3', bootable: true, flags: ['active', 'confirmed'] },
          { slot: 1, hash: slot1Hash68, version: '9.9.9', bootable: true, flags: ['pending', 'permanent'] },
        ],
      }), push);
    });
    const link68b = await dev68b.open();
    const slots68 = await new SmpDevice(link68b).imageState();
    eq(slots68.length, 2, '68 imageState: 2 slots parsed');
    eq(slots68[0]!.slot, 0, '68 imageState: slot 0 index');
    eq(toHex(slots68[0]!.hash), toHex(slot0Hash68), '68 imageState: slot-0 hash bytes');
    eq(slots68[0]!.active, true, '68 imageState: slot-0 active');
    eq(slots68[0]!.confirmed, true, '68 imageState: slot-0 confirmed');
    eq(slots68[0]!.pending, false, '68 imageState: slot-0 not pending');
    eq(slots68[0]!.permanent, false, '68 imageState: slot-0 not permanent');
    eq(slots68[1]!.slot, 1, '68 imageState: slot 1 index');
    eq(toHex(slots68[1]!.hash), toHex(slot1Hash68), '68 imageState: slot-1 hash bytes');
    eq(slots68[1]!.pending, true, '68 imageState: slot-1 pending');
    eq(slots68[1]!.permanent, true, '68 imageState: slot-1 permanent');
    eq(slots68[1]!.active, false, '68 imageState: slot-1 not active');
    eq(slots68[1]!.confirmed, false, '68 imageState: slot-1 not confirmed');
    await link68b.close();
  }

  // --- slot-info: reply map parsed; rc 8 (ENOTSUP) → null --------------------
  {
    const dev68s = mkSmp68((rq, push) => {
      rspLine68(rq, cborEncode({ '0,1': 2, '0,2': 4 }), push);
    });
    const link68s = await dev68s.open();
    const map68s = await new SmpDevice(link68s).slotInfoMap();
    eq(map68s !== null && map68s.get('0,1') === 2 && map68s.get('0,2') === 4, true,
      '68 slot-info: reply map parsed ("0,1"→2, "0,2"→4)');
    await link68s.close();
    const dev68n = mkSmp68((rq, push) => {
      rspLine68(rq, cborEncode({ rc: 8 }), push);
    });
    const link68n = await dev68n.open();
    eq(await new SmpDevice(link68n).slotInfoMap(), null,
      '68 slot-info: rc 8 (ENOTSUP) → null');
    await link68n.close();
  }

  // --- (c) upload happy path (2 chunks): first chunk len+sha, later neither,
  // seq increments & 0xFF, progress + first-ack callbacks --------------------
  {
    const bytes68c = Uint8Array.from({ length: 700 }, (_, i) => (i * 7 + 3) & 0xff);
    const sha68c = Uint8Array.from({ length: 32 }, (_, i) => 0x50 + i);
    const reqs68c: SmpFrame[] = [];
    const uploads68c: SmpFrame[] = [];
    let post68c = false;
    const progress68c: { sent: number; total: number }[] = [];
    let firstAck68c = 0;
    const dev68c = mkSmp68((rq, push) => {
      reqs68c.push(rq);
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_STATE) {
        rspLine68(rq, cborEncode(images68(post68c, pre0A68, sha68c)), push);
        return;
      }
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_UPLOAD) {
        uploads68c.push(rq);
        const v = cborDecode(rq.payload).value as { off: number; data: Uint8Array };
        if (v.off + v.data.length >= 700) post68c = true;
        rspLine68(rq, cborEncode({ off: v.off + v.data.length, rc: 0 }), push);
        return;
      }
    });
    const link68c = await dev68c.open();
    await new SmpDevice(link68c).uploadImage(
      { bytes: bytes68c, sha256: sha68c, imageId: 2 },
      {
        onProgress: (p) => progress68c.push(p),
        onFirstChunkAck: () => { firstAck68c++; },
        shouldContinue: () => true,
      },
    );
    eq(reqs68c.length, 4, '68 upload: pre-read + 2 chunks + verify read = 4 requests');
    eq(reqs68c[0]!.op === SMP.OP_READ && reqs68c[0]!.cmdId === SMP.ID_IMAGE_STATE, true,
      '68 upload: pre-read is an image-state READ');
    eq(uploads68c.length, 2, '68 upload: exactly 2 chunk writes');
    eq(uploads68c[0]!.op === SMP.OP_WRITE && uploads68c[0]!.cmdId === SMP.ID_IMAGE_UPLOAD, true,
      '68 upload: chunks are WRITE img/1');
    const first68 = cborDecode(uploads68c[0]!.payload).value as {
      image: number; off: number; len: number; sha: Uint8Array; data: Uint8Array;
    };
    eq(first68.image, 2, '68 upload: first chunk image id 2');
    eq(first68.off, 0, '68 upload: first chunk off 0');
    eq(first68.len, 700, '68 upload: first chunk carries len = total');
    eq(toHex(first68.sha), toHex(sha68c), '68 upload: first chunk carries sha');
    eq(first68.data.length, 512, '68 upload: first chunk data 512B (chunk cap 0x200)');
    eq(toHex(first68.data), toHex(bytes68c.subarray(0, 512)), '68 upload: first chunk data bytes');
    const later68 = cborDecode(uploads68c[1]!.payload).value as {
      off: number; data: Uint8Array; len?: number; sha?: Uint8Array;
    };
    eq(later68.off, 512, '68 upload: later chunk off 512');
    eq(later68.data.length, 188, '68 upload: later chunk data = remaining (188B)');
    eq(toHex(later68.data), toHex(bytes68c.subarray(512)), '68 upload: later chunk data bytes');
    eq('len' in later68 && 'sha' in later68, false, '68 upload: later chunk carries no len/sha');
    eq(uploads68c[1]!.seq, (uploads68c[0]!.seq + 1) & 0xff, '68 upload: chunk seq increments & 0xFF');
    eq(JSON.stringify(progress68c),
      JSON.stringify([{ sent: 512, total: 700 }, { sent: 700, total: 700 }]),
      '68 upload: progress follows the device acks');
    eq(firstAck68c, 1, '68 upload: onFirstChunkAck fired exactly once');
    await link68c.close();
  }

  // --- (d) device-off authoritative: reply off one byte higher than local →
  // the next chunk resumes at the DEVICE value --------------------------------
  {
    const bytes68d = Uint8Array.from({ length: 1026 }, (_, i) => (i * 7 + 3) & 0xff);
    const sha68d = Uint8Array.from({ length: 32 }, (_, i) => 0x60 + i);
    const chunks68d: { off: number; data: Uint8Array }[] = [];
    let post68d = false;
    const progress68d: { sent: number; total: number }[] = [];
    const dev68d = mkSmp68((rq, push) => {
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_STATE) {
        rspLine68(rq, cborEncode(images68(post68d, pre0A68, sha68d)), push);
        return;
      }
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_UPLOAD) {
        const v = cborDecode(rq.payload).value as { off: number; data: Uint8Array };
        chunks68d.push({ off: v.off, data: v.data });
        // lie one byte forward on the first ack: device claims 513, we sent 512
        const next = Math.min(v.off + v.data.length + (v.off === 0 ? 1 : 0), 1026);
        if (next >= 1026) post68d = true;
        rspLine68(rq, cborEncode({ off: next, rc: 0 }), push);
        return;
      }
    });
    const link68d = await dev68d.open();
    await new SmpDevice(link68d).uploadImage(
      { bytes: bytes68d, sha256: sha68d, imageId: 2 },
      { onProgress: (p) => progress68d.push(p) },
    );
    eq(chunks68d.length, 3, '68 offset-authoritative: 3 chunks for 1026B after the +1 lie');
    eq(chunks68d[1]!.off, 513, '68 offset-authoritative: chunk 2 off = DEVICE 513 (not local 512)');
    eq(toHex(chunks68d[1]!.data), toHex(bytes68d.subarray(513, 1025)),
      '68 offset-authoritative: chunk 2 data resumes at the device offset');
    eq(chunks68d[2]!.off, 1025, '68 offset-authoritative: chunk 3 off 1025');
    eq(chunks68d[2]!.data.length, 1, '68 offset-authoritative: chunk 3 carries the last byte');
    eq(JSON.stringify(progress68d),
      JSON.stringify([{ sent: 513, total: 1026 }, { sent: 1025, total: 1026 }, { sent: 1026, total: 1026 }]),
      '68 offset-authoritative: progress reports the device offsets');
    await link68d.close();
  }

  // --- (e) rc 3 on the first chunk → throws, nothing further written ---------
  {
    const bytes68e = Uint8Array.from({ length: 700 }, (_, i) => (i * 7 + 3) & 0xff);
    const sha68e = Uint8Array.from({ length: 32 }, (_, i) => 0x60 + i);
    const seen68e: string[] = [];
    const dev68e = mkSmp68((rq, push) => {
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_STATE) {
        seen68e.push('state');
        rspLine68(rq, cborEncode(images68(false, pre0A68, sha68e)), push);
        return;
      }
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_UPLOAD) {
        seen68e.push('chunk');
        rspLine68(rq, cborEncode({ rc: 3 }), push); // EINVAL — first-chunk too large
        return;
      }
    });
    const link68e = await dev68e.open();
    let err68e = '';
    try {
      await new SmpDevice(link68e).uploadImage({ bytes: bytes68e, sha256: sha68e, imageId: 2 });
    } catch (e) { err68e = (e as Error).message; }
    eq(err68e.includes('rc 3'), true, '68 rc-abort: throw carries the device rc');
    eq(JSON.stringify(seen68e), JSON.stringify(['state', 'chunk']),
      '68 rc-abort: nothing written after the rc=3 reply');
    await link68e.close();
  }

  // --- (f) erase classification: offset-0 reply delayed past chunkMs but
  // within eraseMs (tiny injected timeouts) → accepted ------------------------
  {
    const bytes68f = Uint8Array.from({ length: 100 }, (_, i) => (i * 7 + 3) & 0xff);
    const sha68f = Uint8Array.from({ length: 32 }, (_, i) => 0x30 + i);
    let post68f = false;
    const dev68f = mkSmp68((rq, push) => {
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_STATE) {
        rspLine68(rq, cborEncode(images68(post68f, pre0A68, sha68f)), push);
        return;
      }
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_UPLOAD) {
        const v = cborDecode(rq.payload).value as { off: number; data: Uint8Array };
        if (v.off + v.data.length >= 100) post68f = true;
        // single-chunk image: the offset-0 reply IS the erase window — arrives
        // after the chunk class (30 ms) but well inside the erase class (3 s)
        rspLine68(rq, cborEncode({ off: 100, rc: 0 }), push, 80);
        return;
      }
    });
    const link68f = await dev68f.open();
    const t68f = Date.now();
    await new SmpDevice(link68f, { chunkMs: 30, eraseMs: 3000 })
      .uploadImage({ bytes: bytes68f, sha256: sha68f, imageId: 2 });
    const elapsed68f = Date.now() - t68f;
    eq(elapsed68f >= 80, true, '68 erase-class: offset-0 reply really waited past chunkMs (30)');
    eq(elapsed68f < 3000, true, '68 erase-class: upload accepted within eraseMs (resolved, not timed out)');
    await link68f.close();
  }

  // --- shouldContinue() === false between chunks → 'aborted' -----------------
  {
    const bytes68k = Uint8Array.from({ length: 700 }, (_, i) => (i * 7 + 3) & 0xff);
    const sha68k = Uint8Array.from({ length: 32 }, (_, i) => 0x70 + i);
    const chunks68k: number[] = [];
    const dev68k = mkSmp68((rq, push) => {
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_STATE) {
        rspLine68(rq, cborEncode(images68(false, pre0A68, sha68k)), push);
        return;
      }
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_UPLOAD) {
        const v = cborDecode(rq.payload).value as { off: number };
        chunks68k.push(v.off);
        rspLine68(rq, cborEncode({ off: v.off + 512, rc: 0 }), push);
        return;
      }
    });
    const link68k = await dev68k.open();
    let go68k = true;
    let err68k = '';
    try {
      await new SmpDevice(link68k).uploadImage(
        { bytes: bytes68k, sha256: sha68k, imageId: 2 },
        {
          onProgress: (p) => { if (p.sent >= 512) go68k = false; },
          shouldContinue: () => go68k,
        },
      );
    } catch (e) { err68k = (e as Error).message; }
    eq(err68k, 'aborted', '68 shouldContinue: false between chunks → throws aborted');
    eq(chunks68k.length, 1, '68 shouldContinue: only the first chunk was sent');
    await link68k.close();
  }

  // --- swap-already-happened acceptance: post-upload state has the new hash
  // in slot 0 and the armed image moved to slot 1 → still resolves -----------
  {
    const bytes68v = Uint8Array.from({ length: 600 }, (_, i) => (i * 7 + 3) & 0xff);
    const sha68v = Uint8Array.from({ length: 32 }, (_, i) => 0x30 + i);
    let reads68v = 0;
    let post68v = false;
    const dev68v = mkSmp68((rq, push) => {
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_STATE) {
        reads68v++;
        // 1st read = pre-upload; after the upload finished, the bootloader
        // has ALREADY swapped: new hash in slot 0, armed image in slot 1
        const body = reads68v === 1 || !post68v
          ? images68(false, pre0A68, sha68v)
          : { images: [
              { slot: 0, hash: sha68v, flags: [] },
              { slot: 1, hash: pre0A68, flags: ['active', 'confirmed'] },
            ] };
        rspLine68(rq, cborEncode(body), push);
        return;
      }
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_UPLOAD) {
        const v = cborDecode(rq.payload).value as { off: number; data: Uint8Array };
        if (v.off + v.data.length >= 600) post68v = true;
        rspLine68(rq, cborEncode({ off: v.off + v.data.length, rc: 0 }), push);
        return;
      }
    });
    const link68v = await dev68v.open();
    let err68v = '';
    try {
      await new SmpDevice(link68v).uploadImage({ bytes: bytes68v, sha256: sha68v, imageId: 2 });
    } catch (e) { err68v = (e as Error).message; }
    eq(err68v, '', '68 swap-accepted: upload resolves when the swap already happened (slot0=sha, slot1=pre-slot0)');
    await link68v.close();
  }

  // --- verify refusal: post-upload state matches neither rule → throws -------
  {
    const bytes68w = Uint8Array.from({ length: 100 }, (_, i) => (i * 7 + 3) & 0xff);
    const sha68w = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
    const dev68w = mkSmp68((rq, push) => {
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_STATE) {
        // pre and post identical: slot 1 never took the write
        rspLine68(rq, cborEncode(images68(false, pre0A68, sha68w)), push);
        return;
      }
      if (rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_UPLOAD) {
        const v = cborDecode(rq.payload).value as { off: number; data: Uint8Array };
        rspLine68(rq, cborEncode({ off: v.off + v.data.length, rc: 0 }), push);
        return;
      }
    });
    const link68w = await dev68w.open();
    let err68w = '';
    try {
      await new SmpDevice(link68w).uploadImage({ bytes: bytes68w, sha256: sha68w, imageId: 2 });
    } catch (e) { err68w = (e as Error).message; }
    eq(err68w.includes('slot-1 hash'), true,
      '68 verify-refusal: unchanged slot-1 after upload throws');
    await link68w.close();
  }

  // --- (g) resolveUploadImageId numbering matrix ------------------------------
  eq(resolveUploadImageId(new Map([['0,1', 2]]), 'keyboard'), 2,
    '68 numbering: keyboard map confirms 2');
  eq(resolveUploadImageId(null, 'keyboard'), 2,
    '68 numbering: keyboard ASSUMED 2 on a null map');
  let threw68g = '';
  try { resolveUploadImageId(new Map([['0,1', 3]]), 'keyboard'); } catch (e) { threw68g = (e as Error).message; }
  eq(threw68g !== '', true, '68 numbering: disagreeing keyboard map throws');
  eq(resolveUploadImageId(new Map([['0,2', 4]]), 'modules', 1_048_576), 4,
    '68 numbering: modules map wins 4');
  threw68g = '';
  try { resolveUploadImageId(null, 'modules', 1_000_000); } catch (e) { threw68g = (e as Error).message; }
  eq(threw68g !== '', true, '68 numbering: modules unmapped with a wrong size throws');
  eq(resolveUploadImageId(null, 'modules', 1_048_576), 4,
    '68 numbering: modules unmapped, exact 1 MiB → 4');
  threw68g = '';
  try { resolveUploadImageId(new Map([['0,2', 5]]), 'modules', 1_048_576); } catch (e) { threw68g = (e as Error).message; }
  eq(threw68g !== '', true, '68 numbering: disagreeing modules map throws (map wins)');

  // --- (h) setPending frame bytes; osReset on a silent link resolves ---------
  {
    const hash68h = Uint8Array.from({ length: 32 }, (_, i) => 0x11 + i);
    const hash68h2 = Uint8Array.from({ length: 32 }, (_, i) => 0x60 + i);
    const reqs68h: SmpFrame[] = [];
    const dev68h = mkSmp68((rq, push) => {
      reqs68h.push(rq);
      if (rq.group === SMP.GROUP_OS && rq.cmdId === SMP.ID_OS_RESET) return; // silent: reboots mid-reply
      rspLine68(rq, cborEncode({ rc: 0 }), push);
    });
    const link68h = await dev68h.open();
    const dev68 = new SmpDevice(link68h, { chunkMs: 60 });
    await dev68.setPending(hash68h, true);
    eq(reqs68h.length, 1, '68 setPending: one WRITE on the wire');
    eq(reqs68h[0]!.op, SMP.OP_WRITE, '68 setPending: op WRITE');
    eq(reqs68h[0]!.group, SMP.GROUP_IMAGE, '68 setPending: group IMAGE');
    eq(reqs68h[0]!.cmdId, SMP.ID_IMAGE_STATE, '68 setPending: id 0 (img-state channel)');
    const pend68 = cborDecode(reqs68h[0]!.payload).value as { hash: Uint8Array; confirm: boolean };
    eq(pend68.hash.length, 32, '68 setPending: hash is 32B');
    eq(toHex(pend68.hash), toHex(hash68h), '68 setPending: hash bytes');
    eq(pend68.confirm, true, '68 setPending: confirm true');
    await dev68.setPending(hash68h2, false);
    const pend68b = cborDecode(reqs68h[1]!.payload).value as { hash: Uint8Array; confirm: boolean };
    eq(pend68b.confirm === false && toHex(pend68b.hash) === toHex(hash68h2), true,
      '68 setPending: confirm false + second hash bytes');
    const dev68h2 = mkSmp68((rq, push) => {
      rspLine68(rq, cborEncode({ rc: 4 }), push);
    });
    const link68h2 = await dev68h2.open();
    let err68h = '';
    try { await new SmpDevice(link68h2).setPending(hash68h, true); } catch (e) { err68h = (e as Error).message; }
    eq(err68h.includes('rc 4'), true, '68 setPending: rc != 0 throws carrying rc');
    await link68h2.close();
    const t68h = Date.now();
    await dev68.osReset();
    const osElapsed68 = Date.now() - t68h;
    eq(reqs68h.length, 3, '68 osReset: request reached the device');
    eq(reqs68h[2]!.op === SMP.OP_WRITE && reqs68h[2]!.group === SMP.GROUP_OS
      && reqs68h[2]!.cmdId === SMP.ID_OS_RESET, true, '68 osReset: WRITE os/5 on the wire');
    eq(toHex(reqs68h[2]!.payload), 'a0', '68 osReset: empty-map payload');
    eq(osElapsed68 < 3000, true, '68 osReset: silent link resolves (missing reply = success, bounded wait)');
    await link68h.close();
  }

  // --- (i) enterMcuboot() wire pin -------------------------------------------
  {
    // Pend-forever reader: the pump parks in read(), readFrame hits its own
    // deadline — the session never sees a reply.
    const pendReader68 = () => {
      let wake: (() => void) | null = null;
      const done = new Promise<void>((r) => { wake = r; });
      return {
        async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
          await done;
          return { value: undefined, done: true };
        },
        cancel() { wake?.(); },
        releaseLock() {},
      };
    };
    const writes68i: Uint8Array[] = [];
    const port68i = { readable: null, writable: null, async open() {}, async setSignals() {}, async close() {} };
    const mkSes68i = (
      reader: unknown,
      writeFn: (b: Uint8Array) => Promise<void>,
    ): NayaSession =>
      new NayaSession(
        port68i as unknown as SerialPort, 0x50,
        new FrameReader(reader as ReadableStreamDefaultReader<Uint8Array>),
        { releaseLock() {} } as unknown as WritableStreamDefaultWriter<Uint8Array>,
        reader as ReadableStreamDefaultReader<Uint8Array>,
        writeFn,
        null,
      );
    // silent device: exactly one frame, resolves on the bounded ~1500 ms wait
    const ses68i = mkSes68i(pendReader68(), async (b) => { writes68i.push(Uint8Array.from(b)); });
    const t68i = Date.now();
    await ses68i.enterMcuboot();
    const elapsed68i = Date.now() - t68i;
    eq(writes68i.length, 1, '68 enterMcuboot: exactly ONE frame written');
    const f68i = verifyFrame(writes68i[0]!);
    eq(f68i.type, 0xee, '68 enterMcuboot: type 0xEE');
    eq(f68i.c0, 0x10, '68 enterMcuboot: c0 0x10');
    eq(f68i.c1, 0xae, '68 enterMcuboot: c1 0xAE');
    eq(f68i.dst, 0x50, '68 enterMcuboot: dst = session dst');
    eq(f68i.src, 0x00, '68 enterMcuboot: sender 0x00, id 0x00');
    eq(f68i.id, 0x00, '68 enterMcuboot: id 0x00');
    eq(f68i.payload.length, 0, '68 enterMcuboot: empty params');
    eq(elapsed68i >= 1500 && elapsed68i < 3000, true,
      '68 enterMcuboot: silent device — bounded ~1500 ms wait then resolves (never roundtrip retries)');
    nayaWrites68.push(...writes68i);
    // an early reply also resolves (bounded wait ends on ANY reply, swallowed)
    {
      let wake: (() => void) | null = null;
      const done = new Promise<void>((r) => { wake = r; });
      let served = false;
      const reader68 = {
        async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
          if (!served) {
            served = true;
            await sleep(20);
            return { value: buildFrame(0x50, 0xee, 0x10, 0xae, new Uint8Array([0x00])), done: false };
          }
          await done;
          return { value: undefined, done: true };
        },
        cancel() { wake?.(); },
        releaseLock() {},
      };
      const writes68i2: Uint8Array[] = [];
      const ses68i2 = mkSes68i(reader68, async (b) => { writes68i2.push(Uint8Array.from(b)); });
      const t68i2 = Date.now();
      await ses68i2.enterMcuboot();
      const elapsed68i2 = Date.now() - t68i2;
      eq(writes68i2.length, 1, '68 enterMcuboot: reply path still sends exactly one frame');
      eq(elapsed68i2 < 1200, true, '68 enterMcuboot: an arriving reply ends the wait early (swallowed)');
      nayaWrites68.push(...writes68i2);
    }
  }

  // --- §68-wide tripwire: no DFU reset anywhere in the fixture write logs -----
  // RESET_DFU = ee/10be is a different, never-sent op. Naya writes are
  // checked structurally (verifyFrame + c0/c1); raw SMP lines are decoded
  // and scanned byte-wise (a Naya frame could only reach that log as bytes).
  let dfu68 = 0;
  for (const w of nayaWrites68) {
    try {
      const f = verifyFrame(w);
      if (f.c0 === 0x10 && f.c1 === 0xbe) dfu68++;
    } catch { dfu68++; }
  }
  for (const line of smpLines68) {
    const dec = b64Bytes68(line);
    for (let i = 0; i + 1 < dec.length; i++) {
      if (dec[i] === 0x10 && dec[i + 1] === 0xbe) { dfu68++; break; }
    }
  }
  eq(smpLines68.length > 0 && nayaWrites68.length === 2, true,
    '68 tripwire: fixture write logs were actually captured');
  eq(dfu68, 0, '68 tripwire: no fixture write carries c0=0x10 c1=0xBE (DFU reset never sent)');
  eq(SMP_DEFAULT_TIMEOUTS.chunkMs, 20000, '68 timeouts: default chunkMs 20s');
  eq(SMP_DEFAULT_TIMEOUTS.eraseMs, 90000, '68 timeouts: default eraseMs 90s');
  eq(SMP_DEFAULT_TIMEOUTS.transceiveMs, 5000, '68 timeouts: default transceiveMs 5s');
})();

// §69 firmware catalog + fetch + plan libs: vendored OF catalog integrity,
// loader validation, PID/side/gen table, plan flags (unchanged/downgrade/
// unknownCurrent/present/fetchable/reason), the catalog-by-name hazard
// (14 entries share the literal name kb_fwl.bin — matching is BY ENTRY,
// never by file name), and sha256-gated fetch over an injectable fetchFn.
void (async () => {
  const msg69 = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // (a) vendored catalog loads through the memoized dynamic-import loader
  const cat69 = await loadFirmwareCatalog();
  eq(cat69.generated.startsWith('2026-09-23'), true,
    '69 catalog: generated date 2026-09-23 (vendored byte-identical from OF)');
  eq(cat69.images.length, 69, '69 catalog: 69 images');
  eq(cat69.releases.length, 25, '69 catalog: 25 releases');
  const comp69 = cat69.images.find((e) => e.file === 'Touch_UserApp.sfb');
  eq(comp69 !== undefined && typeof comp69.sha256 === 'string' && typeof comp69.blobSha256 !== 'string',
    true, '69 catalog: module component entries carry sha256 (no blobSha256) and still load');
  eq(cat69.images.filter((e) => e.target === 'keyboard' && e.flashable === true).length, 24,
    '69 catalog: 24 flashable keyboard images');
  eq((await loadFirmwareCatalog()) === cat69, true,
    '69 catalog: loader memoizes — second call returns the same instance');
  eq(FIRMWARE_SOURCE_BASE,
    'https://raw.githubusercontent.com/create-collective/create-legacy-firmware/main/firmware-history/',
    '69 fetch: source base is the legacy firmware-history raw URL');

  // (b) loader validation throws on doctored shapes
  const throwsParse69 = (raw: unknown, name: string): void => {
    let threw = false;
    try { parseFirmwareCatalog(raw); } catch { threw = true; }
    eq(threw, true, name);
  };
  throwsParse69(null, '69 validate: null throws');
  throwsParse69({}, '69 validate: missing images throws');
  throwsParse69({ generated: 'x', images: [] }, '69 validate: empty images array throws');
  throwsParse69({ generated: 'x', images: [{ target: 'keyboard', blobSha256: 'a' }] },
    '69 validate: entry without string file throws');
  throwsParse69({ generated: 'x', images: [{ file: 'x.bin', blobSha256: 'a' }] },
    '69 validate: entry without string target throws');
  throwsParse69({ generated: 'x', images: [{ file: 'x.bin', target: 'keyboard' }] },
    '69 validate: entry without blobSha256/sha256 throws');
  let compOk69 = false;
  try {
    parseFirmwareCatalog({ generated: 'x', images: [{ file: 'Touch_UserApp.sfb', target: 'module', sha256: 'ab' }] });
    compOk69 = true;
  } catch { /* must not throw */ }
  eq(compOk69, true, '69 validate: module component entry (sha256 only) accepted');

  // (c) PID/side/gen table (family 0x064/06F/07A left, 0x0C8/0D3/0DE right;
  //     gen B = pid & 0x1000; unknown → null)
  eq(NAYA_VID, 0x37d1, '69 plat: NAYA_VID 0x37d1');
  eq(JSON.stringify([...RECOVERY_PIDS]), JSON.stringify([0x06f, 0x106f, 0x0d3, 0x10d3]),
    '69 plat: RECOVERY_PIDS [0x06f,0x106f,0x0d3,0x10d3] — mcuboot bases × {0, 0x1000}');
  {
    const rp69 = new Set<number>(RECOVERY_PIDS);
    eq(rp69.has(0x106f) && rp69.has(0x10d3), true,
      '69 plat: RECOVERY_PIDS covers gen-B MCUboot 0x106f/0x10d3');
    eq(rp69.has(0x16f) || rp69.has(0x1d3), false,
      '69 plat: RECOVERY_PIDS excludes the bit-0x100 slips 0x16f/0x1d3');
  }
  const pi69 = (pid: number): string => {
    const r = pidInfo(pid);
    return r === null ? 'null' : `${r.side}/${r.mode}/${r.generation}`;
  };
  eq(pi69(0x0064), 'left/app/A', '69 plat: 0x0064 left app A');
  eq(pi69(0x00c8), 'right/app/A', '69 plat: 0x00C8 right app A');
  eq(pi69(0x006f), 'left/mcuboot/A', '69 plat: 0x006F left mcuboot A');
  eq(pi69(0x00d3), 'right/mcuboot/A', '69 plat: 0x00D3 right mcuboot A');
  eq(pi69(0x007a), 'left/third/A', '69 plat: 0x007A left third A');
  eq(pi69(0x00de), 'right/third/A', '69 plat: 0x00DE right third A');
  eq(pi69(0x1064), 'left/app/B', '69 plat: 0x1064 left app B');
  eq(pi69(0x106f), 'left/mcuboot/B', '69 plat: 0x106F left mcuboot B');
  eq(pi69(0x10d3), 'right/mcuboot/B', '69 plat: 0x10D3 right mcuboot B');
  // 0x16f/0x1d3 (an earlier brief draft) carry bit 0x100 — inside the family
  // field, not a NayaCore family; the recovery set uses base | 0x1000 (ruled
  // a transcription slip, matching OF recovery.py). pidInfo never guesses:
  // unknown family → null, matching OF pid_info.
  eq(pi69(0x16f), 'null', '69 plat: 0x16F is outside the NayaCore family table → null');
  eq(pi69(0x1d3), 'null', '69 plat: 0x1D3 is outside the NayaCore family table → null');
  eq(pi69(0x0009), 'null', '69 plat: 0x0009 unknown family → null');
  eq(pi69(0x1000), 'null', '69 plat: bare gen-B bit, unknown family → null');

  // keyboardVersions: flashable keyboard versions, newest releaseOrder first
  const kv69 = keyboardVersions(cat69);
  eq(kv69.length, 11, '69 versions: 11 flashable keyboard versions (betas + pre-history withheld)');
  eq(kv69[0] !== undefined && kv69[0].label === '3.41.0' && kv69[0].declared
    && kv69[0].releaseOrder === 23, true, '69 versions: first = 3.41.0 declared ro 23');
  eq(kv69[0]?.bundle, 'NayaFlow 1.25.1', "69 versions: first bundle 'NayaFlow 1.25.1'");
  eq(kv69.map((v) => v.label).join('|'),
    '3.41.0|3.35.4|3.31.1|3.29.1|3.28.7|NayaFlow 1.14.3|NayaFlow 1.11.11'
    + '|NayaFlow 1.11.8, 1.11.10|NayaFlow 1.11.0, 1.11.9|NayaFlow 1.3.8 to 1.6.10'
    + '|NayaFlow 0.1.0 to 0.1.1',
    '69 versions: exact newest-first order');
  eq(kv69.filter((v) => v.declared).length, 5, '69 versions: 5 declared (createFirmware) versions');
  eq(kv69[kv69.length - 1]?.declared, false, '69 versions: oldest (0.1.0 to 0.1.1) undeclared');

  // (d) plan flags against the real catalog
  const FWL341 = '3d3e544ece9d986a0e6cae41879cade1749272cb8fac39b6f8adc10edff111e0';
  const FWR341 = 'a4c137eb4d8b55f3cd1282b1752b8eb45d00c1180189aee531a6e990a407acbf';
  const FWL64_341 = 'afa7642bcf6cbc210917d275d4394f653dcb754dfd1e57f1cb4caa184992dba4';
  const FWL335 = 'a126f4f6dd0f45bd0572e4f107a22bd4697850ef2b548d3ff76e662bbe91651c';
  const FWL1143 = '099651b8b6950e243ced709f6edd38127413b3ea5f99f0bf483d77d6500bfe61';
  const mkHalf69 = (side: 'left' | 'right', pid: number | null, fw: string | null) =>
    ({ side, pid, fw });
  const heldVault69 = newVault();
  heldVault69.set(
    { file: 'probe.bin', target: 'keyboard', type: 'app', side: 'left', generation: 'A',
      flashable: true, blobSha256: FWL341 },
    new Uint8Array([0x01]),
  );
  const pUpToDate69 = resolveKeyboardPlan(cat69, [mkHalf69('left', 0x0064, '3.41.0')], heldVault69, '3.41.0').halves[0]!;
  eq(pUpToDate69.image?.blobSha256, FWL341, '69 plan: up-to-date left A 3.41.0 → fwl entry by digest');
  eq(pUpToDate69.generation, 'A', '69 plan: pid 0x0064 → generation A');
  eq(pUpToDate69.present, true, '69 plan: present when vault holds blobSha256');
  eq(pUpToDate69.fetchable, true, '69 plan: fetchable when image carries historyPath');
  eq(pUpToDate69.unchanged, true, '69 plan: unchanged when current == label');
  eq(pUpToDate69.downgrade, false, '69 plan: same version is not a downgrade');
  eq(pUpToDate69.unknownCurrent, false, '69 plan: 3.41.0 is a declared current');
  eq(pUpToDate69.reason, undefined, '69 plan: no reason on the happy path');

  const pRight69 = resolveKeyboardPlan(cat69, [mkHalf69('right', 0x00c8, '3.41.0')], newVault(), '3.41.0').halves[0]!;
  eq(pRight69.image?.blobSha256, FWR341, '69 plan: right A resolves the fwr entry');
  eq(pRight69.present, false, '69 plan: present false on empty vault');

  const pDown69 = resolveKeyboardPlan(cat69, [mkHalf69('left', 0x0064, '3.41.0')], newVault(), '3.35.4').halves[0]!;
  eq(pDown69.downgrade, true, '69 plan: 3.41.0 → 3.35.4 is a downgrade (dot-tuple)');
  eq(pDown69.unchanged, false, '69 plan: downgrade is not unchanged');
  eq(pDown69.image?.blobSha256, FWL335, '69 plan: target 3.35.4 image digest');
  const pUp69 = resolveKeyboardPlan(cat69, [mkHalf69('left', 0x0064, '3.35.4')], newVault(), '3.41.0').halves[0]!;
  eq(pUp69.downgrade, false, '69 plan: 3.35.4 → 3.41.0 is an upgrade');

  const pRoDown69 = resolveKeyboardPlan(cat69, [mkHalf69('left', 0x0064, '3.41.0')], newVault(), 'NayaFlow 1.14.3').halves[0]!;
  eq(pRoDown69.downgrade, true,
    '69 plan: declared → undeclared downgrades by releaseOrder fallback (23 > 14)');
  eq(pRoDown69.image?.blobSha256, FWL1143, '69 plan: undeclared target label still finds its image');
  const pRoUp69 = resolveKeyboardPlan(cat69, [mkHalf69('left', 0x1064, 'NayaFlow 1.11.11')], newVault(), '3.41.0').halves[0]!;
  eq(pRoUp69.unknownCurrent, true, '69 plan: NayaFlow 1.11.11 is not among createFirmware values');
  eq(pRoUp69.downgrade, false, '69 plan: undeclared ro 13 → declared ro 23 is not a downgrade');
  const pUnknown69 = resolveKeyboardPlan(cat69, [mkHalf69('left', 0x0064, '9.9.9')], newVault(), '3.35.4').halves[0]!;
  eq(pUnknown69.unknownCurrent, true, "69 plan: unknown '9.9.9' flagged");
  eq(pUnknown69.downgrade, false, "69 plan: unknown '9.9.9' has no releaseOrder → no downgrade claim");

  const pNoImgB69 = resolveKeyboardPlan(cat69, [mkHalf69('left', 0x1064, '3.35.4')], newVault(), '3.35.4').halves[0]!;
  eq(pNoImgB69.image === null && pNoImgB69.reason === 'no image for this half+generation', true,
    '69 plan: gen B + 3.35.4 (A-era release) → no image for this half+generation');
  const pNoPid69 = resolveKeyboardPlan(cat69, [mkHalf69('left', null, '3.41.0')], newVault(), '3.41.0').halves[0]!;
  eq(pNoPid69.generation === null && pNoPid69.image === null
    && pNoPid69.reason === 'no image for this half+generation' && pNoPid69.unchanged, true,
    '69 plan: pid null → gen null, no image, unchanged still true');
  const pBeta69 = resolveKeyboardPlan(cat69, [mkHalf69('left', 0x0064, null)], newVault(), '3.40.4').halves[0]!;
  eq(pBeta69.image === null && pBeta69.fetchable === false
    && (pBeta69.reason ?? '').startsWith('not flashable: beta-channel image'), true,
    '69 plan: withheld beta target → not flashable reason, nothing fetchable');
  eq(pBeta69.unknownCurrent, false, '69 plan: beta 3.40.4 is a declared createFirmware (recognised, withheld)');

  const catSynth69: FwCatalog = {
    generated: 'probe',
    images: [{
      file: 'kb_np.bin', target: 'keyboard', type: 'app', side: 'left', generation: 'A',
      flashable: true, blobSha256: 'ab'.repeat(32), createFirmware: '1.0.0',
    }],
    releases: [],
  };
  const pNoPath69 = resolveKeyboardPlan(catSynth69, [mkHalf69('left', 0x0064, null)], newVault(), '1.0.0').halves[0]!;
  eq(pNoPath69.image !== null && pNoPath69.fetchable === false && pNoPath69.present === false
    && pNoPath69.reason === undefined, true,
    '69 plan: flashable image without historyPath → image present, fetchable false, no reason');
  const pBoth69 = resolveKeyboardPlan(
    cat69,
    [mkHalf69('left', 0x0064, '3.41.0'), mkHalf69('right', 0x00c8, '3.41.0')],
    newVault(), '3.41.0',
  ).halves;
  eq(pBoth69[0]?.side === 'left' && pBoth69[1]?.side === 'right', true,
    '69 plan: halves keep input order and side');
  eq(pBoth69[0]?.image?.blobSha256 === FWL341 && pBoth69[1]?.image?.blobSha256 === FWR341, true,
    '69 plan: per-half images resolve independently');

  // (e) catalog-by-name hazard: kb_fwl.bin appears 14 times — resolution is
  // by ENTRY (side+gen+label → hash-bearing row), never by file name
  const hazA69 = findKeyboardImage(cat69, 'left', 'A', '3.41.0');
  const hazB69 = findKeyboardImage(cat69, 'left', 'A', '3.35.4');
  eq(hazA69?.file === 'kb_fwl.bin' && hazB69?.file === 'kb_fwl.bin', true,
    "69 hazard: both 3.41.0 and 3.35.4 left-A entries share file 'kb_fwl.bin'");
  eq(hazA69?.blobSha256, FWL341, '69 hazard: 3.41.0 lookup → 1.25.1 blob');
  eq(hazB69?.blobSha256, FWL335, '69 hazard: 3.35.4 lookup → 1.21.0 blob');
  eq(hazA69?.blobSha256 !== hazB69?.blobSha256, true,
    '69 hazard: same file name, distinct entries — never name-keyed');
  const hazGen69 = findKeyboardImage(cat69, 'left', 'B', '3.41.0');
  eq(hazGen69?.file === 'kb_fwl_64.bin' && hazGen69?.blobSha256 === FWL64_341, true,
    '69 hazard: gen B splits within one version (kb_fwl_64.bin)');
  const hazRight69 = findKeyboardImage(cat69, 'right', 'A', '3.41.0');
  eq(hazRight69?.file === 'kb_fwr.bin' && hazRight69?.blobSha256 === FWR341, true,
    '69 hazard: right half resolves the fwr entry');
  eq(findKeyboardImage(cat69, 'left', 'A', '3.99.9-nope'), null,
    '69 hazard: unknown label → null');

  // (f) fetch over an injectable fetchFn: sha256 gate, size cap, status,
  // nothing-written guarantee
  const emptySha69 = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(0))),
  ).map((b) => b.toString(16).padStart(2, '0')).join('');
  eq(emptySha69, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '69 fetch: node 22 globalThis.crypto.subtle pins the empty SHA-256 vector');
  const bytes69 = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x42]);
  const digest69 = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes69)),
  ).map((b) => b.toString(16).padStart(2, '0')).join('');
  const goodEntry69: FwEntry = {
    file: 'kb_probe.bin', target: 'keyboard', type: 'app', side: 'left', generation: 'A',
    flashable: true, blobSha256: digest69, historyPath: 'v9.9.9/kb_probe.bin',
    createFirmware: '9.9.9',
  };
  const fakeOk69: typeof fetch = async () => new Response(bytes69);
  const vaultOk69 = newVault();
  let got69: Uint8Array | null = null;
  let okFail69 = '';
  try { got69 = await fetchImage(goodEntry69, { fetchFn: fakeOk69 }); } catch (e) { okFail69 = msg69(e); }
  eq(okFail69 === '' && got69 !== null && toHex(got69) === toHex(bytes69), true,
    '69 fetch: ok — bytes round-trip through the fake fetchFn');
  vaultOk69.set(goodEntry69, got69 ?? new Uint8Array(0));
  eq(vaultOk69.has(digest69) && vaultOk69.count() === 1, true,
    '69 fetch: vault stores under blobSha256');
  eq(toHex(vaultOk69.get(digest69) ?? new Uint8Array(0)), toHex(bytes69),
    '69 fetch: vault.get returns the stored bytes');

  const badEntry69: FwEntry = { ...goodEntry69, blobSha256: 'ff'.repeat(32) };
  const vaultBad69 = newVault();
  vaultBad69.set(goodEntry69, bytes69);
  let badFail69 = '';
  try { await fetchImage(badEntry69, { fetchFn: fakeOk69 }); } catch (e) { badFail69 = msg69(e); }
  eq(badFail69.includes('nothing was written'), true,
    '69 fetch: digest mismatch — message promises nothing was written');
  eq(badFail69.includes('expected ff'), true, '69 fetch: mismatch message names the expected digest');
  eq(vaultBad69.count() === 1 && toHex(vaultBad69.get(digest69) ?? new Uint8Array(0)) === toHex(bytes69),
    true, '69 fetch: mismatch — vault untouched, original bytes intact');

  const fakeBig69: typeof fetch = async () => new Response(new Uint8Array(9 * 1024 * 1024));
  let bigFail69 = '';
  try { await fetchImage(goodEntry69, { fetchFn: fakeBig69 }); } catch (e) { bigFail69 = msg69(e); }
  eq(bigFail69.includes('8 MiB'), true, '69 fetch: 9 MiB body refused at the 8 MiB cap');
  eq(vaultOk69.count() === 1, true, '69 fetch: oversized — vault untouched');

  const fake404_69: typeof fetch = async () => new Response(null, { status: 404 });
  let f404_69 = '';
  try { await fetchImage(goodEntry69, { fetchFn: fake404_69 }); } catch (e) { f404_69 = msg69(e); }
  eq(f404_69.includes('404'), true, '69 fetch: HTTP 404 surfaces in the reason');

  let noHp69 = '';
  try {
    await fetchImage({ ...goodEntry69, historyPath: undefined }, { fetchFn: fakeOk69 });
  } catch (e) { noHp69 = msg69(e); }
  eq(noHp69.includes('no historyPath'), true, '69 fetch: entry without historyPath refuses');
  let noSha69 = '';
  try {
    await fetchImage({ ...goodEntry69, blobSha256: undefined as unknown as string }, { fetchFn: fakeOk69 });
  } catch (e) { noSha69 = msg69(e); }
  eq(noSha69.includes('no blobSha256'), true, '69 fetch: entry without blobSha256 refuses');

  const missEntry69: FwEntry = { ...goodEntry69, file: 'miss.bin', historyPath: 'v9.9.9/miss.bin' };
  const noPathEntry69: FwEntry = { ...goodEntry69, file: 'nopath.bin', historyPath: undefined };
  const catFetch69: FwCatalog = { generated: 'probe', images: [goodEntry69, missEntry69, noPathEntry69], releases: [] };
  const fakeSplit69: typeof fetch = (input) =>
    (String(input).endsWith('kb_probe.bin') ? new Response(bytes69) : new Response(null, { status: 404 }));
  const vaultV69 = newVault();
  const seen69: boolean[] = [];
  const rV69 = await fetchVersion(catFetch69, '9.9.9', vaultV69, {
    fetchFn: fakeSplit69,
    onOne: (r) => { seen69.push(r.ok); },
  });
  eq(rV69.fetched, 1, '69 fetchVersion: one good entry fetched');
  eq(rV69.failed.length === 1 && rV69.failed[0].path === 'v9.9.9/miss.bin', true,
    '69 fetchVersion: 404 entry lands in failed with its path');
  eq(rV69.failed[0]?.reason.includes('404'), true, '69 fetchVersion: failed reason carries the status');
  eq(seen69.length === 2 && seen69[0] === true && seen69[1] === false, true,
    '69 fetchVersion: onOne reports both outcomes in order');
  eq(vaultV69.count(), 1, '69 fetchVersion: only the good bytes are stored');
  eq(noPathEntry69.historyPath === undefined && rV69.fetched === 1, true,
    '69 fetchVersion: historyPath-less entries under the label are skipped');

  const vReal69 = newVault();
  const fakeWrong69: typeof fetch = async () => new Response(bytes69);
  const rReal69 = await fetchVersion(cat69, '3.41.0', vReal69, { fetchFn: fakeWrong69 });
  eq(rReal69.fetched, 0, '69 fetchVersion real: fake bytes match no digest — 0 fetched');
  eq(rReal69.failed.length, 4, '69 fetchVersion real: exactly 4 historyPath entries under 3.41.0');
  eq(rReal69.failed.every((f) => f.reason.includes('nothing was written')), true,
    '69 fetchVersion real: every attempt stopped at the sha256 gate');
  eq(vReal69.count(), 0, '69 fetchVersion real: nothing written on total mismatch');
})();

// §70 firmware interlock gate: the full refusal matrix — every rule alone
// (everything else passing) refuses with EXACTLY its refusal string, the
// all-pass inputs clear with [], boundary sizes pass (cap inclusive for the
// keyboard, exact for the module bundle), allowOlder lifts the downgrade
// refusal, consent lifts the unknown-current refusal, and forceType lifts
// ONLY the module type-identification blocker — never the bay, undocked,
// right-half, arm-token, or catalog-flashable rules. Violations collect
// (brief order), so the run log can show everything wrong at once.
{
  const SHA70 = 'ab'.repeat(32); // keyboard entry blobSha256
  const SHAM70 = 'cd'.repeat(32); // module bundle blobSha256
  const SLOT0_70 = '11'.repeat(32); // device-reported slot-0 hash (arm token)
  const eqArr70 = (a: string[], b: string[], name: string) =>
    eq(JSON.stringify(a), JSON.stringify(b), name);

  // hand-built minimal catalog rows — the gate is pure and must not load
  // the vendored catalog to decide
  const kbEntry70: FwEntry = {
    file: 'kb_fwl.bin', target: 'keyboard', type: 'app', side: 'left', generation: 'A',
    flashable: true, blobSha256: SHA70,
  };
  const modEntry70: FwEntry = {
    file: 'Touch_UserApp.bin', target: 'module', type: 'littlefs', side: null, generation: null,
    flashable: true, blobSha256: SHAM70,
  };
  const kbBase70: KeyboardGateInput = {
    kind: 'keyboard', entry: kbEntry70, heldSha256: SHA70,
    arm: SLOT0_70, slot0Hash: SLOT0_70,
    pidSide: 'left', pidGeneration: 'A',
    fileSize: 663_552,
    downgrade: false, allowOlder: false, unknownCurrent: false, consented: false,
    modulesDocked: false, uploadImageId: 2,
  };
  const modBase70: ModuleGateInput = {
    kind: 'module', entry: modEntry70, heldSha256: SHAM70,
    arm: SLOT0_70, slot0Hash: SLOT0_70,
    fileSize: 1_048_576, bundleNewerThanKeyboard: false,
    downgrade: false, allowOlder: false,
    rightConnected: false, moduleDockedSide: 'left',
    uploadImageId: 4, forceType: null,
  };

  // refusal copy — exactly what the gate and the procedures share
  const R70 = {
    sha: 'sha mismatch: held bytes are not this catalog image',
    arm: 'arm token must equal the device-reported slot-0 hash from this run',
    crossKb: 'type cross: littlefs is never a keyboard image',
    crossMod: 'type cross: mcuboot is never a module image',
    idKb: 'uploadImageId must be 2 for a keyboard',
    idMod: 'uploadImageId must be 4 for a module',
    kbSize: 'keyboard image exceeds the 663,552-byte slot cap',
    modSize: 'module bundle must be exactly 1,048,576 bytes',
    docked: 'modules are docked — undock them before flashing the keyboard',
    downgrade: 'downgrade refused without allowOlder',
    consent: 'current firmware is unknown — consent required before flashing',
    sideGen: 'catalog entry side/generation does not match the half',
    right: 'right half is connected — unplug it before flashing modules',
    bay: 'module must be docked in the left bay',
    bundle: 'bundle is newer than the keyboard firmware — update the keyboard first',
  };

  // all-pass inputs clear
  eqArr70(checkFlashGate(kbBase70), [], '70 gate: all-pass keyboard input → []');
  eqArr70(checkFlashGate(modBase70), [], '70 gate: all-pass module input → []');

  // --- keyboard matrix: every rule alone, all else passing ------------------
  eqArr70(checkFlashGate({ ...kbBase70, heldSha256: 'ff'.repeat(32) }), [R70.sha],
    '70 gate kb: sha mismatch refuses');
  eqArr70(checkFlashGate({ ...kbBase70, entry: { ...kbEntry70, flashable: false, withheldBecause: ['beta-channel image'] } }),
    ['not flashable: beta-channel image'], '70 gate kb: !flashable joins withheldBecause');
  eqArr70(checkFlashGate({ ...kbBase70, entry: { ...kbEntry70, flashable: false } }),
    ['not flashable'], '70 gate kb: !flashable without reasons → bare copy');
  eqArr70(checkFlashGate({ ...kbBase70, entry: { ...kbEntry70, type: 'littlefs' } }), [R70.crossKb],
    '70 gate kb: littlefs never keyboard');
  eqArr70(checkFlashGate({ ...kbBase70, arm: null }), [R70.arm],
    '70 gate kb: arm null refuses');
  eqArr70(checkFlashGate({ ...kbBase70, arm: '22'.repeat(32) }), [R70.arm],
    '70 gate kb: stale/foreign arm refuses');
  eqArr70(checkFlashGate({ ...kbBase70, slot0Hash: null }), [R70.arm],
    '70 gate kb: slot0Hash null — arm can never match the device, refuses');
  eqArr70(checkFlashGate({ ...kbBase70, uploadImageId: 4 }), [R70.idKb],
    '70 gate kb: uploadImageId ≠ 2 refuses');
  eq(checkFlashGate({ ...kbBase70, fileSize: 663_552 }).length, 0,
    '70 gate kb: exactly 663,552 B passes (cap inclusive)');
  eqArr70(checkFlashGate({ ...kbBase70, fileSize: 663_553 }), [R70.kbSize],
    '70 gate kb: one byte over the slot cap refuses');
  eqArr70(checkFlashGate({ ...kbBase70, modulesDocked: true }), [R70.docked],
    '70 gate kb: modules docked refuses');
  eqArr70(checkFlashGate({ ...kbBase70, downgrade: true }), [R70.downgrade],
    '70 gate kb: downgrade without allowOlder refuses');
  eqArr70(checkFlashGate({ ...kbBase70, downgrade: true, allowOlder: true }), [],
    '70 gate kb: allowOlder lifts the downgrade refusal');
  eqArr70(checkFlashGate({ ...kbBase70, unknownCurrent: true }), [R70.consent],
    '70 gate kb: unknown current without consent refuses');
  eqArr70(checkFlashGate({ ...kbBase70, unknownCurrent: true, consented: true }), [],
    '70 gate kb: consent lifts the unknown-current refusal');
  eqArr70(checkFlashGate({ ...kbBase70, entry: { ...kbEntry70, side: 'right' } }), [R70.sideGen],
    '70 gate kb: entry side ≠ pid side refuses');
  eqArr70(checkFlashGate({ ...kbBase70, entry: { ...kbEntry70, generation: 'B' } }), [R70.sideGen],
    '70 gate kb: entry generation ≠ pid generation refuses');

  // --- module matrix ----------------------------------------------------------
  eqArr70(checkFlashGate({ ...modBase70, heldSha256: 'ee'.repeat(32) }), [R70.sha],
    '70 gate mod: sha mismatch refuses');
  eqArr70(checkFlashGate({ ...modBase70, entry: { ...modEntry70, flashable: false, withheldBecause: ['superseded bundle'] } }),
    ['not flashable: superseded bundle'], '70 gate mod: !flashable joins withheldBecause');
  eqArr70(checkFlashGate({ ...modBase70, entry: { ...modEntry70, type: 'mcuboot' } }), [R70.crossMod],
    '70 gate mod: mcuboot never module');
  eqArr70(checkFlashGate({ ...modBase70, arm: null }), [R70.arm],
    '70 gate mod: arm null refuses');
  eqArr70(checkFlashGate({ ...modBase70, uploadImageId: 2 }), [R70.idMod],
    '70 gate mod: uploadImageId ≠ 4 refuses');
  eq(checkFlashGate({ ...modBase70, fileSize: 1_048_576 }).length, 0,
    '70 gate mod: exactly 1,048,576 B passes');
  eqArr70(checkFlashGate({ ...modBase70, fileSize: 1_048_575 }), [R70.modSize],
    '70 gate mod: one byte under 1 MiB refuses');
  eqArr70(checkFlashGate({ ...modBase70, fileSize: 1_048_577 }), [R70.modSize],
    '70 gate mod: one byte over 1 MiB refuses');
  eqArr70(checkFlashGate({ ...modBase70, rightConnected: true }), [R70.right],
    '70 gate mod: right half connected refuses');
  eqArr70(checkFlashGate({ ...modBase70, moduleDockedSide: 'right' }), [R70.bay],
    '70 gate mod: module docked in the right bay refuses');
  eqArr70(checkFlashGate({ ...modBase70, moduleDockedSide: null }), [R70.bay],
    '70 gate mod: module not docked (side null) refuses');
  eqArr70(checkFlashGate({ ...modBase70, downgrade: true }), [R70.downgrade],
    '70 gate mod: downgrade without allowOlder refuses');
  eqArr70(checkFlashGate({ ...modBase70, bundleNewerThanKeyboard: true }), [R70.bundle],
    '70 gate mod: bundle newer than keyboard refuses');

  // --- forceType: lifts ONLY the module type-identification blocker -----------
  eqArr70(checkFlashGate({ ...modBase70, entry: { ...modEntry70, type: 'mcuboot' }, forceType: 'Tune' }), [],
    '70 gate force: forceType lifts the module type-cross refusal');
  eqArr70(checkFlashGate({ ...modBase70, moduleDockedSide: 'right', forceType: 'Tune' }), [R70.bay],
    '70 gate force: forceType never lifts the bay rule');
  eqArr70(checkFlashGate({ ...modBase70, moduleDockedSide: null, forceType: 'Tune' }), [R70.bay],
    '70 gate force: forceType never lifts the undocked rule');
  eqArr70(checkFlashGate({ ...modBase70, rightConnected: true, forceType: 'Tune' }), [R70.right],
    '70 gate force: forceType never lifts the right-half rule');
  eqArr70(checkFlashGate({ ...modBase70, entry: { ...modEntry70, flashable: false, withheldBecause: ['x'] }, forceType: 'Tune' }),
    ['not flashable: x'], '70 gate force: forceType never lifts the catalog flashable rule');
  eqArr70(checkFlashGate({ ...modBase70, arm: null, forceType: 'Tune' }), [R70.arm],
    '70 gate force: forceType never lifts the arm-token rule');

  // violations collect — two broken rules return both strings, brief order
  eqArr70(checkFlashGate({ ...kbBase70, heldSha256: 'ff'.repeat(32), modulesDocked: true }),
    [R70.sha, R70.docked], '70 gate: multiple violations collect in order');
}

// §71 firmware run log + procedure lifecycle: JSONL run log with fixed key
// order (run.start meta first, run.end verdict last), the one-run lock +
// freeze flag + unload guards on an injectable win, and preflight
// capture/verify over scripted NayaSession fakes — fw fe/1002, BLE identity
// be/1008|1002|1005 (the bleSplitReads set), de/1001 module presence on both
// halves (the undock-gate input), left-only keymap+LED banks 0+1 (30/1003 +
// 30/100d multipart — the reads whose caches useFlash's auto-backup
// serializes; the left half owns dest 0x50). Artifact = stable-key-order
// serialization + WebCrypto sha256, logged as a `preflight` artifact note.
/* §71 owns the module-level one-run lock while it runs; later procedure
 * sections (§72+) must not interleave with it. It signals completion here
 * and they await the signal before their first beginFirmwareRun. */
let signal71done: (() => void) | null = null;
const after71: Promise<void> = new Promise<void>((r) => { signal71done = r; });
void (async () => {
  /* ---- (a) run log shape -------------------------------------------------- */
  const CORE71 = ['ts', 'elapsed_ms', 'step', 'label', 'phase'];
  const log71 = new FirmwareRunLog('keyboard');
  eq(/^keyboard-\d{8}-\d{6}$/.test(log71.id), true, '71 log: id = kind-YYYYMMDD-HHMMSS');
  eq(log71.done, false, '71 log: not done before finish');
  eq(log71.events.length, 1, '71 log: constructor emits run.start meta');
  const rs71 = log71.events[0]!;
  eq(rs71.step === 'run.start' && rs71.phase === 'start', true,
    '71 log: first event is run.start, phase start');
  eq(rs71.kind, 'keyboard', '71 log: run.start carries the run kind');
  eq(rs71.elapsed_ms, 0, '71 log: run.start elapsed_ms 0');
  eq(rs71.label, STEP_LABELS['run.start'], '71 log: label from STEP_LABELS');

  log71.start('preflight.capture');
  log71.ok('preflight.capture', undefined, { took_ms: 12 });
  log71.start('mcuboot.enter', 'left');
  log71.progress('upload', 'left', 5, 100, 2000);
  log71.action('mcuboot.enter', 'left', 'grant the bootloader port');
  log71.note('identify', 'left', 'slot-0 hash noted', { sha256: 'ab'.repeat(32) });
  log71.note('mystery.step', undefined, 'unlabeled');
  log71.fail('swap.verify', 'left', 'slot flags not pending');

  const seen71: RunEvent[] = [];
  const unsub71 = log71.subscribe((e) => seen71.push(e));
  log71.note('gate.check', undefined, 'subscribed');
  unsub71();
  log71.note('gate.check', undefined, 'not subscribed');
  eq(seen71.length === 1 && seen71[0]!.detail === 'subscribed', true,
    '71 log: subscribe sees events until unsubscribe');

  log71.finish(false, 'aborted', ['swap.verify: slot flags not pending'], ['version changed']);
  eq(log71.done, true, '71 log: done after finish');
  const le71 = log71.events[log71.events.length - 1]!;
  eq(le71.step, 'run.end', '71 log: last event is run.end');
  eq(le71.phase, 'fail', '71 log: run.end phase mirrors the verdict');
  eq(le71.ok, false, '71 log: run.end carries ok');
  eq(le71.summary, 'aborted', '71 log: run.end carries summary');
  eq(JSON.stringify(le71.failures), JSON.stringify(['swap.verify: slot flags not pending']),
    '71 log: run.end carries failures');
  eq(JSON.stringify(le71.advisories), JSON.stringify(['version changed']),
    '71 log: run.end carries advisories');
  const frozen71 = log71.events.length;
  log71.ok('late.step');
  eq(log71.events.length, frozen71, '71 log: events after finish are frozen out');

  const parsed71 = log71.lines().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  eq(parsed71.length, log71.events.length, '71 log: lines() is parse-clean JSONL, one per event');
  const keys71 = parsed71.map((o) => Object.keys(o));
  eq(keys71.every((k) => k.slice(0, 5).join(',') === CORE71.join(',')), true,
    '71 log: every line opens ts,elapsed_ms,step,label,phase in order');
  const keysAt71 = (step: string, phase?: string): string[] => {
    for (let i = parsed71.length - 1; i >= 0; i--) {
      if (parsed71[i]!.step === step && (phase === undefined || parsed71[i]!.phase === phase))
        return keys71[i]!;
    }
    return ['MISSING'];
  };
  eq(JSON.stringify(keysAt71('run.start')), JSON.stringify([...CORE71, 'kind']),
    '71 log: run.start key order');
  eq(JSON.stringify(keysAt71('upload')), JSON.stringify([...CORE71, 'side', 'percent', 'sent', 'total']),
    '71 log: progress row carries percent/sent/total after side');
  eq(JSON.stringify(keysAt71('mcuboot.enter', 'start')), JSON.stringify([...CORE71, 'side']),
    '71 log: step start row key order');
  eq(JSON.stringify(keysAt71('mcuboot.enter', 'action')), JSON.stringify([...CORE71, 'side', 'detail']),
    '71 log: action row carries detail');
  eq(JSON.stringify(keysAt71('identify', 'note')), JSON.stringify([...CORE71, 'side', 'detail', 'sha256']),
    '71 log: note row carries detail + extras');
  eq(JSON.stringify(keysAt71('preflight.capture', 'ok')), JSON.stringify([...CORE71, 'took_ms']),
    '71 log: ok row hoists took_ms into the canonical slot');
  eq(JSON.stringify(keysAt71('run.end')),
    JSON.stringify([...CORE71, 'ok', 'summary', 'failures', 'advisories']),
    '71 log: run.end key order');
  const mys71 = parsed71.find((o) => o.step === 'mystery.step');
  eq(mys71 !== undefined && mys71.label === 'mystery.step', true,
    '71 log: unknown step label falls back to the step name');
  eq(['run.start', 'run.end', 'preflight.capture', 'preflight.verify', 'mcuboot.enter',
    'identify', 'slot.erase', 'upload', 'swap.verify', 'mcuboot.exit', 'version.confirm',
    'halves.settle', 'brightness.restore', 'lighting.restore', 'verify.compare',
    'slot.map', 'bundle.verify', 'bundle.restart', 'module.program', 'module.restart',
    'module.verify'].every((s) => typeof STEP_LABELS[s] === 'string' && STEP_LABELS[s].length > 0),
    true, '71 log: STEP_LABELS covers the spec step set (keyboard + module)');

  /* ---- (b) lifecycle: one-run lock, freeze flag, unload guards ------------- */
  eq(firmwareRunActive(), false, '71 life: flag starts false');
  const map71 = new Map<'left' | 'right', NayaSession>();
  const busy71 = { current: false };
  const winCalls71: string[] = [];
  const winFns71 = new Map<string, unknown>();
  let winRefs71 = true;
  const win71 = {
    addEventListener(t: string, l: unknown): void { winCalls71.push(`add:${t}`); winFns71.set(t, l); },
    removeEventListener(t: string, l: unknown): void {
      winCalls71.push(`remove:${t}`);
      if (winFns71.get(t) !== l) winRefs71 = false;
    },
  };
  const log71b = beginFirmwareRun(
    { sesRef: { current: map71 }, busyRef: busy71, win: win71 }, 'keyboard',
  );
  eq(log71b !== null, true, '71 life: beginRun returns the run log');
  eq(firmwareRunActive() === true && busy71.current === true, true,
    '71 life: flag true + busyRef held during the run');
  eq(JSON.stringify(winCalls71), JSON.stringify(['add:beforeunload', 'add:pagehide']),
    '71 life: begin registers both unload guards');
  eq(beginFirmwareRun(
    { sesRef: { current: map71 }, busyRef: busy71, win: win71 }, 'module',
  ), null, '71 life: second beginRun while active refuses');
  eq(firmwareRunActive() === true && busy71.current === true, true,
    '71 life: refusal leaves the first run intact');
  const handler71 = winFns71.get('beforeunload') as
    (e: { preventDefault: () => void; returnValue?: unknown }) => void;
  let pd71 = false;
  const ev71 = { preventDefault: (): void => { pd71 = true; }, returnValue: undefined as unknown };
  handler71(ev71);
  eq(pd71 && ev71.returnValue === true, true,
    '71 life: unload guard sets returnValue + preventDefault');
  const ended71 = endFirmwareRun(false, 'aborted', ['swap.verify failed'], ['version changed']);
  eq(ended71 !== null && ended71.done, true, '71 life: endRun finishes the active log');
  const le71b = ended71!.events[ended71!.events.length - 1]!;
  eq(le71b.step === 'run.end' && le71b.ok === false, true,
    '71 life: run.end verdict on the active log');
  eq(firmwareRunActive() === false && busy71.current === false, true,
    '71 life: flag + busy released after endRun');
  eq(JSON.stringify(winCalls71),
    JSON.stringify(['add:beforeunload', 'add:pagehide', 'remove:beforeunload', 'remove:pagehide']),
    '71 life: guards registered exactly while active (same handler refs)');
  eq(winRefs71, true, '71 life: removeEventListener receives the registered handler refs');

  const log71c = beginFirmwareRun({ sesRef: { current: map71 }, busyRef: busy71 }, 'module');
  eq(log71c !== null && log71c.id.startsWith('module-') && firmwareRunActive(), true,
    '71 life: default win (globalThis, guarded) — module run begins');
  endFirmwareRun(true, 'ok');
  eq(firmwareRunActive() === false && busy71.current === false, true,
    '71 life: clean end of the module run');
  eq(endFirmwareRun(true, 'noop'), null, '71 life: endRun without an active run is a no-op');
  const busyFake71 = { current: true };
  eq(beginFirmwareRun(
    { sesRef: { current: map71 }, busyRef: busyFake71 }, 'module',
  ), null, '71 life: begin refuses while busyRef is held by another op');

  /* ---- (c) preflight capture + verify on scripted fakes -------------------- */
  const macL71 = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
  const macR71 = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f];
  const keysA71 = [0x10, 0x20, 0x30, 0x40];
  const keysB71 = [0x50, 0x60, 0x70, 0x80];
  const ledsA71 = [0xb4, 0x00, 0x64, 0x11];
  const replyL71 = (rq: Frame): Uint8Array => {
    const k = `${rq.type.toString(16)}/${rq.c1.toString(16)}`;
    const part = rq.payload[0] ?? 0;
    const layer = rq.payload[1] ?? 0;
    if (k === 'fe/2') return Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04]); // v1.2.3.4
    if (k === 'be/8') return Uint8Array.from(macL71);
    if (k === 'be/2') return Uint8Array.from(macR71);
    if (k === 'be/5') return Uint8Array.from([1, ...macR71]);
    if (k === 'de/1') return Uint8Array.from([0x00, 0x00, 0x10, 0x00]); // absent Touch, L
    if (k === '30/3') {
      if (layer === 1) return Uint8Array.from([0x16]); // bank 1: nothing stored
      return part === 0
        ? Uint8Array.from([0x01, layer, ...keysA71])
        : Uint8Array.from([0x00, layer, ...keysB71]);
    }
    if (k === '30/d') {
      if (layer === 1) return Uint8Array.from([0x16]);
      return Uint8Array.from([0x00, layer, ...ledsA71]);
    }
    return Uint8Array.from([0x00]);
  };
  const replyR71 = (rq: Frame): Uint8Array => {
    const k = `${rq.type.toString(16)}/${rq.c1.toString(16)}`;
    if (k === 'fe/2') return Uint8Array.from([0x00, 0x02, 0x00, 0x03, 0x04]); // v2.0.3.4
    if (k === 'be/8') return Uint8Array.from(macR71);
    if (k === 'be/2') return Uint8Array.from(macL71);
    if (k === 'be/5') return Uint8Array.from([1, ...macL71]);
    if (k === 'de/1') return Uint8Array.from([0x00, 0x00, 0x21, 0x00]); // absent Track, R
    return Uint8Array.from([0x00]);
  };
  const scripted71 = (reply: (rq: Frame) => Uint8Array) => {
    const reqs: Frame[] = [];
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    const reader = {
      async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
        for (;;) {
          const c = queue.shift();
          if (c) return { value: c, done: false };
          await new Promise<void>((res) => { waiter = res; });
        }
      },
      cancel() { const w = waiter; waiter = null; w?.(); },
      releaseLock() {},
    };
    const writer = {
      async write(b: Uint8Array) {
        const rq = verifyFrame(Uint8Array.from(b));
        reqs.push(rq);
        const resp = buildFrame(0x50, rq.type, rq.c0, rq.c1, reply(rq));
        verifyFrame(resp);
        setTimeout(() => { queue.push(resp); const w = waiter; waiter = null; w?.(); }, 5);
      },
      releaseLock() {},
    };
    const port = {
      readable: { locked: false, getReader: () => reader },
      writable: { getWriter: () => writer },
      async open() {}, async setSignals() {}, async close() {},
    };
    return {
      reqs,
      session() {
        const r = port.readable.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
        const w = port.writable.getWriter() as unknown as WritableStreamDefaultWriter<Uint8Array>;
        return new NayaSession(
          port as unknown as SerialPort, 0x50,
          new FrameReader(r), w, r,
          async (b) => { await w.write(b); }, null,
        );
      },
    };
  };
  const leftDev71 = scripted71(replyL71);
  const rightDev71 = scripted71(replyR71);
  const sessions71 = new Map<'left' | 'right', NayaSession>();
  sessions71.set('left', leftDev71.session());
  sessions71.set('right', rightDev71.session());

  const lf71 = beginFirmwareRun(
    { sesRef: { current: sessions71 }, busyRef: { current: false } }, 'keyboard',
  );
  eq(lf71 !== null, true, '71 preflight: run begun for the capture');
  const cap71 = await capturePreflight(sessions71, ['left', 'right']);
  eq(cap71.kind, 'preflight', '71 preflight: capture tagged kind preflight');
  const hl71 = cap71.data.halves.left!;
  const hr71 = cap71.data.halves.right!;
  eq(hl71.fwHex, '00 01 02 03 04', '71 preflight: left fw fe/1002 raw hex');
  eq((hl71.fwText ?? '').startsWith('v1.2.3.4'), true, '71 preflight: left fwText via fwVersionText');
  eq(hl71.bleAddress, '11 22 33 44 55 66', '71 preflight: left BLE address (be/1008)');
  eq(hl71.pairAddress, 'aa bb cc dd ee 0f', '71 preflight: left pair address (be/1002)');
  eq(JSON.stringify(hl71.bondedPeers), JSON.stringify(['aa bb cc dd ee 0f']),
    '71 preflight: left bond table (be/1005)');
  eq(hl71.modulePresent === false && hl71.moduleType === 'none' && hl71.moduleHalfBit === 0, true,
    '71 preflight: left module absent → none, halfBit L');
  eq(hr71.fwHex, '00 02 00 03 04', '71 preflight: right fw read separately');
  eq(hr71.bleAddress === 'aa bb cc dd ee 0f' && hr71.pairAddress === '11 22 33 44 55 66', true,
    '71 preflight: right BLE identity mirrored');
  eq(JSON.stringify(hr71.bondedPeers), JSON.stringify(['11 22 33 44 55 66']),
    '71 preflight: right bond table');
  eq(hr71.modulePresent === false && hr71.moduleType === 'none' && hr71.moduleHalfBit === 1, true,
    '71 preflight: right module absent, halfBit R (undock-gate input, both halves)');
  const kb71 = cap71.data.keymapBanks!;
  eq(kb71['0'].keysStatus === 'ok' && kb71['0'].keysHex === '10 20 30 40 50 60 70 80', true,
    '71 preflight: bank-0 keymap stitched from 2 multipart parts');
  eq(kb71['0'].ledsStatus === 'ok' && kb71['0'].ledsHex === 'b4 00 64 11', true,
    '71 preflight: bank-0 LED map captured');
  eq(kb71['1'].keysStatus === 'empty' && kb71['1'].keysHex === null, true,
    '71 preflight: bank-1 keymap empty → status, no hex');
  eq(kb71['1'].ledsStatus === 'empty' && kb71['1'].ledsHex === null, true,
    '71 preflight: bank-1 LED map empty → status, no hex');

  const cnt71 = (d: { reqs: Frame[] }, t: number, c1: number): number =>
    d.reqs.filter((r) => r.type === t && r.c1 === c1).length;
  eq(cnt71(leftDev71, 0xfe, 0x02), 1, '71 preflight wire: left fe/1002 asked once');
  eq(cnt71(leftDev71, 0xbe, 0x08) === 1 && cnt71(leftDev71, 0xbe, 0x02) === 1 &&
      cnt71(leftDev71, 0xbe, 0x05) === 1, true,
    '71 preflight wire: left BLE identity trio asked once each');
  eq(cnt71(leftDev71, 0xde, 0x01), 1, '71 preflight wire: left de/1001 asked once');
  eq(cnt71(leftDev71, 0x30, 0x03) === 3 && cnt71(leftDev71, 0x30, 0x0d) === 2, true,
    '71 preflight wire: left keymap 2+1 parts, ledmap 1+1 (banks 0+1)');
  eq(cnt71(rightDev71, 0xde, 0x01), 1,
    '71 preflight wire: right de/1001 asked (undock gate covers both halves)');
  eq(cnt71(rightDev71, 0x30, 0x03) === 0 && cnt71(rightDev71, 0x30, 0x0d) === 0, true,
    '71 preflight wire: keymap/LED reads are LEFT-only (left owns dest 0x50)');

  eq(/^[0-9a-f]{64}$/.test(cap71.sha256), true, '71 preflight: sha256 is 64-hex');
  eq(cap71.serialized, stableStringify(cap71.data),
    '71 preflight: serialized = stable-key-order serialization of the doc');
  const note71 = lf71!.events.find((e) => e.phase === 'note' && e.step === 'preflight.capture');
  eq(note71 !== undefined && note71!.artifact === 'preflight' && note71!.sha256 === cap71.sha256,
    true, '71 preflight: artifact note in the run log carries the sha256');
  eq((await verifyPreflight(cap71)).ok, true, '71 preflight: re-serialize verify passes');
  endFirmwareRun(true, 'preflight captured');

  // determinism: a fresh capture over fresh fakes with the SAME world yields
  // the same sha256 (no timestamps inside the artifact doc)
  const leftDev71b = scripted71(replyL71);
  const rightDev71b = scripted71(replyR71);
  const sessions71b = new Map<'left' | 'right', NayaSession>();
  sessions71b.set('left', leftDev71b.session());
  sessions71b.set('right', rightDev71b.session());
  const cap71b = await capturePreflight(sessions71b, ['left', 'right']);
  eq(cap71b.sha256, cap71.sha256, '71 preflight: same world → same sha256 (stable serialization)');
  const mut71 = JSON.parse(JSON.stringify(cap71)) as typeof cap71;
  mut71.data.halves.left!.fwHex = 'ff';
  const vr71 = await verifyPreflight(mut71);
  eq(vr71.ok === false && (vr71.reason ?? '').length > 0, true,
    '71 preflight: mutated snapshot fails verify with a reason');
  await sessions71.get('left')!.close();
  await sessions71.get('right')!.close();
  await sessions71b.get('left')!.close();
  await sessions71b.get('right')!.close();
  signal71done?.();
})();

// §72 keyboard flash-one-side core (startKeyboardRun): mcuboot entry through
// the app-session fake, scripted fake mcuboot line-ports behind an injectable
// SerialWorld (getPorts only — the smoke never opens a user gesture), probe
// discipline (first imageState answer wins, silent port → bootloader.console
// note), gate refusal BEFORE any upload write, upload progress + slot.erase
// ok on first chunk ack, swap.verify re-poll with early success, injected
// millisecond timeouts everywhere (the core never sleeps on raw constants).
// Fixtures: mkSmp68-style SMP line ports (streams rebuild on open — the port
// re-opens per probe like real WebSerial), §71-style NayaSession fakes whose
// writer triggers re-enumeration when the ee/10ae enter frame lands.
/* §72 owns the module-level one-run lock while its cases run; §73+ must not
 * interleave. It signals completion here and they await the signal before
 * their first beginFirmwareRun. */
let signal72done: (() => void) | null = null;
const after72: Promise<void> = new Promise<void>((r) => { signal72done = r; });
void (async () => {
  const msg72 = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const hex32 = (u8: Uint8Array): string => toHex(u8).replace(/ /g, '');
  const last72 = (log: FirmwareRunLog): RunEvent => log.events[log.events.length - 1]!;

  // ---- serial-world seam: node-safe, throws lazily -------------------------
  {
    const w = defaultSerialWorld();
    eq(typeof w.getPorts === 'function' && typeof w.requestPort === 'function', true,
      '72 world: defaultSerialWorld() constructs node-safe (no navigator access at build)');
    let gpErr = '';
    try { await w.getPorts(); } catch (e) { gpErr = msg72(e); }
    eq(/WebSerial/.test(gpErr), true, '72 world: getPorts rejects lazily with the no-WebSerial reason');
    let rpErr = '';
    try { await w.requestPort([{ usbVendorId: NAYA_VID }]); } catch (e) { rpErr = msg72(e); }
    eq(/WebSerial/.test(rpErr), true, '72 world: requestPort rejects lazily with the same reason');
  }

  // ---- fixtures --------------------------------------------------------------
  const portInfo72 = (pid: number): { usbVendorId: number; usbProductId: number } =>
    ({ usbVendorId: NAYA_VID, usbProductId: pid });
  // world-only stub (the core reads only getInfo off app ports pre-enter)
  const stubPort72 = (pid: number): PortWithInfo =>
    ({ getInfo: () => portInfo72(pid) }) as unknown as PortWithInfo;

  // Stateful fake mcuboot line-port. Streams REBUILD on open(): the flash
  // core opens/closes the port per probe (SmpLink owns locks), like a real
  // WebSerial port that is closed and re-opened. State machine: fresh →
  // uploaded (slot-1 = sha) → swapped (slot-0 = sha); alreadySwapped lands
  // straight in swapped (the uploadImage swap-already-happened readback).
  const mkBoot72 = (o: {
    pid: number;
    pre0: Uint8Array;
    sha: Uint8Array;
    alreadySwapped?: boolean;
    swapAfterMs?: number | null;
    failRc?: number | null;
    onReset?: () => void; // T7: the return-to-app phase os-resets the answering port
  }) => {
    const linesWritten: string[] = [];
    let reads = 0;
    let stage: 'fresh' | 'uploaded' | 'swapped' = 'fresh';
    let total = -1;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let pending = '';
    let streams: {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    } | null = null;
    const build = (): void => {
      pending = '';
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const readable = new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
      });
      const push = (t: string, delayMs = 5): void => {
        setTimeout(() => { controller?.enqueue(enc.encode(t)); }, delayMs);
      };
      const writable = new WritableStream<Uint8Array>({
        write(b) {
          pending += dec.decode(b);
          for (;;) {
            const i = pending.indexOf('\n');
            if (i < 0) break;
            const line = pending.slice(0, i + 1);
            pending = pending.slice(i + 1);
            linesWritten.push(line);
            const rq = parseSmpChunks(line).frames[0];
            if (!rq) continue;
            if (rq.op === SMP.OP_READ && rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_STATE) {
              reads++;
              const slots = stage === 'swapped'
                ? [
                    { slot: 0, hash: o.sha, flags: ['active', 'confirmed'] },
                    { slot: 1, hash: o.pre0, flags: [] },
                  ]
                : stage === 'uploaded'
                  ? [
                      { slot: 0, hash: o.pre0, flags: ['active', 'confirmed'] },
                      { slot: 1, hash: o.sha, flags: ['pending'] },
                    ]
                  : [
                      { slot: 0, hash: o.pre0, flags: ['active', 'confirmed'] },
                      { slot: 1, hash: o.pre0, flags: [] },
                    ];
              push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ rc: 0, images: slots })));
              continue;
            }
            if (rq.op === SMP.OP_READ && rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_SLOT_INFO) {
              // rc 8 ENOTSUP — no numbering map → the ASSUMED-2 rule
              push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ rc: 8 })));
              continue;
            }
            if (rq.op === SMP.OP_WRITE && rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_UPLOAD) {
              const v = cborDecode(rq.payload).value as { off: number; len?: number; data: Uint8Array };
              if (o.failRc !== null && o.failRc !== undefined) {
                push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ rc: o.failRc })));
                continue;
              }
              if (v.off === 0) total = typeof v.len === 'number' ? v.len : -1;
              const end = v.off + v.data.length;
              if (total >= 0 && end >= total) {
                stage = o.alreadySwapped === true ? 'swapped' : 'uploaded';
                const delay = o.swapAfterMs;
                if (typeof delay === 'number') setTimeout(() => { stage = 'swapped'; }, delay);
              }
              push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ off: end, rc: 0 })));
              continue;
            }
            if (rq.op === SMP.OP_WRITE && rq.group === SMP.GROUP_OS && rq.cmdId === SMP.ID_OS_RESET) {
              // mcuboot.exit (T7): the reset reply usually never comes — a
              // fast rc 0 or nothing are both fine; the harness hook fires
              // so the world can re-enumerate.
              push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ rc: 0 })));
              o.onReset?.();
              continue;
            }
          }
        },
      });
      streams = { readable, writable };
    };
    build();
    const port = {
      get readable() { return streams?.readable ?? null; },
      get writable() { return streams?.writable ?? null; },
      async open() { build(); },
      async setSignals() {},
      async close() { streams = null; },
      getInfo: () => portInfo72(o.pid),
    };
    const isWrite = (l: string, group: number, cmdId: number): boolean => {
      const f = parseSmpChunks(l).frames[0];
      return !!f && f.op === SMP.OP_WRITE && f.group === group && f.cmdId === cmdId;
    };
    return {
      port: port as unknown as PortWithInfo,
      linesWritten,
      reads: (): number => reads,
      uploadCount: (): number => linesWritten.filter((l) => isWrite(l, SMP.GROUP_IMAGE, SMP.ID_IMAGE_UPLOAD)).length,
      osResetCount: (): number => linesWritten.filter((l) => isWrite(l, SMP.GROUP_OS, SMP.ID_OS_RESET)).length,
    };
  };

  // The OTHER CDC interface: a log port that swallows SMP frames (never
  // answers) and babbles console text. Same rebuildable-stream contract.
  const mkLogPort72 = (pid: number, banner: string) => {
    const linesWritten: string[] = [];
    let streams: {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    } | null = null;
    const build = (): void => {
      const readable = new ReadableStream<Uint8Array>({
        start(c) { setTimeout(() => { c.enqueue(new TextEncoder().encode(banner)); }, 5); },
      });
      const dec = new TextDecoder();
      const writable = new WritableStream<Uint8Array>({
        write(b) { linesWritten.push(dec.decode(b)); },
      });
      streams = { readable, writable };
    };
    build();
    const port = {
      get readable() { return streams?.readable ?? null; },
      get writable() { return streams?.writable ?? null; },
      async open() { build(); },
      async setSignals() {},
      async close() { streams = null; },
      getInfo: () => portInfo72(pid),
    };
    return { port: port as unknown as PortWithInfo, linesWritten };
  };

  // Injected SerialWorld: mutable port list behind getPorts.
  const mkWorld72 = (initial: PortWithInfo[]): { world: SerialWorld; list: PortWithInfo[] } => {
    const list = [...initial];
    return {
      list,
      world: {
        getPorts: async () => [...list],
        requestPort: async () => { throw new Error('no user gesture in the smoke world'); },
      },
    };
  };

  // App-mode session fake (§71 scripted71 shape) + re-enumeration: the
  // writer fires onEnter 30 ms after the ee/10ae enter frame lands.
  const scripted72 = (
    reply: (rq: Frame) => Uint8Array,
    onEnter?: () => void,
  ) => {
    const reqs: Frame[] = [];
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    const reader = {
      async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
        for (;;) {
          const c = queue.shift();
          if (c) return { value: c, done: false };
          await new Promise<void>((res) => { waiter = res; });
        }
      },
      cancel() { const w = waiter; waiter = null; w?.(); },
      releaseLock() {},
    };
    const writer = {
      async write(b: Uint8Array) {
        const rq = verifyFrame(Uint8Array.from(b));
        reqs.push(rq);
        if (rq.type === 0xee && rq.c0 === 0x10 && rq.c1 === 0xae) setTimeout(() => onEnter?.(), 30);
        const resp = buildFrame(0x50, rq.type, rq.c0, rq.c1, reply(rq));
        verifyFrame(resp);
        setTimeout(() => { queue.push(resp); const w = waiter; waiter = null; w?.(); }, 5);
      },
      releaseLock() {},
    };
    const port = {
      readable: { locked: false, getReader: () => reader },
      writable: { getWriter: () => writer },
      async open() {}, async setSignals() {}, async close() {},
    };
    return {
      reqs,
      port: port as unknown as PortWithInfo,
      session() {
        const r = port.readable.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
        const w = port.writable.getWriter() as unknown as WritableStreamDefaultWriter<Uint8Array>;
        return new NayaSession(
          port as unknown as SerialPort, 0x50,
          new FrameReader(r), w, r,
          async (b) => { await w.write(b); }, null,
        );
      },
    };
  };
  const replyApp72 = (o: { docked?: boolean }) => (rq: Frame): Uint8Array => {
    const k = `${rq.type.toString(16)}/${rq.c1.toString(16)}`;
    if (k === 'ee/ae') return Uint8Array.from([0]); // half acks, then reboots
    if (k === 'fe/2') return Uint8Array.from([0, 1, 2, 3, 4]);
    if (k === 'be/8') return Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    if (k === 'be/2') return Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f]);
    if (k === 'be/5') return Uint8Array.from([1, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f]);
    if (k === 'de/1') {
      return o.docked === true
        ? Uint8Array.from([0x00, 0x01, 0x10, 0x00]) // Touch present (undock-gate trip)
        : Uint8Array.from([0x00, 0x00, 0x10, 0x00]); // absent
    }
    if (k === '30/3') {
      const part = rq.payload[0] ?? 0;
      const layer = rq.payload[1] ?? 0;
      if (layer === 1) return Uint8Array.from([0x16]);
      return part === 0
        ? Uint8Array.from([0x01, layer, 0x10, 0x20, 0x30, 0x40])
        : Uint8Array.from([0x00, layer, 0x50, 0x60, 0x70, 0x80]);
    }
    if (k === '30/d') {
      if ((rq.payload[1] ?? 0) === 1) return Uint8Array.from([0x16]);
      return Uint8Array.from([0x00, rq.payload[1] ?? 0, 0xb4, 0x00, 0x64, 0x11]);
    }
    return Uint8Array.from([0x00]);
  };

  // ---- catalog picks: newest dual-side gen-A label + an older running entry
  const cat72 = await loadFirmwareCatalog();
  let label72: string | undefined;
  let entryL72: FwEntry | null = null;
  let entryR72: FwEntry | null = null;
  for (const v of keyboardVersions(cat72)) {
    const l = findKeyboardImage(cat72, 'left', 'A', v.label);
    const r = findKeyboardImage(cat72, 'right', 'A', v.label);
    if (l === null || r === null) continue;
    if (typeof l.plaintextSha256 !== 'string' || typeof r.plaintextSha256 !== 'string') continue;
    label72 = v.label;
    entryL72 = l;
    entryR72 = r;
    break;
  }
  let runEntry72: FwEntry | null = null; // an OLDER left/A entry = the running image
  for (const v of keyboardVersions(cat72)) {
    if (v.label === label72) continue;
    const l = findKeyboardImage(cat72, 'left', 'A', v.label);
    if (l === null || typeof l.plaintextSha256 !== 'string') continue;
    if (typeof l.releaseOrder === 'number' && entryL72 !== null &&
        typeof entryL72.releaseOrder === 'number' && l.releaseOrder < entryL72.releaseOrder) {
      runEntry72 = l;
      break;
    }
  }
  eq(label72 !== undefined && entryL72 !== null && entryR72 !== null && runEntry72 !== null, true,
    '72 fixture: newest dual-side gen-A label with plaintext hashes + an older running entry exist');
  const pre072 = hexToBytes(runEntry72!.plaintextSha256!)!; // left slot-0 while running the older image
  const pre0R72 = hexToBytes(entryR72!.plaintextSha256!)!; // right slot-0 (unchanged case)
  const foreign72 = Uint8Array.from({ length: 32 }, (_, i) => 0x70 + i);
  const shaL72 = hexToBytes(entryL72!.plaintextSha256 ?? entryL72!.blobSha256)!;
  const shaR72 = hexToBytes(entryR72!.plaintextSha256 ?? entryR72!.blobSha256)!;
  const bytes72 = (seed: number): Uint8Array => Uint8Array.from({ length: 700 }, (_, i) => (i * 13 + seed) & 0xff);
  // fe/1002 payload shaped like the device's version bytes for a declared
  // label ('3.41.0' → 00 03 29 00 00-style four components — fwVersionText
  // decodes it as v3.41.0.0).
  const fwBytes72 = (label: string): Uint8Array => {
    const parts = label.split('.').map((p) => Number.parseInt(p, 10));
    while (parts.length < 4) parts.push(0);
    return Uint8Array.from([0, ...parts.slice(0, 4)]);
  };
  const mkVault72 = (): Vault => {
    const v = newVault();
    v.set(entryL72!, bytes72(3));
    v.set(entryR72!, bytes72(5));
    return v;
  };

  // Injected timeouts — millisecond scale; nothing in the core may sleep on
  // raw constants (swapMs 400 < settle+poll of a SECOND re-poll, so any
  // early-success path is proven by finishing at all).
  const T72 = { pollMs: 15, enterMs: 1200, swapMs: 400, rePollMs: 10, probeMs: 150,
    resetMs: 60, confirmMs: 9000, reResetMs: 300, settleMs: 1500,
    rescueMs: 900 }; // T8: the stranded-half rescue window (failure tail)

  const mkCase72 = (o: {
    foreign?: boolean; // slot-0 hash matches no catalog entry
    failRc?: number | null;
    alreadySwapped?: boolean;
    swapAfterMs?: number | null;
    boots?: { left?: Array<'smp' | 'log'>; right?: Array<'smp'> };
    docked?: 'left' | 'right' | null;
    grant?: 'reject' | null;
    enterMs?: number;
    returnToApp?: boolean; // T7: os reset re-enumerates the app port for version.confirm
  }) => {
    const appL = stubPort72(0x064);
    const appR = stubPort72(0x0c8);
    const w = mkWorld72([appL, appR]);
    // Post-flash app-mode fakes (T7 return-to-app): the re-enumerated app
    // port answers the connectPort discipline — fa/1001 identify (33B left /
    // 21B right) and fe/1002 with the flashed version's bytes. T8: the tail's
    // verify.compare re-reads the full preflight verb set through these
    // sessions, so they delegate to the same replyApp72 shapes the
    // pre-flight capture saw — identical values, clean compare.
    const fwAfter72 = fwBytes72(label72!);
    const appAfterL = scripted72((rq: Frame): Uint8Array => {
      const k = `${rq.type.toString(16)}/${rq.c1.toString(16)}`;
      if (k === 'fa/1') return Uint8Array.from({ length: 33 }, (_, i) => i);
      if (k === 'fe/2') return fwAfter72;
      return replyApp72({})(rq);
    });
    const appAfterR = scripted72((rq: Frame): Uint8Array => {
      const k = `${rq.type.toString(16)}/${rq.c1.toString(16)}`;
      if (k === 'fa/1') return Uint8Array.from({ length: 21 }, (_, i) => i);
      if (k === 'fe/2') return fwAfter72;
      return replyApp72({})(rq);
    });
    // The re-enumerated app ports must carry the USB identity — portMatches
    // decodes the PID, and a port without getInfo matches nothing.
    const appAfterLPort = { ...appAfterL.port, getInfo: () => portInfo72(0x064) } as unknown as PortWithInfo;
    const appAfterRPort = { ...appAfterR.port, getInfo: () => portInfo72(0x0c8) } as unknown as PortWithInfo;
    const drop72 = (p: PortWithInfo): void => {
      const i = w.list.indexOf(p);
      if (i >= 0) w.list.splice(i, 1);
    };
    const bootL = mkBoot72({
      pid: 0x06f,
      pre0: o.foreign === true ? foreign72 : pre072,
      sha: shaL72,
      alreadySwapped: o.alreadySwapped,
      swapAfterMs: o.swapAfterMs ?? null,
      failRc: o.failRc ?? null,
      onReset: () => {
        if (o.returnToApp !== true) return;
        drop72(bootL.port);
        drop72(logL.port);
        w.list.push(appAfterLPort);
      },
    });
    const bootR = mkBoot72({
      pid: 0x0d3, pre0: pre0R72, sha: shaR72, swapAfterMs: o.swapAfterMs ?? null,
      onReset: () => {
        if (o.returnToApp !== true) return;
        drop72(bootR.port);
        w.list.push(appAfterRPort);
      },
    });
    const logL = mkLogPort72(0x06f, 'Naya bootloader log port — verbosity high\n');
    const onEnter = (side: 'left' | 'right'): void => {
      const i = w.list.indexOf(side === 'left' ? appL : appR);
      if (i >= 0) w.list.splice(i, 1); // the app port is gone — OS re-enumerated
      const boots = side === 'left' ? (o.boots?.left ?? ['smp']) : (o.boots?.right ?? ['smp']);
      for (const b of boots) {
        if (side === 'left' && b === 'smp') w.list.push(bootL.port);
        if (side === 'left' && b === 'log') w.list.push(logL.port);
        if (side === 'right' && b === 'smp') w.list.push(bootR.port);
      }
    };
    const leftDev = scripted72(replyApp72({ docked: o.docked === 'left' }), () => onEnter('left'));
    const rightDev = scripted72(replyApp72({ docked: o.docked === 'right' }), () => onEnter('right'));
    const sesRef = { current: new Map<'left' | 'right', NayaSession>() };
    sesRef.current.set('left', leftDev.session());
    sesRef.current.set('right', rightDev.session());
    let grantCalls = 0;
    const deps = {
      sesRef,
      busyRef: { current: false },
      world: w.world,
      vault: mkVault72(),
      timeouts: { ...T72, ...(o.enterMs !== undefined ? { enterMs: o.enterMs } : {}) },
      ...(o.grant === 'reject'
        ? {
            grantPort: async (): Promise<PortWithInfo> => {
              grantCalls++;
              throw new Error('user cancelled the port picker');
            },
          }
        : {}),
    };
    return {
      deps, bootL, bootR, logL, leftDev, rightDev,
      grantCalls: (): number => grantCalls,
    };
  };
  const leftOnly72 = [{ side: 'left' as const, label: label72! }];
  const kbOpts72 = { allowOlder: false, acceptUnknown: false, consentedUnknown: false };

  /* Cases run SEQUENTIALLY (each owns the module-level one-run lock for its
   * duration) and only after §71 has released it. Each case is its own
   * function so a refused run (null) fails its assert instead of crashing
   * the remaining sections. */
  const begin72 = async (name: string, c: ReturnType<typeof mkCase72>, opts: Parameters<typeof startKeyboardRun>[1]): Promise<FirmwareRunLog | null> => {
    const log = await startKeyboardRun(c.deps, opts);
    if (log === null) eq(false, true, `${name}: run began (null = refused — the one-run lock was held)`);
    return log;
  };

  // ---- (a) happy path, targets listed [right, left], run goes LEFT first ----
  const caseA72 = async (): Promise<void> => {
    const c = mkCase72({ boots: { left: ['smp'], right: ['smp'] }, swapAfterMs: 40, returnToApp: true });
    const log = await begin72('72(a)', c, {
      targets: [{ side: 'right', label: label72! }, { side: 'left', label: label72! }],
      ...kbOpts72,
    });
    if (log === null) return;
    const enterOkL = log.events.findIndex((e) => e.step === 'mcuboot.enter' && e.phase === 'ok' && e.side === 'left');
    const identOkL = log.events.findIndex((e) => e.step === 'identify' && e.phase === 'ok' && e.side === 'left');
    const eraseOkL = log.events.findIndex((e) => e.step === 'slot.erase' && e.phase === 'ok' && e.side === 'left');
    const progL = log.events.findIndex((e) => e.step === 'upload' && e.phase === 'progress' && e.side === 'left');
    const swapOkL = log.events.findIndex((e) => e.step === 'swap.verify' && e.phase === 'ok' && e.side === 'left');
    eq(enterOkL >= 0 && enterOkL < identOkL && identOkL < eraseOkL && eraseOkL < progL && progL < swapOkL, true,
      '72(a) order: mcuboot.enter → identify → slot.erase(ok) → upload(progress) → swap.verify(ok)');
    const firstEnter = log.events.find((e) => e.step === 'mcuboot.enter' && e.phase === 'start');
    eq(firstEnter?.side, 'left', '72(a) left-first: targets listed [right, left], the run starts with LEFT');
    eq(c.leftDev.reqs.filter((f) => f.type === 0xee && f.c0 === 0x10 && f.c1 === 0xae).length, 1,
      '72(a) ON: exactly one ee/10ae through the left app-session fake');
    eq(c.rightDev.reqs.filter((f) => f.type === 0xee && f.c0 === 0x10 && f.c1 === 0xae).length, 1,
      '72(a) ON: right half entered too (second target)');
    const le72a = last72(log);
    eq(le72a.step === 'run.end' && le72a.ok === true, true, '72(a) run.end ok');
    eq(log.events.filter((e) => e.step === 'swap.verify' && e.phase === 'ok').length, 2,
      '72(a) both halves swap-verified');
    eq(c.bootL.uploadCount(), 2, '72(a) two upload chunk writes (700 B = 512 + 188) on the left bootloader');
    eq(c.bootL.osResetCount(), 1, '72(a) exactly one os reset — the T7 mcuboot.exit, sent to the answering port');
    eq(c.bootL.reads() >= 4, true, '72(a) probe + upload pre/post reads + a swap re-poll happened');
    const sm72 = log.events.find((e) => e.step === 'slot.map' && e.phase === 'ok');
    eq(sm72 !== undefined && /assumed/.test(sm72.detail ?? ''), true,
      '72(a) slot map: rc 8 → no map, ASSUMED image id noted');
    const note72 = log.events.find((e) => e.step === 'identify' && e.phase === 'note' && e.side === 'left');
    eq(note72 !== undefined && note72.sha256 === hex32(pre072), true,
      '72(a) identify note carries the slot-0 hash as arm token');
    eq(log.events.some((e) => e.step === 'gate.check' && e.phase === 'ok' && e.side === 'right'), true,
      '72(a) gate passed on live values for the right half too');
  };

  // ---- (b) foreign running hash → gate refusal, ZERO upload writes ----------
  const caseB72 = async (): Promise<void> => {
    const c = mkCase72({ foreign: true, boots: { left: ['smp'] } });
    const log = await begin72('72(b)', c, { targets: leftOnly72, ...kbOpts72 });
    if (log === null) return;
    eq(last72(log).step === 'run.end' && last72(log).ok === false, true,
      '72(b) run fails on the foreign running hash');
    const gf = log.events.find((e) => e.step === 'gate.check' && e.phase === 'fail');
    eq(gf !== undefined && /consent required/.test(gf.detail ?? ''), true,
      '72(b) gate refusal: unknown current firmware needs consent');
    const anyWrite72b = c.bootL.linesWritten.some((l) => {
      const f = parseSmpChunks(l).frames[0];
      return !!f && f.op === SMP.OP_WRITE && f.group === SMP.GROUP_IMAGE;
    });
    eq(anyWrite72b, false,
      '72(b) ZERO image-family writes on the bootloader port — no upload, no set-pending, nothing (the T8 rescue tail may only os-reset: OS family)');
    eq(log.events.some((e) => e.step === 'upload'), false, '72(b) upload never started');
  };

  // ---- (c) upload rc≠0 abort: run fails, T8 rescue resets the parked half --
  const caseC72 = async (): Promise<void> => {
    const c = mkCase72({ failRc: 5, boots: { left: ['smp'] } });
    const log = await begin72('72(c)', c, { targets: leftOnly72, ...kbOpts72 });
    if (log === null) return;
    eq(last72(log).step === 'run.end' && last72(log).ok === false, true, '72(c) run fails on rc≠0');
    const uf = log.events.find((e) => e.step === 'upload' && e.phase === 'fail');
    eq(uf !== undefined && /rc 5/.test(uf.detail ?? ''), true, '72(c) upload rc≠0 surfaces as the upload failure');
    eq(c.bootL.uploadCount(), 1, '72(c) exactly one chunk write attempted (abort on the first rc≠0)');
    eq(c.bootL.osResetCount() >= 1, true,
      '72(c) T8 rescue: the parked half is os-reset (initial + reResetMs-cadence re-resets through the window)');
    const rf72c = log.events.find((e) => e.step === 'rescue' && e.phase === 'fail');
    eq(rf72c !== undefined && /power cycle/.test(rf72c.detail ?? ''), true,
      '72(c) rescue outcome: half never came back within the window → power-cycle note, run still fails on the upload');
    eq(log.events.some((e) => e.step === 'swap.verify'), false, '72(c) swap.verify never started');
    eq(log.events.some((e) => e.step === 'gate.check' && e.phase === 'ok'), true,
      '72(c) the gate had passed before the abort');
  };

  // ---- (d) probe discipline: silent log port first, answering port second ---
  const caseD72 = async (): Promise<void> => {
    const c = mkCase72({ boots: { left: ['log', 'smp'] }, swapAfterMs: 40, returnToApp: true });
    const log = await begin72('72(d)', c, { targets: leftOnly72, ...kbOpts72 });
    if (log === null) return;
    eq(last72(log).step === 'run.end' && last72(log).ok === true, true,
      '72(d) probe discipline lands on the answering port — run completes');
    eq(c.bootL.uploadCount(), 2, '72(d) upload went to the ANSWERING port');
    const logUpload72 = c.logL.linesWritten.some((l) => {
      const f = parseSmpChunks(l).frames[0];
      return !!f && f.op === SMP.OP_WRITE && f.group === SMP.GROUP_IMAGE && f.cmdId === SMP.ID_IMAGE_UPLOAD;
    });
    eq(logUpload72, false, '72(d) the silent port saw probes only — no upload writes (it is re-probed each swap re-poll)');
    eq(c.logL.linesWritten.length >= 1, true,
      '72(d) the silent port was probed (its silence is what the console tap records)');
    const con = log.events.find((e) => e.step === 'bootloader.console');
    eq(con !== undefined && /log port/.test(con.detail ?? ''), true,
      '72(d) silent port console text surfaces as a bootloader.console note');
  };

  // ---- (e) swap-already-happened: slot-0 == target sha at the post-upload
  //      readback → swap.verify accepts without any reset loop ----------------
  const caseE72 = async (): Promise<void> => {
    const c = mkCase72({ alreadySwapped: true, boots: { left: ['smp'] }, returnToApp: true });
    const log = await begin72('72(e)', c, { targets: leftOnly72, ...kbOpts72 });
    if (log === null) return;
    eq(last72(log).step === 'run.end' && last72(log).ok === true, true,
      '72(e) run completes — swap already happened during the upload readback');
    const sv = log.events.find((e) => e.step === 'swap.verify' && e.phase === 'ok');
    eq(sv !== undefined && /slot-0/.test(sv.detail ?? ''), true,
      '72(e) swap.verify ok: slot-0 == target sha observed on a re-poll');
    eq(c.bootL.osResetCount(), 1, '72(e) no reset LOOP — the single mcuboot.exit reset after the verify');
    eq(c.bootL.reads() >= 4, true, '72(e) the swap re-poll re-read image state');
  };

  // ---- (f) no port appears, injected grant mechanism rejects → clear copy ---
  const caseF72 = async (): Promise<void> => {
    const c = mkCase72({ boots: { left: [] }, grant: 'reject' });
    const log = await begin72('72(f)', c, { targets: leftOnly72, ...kbOpts72 });
    if (log === null) return;
    const act = log.events.find((e) => e.phase === 'action');
    eq(act !== undefined && act.step === 'mcuboot.enter' && /grant/.test(act.detail ?? ''), true,
      '72(f) action event asks the user to grant the bootloader port');
    eq(c.grantCalls(), 1, '72(f) the injected grant mechanism was awaited');
    const le72f = last72(log);
    eq(le72f.step === 'run.end' && le72f.ok === false && /grant/.test(le72f.summary ?? ''), true,
      '72(f) grant rejection fails the run with clear copy');
  };

  // ---- (g) no port appears, NO grant mechanism → bounded fail, no action ----
  const caseG72 = async (): Promise<void> => {
    const c = mkCase72({ boots: { left: [] }, enterMs: 90 });
    const t072g = Date.now();
    const log = await begin72('72(g)', c, { targets: leftOnly72, ...kbOpts72 });
    if (log === null) return;
    const dt72g = Date.now() - t072g;
    const le72g = last72(log);
    eq(le72g.step === 'run.end' && le72g.ok === false && /replug/.test(le72g.summary ?? ''), true,
      '72(g) no grant mechanism + no port → clear replug copy');
    eq(log.events.some((e) => e.phase === 'action'), false, '72(g) no action event without a grant mechanism');
    eq(dt72g < 10000, true, '72(g) the wait is bounded by the injected enterMs (never raw constants)');
  };

  // ---- (h) module docked → refuse before anything moves ---------------------
  const caseH72 = async (): Promise<void> => {
    const c = mkCase72({ docked: 'left', boots: { left: ['smp'] } });
    const log = await begin72('72(h)', c, { targets: leftOnly72, ...kbOpts72 });
    if (log === null) return;
    const le72h = last72(log);
    eq(le72h.step === 'run.end' && le72h.ok === false && /undock/.test(le72h.summary ?? ''), true,
      '72(h) docked module refuses the keyboard flash');
    eq(c.leftDev.reqs.some((f) => f.type === 0xee), false, '72(h) no bootloader entry on the dock refusal');
    eq(log.events.some((e) => e.step === 'mcuboot.enter' && e.phase === 'start'), false,
      '72(h) the refusal lands during preflight — no per-side steps started');
  };

  await after71; // §71 owns the one-run lock while it runs — never interleave
  await caseA72();
  await caseB72();
  await caseC72();
  await caseD72();
  await caseE72();
  await caseF72();
  await caseG72();
  await caseH72();
  signal72done?.();
})();

// §73 post-flash return to app (startKeyboardRun steps 9-11 + handover):
// mcuboot.exit os-resets ONLY the SMP-answering bootloader port (the silent
// twin sees zero SMP writes); the re-enumerated app port gets a
// procedure-owned NayaSession opened with the useSessions.connectPort
// discipline (connect → fa/1001 identify → dst + left handshake) and the
// flashed version is confirmed against fe/1002 — mismatch REFUSES (the
// write is hash-verified; the half is simply re-flashable), a
// non-versioned target is advisory-only, and the reset is re-sent on the
// reResetMs cadence while the app port is still missing. halves.settle
// waits for BOTH known halves to answer identity again: owned/stale
// sessions re-probed first, then world polling — a late answer inside the
// window passes, a never-answering half logs fail-and-continue into the
// verdict. Run end hands over: owned sessions closed, dead pre-flash
// sessions closed, flag cleared, rescan() called — while a run owns the
// ports the shared sweep is frozen (getPorts never touched), and
// rescanSweep itself connects app-PID ports only (a bootloader PID is
// never auto-connected).
let signal73done: (() => void) | null = null;
// T8's §74 chains on this signal the way §73 chains on after72.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const after73: Promise<void> = new Promise<void>((r) => { signal73done = r; });
void (async () => {
  await after72; // §72 owns the one-run lock while its cases run — never interleave
  const portInfo73 = (pid: number): { usbVendorId: number; usbProductId: number } =>
    ({ usbVendorId: NAYA_VID, usbProductId: pid });
  const stubPort73 = (pid: number): PortWithInfo =>
    ({ getInfo: () => portInfo73(pid) }) as unknown as PortWithInfo;
  const mkWorld73 = (initial: PortWithInfo[]): { world: SerialWorld; list: PortWithInfo[] } => {
    const list = [...initial];
    return {
      list,
      world: {
        getPorts: async () => [...list],
        requestPort: async () => { throw new Error('no user gesture in the smoke world'); },
      },
    };
  };
  const drop73 = (list: PortWithInfo[], p: PortWithInfo): void => {
    const i = list.indexOf(p);
    if (i >= 0) list.splice(i, 1);
  };
  const lastEv73 = (log: FirmwareRunLog): RunEvent => log.events[log.events.length - 1]!;
  // zero OP_WRITE frames of any kind written to a port's recorded lines
  const hasSmpWrite73 = (lines: string[]): boolean =>
    lines.some((l) => {
      const f = parseSmpChunks(l).frames[0];
      return !!f && f.op === SMP.OP_WRITE;
    });

  // fe/1002 payload shaped like the device's version bytes for a declared
  // label ('3.41.0' → four components; fwVersionText decodes v3.41.0.0).
  const fwBytes73 = (label: string): Uint8Array => {
    const parts = label.split('.').map((p) => Number.parseInt(p, 10));
    while (parts.length < 4) parts.push(0);
    return Uint8Array.from([0, ...parts.slice(0, 4)]);
  };

  // Bootloader line-port — the §72 mkBoot72 shape plus the os/5 hook: when
  // os reset lands, onReset fires so the harness can re-enumerate the world
  // (boot port REPLACED by the app port — spec: same path in reverse).
  const mkBoot73 = (o: {
    pid: number;
    pre0: Uint8Array;
    sha: Uint8Array;
    swapAfterMs?: number | null;
    onReset?: () => void;
  }) => {
    const linesWritten: string[] = [];
    let stage: 'fresh' | 'uploaded' | 'swapped' = 'fresh';
    let total = -1;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let pending = '';
    let streams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } | null = null;
    const build = (): void => {
      pending = '';
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const readable = new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
      });
      const push = (t: string, delayMs = 5): void => {
        setTimeout(() => { controller?.enqueue(enc.encode(t)); }, delayMs);
      };
      const writable = new WritableStream<Uint8Array>({
        write(b) {
          pending += dec.decode(b);
          for (;;) {
            const i = pending.indexOf('\n');
            if (i < 0) break;
            const line = pending.slice(0, i + 1);
            pending = pending.slice(i + 1);
            linesWritten.push(line);
            const rq = parseSmpChunks(line).frames[0];
            if (!rq) continue;
            if (rq.op === SMP.OP_READ && rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_STATE) {
              const slots = stage === 'swapped'
                ? [
                    { slot: 0, hash: o.sha, flags: ['active', 'confirmed'] },
                    { slot: 1, hash: o.pre0, flags: [] },
                  ]
                : stage === 'uploaded'
                  ? [
                      { slot: 0, hash: o.pre0, flags: ['active', 'confirmed'] },
                      { slot: 1, hash: o.sha, flags: ['pending'] },
                    ]
                  : [
                      { slot: 0, hash: o.pre0, flags: ['active', 'confirmed'] },
                      { slot: 1, hash: o.pre0, flags: [] },
                    ];
              push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ rc: 0, images: slots })));
              continue;
            }
            if (rq.op === SMP.OP_READ && rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_SLOT_INFO) {
              push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ rc: 8 })));
              continue;
            }
            if (rq.op === SMP.OP_WRITE && rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_UPLOAD) {
              const v = cborDecode(rq.payload).value as { off: number; len?: number; data: Uint8Array };
              if (v.off === 0) total = typeof v.len === 'number' ? v.len : -1;
              const end = v.off + v.data.length;
              if (total >= 0 && end >= total) {
                stage = 'uploaded';
                const delay = o.swapAfterMs;
                if (typeof delay === 'number') setTimeout(() => { stage = 'swapped'; }, delay);
              }
              push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ off: end, rc: 0 })));
              continue;
            }
            if (rq.op === SMP.OP_WRITE && rq.group === SMP.GROUP_OS && rq.cmdId === SMP.ID_OS_RESET) {
              push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ rc: 0 })));
              o.onReset?.();
              continue;
            }
          }
        },
      });
      streams = { readable, writable };
    };
    build();
    const port = {
      get readable() { return streams?.readable ?? null; },
      get writable() { return streams?.writable ?? null; },
      async open() { build(); },
      async setSignals() {},
      async close() { streams = null; },
      getInfo: () => portInfo73(o.pid),
    };
    const isWrite = (l: string, group: number, cmdId: number): boolean => {
      const f = parseSmpChunks(l).frames[0];
      return !!f && f.op === SMP.OP_WRITE && f.group === group && f.cmdId === cmdId;
    };
    return {
      port: port as unknown as PortWithInfo,
      linesWritten,
      osResetCount: (): number => linesWritten.filter((l) => isWrite(l, SMP.GROUP_OS, SMP.ID_OS_RESET)).length,
    };
  };

  // The OTHER CDC interface: a log port that swallows SMP frames (never
  // answers) and babbles console text — the silent twin of §73(a).
  const mkLog73 = (pid: number, banner: string) => {
    const linesWritten: string[] = [];
    let streams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } | null = null;
    const build = (): void => {
      const readable = new ReadableStream<Uint8Array>({
        start(c) { setTimeout(() => { c.enqueue(new TextEncoder().encode(banner)); }, 5); },
      });
      const dec = new TextDecoder();
      const writable = new WritableStream<Uint8Array>({
        write(b) { linesWritten.push(dec.decode(b)); },
      });
      streams = { readable, writable };
    };
    build();
    const port = {
      get readable() { return streams?.readable ?? null; },
      get writable() { return streams?.writable ?? null; },
      async open() { build(); },
      async setSignals() {},
      async close() { streams = null; },
      getInfo: () => portInfo73(pid),
    };
    return { port: port as unknown as PortWithInfo, linesWritten };
  };

  // Post-flash app-mode port: real stream shapes (NayaSession.connect opens
  // it — 2.5 s settle + wake, the connectPort discipline), fa/1001 identify
  // payload of idLen bytes (≥27 = left), fe/1002 = fw. dieAfterWrites:
  // answer the Nth write, then go dark and vanish (onDie = the USB drop the
  // harness reacts to) — the central drops off USB during re-link.
  const mkApp73 = (o: {
    pid: number;
    fw: Uint8Array;
    idLen: number;
    dieAfterWrites?: number | null;
    onDie?: () => void;
  }) => {
    let closes = 0;
    let writes = 0;
    let dead = false;
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    const reader = {
      async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
        for (;;) {
          const c = queue.shift();
          if (c) return { value: c, done: false };
          await new Promise<void>((res) => { waiter = res; });
        }
      },
      cancel() { const w = waiter; waiter = null; w?.(); },
      releaseLock() {},
    };
    const writer = {
      async write(b: Uint8Array) {
        if (dead) return; // the half went dark — writes vanish
        const rq = verifyFrame(Uint8Array.from(b));
        writes += 1;
        const resp = buildFrame(0x50, rq.type, rq.c0, rq.c1, (() => {
          const k = `${rq.type.toString(16)}/${rq.c1.toString(16)}`;
          if (k === 'fa/1') return Uint8Array.from({ length: o.idLen }, (_, i) => i);
          if (k === 'fe/2') return o.fw;
          // T8: the tail (brightness/lighting restores, verify.compare)
          // re-reads the preflight verb set through this owned session —
          // delegate to the same shapes the pre-flight capture saw.
          return replyApp73(rq);
        })());
        verifyFrame(resp);
        setTimeout(() => { queue.push(resp); const w = waiter; waiter = null; w?.(); }, 5);
        if (o.dieAfterWrites != null && writes >= o.dieAfterWrites) {
          dead = true;
          o.onDie?.();
        }
      },
      releaseLock() {},
    };
    const port = {
      readable: { locked: false, getReader: () => reader },
      writable: { getWriter: () => writer },
      async open() {}, async setSignals() {}, async close() { closes += 1; },
      getInfo: () => portInfo73(o.pid),
    };
    return {
      port: port as unknown as PortWithInfo,
      closes: (): number => closes,
      writes: (): number => writes,
    };
  };

  // Pre-flash app-session fake — the §72 scripted72 shape, but the half
  // goes DARK once the ee/10ae enter frame lands (it rebooted mid-write):
  // the ack still delivers, every later write vanishes, so a stale
  // pre-flash session can never masquerade as alive.
  const scripted73 = (reply: (rq: Frame) => Uint8Array, onEnter?: () => void) => {
    const reqs: Frame[] = [];
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    let dead = false;
    const reader = {
      async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
        for (;;) {
          const c = queue.shift();
          if (c) return { value: c, done: false };
          await new Promise<void>((res) => { waiter = res; });
        }
      },
      cancel() { const w = waiter; waiter = null; w?.(); },
      releaseLock() {},
    };
    const writer = {
      async write(b: Uint8Array) {
        if (dead) return;
        const rq = verifyFrame(Uint8Array.from(b));
        reqs.push(rq);
        if (rq.type === 0xee && rq.c0 === 0x10 && rq.c1 === 0xae) {
          const ack = buildFrame(0x50, rq.type, rq.c0, rq.c1, Uint8Array.from([0x00]));
          verifyFrame(ack);
          setTimeout(() => { queue.push(ack); const w = waiter; waiter = null; w?.(); }, 5);
          dead = true; // after the ack the half is rebooting — dark
          setTimeout(() => onEnter?.(), 30);
          return;
        }
        const resp = buildFrame(0x50, rq.type, rq.c0, rq.c1, reply(rq));
        verifyFrame(resp);
        setTimeout(() => { queue.push(resp); const w = waiter; waiter = null; w?.(); }, 5);
      },
      releaseLock() {},
    };
    const port = {
      readable: { locked: false, getReader: () => reader },
      writable: { getWriter: () => writer },
      async open() {}, async setSignals() {}, async close() {},
    };
    return {
      reqs,
      session() {
        const r = port.readable.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
        const w = port.writable.getWriter() as unknown as WritableStreamDefaultWriter<Uint8Array>;
        return new NayaSession(
          port as unknown as SerialPort, 0x50,
          new FrameReader(r), w, r,
          async (b) => { await w.write(b); }, null,
        );
      },
    };
  };
  const replyApp73 = (rq: Frame): Uint8Array => {
    const k = `${rq.type.toString(16)}/${rq.c1.toString(16)}`;
    if (k === 'fe/2') return Uint8Array.from([0, 1, 2, 3, 4]);
    if (k === 'be/8') return Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    if (k === 'be/2') return Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f]);
    if (k === 'be/5') return Uint8Array.from([1, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f]);
    if (k === 'de/1') return Uint8Array.from([0x00, 0x00, 0x10, 0x00]); // module absent
    if (k === '30/3') {
      const part = rq.payload[0] ?? 0;
      const layer = rq.payload[1] ?? 0;
      if (layer === 1) return Uint8Array.from([0x16]);
      return part === 0
        ? Uint8Array.from([0x01, layer, 0x10, 0x20, 0x30, 0x40])
        : Uint8Array.from([0x00, layer, 0x50, 0x60, 0x70, 0x80]);
    }
    if (k === '30/d') {
      if ((rq.payload[1] ?? 0) === 1) return Uint8Array.from([0x16]);
      return Uint8Array.from([0x00, rq.payload[1] ?? 0, 0xb4, 0x00, 0x64, 0x11]);
    }
    return Uint8Array.from([0x00]);
  };

  // ---- catalog picks (§72 pattern): newest dual-side gen-A label + older
  // running entry, plus the non-versioned label for the advisory case.
  const cat73 = await loadFirmwareCatalog();
  let label73: string | undefined;
  let entryL73: FwEntry | null = null;
  let entryR73: FwEntry | null = null;
  for (const v of keyboardVersions(cat73)) {
    const l = findKeyboardImage(cat73, 'left', 'A', v.label);
    const r = findKeyboardImage(cat73, 'right', 'A', v.label);
    if (l === null || r === null) continue;
    if (typeof l.plaintextSha256 !== 'string' || typeof r.plaintextSha256 !== 'string') continue;
    label73 = v.label;
    entryL73 = l;
    entryR73 = r;
    break;
  }
  let runEntry73: FwEntry | null = null;
  for (const v of keyboardVersions(cat73)) {
    if (v.label === label73) continue;
    const l = findKeyboardImage(cat73, 'left', 'A', v.label);
    if (l === null || typeof l.plaintextSha256 !== 'string') continue;
    if (typeof l.releaseOrder === 'number' && entryL73 !== null &&
        typeof entryL73.releaseOrder === 'number' && l.releaseOrder < entryL73.releaseOrder) {
      runEntry73 = l;
      break;
    }
  }
  eq(label73 !== undefined && entryL73 !== null && entryR73 !== null && runEntry73 !== null, true,
    '73 fixture: dual-side gen-A label with plaintext hashes + an older running entry exist');
  const nf73 = findKeyboardImage(cat73, 'left', 'A', 'NayaFlow 1.14.3');
  eq(nf73 !== null && typeof nf73.plaintextSha256 === 'string', true,
    '73 fixture: NayaFlow 1.14.3 left/A entry carries a plaintext hash (non-versioned label)');
  const pre073 = hexToBytes(runEntry73!.plaintextSha256!)!;
  const pre0R73 = hexToBytes(entryR73!.plaintextSha256!)!;
  const shaL73 = hexToBytes(entryL73!.plaintextSha256 ?? entryL73!.blobSha256)!;
  const shaR73 = hexToBytes(entryR73!.plaintextSha256 ?? entryR73!.blobSha256)!;
  const bytes73 = (seed: number): Uint8Array => Uint8Array.from({ length: 700 }, (_, i) => (i * 13 + seed) & 0xff);
  const mkVault73 = (): Vault => {
    const v = newVault();
    v.set(entryL73!, bytes73(3));
    v.set(entryR73!, bytes73(5));
    return v;
  };

  const T73 = { pollMs: 15, enterMs: 1200, swapMs: 400, rePollMs: 10, probeMs: 150,
    resetMs: 60, confirmMs: 9000, reResetMs: 300, settleMs: 1500,
    rescueMs: 900 }; // T8: the stranded-half rescue window (failure tail)
  const leftOnly73 = [{ side: 'left' as const, label: label73! }];
  const kbOpts73 = { allowOlder: false, acceptUnknown: false, consentedUnknown: false };

  // Left-only case builder (§73(a)+(b-ok) and the mismatch refusal): silent
  // twin + answering bootloader port, both REPLACED by the app-mode port
  // when os reset lands on the answerer.
  const mkCase73A = (appFw: Uint8Array, vault?: Vault) => {
    const appLstub = stubPort73(0x064);
    const appRstub = stubPort73(0x0c8);
    const w = mkWorld73([appLstub, appRstub]);
    const appAfterL = mkApp73({ pid: 0x064, fw: appFw, idLen: 33 });
    const logL = mkLog73(0x06f, 'Naya bootloader log port — verbosity high\n');
    const bootL = mkBoot73({
      pid: 0x06f, pre0: pre073, sha: shaL73, swapAfterMs: 30,
      onReset: () => {
        drop73(w.list, bootL.port);
        drop73(w.list, logL.port);
        w.list.push(appAfterL.port);
      },
    });
    const leftDev = scripted73(replyApp73, () => {
      drop73(w.list, appLstub);
      w.list.push(bootL.port);
      w.list.push(logL.port);
    });
    const sesRef = { current: new Map<'left' | 'right', NayaSession>() };
    sesRef.current.set('left', leftDev.session());
    let rescans = 0;
    let rescanFlag: boolean | null = null;
    const deps = {
      sesRef,
      busyRef: { current: false },
      world: w.world,
      vault: vault ?? mkVault73(),
      timeouts: T73,
      rescan: async (): Promise<void> => {
        rescans += 1;
        rescanFlag = firmwareRunActive();
      },
    };
    return {
      deps, bootL, logL, appAfterL, leftDev, sesRef,
      rescans: (): number => rescans,
      rescanFlag: (): boolean | null => rescanFlag,
    };
  };

  // ---- (a) reset discipline + (b-ok) version.confirm on the new port ------
  {
    const c = mkCase73A(fwBytes73(label73!));
    const log = await startKeyboardRun(c.deps, { targets: leftOnly73, ...kbOpts73 });
    if (log === null) {
      eq(false, true, '73(a): run began (null = refused — the one-run lock was held)');
    } else {
      const le = lastEv73(log);
      eq(le.step === 'run.end' && le.ok === true, true, '73(a) run.end ok');
      const exitOk = log.events.findIndex((e) => e.step === 'mcuboot.exit' && e.phase === 'ok' && e.side === 'left');
      const vcOk = log.events.findIndex((e) => e.step === 'version.confirm' && e.phase === 'ok' && e.side === 'left');
      const settleOk = log.events.findIndex((e) => e.step === 'halves.settle' && e.phase === 'ok');
      eq(exitOk >= 0 && exitOk < vcOk && vcOk < settleOk && settleOk < log.events.length - 1, true,
        '73(a) order: mcuboot.exit → version.confirm → halves.settle → run.end');
      eq(c.bootL.osResetCount(), 1, '73(a) exactly one os reset, on the ANSWERING port');
      eq(hasSmpWrite73(c.logL.linesWritten), false,
        '73(a) the silent twin saw ZERO SMP writes (probes are reads; the reset went to the answerer only)');
      const vn = log.events.find((e) => e.step === 'version.confirm' && e.phase === 'note' && e.side === 'left');
      eq(vn !== undefined && (vn.detail ?? '').includes(label73!), true,
        '73(b) version.confirm ok: the re-enumerated half reports the flashed version');
      eq(c.appAfterL.writes() >= 3, true,
        '73(b) the app session opened on the NEW port (identify + handshake + fw read through it)');
      eq(c.appAfterL.closes() >= 1, true,
        '73(a) the procedure-owned session was closed at run end');
      eq(c.rescans() === 1 && c.rescanFlag() === false, true,
        '73(a) handover: rescan() called exactly once, AFTER the freeze flag cleared');
      eq(c.sesRef.current.size === 0, true,
        '73(a) the dead pre-flash session was disconnected and the map cleared');
    }
  }

  // ---- (b) version mismatch → refusal with the hash-verified-write note ---
  {
    const c = mkCase73A(fwBytes73('3.40.0'));
    const log = await startKeyboardRun(c.deps, { targets: leftOnly73, ...kbOpts73 });
    if (log === null) {
      eq(false, true, '73(b): run began');
    } else {
      const le = lastEv73(log);
      eq(le.step === 'run.end' && le.ok === false, true, '73(b) mismatch refuses the run');
      const vf = log.events.find((e) => e.step === 'version.confirm' && e.phase === 'fail' && e.side === 'left');
      eq(vf !== undefined && /hash-verified/.test(vf.detail ?? '') && /re-flash/.test(vf.detail ?? ''), true,
        '73(b) the refusal carries the hash-verified-write / re-flashable note');
      eq((le.failures as string[]).some((f) => f.startsWith('version.confirm')), true,
        '73(b) the verdict failures list carries the version.confirm refusal');
      eq(c.appAfterL.closes() >= 1, true, '73(b) the owned session was closed before the refusal ended the run');
    }
  }

  // ---- (b2) non-versioned target → advisory note only, never a refusal ----
  {
    const appLstub = stubPort73(0x064);
    const appRstub = stubPort73(0x0c8);
    const w = mkWorld73([appLstub, appRstub]);
    const nfPlain = hexToBytes(nf73!.plaintextSha256!)!;
    const appAfterL = mkApp73({ pid: 0x064, fw: fwBytes73(label73!), idLen: 33 });
    const bootL = mkBoot73({
      pid: 0x06f, pre0: nfPlain, sha: nfPlain, swapAfterMs: 30,
      onReset: () => { drop73(w.list, bootL.port); w.list.push(appAfterL.port); },
    });
    const leftDev = scripted73(replyApp73, () => { drop73(w.list, appLstub); w.list.push(bootL.port); });
    const sesRef = { current: new Map<'left' | 'right', NayaSession>() };
    sesRef.current.set('left', leftDev.session());
    const vaultB2 = newVault();
    vaultB2.set(nf73!, bytes73(7));
    const log = await startKeyboardRun({
      sesRef, busyRef: { current: false }, world: w.world, vault: vaultB2, timeouts: T73,
    }, { targets: [{ side: 'left', label: 'NayaFlow 1.14.3' }], ...kbOpts73 });
    if (log === null) {
      eq(false, true, '73(b2): run began');
    } else {
      const le = lastEv73(log);
      eq(le.step === 'run.end' && le.ok === true, true,
        '73(b2) non-versioned target → advisory only, run still ok');
      const vn = log.events.find((e) => e.step === 'version.confirm' && e.phase === 'note');
      eq(vn !== undefined && /cannot confirm on-device/.test(vn.detail ?? ''), true,
        '73(b2) the advisory note explains why the version cannot be confirmed on-device');
      eq(log.events.some((e) => e.step === 'version.confirm' && e.phase === 'fail'), false,
        '73(b2) no version.confirm refusal for a non-versioned target');
    }
  }

  // ---- (b3) app port late → the reset is re-sent on the reResetMs cadence --
  {
    const appLstub = stubPort73(0x064);
    const appRstub = stubPort73(0x0c8);
    const w = mkWorld73([appLstub, appRstub]);
    const appAfterL = mkApp73({ pid: 0x064, fw: fwBytes73(label73!), idLen: 33 });
    let resets = 0;
    const bootL = mkBoot73({
      pid: 0x06f, pre0: pre073, sha: shaL73, swapAfterMs: 30,
      onReset: () => {
        resets += 1;
        if (resets >= 2) { // only the SECOND reset re-enumerates the app port
          drop73(w.list, bootL.port);
          w.list.push(appAfterL.port);
        }
      },
    });
    const leftDev = scripted73(replyApp73, () => { drop73(w.list, appLstub); w.list.push(bootL.port); });
    const sesRef = { current: new Map<'left' | 'right', NayaSession>() };
    sesRef.current.set('left', leftDev.session());
    const log = await startKeyboardRun({
      sesRef, busyRef: { current: false }, world: w.world, vault: mkVault73(), timeouts: T73,
    }, { targets: leftOnly73, ...kbOpts73 });
    if (log === null) {
      eq(false, true, '73(b3): run began');
    } else {
      eq(lastEv73(log).step === 'run.end' && lastEv73(log).ok === true, true,
        '73(b3) the re-reset cadence brings the half back — run ok');
      eq(resets, 2, '73(b3) exactly two resets were sent (re-reset every reResetMs while the app port was missing)');
      const vcOk = log.events.find((e) => e.step === 'version.confirm' && e.phase === 'ok' && e.side === 'left');
      eq(vcOk !== undefined, true, '73(b3) version.confirm ok after the re-reset');
    }
  }

  // ---- (c) halves.settle: late answer passes; never → fail-and-continue ---
  const mkCase73C = (never: boolean) => {
    const appLstub = stubPort73(0x064);
    const appRstub = stubPort73(0x0c8);
    const w = mkWorld73([appLstub, appRstub]);
    const fwAfter = fwBytes73(label73!);
    const appAfterL = mkApp73({ pid: 0x064, fw: fwAfter, idLen: 33 });
    const appAfterR2 = mkApp73({ pid: 0x0c8, fw: fwAfter, idLen: 21 });
    const appAfterR1 = mkApp73({
      pid: 0x0c8, fw: fwAfter, idLen: 21, dieAfterWrites: 3,
      onDie: () => {
        drop73(w.list, appAfterR1.port); // the central drops off USB during re-link
        if (!never) setTimeout(() => { w.list.push(appAfterR2.port); }, 400);
      },
    });
    const bootR = mkBoot73({
      pid: 0x0d3, pre0: pre0R73, sha: shaR73, swapAfterMs: 30,
      onReset: () => { drop73(w.list, bootR.port); w.list.push(appAfterR1.port); },
    });
    const logL = mkLog73(0x06f, 'log twin\n');
    const bootL = mkBoot73({
      pid: 0x06f, pre0: pre073, sha: shaL73, swapAfterMs: 30,
      onReset: () => { drop73(w.list, bootL.port); drop73(w.list, logL.port); w.list.push(appAfterL.port); },
    });
    const leftDev = scripted73(replyApp73, () => { drop73(w.list, appLstub); w.list.push(bootL.port); w.list.push(logL.port); });
    const rightDev = scripted73(replyApp73, () => { drop73(w.list, appRstub); w.list.push(bootR.port); });
    const sesRef = { current: new Map<'left' | 'right', NayaSession>() };
    sesRef.current.set('left', leftDev.session());
    sesRef.current.set('right', rightDev.session());
    const deps = {
      sesRef,
      busyRef: { current: false },
      world: w.world,
      vault: mkVault73(),
      timeouts: { ...T73, settleMs: never ? 1500 : 12000 },
    };
    return { deps, sesRef, appAfterR1, appAfterR2 };
  };
  {
    const c = mkCase73C(false);
    const log = await startKeyboardRun(c.deps, {
      targets: [{ side: 'left', label: label73! }, { side: 'right', label: label73! }], ...kbOpts73,
    });
    if (log === null) {
      eq(false, true, '73(c-late): run began');
    } else {
      const le = lastEv73(log);
      eq(le.step === 'run.end' && le.ok === true, true, '73(c-late) second half answers late (in window) → run ok');
      eq(log.events.some((e) => e.step === 'halves.settle' && e.phase === 'ok'), true,
        '73(c-late) halves.settle ok');
      eq(log.events.filter((e) => e.step === 'version.confirm' && e.phase === 'ok').length, 2,
        '73(c-late) both halves version-confirmed before the settle wait');
      eq(c.appAfterR2.closes() >= 1, true,
        '73(c-late) the right half was RE-connected on a fresh app port (world polling picked it up)');
      eq(c.sesRef.current.size === 0, true, '73(c-late) handover cleared the stale session map');
    }
  }
  {
    const c = mkCase73C(true);
    const log = await startKeyboardRun(c.deps, {
      targets: [{ side: 'left', label: label73! }, { side: 'right', label: label73! }], ...kbOpts73,
    });
    if (log === null) {
      eq(false, true, '73(c-never): run began');
    } else {
      const le = lastEv73(log);
      eq(le.step === 'run.end', true, '73(c-never) the run continues to run.end after the settle timeout');
      eq(le.ok === false, true, '73(c-never) the settle timeout fails the verdict');
      const sf = log.events.find((e) => e.step === 'halves.settle' && e.phase === 'fail' && e.side === 'right');
      eq(sf !== undefined, true, '73(c-never) a per-side fail-and-continue note lands for the dark half');
      eq((le.failures as string[]).some((f) => f.startsWith('halves.settle')), true,
        '73(c-never) the verdict failures list carries the settle timeout');
      eq(log.events.filter((e) => e.step === 'version.confirm' && e.phase === 'ok').length, 2,
        '73(c-never) the settle timeout came AFTER both confirms — the run was not aborted early');
    }
  }

  // ---- (d) rescan sweep: freeze while a run owns the ports; app PIDs only --
  {
    const mapD = new Map<'left' | 'right', NayaSession>();
    const beginD = beginFirmwareRun({ sesRef: { current: mapD }, busyRef: { current: false } }, 'keyboard');
    eq(beginD !== null, true, '73(d) freeze: run begun');
    let gpCalls = 0;
    await rescanSweep({
      getPorts: async () => { gpCalls += 1; return []; },
      connect: async () => {},
      claimed: () => false,
    });
    eq(gpCalls, 0, '73(d) freeze: firmwareRunActive() → the sweep never even lists ports');
    endFirmwareRun(true, 'done');
    const bootPD = { getInfo: () => portInfo73(0x06f) };
    const thirdPD = { getInfo: () => portInfo73(0x07a) };
    const appLD = { getInfo: () => portInfo73(0x064) };
    const appRD = { getInfo: () => portInfo73(0x0c8) };
    const foreignPD = { getInfo: () => ({ usbVendorId: 0x1234, usbProductId: 0x064 }) };
    const noInfoPD = {};
    const connectsD: string[] = [];
    const nD = await rescanSweep({
      getPorts: async () => [bootPD, thirdPD, appLD, appRD, foreignPD, noInfoPD],
      connect: async (p) => { connectsD.push(String(p.getInfo?.().usbProductId)); },
      claimed: (s) => s === 'left', // left already claimed — unclaimed halves only
    });
    eq(nD === 1 && JSON.stringify(connectsD) === JSON.stringify([String(0x0c8)]), true,
      '73(d) sweep: connects the unclaimed app-PID port; SKIPS mcuboot/third PIDs, foreign VID, no-info, claimed sides');
  }
  signal73done?.();
})();

// §74 flash tail (startKeyboardRun steps 12-15 + the failure path): the
// restores are cosmetic and never fatal — brightness.restore writes LED max
// brightness 100 (never 0) per flashed side through the owned session
// (ed/1013 settings write), lighting.restore reads the LEFT half's layer
// list (30/1001 handshake payload) and echoes it straight back (30/1002 —
// one frame to the left clears runtime effects on both halves); a throwing
// restore lands as a note and the run still ends ok. verify.compare
// re-captures the world on the settled sessions and compares against the
// preflight artifact — strict failures: BLE address, pair address, bond
// table, primary (bank 0) keymap, where an absent position equals a `07 00`
// NONE record (the device compacts fillers away); LED map and bank-1
// differences are advisories only (a version change across the flash is the
// expected reason for them). The failure path rescues any entered half
// still parked in its bootloader: probe for the answering port, os reset,
// await the app PID within rescueMs with re-resets on the reResetMs cadence
// — three logged outcomes: back running X / still parked after the window →
// power-cycle note / left the bootloader but not on USB → unplug-replug
// note. run.end carries failures[] + advisories[] either way.
let signal74done: (() => void) | null = null;
// T9/T10's §75+ chain on this signal the way §74 chains on after73.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const after74: Promise<void> = new Promise<void>((r) => { signal74done = r; });
void (async () => {
  await after73; // §73 owns the one-run lock while its cases run — never interleave
  const portInfo74 = (pid: number): { usbVendorId: number; usbProductId: number } =>
    ({ usbVendorId: NAYA_VID, usbProductId: pid });
  const stubPort74 = (pid: number): PortWithInfo =>
    ({ getInfo: () => portInfo74(pid) }) as unknown as PortWithInfo;
  const mkWorld74 = (initial: PortWithInfo[]): { world: SerialWorld; list: PortWithInfo[] } => {
    const list = [...initial];
    return {
      list,
      world: {
        getPorts: async () => [...list],
        requestPort: async () => { throw new Error('no user gesture in the smoke world'); },
      },
    };
  };
  const drop74 = (list: PortWithInfo[], p: PortWithInfo): void => {
    const i = list.indexOf(p);
    if (i >= 0) list.splice(i, 1);
  };
  const lastEv74 = (log: FirmwareRunLog): RunEvent => log.events[log.events.length - 1]!;
  // The silent twin: swallows SMP frames, babbles console text (§73 mkLog73).
  const mkLogPort74 = (pid: number, banner: string) => {
    let streams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } | null = null;
    const build = (): void => {
      const readable = new ReadableStream<Uint8Array>({
        start(c) { setTimeout(() => { c.enqueue(new TextEncoder().encode(banner)); }, 5); },
      });
      const writable = new WritableStream<Uint8Array>({
        write() { /* swallowed */ },
      });
      streams = { readable, writable };
    };
    build();
    const port = {
      get readable() { return streams?.readable ?? null; },
      get writable() { return streams?.writable ?? null; },
      async open() { build(); },
      async setSignals() {},
      async close() { streams = null; },
      getInfo: () => portInfo74(pid),
    };
    return { port: port as unknown as PortWithInfo };
  };
  const fwBytes74 = (label: string): Uint8Array => {
    const parts = label.split('.').map((p) => Number.parseInt(p, 10));
    while (parts.length < 4) parts.push(0);
    return Uint8Array.from([0, ...parts.slice(0, 4)]);
  };

  // Recording app-mode port fake — the §73 mkApp73 shape plus:
  // - every request recorded as {key, params} so the smoke can observe the
  //   ed/1013 brightness value and the 30/1002 layer-list echo bytes;
  // - 30/1001 inventory + 30/1003/30/100d bank overrides (the compare
  //   fixtures feed DIFFERENT bank bytes pre vs post);
  // - throwKeys: the writer THROWS for the listed verb keys (restore
  //   failure → note, never fatal).
  const mkApp74 = (o: {
    pid: number;
    fw: Uint8Array;
    idLen: number;
    inventory?: Uint8Array; // 30/1001 handshake reply payload
    keyBank?: (layer: number, part: number) => Uint8Array; // 30/1003 parts
    ledBank?: (layer: number, part: number) => Uint8Array; // 30/100d parts
    be8?: Uint8Array;
    throwKeys?: string[];
  }) => {
    const replyDefault = replyApp74(); // canonical pre-shape for non-overridden verbs
    let closes = 0;
    let dead = false;
    const writes: { key: string; params: Uint8Array }[] = [];
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    const throwSet = new Set(o.throwKeys ?? []);
    const reader = {
      async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
        for (;;) {
          const c = queue.shift();
          if (c) return { value: c, done: false };
          await new Promise<void>((res) => { waiter = res; });
        }
      },
      cancel() { const w = waiter; waiter = null; w?.(); },
      releaseLock() {},
    };
    const writer = {
      async write(b: Uint8Array) {
        if (dead) return;
        const rq = verifyFrame(Uint8Array.from(b));
        const k = `${rq.type.toString(16)}/${rq.c1.toString(16)}`;
        writes.push({ key: k, params: rq.payload });
        if (throwSet.has(k)) throw new Error(`fake ${k} write failure`);
        const resp = buildFrame(0x50, rq.type, rq.c0, rq.c1, (() => {
          if (k === 'fa/1') return Uint8Array.from({ length: o.idLen }, (_, i) => i);
          if (k === 'fe/2') return o.fw;
          if (k === '30/1') return o.inventory ?? Uint8Array.from([0x00]);
          if (k === '30/2') return Uint8Array.from([0x00, 0x00]);
          if (k === 'ed/13') return Uint8Array.from([0x00]);
          if (k === 'be/8') return o.be8 ?? Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
          if (k === 'be/2') return Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f]);
          if (k === 'be/5') return Uint8Array.from([1, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f]);
          if (k === 'de/1') return Uint8Array.from([0x00, 0x00, 0x10, 0x00]); // module absent
          if (k === '30/3') return o.keyBank ? o.keyBank(rq.payload[1] ?? 0, rq.payload[0] ?? 0) : replyDefault(rq);
          if (k === '30/d') return o.ledBank ? o.ledBank(rq.payload[1] ?? 0, rq.payload[0] ?? 0) : replyDefault(rq);
          return Uint8Array.from([0x00]);
        })());
        verifyFrame(resp);
        setTimeout(() => { queue.push(resp); const w = waiter; waiter = null; w?.(); }, 5);
      },
      releaseLock() {},
    };
    const port = {
      readable: { locked: false, getReader: () => reader },
      writable: { getWriter: () => writer },
      async open() {}, async setSignals() {}, async close() { closes += 1; },
      getInfo: () => portInfo74(o.pid),
    };
    return {
      port: port as unknown as PortWithInfo,
      closes: (): number => closes,
      writesOf: (key: string): Uint8Array[] => writes.filter((w) => w.key === key).map((w) => w.params),
    };
  };

  // Bootloader line-port — the §73 mkBoot73 shape plus failRc (the upload
  // aborts on the first rc≠0 chunk ack, leaving the half parked).
  const mkBoot74 = (o: {
    pid: number;
    pre0: Uint8Array;
    sha: Uint8Array;
    swapAfterMs?: number | null;
    failRc?: number | null;
    onReset?: () => void;
  }) => {
    const linesWritten: string[] = [];
    let stage: 'fresh' | 'uploaded' | 'swapped' = 'fresh';
    let total = -1;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let pending = '';
    let streams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } | null = null;
    const build = (): void => {
      pending = '';
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const readable = new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
      });
      const push = (t: string, delayMs = 5): void => {
        setTimeout(() => { controller?.enqueue(enc.encode(t)); }, delayMs);
      };
      const writable = new WritableStream<Uint8Array>({
        write(b) {
          pending += dec.decode(b);
          for (;;) {
            const i = pending.indexOf('\n');
            if (i < 0) break;
            const line = pending.slice(0, i + 1);
            pending = pending.slice(i + 1);
            linesWritten.push(line);
            const rq = parseSmpChunks(line).frames[0];
            if (!rq) continue;
            if (rq.op === SMP.OP_READ && rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_STATE) {
              const slots = stage === 'swapped'
                ? [
                    { slot: 0, hash: o.sha, flags: ['active', 'confirmed'] },
                    { slot: 1, hash: o.pre0, flags: [] },
                  ]
                : stage === 'uploaded'
                  ? [
                      { slot: 0, hash: o.pre0, flags: ['active', 'confirmed'] },
                      { slot: 1, hash: o.sha, flags: ['pending'] },
                    ]
                  : [
                      { slot: 0, hash: o.pre0, flags: ['active', 'confirmed'] },
                      { slot: 1, hash: o.pre0, flags: [] },
                    ];
              push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ rc: 0, images: slots })));
              continue;
            }
            if (rq.op === SMP.OP_READ && rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_SLOT_INFO) {
              push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ rc: 8 })));
              continue;
            }
            if (rq.op === SMP.OP_WRITE && rq.group === SMP.GROUP_IMAGE && rq.cmdId === SMP.ID_IMAGE_UPLOAD) {
              const v = cborDecode(rq.payload).value as { off: number; len?: number; data: Uint8Array };
              if (o.failRc !== null && o.failRc !== undefined) {
                push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ rc: o.failRc })));
                continue;
              }
              if (v.off === 0) total = typeof v.len === 'number' ? v.len : -1;
              const end = v.off + v.data.length;
              if (total >= 0 && end >= total) {
                stage = 'uploaded';
                const delay = o.swapAfterMs;
                if (typeof delay === 'number') setTimeout(() => { stage = 'swapped'; }, delay);
              }
              push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ off: end, rc: 0 })));
              continue;
            }
            if (rq.op === SMP.OP_WRITE && rq.group === SMP.GROUP_OS && rq.cmdId === SMP.ID_OS_RESET) {
              push(encodeSmpLine(SMP.OP_READ_RSP, rq.group, rq.seq, rq.cmdId, cborEncode({ rc: 0 })));
              o.onReset?.();
              continue;
            }
          }
        },
      });
      streams = { readable, writable };
    };
    build();
    const port = {
      get readable() { return streams?.readable ?? null; },
      get writable() { return streams?.writable ?? null; },
      async open() { build(); },
      async setSignals() {},
      async close() { streams = null; },
      getInfo: () => portInfo74(o.pid),
    };
    const isWrite = (l: string, group: number, cmdId: number): boolean => {
      const f = parseSmpChunks(l).frames[0];
      return !!f && f.op === SMP.OP_WRITE && f.group === group && f.cmdId === cmdId;
    };
    return {
      port: port as unknown as PortWithInfo,
      linesWritten,
      osResetCount: (): number => linesWritten.filter((l) => isWrite(l, SMP.GROUP_OS, SMP.ID_OS_RESET)).length,
    };
  };

  // Pre-flash app-session fake — the §73 scripted73 shape verbatim (the
  // half goes dark once the ee/10ae enter frame lands).
  const scripted74 = (reply: (rq: Frame) => Uint8Array, onEnter?: () => void) => {
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    let dead = false;
    const reader = {
      async read(): Promise<{ value?: Uint8Array; done?: boolean }> {
        for (;;) {
          const c = queue.shift();
          if (c) return { value: c, done: false };
          await new Promise<void>((res) => { waiter = res; });
        }
      },
      cancel() { const w = waiter; waiter = null; w?.(); },
      releaseLock() {},
    };
    const writer = {
      async write(b: Uint8Array) {
        if (dead) return;
        const rq = verifyFrame(Uint8Array.from(b));
        if (rq.type === 0xee && rq.c0 === 0x10 && rq.c1 === 0xae) {
          const ack = buildFrame(0x50, rq.type, rq.c0, rq.c1, Uint8Array.from([0x00]));
          verifyFrame(ack);
          setTimeout(() => { queue.push(ack); const w = waiter; waiter = null; w?.(); }, 5);
          dead = true;
          setTimeout(() => onEnter?.(), 30);
          return;
        }
        const resp = buildFrame(0x50, rq.type, rq.c0, rq.c1, reply(rq));
        verifyFrame(resp);
        setTimeout(() => { queue.push(resp); const w = waiter; waiter = null; w?.(); }, 5);
      },
      releaseLock() {},
    };
    const port = {
      readable: { locked: false, getReader: () => reader },
      writable: { getWriter: () => writer },
      async open() {}, async setSignals() {}, async close() {},
    };
    return {
      session() {
        const r = port.readable.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
        const w = port.writable.getWriter() as unknown as WritableStreamDefaultWriter<Uint8Array>;
        return new NayaSession(
          port as unknown as SerialPort, 0x50,
          new FrameReader(r), w, r,
          async (b) => { await w.write(b); }, null,
        );
      },
    };
  };

  // Preflight reply shape — the replyApp73 verb set, with the keymap/LED
  // banks overridable per case (the compare fixtures feed DIFFERENT bytes
  // pre vs post and expect the classified verdict). Also the DEFAULT the
  // post-side fake delegates to when a bank override is absent — the
  // identical-world compare must see identical bytes, never a [0x00]
  // no-answer (that would read as an 'unknown' bank status).
  const replyApp74 = (banks?: {
    keymap?: Record<number, Uint8Array>; // layer → assembled blob
    ledmap?: Record<number, Uint8Array>;
  }) => (rq: Frame): Uint8Array => {
    const k = `${rq.type.toString(16)}/${rq.c1.toString(16)}`;
    if (k === 'fe/2') return Uint8Array.from([0, 1, 2, 3, 4]);
    if (k === 'be/8') return Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    if (k === 'be/2') return Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f]);
    if (k === 'be/5') return Uint8Array.from([1, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f]);
    if (k === 'de/1') return Uint8Array.from([0x00, 0x00, 0x10, 0x00]); // module absent
    if (k === '30/3') {
      const layer = rq.payload[1] ?? 0;
      const part = rq.payload[0] ?? 0;
      const blob = banks?.keymap?.[layer];
      if (blob === undefined) {
        if (layer === 1) return Uint8Array.from([0x16]);
        return part === 0
          ? Uint8Array.from([0x01, layer, 0x10, 0x20, 0x30, 0x40])
          : Uint8Array.from([0x00, layer, 0x50, 0x60, 0x70, 0x80]);
      }
      const chunk = 6;
      const body = blob.subarray(part * chunk, (part + 1) * chunk);
      const more = (part + 1) * chunk < blob.length ? 0x01 : 0x00;
      return Uint8Array.from([more, layer, ...body]);
    }
    if (k === '30/d') {
      const layer = rq.payload[1] ?? 0;
      const part = rq.payload[0] ?? 0;
      const blob = banks?.ledmap?.[layer];
      if (blob === undefined) {
        if (layer === 1) return Uint8Array.from([0x16]);
        return Uint8Array.from([0x00, layer, 0xb4, 0x00, 0x64, 0x11]);
      }
      const chunk = 6;
      const body = blob.subarray(part * chunk, (part + 1) * chunk);
      const more = (part + 1) * chunk < blob.length ? 0x01 : 0x00;
      return Uint8Array.from([more, layer, ...body]);
    }
    return Uint8Array.from([0x00]);
  };

  // ---- catalog picks (§73 pattern): newest dual-side gen-A label + older
  // running entry.
  const cat74 = await loadFirmwareCatalog();
  let label74: string | undefined;
  let entryL74: FwEntry | null = null;
  let entryR74: FwEntry | null = null;
  for (const v of keyboardVersions(cat74)) {
    const l = findKeyboardImage(cat74, 'left', 'A', v.label);
    const r = findKeyboardImage(cat74, 'right', 'A', v.label);
    if (l === null || r === null) continue;
    if (typeof l.plaintextSha256 !== 'string' || typeof r.plaintextSha256 !== 'string') continue;
    label74 = v.label;
    entryL74 = l;
    entryR74 = r;
    break;
  }
  let runEntry74: FwEntry | null = null;
  for (const v of keyboardVersions(cat74)) {
    if (v.label === label74) continue;
    const l = findKeyboardImage(cat74, 'left', 'A', v.label);
    if (l === null || typeof l.plaintextSha256 !== 'string') continue;
    if (typeof l.releaseOrder === 'number' && entryL74 !== null &&
        typeof entryL74.releaseOrder === 'number' && l.releaseOrder < entryL74.releaseOrder) {
      runEntry74 = l;
      break;
    }
  }
  eq(label74 !== undefined && entryL74 !== null && entryR74 !== null && runEntry74 !== null, true,
    '74 fixture: dual-side gen-A label with plaintext hashes + an older running entry exist');
  const pre074 = hexToBytes(runEntry74!.plaintextSha256!)!;
  const shaL74 = hexToBytes(entryL74!.plaintextSha256 ?? entryL74!.blobSha256)!;
  const bytes74 = (seed: number): Uint8Array => Uint8Array.from({ length: 700 }, (_, i) => (i * 13 + seed) & 0xff);
  const mkVault74 = (): Vault => {
    const v = newVault();
    v.set(entryL74!, bytes74(3));
    v.set(entryR74!, bytes74(5));
    return v;
  };
  const T74 = { pollMs: 15, enterMs: 1200, swapMs: 400, rePollMs: 10, probeMs: 150,
    resetMs: 60, confirmMs: 9000, reResetMs: 300, settleMs: 1500, rescueMs: 600 };
  const leftOnly74 = [{ side: 'left' as const, label: label74! }];
  const kbOpts74 = { allowOlder: false, acceptUnknown: false, consentedUnknown: false };

  // Left-only case builder: silent twin + answering bootloader port, both
  // replaced by the post-flash app port when an os reset lands on the
  // answerer (reenumerate: false keeps the half parked — still-parked
  // outcome). postApp shapes the owned session's answers (compare fixtures).
  const mkCase74 = (o: {
    failUpload?: boolean;
    reenumerate?: boolean; // default true — the os reset re-enumerates the app port
    noBootPort?: boolean; // the bootloader port never appears (enter-window abort)
    preBanks?: { keymap?: Record<number, Uint8Array>; ledmap?: Record<number, Uint8Array> };
    postApp?: {
      be8?: Uint8Array;
      keyBank?: (layer: number, part: number) => Uint8Array;
      ledBank?: (layer: number, part: number) => Uint8Array;
      inventory?: Uint8Array;
      throwKeys?: string[];
    };
    enterMs?: number;
  }) => {
    const appLstub = stubPort74(0x064);
    const appRstub = stubPort74(0x0c8);
    const w = mkWorld74([appLstub, appRstub]);
    const appAfterL = mkApp74({
      pid: 0x064, fw: fwBytes74(label74!), idLen: 33,
      be8: o.postApp?.be8,
      keyBank: o.postApp?.keyBank,
      ledBank: o.postApp?.ledBank,
      inventory: o.postApp?.inventory,
      throwKeys: o.postApp?.throwKeys,
    });
    const logL = mkLogPort74(0x06f, 'Naya bootloader log port — verbosity high\n');
    const bootL = mkBoot74({
      pid: 0x06f, pre0: pre074, sha: shaL74, swapAfterMs: 30,
      failRc: o.failUpload === true ? 5 : null,
      onReset: () => {
        if (o.reenumerate === false) return;
        drop74(w.list, bootL.port);
        drop74(w.list, logL.port);
        w.list.push(appAfterL.port);
      },
    });
    const leftDev = scripted74(replyApp74(o.preBanks), () => {
      drop74(w.list, appLstub);
      if (o.noBootPort !== true) {
        w.list.push(bootL.port);
        w.list.push(logL.port);
      }
    });
    const sesRef = { current: new Map<'left' | 'right', NayaSession>() };
    sesRef.current.set('left', leftDev.session());
    let rescans = 0;
    let rescanFlag: boolean | null = null;
    const deps = {
      sesRef,
      busyRef: { current: false },
      world: w.world,
      vault: mkVault74(),
      timeouts: { ...T74, ...(o.enterMs !== undefined ? { enterMs: o.enterMs } : {}) },
      rescan: async (): Promise<void> => {
        rescans += 1;
        rescanFlag = firmwareRunActive();
      },
    };
    return {
      deps, bootL, appAfterL, sesRef,
      rescans: (): number => rescans,
      rescanFlag: (): boolean | null => rescanFlag,
    };
  };

  // ---- (a) upload throws mid-run → rescue resets the parked fake, the
  // outcome lands ("back running …"), the verdict still fails on the upload.
  {
    const c = mkCase74({ failUpload: true });
    const log = await startKeyboardRun(c.deps, { targets: leftOnly74, ...kbOpts74 });
    if (log === null) {
      eq(false, true, '74(a): run began');
    } else {
      const le = lastEv74(log);
      eq(le.step === 'run.end' && le.ok === false, true, '74(a) run.end fails on the upload throw');
      eq((le.failures as string[]).some((f) => f.startsWith('upload:')), true,
        '74(a) the verdict failures list carries the upload failure');
      eq(c.bootL.osResetCount(), 1, '74(a) the rescue os-reset the parked half exactly once');
      const rok = log.events.find((e) => e.step === 'rescue' && e.phase === 'ok' && e.side === 'left');
      eq(rok !== undefined && /back running/.test(rok.detail ?? ''), true,
        '74(a) rescue outcome logged: the half is back running (with its version)');
      eq(c.rescans() === 1 && c.rescanFlag() === false, true,
        '74(a) the failure tail still hands the ports back (rescan after the flag cleared)');
      eq(c.sesRef.current.size === 0, true, '74(a) the dead pre-flash session was dropped at handover');
    }
  }

  // ---- (a2) the half never comes back → still-parked power-cycle outcome ---
  {
    const c = mkCase74({ failUpload: true, reenumerate: false });
    const log = await startKeyboardRun(c.deps, { targets: leftOnly74, ...kbOpts74 });
    if (log === null) {
      eq(false, true, '74(a2): run began');
    } else {
      const le = lastEv74(log);
      eq(le.step === 'run.end' && le.ok === false, true, '74(a2) run.end fails');
      const rf = log.events.find((e) => e.step === 'rescue' && e.phase === 'fail' && e.side === 'left');
      eq(rf !== undefined && /power cycle/.test(rf.detail ?? ''), true,
        '74(a2) still parked after the window → the power-cycle note');
      eq((le.failures as string[]).some((f) => f.startsWith('rescue:')), true,
        '74(a2) the verdict failures list carries the unresolved rescue');
      eq(c.bootL.osResetCount() >= 1, true, '74(a2) at least the initial rescue os-reset was sent');
    }
  }

  // ---- (a3) the half left the bootloader but never re-appeared on USB →
  // unplug-replug outcome, instantly (no window wait on a vanished port) ----
  {
    const c = mkCase74({ noBootPort: true, enterMs: 90 });
    const t0 = Date.now();
    const log = await startKeyboardRun(c.deps, { targets: leftOnly74, ...kbOpts74 });
    const dt = Date.now() - t0;
    if (log === null) {
      eq(false, true, '74(a3): run began');
    } else {
      const le = lastEv74(log);
      eq(le.step === 'run.end' && le.ok === false, true, '74(a3) run.end fails');
      const rf = log.events.find((e) => e.step === 'rescue' && e.phase === 'fail' && e.side === 'left');
      eq(rf !== undefined && /unplug and replug/.test(rf.detail ?? ''), true,
        '74(a3) not on USB → the unplug-replug note');
      eq(dt < 10000, true, '74(a3) the vanish classification is instant — never a window wait');
    }
  }

  // ---- (b1) compare: post-run BLE address differs → strict failure ---------
  {
    const c = mkCase74({
      postApp: { be8: Uint8Array.from([0x99, 0x88, 0x77, 0x66, 0x55, 0x44]) },
    });
    const log = await startKeyboardRun(c.deps, { targets: leftOnly74, ...kbOpts74 });
    if (log === null) {
      eq(false, true, '74(b1): run began');
    } else {
      const le = lastEv74(log);
      eq(le.step === 'run.end' && le.ok === false, true, '74(b1) a BLE address change fails the run');
      const cf = log.events.find((e) => e.step === 'verify.compare' && e.phase === 'fail');
      eq(cf !== undefined && /BLE address/.test(cf.detail ?? ''), true,
        '74(b1) verify.compare fail: the BLE address change is named');
      eq((le.failures as string[]).some((f) => f.startsWith('verify.compare:')), true,
        '74(b1) the verdict failures list carries the compare refusal');
    }
  }

  // ---- (b2) compare: LED map differs with a version change → advisory only -
  {
    const c = mkCase74({
      postApp: {
        ledBank: (layer, part) => (layer === 1
          ? Uint8Array.from([0x16])
          : Uint8Array.from([part === 0 ? 0x00 : 0x00, layer, part === 0 ? 0xc8 : 0x00, 0x00, 0x64, 0x11])),
      },
    });
    const log = await startKeyboardRun(c.deps, { targets: leftOnly74, ...kbOpts74 });
    if (log === null) {
      eq(false, true, '74(b2): run began');
    } else {
      const le = lastEv74(log);
      eq(le.step === 'run.end' && le.ok === true, true, '74(b2) an LED map difference never fails the run');
      eq((le.advisories as string[]).some((a) => /LED map/.test(a)), true,
        '74(b2) the LED map difference lands in the verdict advisories');
      eq(log.events.some((e) => e.step === 'verify.compare' && e.phase === 'fail'), false,
        '74(b2) no verify.compare failure for an LED map difference');
      const cok = log.events.find((e) => e.step === 'verify.compare' && e.phase === 'ok');
      eq(cok !== undefined, true, '74(b2) verify.compare still closes ok (advisories only)');
    }
  }

  // ---- (b3) compare: identical world + NONE-equivalent keymap → clean ------
  // Pre bank 0 carries an explicit `07 00` NONE filler at KK 0x07 plus a
  // real record at KK 0x08; post carries only KK 0x08 — the absent position
  // equals a `07 00` NONE record (the device compacts fillers away), so the
  // banks compare EQUAL.
  const blob74pre = Uint8Array.from([
    0x07, 0x07, 0x00,                         // KK 0x07: `07 00` NONE filler
    0x08, 0x01, 0x04, 0x42, 0x00, 0x07, 0x00, // KK 0x08: T01 'B'
  ]);
  const blob74post = Uint8Array.from([
    0x08, 0x01, 0x04, 0x42, 0x00, 0x07, 0x00, // KK 0x08 only — 0x07 ABSENT
  ]);
  const keyBankParts74 = (blob: Uint8Array) => (layer: number, part: number): Uint8Array => {
    if (layer !== 0) return Uint8Array.from([0x16]);
    const chunk = 6;
    const body = blob.subarray(part * chunk, (part + 1) * chunk);
    const more = (part + 1) * chunk < blob.length ? 0x01 : 0x00;
    return Uint8Array.from([more, layer, ...body]);
  };
  {
    const c = mkCase74({
      preBanks: { keymap: { 0: blob74pre } },
      postApp: { keyBank: keyBankParts74(blob74post) },
    });
    const log = await startKeyboardRun(c.deps, { targets: leftOnly74, ...kbOpts74 });
    if (log === null) {
      eq(false, true, '74(b3): run began');
    } else {
      const le = lastEv74(log);
      eq(le.step === 'run.end' && le.ok === true, true, '74(b3) the NONE-equivalent keymap compares clean — run ok');
      const cok = log.events.find((e) => e.step === 'verify.compare' && e.phase === 'ok');
      eq(cok !== undefined && /match the preflight/.test(cok.detail ?? ''), true,
        '74(b3) verify.compare ok: identities + primary keymap match the preflight snapshot');
      eq((le.advisories as string[]).filter((a) => /verify\.compare|keymap|LED map/.test(a)).length, 0,
        '74(b3) no compare advisories on an identical world');
    }
  }

  // ---- (c) restores: the owned fake observes the ed/1013 write (value 100,
  // never 0) and the layer-list read + write-back; then the throw variant —
  // a failing restore lands as a note and the run still ends ok --------------
  {
    const inv74 = [
      { idx: 1, uuid: 'a'.repeat(32), animStored: 0 },
      { idx: 2, uuid: 'b'.repeat(32), animStored: 1 },
    ];
    const invReply = encodeLayerListAdd(inv74); // 00 00 prefix — parses as an inventory reply too
    const echoExpected = encodeRestorePayload(inv74);
    const c = mkCase74({ postApp: { inventory: invReply } });
    const log = await startKeyboardRun(c.deps, { targets: leftOnly74, ...kbOpts74 });
    if (log === null) {
      eq(false, true, '74(c): run began');
    } else {
      const le = lastEv74(log);
      eq(le.step === 'run.end' && le.ok === true, true, '74(c) the restored run ends ok');
      const brts = c.appAfterL.writesOf('ed/13');
      eq(brts.length >= 1, true, '74(c) the owned session observed the ed/1013 brightness write');
      eq(brts.length >= 1 && brts[0]!.length === 2 && brts[0]![0] === 0x00 && brts[0]![1] === 100, true,
        '74(c) brightness value is 100 (target 0) — never 0');
      eq(brts.every((p) => p[1] !== 0), true, '74(d) every brightness write carries a non-0 value');
      eq(c.appAfterL.writesOf('30/1').length >= 1, true,
        '74(c) lighting.restore read the layer list (30/1001) through the owned session');
      const echoes = c.appAfterL.writesOf('30/2');
      eq(echoes.length >= 1 && toHex(echoes[0]!) === toHex(echoExpected), true,
        '74(c) lighting.restore echoed the inventory straight back (30/1002 restore payload)');
      const lrOk = log.events.find((e) => e.step === 'lighting.restore' && e.phase === 'ok');
      eq(lrOk !== undefined && /2 entries/.test(lrOk.detail ?? ''), true,
        '74(c) lighting.restore ok names the echoed entry count');
      const brOk = log.events.find((e) => e.step === 'brightness.restore' && e.phase === 'ok' && e.side === 'left');
      eq(brOk !== undefined, true, '74(c) brightness.restore ok for the flashed side');
    }
  }
  {
    // '30/1' must stay ANSWERING here — the owned-session connect
    // (openOwnedSession) handshakes the left half with it, and a throw
    // there would leave version.confirm polling a session that can never
    // open. The lighting failure rides '30/2' (the echo write) instead.
    const c = mkCase74({ postApp: { throwKeys: ['ed/13', '30/2'] } });
    const log = await startKeyboardRun(c.deps, { targets: leftOnly74, ...kbOpts74 });
    if (log === null) {
      eq(false, true, '74(c2): run began');
    } else {
      const le = lastEv74(log);
      eq(le.step === 'run.end' && le.ok === true, true, '74(c2) a throwing restore never fails the run');
      const bn = log.events.find((e) => e.step === 'brightness.restore' && e.phase === 'note' && e.side === 'left');
      eq(bn !== undefined && /not restored/.test(bn.detail ?? ''), true,
        '74(c2) the throwing brightness restore lands as a note');
      const ln = log.events.find((e) => e.step === 'lighting.restore' && e.phase === 'note');
      eq(ln !== undefined, true, '74(c2) the throwing lighting restore lands as a note');
      eq(log.events.some((e) => e.step === 'brightness.restore' && e.phase === 'fail'), false,
        '74(c2) no fail events from the cosmetic steps');
    }
  }
  signal74done?.();
})();

void main();
