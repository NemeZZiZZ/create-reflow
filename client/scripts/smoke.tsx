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

void main();
