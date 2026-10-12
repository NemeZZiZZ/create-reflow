// SMP / MCUboot manager protocol core — no DOM, no React. Runs in the
// browser (WebSerial) and in node (rolldown-bundled smoke tests). Sibling
// of naya.ts (the Naya CDC protocol); the bootloader side of the firmware
// flash speaks this instead.
//
// Wire shape (mcumgr serial/shell transport, line framing):
//   TX: "\x06\x09" + base64([u16BE len][hdr 8B][payload][u16BE crc16]) + "\n"
//   RX: a frame STARTS with a "\x06\x09" line and CONTINUES on "\x04\x14"
//   lines (the base64 is split across lines at a fixed width). Any other
//   line on the port is device noise and ignored.
//   len   = len(hdr + payload) + 2          (the two CRC bytes)
//   hdr   = [(version<<3)|op, flags, lenHi, lenLo, groupHi, groupLo, seq,
//            cmdId] — all big-endian; header lenHi/lenLo = payload length;
//            version = 1; flags = 0 on everything we send.
//   crc16 = CRC16-XMODEM (init 0, poly 0x1021, MSB-first) over hdr+payload.
// There is no line-level reply-length prefix: a frame is complete when the
// accumulated base64 decodes to len+2 bytes — parseSmpChunks owns that
// decision, so a frame only surfaces once it can be CRC-verified whole.

import { sleep } from './naya';

export const SMP = {
  OP_READ: 0, OP_READ_RSP: 1, OP_WRITE: 2,
  GROUP_OS: 0, GROUP_IMAGE: 1,
  ID_ECHO: 0, ID_IMAGE_STATE: 0, ID_IMAGE_UPLOAD: 1, ID_OS_RESET: 5,
  ID_SLOT_INFO: 6,
} as const;

// ---------------------------------------------------------------------------
// CRC16-XMODEM — init 0, poly 0x1021, MSB-first, no reflection, no xorout.
// Check vector: "123456789" → 0x31C3.
// ---------------------------------------------------------------------------
export function crc16Xmodem(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// ---------------------------------------------------------------------------
// base64 — hand-rolled, node-safe (the DOM-free SDK cannot use btoa/atob).
// ---------------------------------------------------------------------------
const B64A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64R = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64A.charCodeAt(i)] = i;
  return t;
})();

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b0 = bytes[i];
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    out += B64A[b0 >> 2];
    out += B64A[((b0 & 3) << 4) | (b1 >> 4)];
    out += has1 ? B64A[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += has2 ? B64A[b2 & 63] : '=';
  }
  return out;
}

// Returns null on any invalid input (illegal char or data after padding) —
// callers treat that as "drop the frame", never throw.
function base64ToBytes(text: string): Uint8Array | null {
  const rev: number[] = [];
  let pad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x3d) {
      pad++; // '='
      continue;
    }
    if (pad > 0) return null; // data after padding
    if (c >= 128 || B64R[c] < 0) return null;
    rev.push(B64R[c]);
  }
  if (pad > 2) return null;
  const out = new Uint8Array(Math.floor((rev.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < rev.length; i++) {
    acc = (acc << 6) | rev[i];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CBOR — the subset mcumgr os/image commands use: uint/negint, byte/text
// strings, bool/null, arrays, maps with text keys. Encode is byte-stable:
// map keys are sorted by their UTF-8 bytes, so the same value always encodes
// to the same bytes (the upload protocol hashes/reassembles payloads, and
// tests pin exact wire bytes).
// ---------------------------------------------------------------------------
export type CborValue =
  | number | bigint | Uint8Array | string | boolean | null
  | CborValue[] | { [key: string]: CborValue };

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();

class CborWriter {
  private buf = new Uint8Array(256);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  bytes(u8: Uint8Array): void {
    this.ensure(u8.length);
    this.buf.set(u8, this.len);
    this.len += u8.length;
  }

  // Type/head + argument, minimal-length form (RFC 8949 deterministic).
  head(major: number, arg: bigint): void {
    const m = major << 5;
    if (arg < 24n) this.byte(m | Number(arg));
    else if (arg <= 0xffn) {
      this.byte(m | 24);
      this.byte(Number(arg));
    } else if (arg <= 0xffffn) {
      this.byte(m | 25);
      this.byte(Number(arg >> 8n));
      this.byte(Number(arg & 0xffn));
    } else if (arg <= 0xffffffffn) {
      this.byte(m | 26);
      for (let s = 24; s >= 0; s -= 8) this.byte(Number((arg >> BigInt(s)) & 0xffn));
    } else {
      this.byte(m | 27);
      for (let s = 56; s >= 0; s -= 8) this.byte(Number((arg >> BigInt(s)) & 0xffn));
    }
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function cborKeyCmp(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function cborEnc(w: CborWriter, v: CborValue): void {
  if (v === null) {
    w.byte(0xf6);
    return;
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`cbor: non-integer number ${v}`);
    w.head(v >= 0 ? 0 : 1, v >= 0 ? BigInt(v) : BigInt(-1 - v));
    return;
  }
  if (typeof v === 'bigint') {
    w.head(v >= 0n ? 0 : 1, v >= 0n ? v : -1n - v);
    return;
  }
  if (typeof v === 'boolean') {
    w.byte(v ? 0xf5 : 0xf4);
    return;
  }
  if (typeof v === 'string') {
    const b = TEXT_ENC.encode(v);
    w.head(3, BigInt(b.length));
    w.bytes(b);
    return;
  }
  if (v instanceof Uint8Array) {
    w.head(2, BigInt(v.length));
    w.bytes(v);
    return;
  }
  if (Array.isArray(v)) {
    w.head(4, BigInt(v.length));
    for (const x of v) cborEnc(w, x);
    return;
  }
  if (typeof v === 'object') {
    const entries = Object.keys(v).map((k) => ({ k, b: TEXT_ENC.encode(k) }));
    entries.sort((a, b) => cborKeyCmp(a.b, b.b));
    w.head(5, BigInt(entries.length));
    for (const e of entries) {
      w.head(3, BigInt(e.b.length));
      w.bytes(e.b);
      cborEnc(w, v[e.k]);
    }
    return;
  }
  throw new Error('cbor: unsupported value'); // undefined / symbol / function
}

export function cborEncode(value: CborValue): Uint8Array {
  const w = new CborWriter();
  cborEnc(w, value);
  return w.result();
}

// Decode one value at buf[pos]. next = first byte after the value, so
// callers can walk multi-value buffers or detect trailing garbage. Throws
// on truncation or unsupported types (the codec must never silently
// misparse); frame-level parsing never throws because payload CBOR is only
// decoded by callers, after CRC verification.
export function cborDecode(buf: Uint8Array, pos = 0): { value: CborValue; next: number } {
  if (pos >= buf.length) throw new Error('cbor: truncated (no head byte)');
  const ib = buf[pos];
  const major = ib >> 5;
  const ai = ib & 0x1f;
  let p = pos + 1;
  if (ai === 31) {
    // Indefinite-length arrays/maps, terminated by the 0xFF break byte.
    if (major !== 4 && major !== 5)
      throw new Error('cbor: indefinite length only valid for arrays/maps');
    const arr: CborValue[] = [];
    const obj: { [key: string]: CborValue } = {};
    for (;;) {
      if (p >= buf.length) throw new Error('cbor: truncated (no break byte)');
      if (buf[p] === 0xff) {
        p++;
        break;
      }
      const k = cborDecode(buf, p);
      p = k.next;
      if (major === 4) {
        arr.push(k.value);
        continue;
      }
      if (typeof k.value !== 'string') throw new Error('cbor: non-string map key');
      const v = cborDecode(buf, p);
      p = v.next;
      obj[k.value] = v.value;
    }
    return { value: major === 4 ? arr : obj, next: p };
  }
  const need = (n: number): void => {
    if (p + n > buf.length) throw new Error('cbor: truncated argument');
  };
  let arg = 0n;
  if (ai < 24) arg = BigInt(ai);
  else if (ai === 24) {
    need(1);
    arg = BigInt(buf[p]);
    p += 1;
  } else if (ai === 25) {
    need(2);
    arg = (BigInt(buf[p]) << 8n) | BigInt(buf[p + 1]);
    p += 2;
  } else if (ai === 26) {
    need(4);
    for (let i = 0; i < 4; i++) arg = (arg << 8n) | BigInt(buf[p + i]);
    p += 4;
  } else if (ai === 27) {
    need(8);
    for (let i = 0; i < 8; i++) arg = (arg << 8n) | BigInt(buf[p + i]);
    p += 8;
  } else throw new Error('cbor: reserved additional info ' + ai);
  const numOf = (b: bigint): number | bigint =>
    b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
  switch (major) {
    case 0: // uint
      return { value: numOf(arg), next: p };
    case 1: // negint: value = -1 - arg
      return { value: numOf(-1n - arg), next: p };
    case 2: {
      const len = Number(arg);
      if (p + len > buf.length) throw new Error('cbor: truncated bytes');
      return { value: buf.slice(p, p + len), next: p + len };
    }
    case 3: {
      const len = Number(arg);
      if (p + len > buf.length) throw new Error('cbor: truncated text');
      return { value: TEXT_DEC.decode(buf.subarray(p, p + len)), next: p + len };
    }
    case 4: {
      const count = Number(arg);
      const arr: CborValue[] = [];
      for (let i = 0; i < count; i++) {
        const r = cborDecode(buf, p);
        arr.push(r.value);
        p = r.next;
      }
      return { value: arr, next: p };
    }
    case 5: {
      const count = Number(arg);
      const obj: { [key: string]: CborValue } = {};
      for (let i = 0; i < count; i++) {
        const k = cborDecode(buf, p);
        p = k.next;
        if (typeof k.value !== 'string') throw new Error('cbor: non-string map key');
        const v = cborDecode(buf, p);
        p = v.next;
        obj[k.value] = v.value;
      }
      return { value: obj, next: p };
    }
    case 7: // simple values (floats are not in our subset)
      if (arg === 20n) return { value: false, next: p };
      if (arg === 21n) return { value: true, next: p };
      if (arg === 22n) return { value: null, next: p };
      throw new Error('cbor: unsupported simple/float value ' + arg);
    default: // 6 = tags, not in our subset
      throw new Error('cbor: unsupported major type ' + major);
  }
}

// ---------------------------------------------------------------------------
// SMP frame codec — line framing (see the wire shape at the top).
// ---------------------------------------------------------------------------
export interface SmpFrame {
  op: number;
  flags: number;
  group: number;
  seq: number;
  cmdId: number;
  payload: Uint8Array;
}

export function encodeSmpLine(
  op: number,
  group: number,
  seq: number,
  cmdId: number,
  payload?: Uint8Array,
): string {
  // Commands carry a CBOR body; no payload means the empty CBOR map 0xA0
  // (what mcumgr's echo/reset expect for a bodyless request).
  const p = payload ?? new Uint8Array([0xa0]);
  const body = new Uint8Array(8 + p.length);
  body[0] = (1 << 3) | (op & 7); // version 1 in the top 5 bits
  body[1] = 0; // flags
  body[2] = (p.length >> 8) & 0xff;
  body[3] = p.length & 0xff;
  body[4] = (group >> 8) & 0xff;
  body[5] = group & 0xff;
  body[6] = seq & 0xff;
  body[7] = cmdId & 0xff;
  body.set(p, 8);
  const len = body.length + 2; // the CRC trailer counts into the frame length
  const pkt = new Uint8Array(2 + body.length + 2);
  pkt[0] = (len >> 8) & 0xff;
  pkt[1] = len & 0xff;
  pkt.set(body, 2);
  const crc = crc16Xmodem(body);
  pkt[pkt.length - 2] = (crc >> 8) & 0xff;
  pkt[pkt.length - 1] = crc & 0xff;
  return '\x06\x09' + bytesToBase64(pkt) + '\n';
}

// Try to finish the accumulated base64 of ONE pending frame.
//   returns null        → the frame is finished (complete + pushed, or dropped)
//   returns the string  → still incomplete, keep accumulating lines
function settleFrame(acc: string, frames: SmpFrame[]): string | null {
  // Only decode at quantum boundaries or once padding shows up: a split
  // base64 chunk is undecodable mid-stream, not invalid.
  if (acc.length % 4 !== 0 && acc.indexOf('=') < 0) return acc;
  const bytes = base64ToBytes(acc);
  if (bytes === null) return null; // bad base64 → drop the frame
  if (bytes.length < 4) return acc; // can't read the length yet — keep going
  const len = (bytes[0] << 8) | bytes[1];
  if (len < 10) return null; // min frame: 8B header + 2B crc
  if (bytes.length < len + 2) return acc; // frame continues on later lines
  const body = bytes.subarray(2, len);
  const crc = (bytes[len] << 8) | bytes[len + 1];
  if (crc16Xmodem(body) !== crc) return null; // bad CRC → drop, never throw
  const payload = body.slice(8);
  if (((body[2] << 8) | body[3]) !== payload.length) return null; // len mismatch
  frames.push({
    op: body[0] & 7,
    flags: body[1],
    group: (body[4] << 8) | body[5],
    seq: body[6],
    cmdId: body[7],
    payload,
  });
  return null;
}

// Feed accumulated RX text; get complete frames + the unconsumed tail.
// Complete lines are consumed; a trailing chunk without "\n" (and any
// pending incomplete frame's lines) is returned in rest verbatim so the
// caller can re-feed it as more bytes arrive. Bad CRC / bad length / bad
// base64 drop exactly that frame and never throw.
export function parseSmpChunks(text: string): { frames: SmpFrame[]; rest: string } {
  const frames: SmpFrame[] = [];
  let acc: string | null = null; // accumulated base64 of the pending frame
  let accRaw = ''; // original text of the pending frame's lines (for rest)
  let tail = ''; // trailing chunk after the last "\n"
  const lines = text.split('\n');
  const last = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (i === last) {
      if (rawLine !== '') tail = rawLine; // unterminated partial line
      break;
    }
    let line = rawLine;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('\x06\x09')) {
      // New frame replaces any abandoned pending one.
      acc = line.slice(2);
      accRaw = rawLine + '\n';
      acc = settleFrame(acc, frames);
      if (acc === null) accRaw = '';
    } else if (line.startsWith('\x04\x14') && acc !== null) {
      acc = settleFrame(acc + line.slice(2), frames);
      if (acc === null) accRaw = '';
      else accRaw += rawLine + '\n';
    }
    // other lines: device noise, dropped
  }
  return { frames, rest: accRaw + tail };
}

// ---------------------------------------------------------------------------
// SmpLink — line-oriented serial session. Same open shape as
// NayaSession.connect (115200 8N1 — baud is CDC-cosmetic on a USB CDC ACM
// device — plus DTR/RTS), but WITHOUT the Naya wake/handshake and without
// FrameReader: an SMP bootloader answers the first frame it sees, and this
// link owns its own TextDecoder accumulation loop.
// ---------------------------------------------------------------------------

export interface SmpSerialPortLike {
  open?(opts?: unknown): Promise<void> | void;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close?(): Promise<void> | void;
}

interface SmpWaiter {
  group: number;
  cmdId: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (f: SmpFrame) => void;
  reject: (e: Error) => void;
}

const SMP_TEXT_ENC = new TextEncoder();

export class SmpLink {
  private port: SmpSerialPortLike;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private waiters = new Map<number, SmpWaiter>();
  private rxText = '';
  private seq = 0;
  private closed = false;

  private constructor(
    port: SmpSerialPortLike,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {
    this.port = port;
    this.reader = reader;
    this.writer = writer;
  }

  static async open(
    port: SmpSerialPortLike,
    opts?: { settleMs?: number },
  ): Promise<SmpLink> {
    let openedHere = false;
    if (!port.readable) {
      await port.open?.({ baudRate: 115200 });
      openedHere = true;
    }
    try {
      const sp = port as {
        setSignals?: (s: {
          dataTerminalReady: boolean;
          requestToSend: boolean;
        }) => Promise<void> | void;
      };
      await sp.setSignals?.({ dataTerminalReady: true, requestToSend: true });
    } catch {
      /* not fatal */
    }
    const readable = port.readable;
    const writable = port.writable;
    if (!readable || !writable) {
      if (openedHere) await SmpLink.quietClose(port);
      throw new Error('port has no streams');
    }
    if (readable.locked) {
      throw new Error('port readable is locked — another session holds this port');
    }
    const reader = readable.getReader();
    const writer = writable.getWriter();
    const link = new SmpLink(port, reader, writer);
    // Bootloader settle window after open before the first frame (spec §1).
    await sleep(typeof opts?.settleMs === 'number' ? opts.settleMs : 250);
    void link.pump();
    return link;
  }

  private static async quietClose(port: SmpSerialPortLike): Promise<void> {
    try {
      await port.close?.();
    } catch {
      /* ignore */
    }
  }

  // Line reader: TextDecoder streaming-accumulate, reparse the pending
  // tail after every chunk, dispatch complete frames. A dead port just
  // ends the loop — pending waiters surface through their timeouts.
  private async pump(): Promise<void> {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          this.rxText += dec.decode(value, { stream: true });
          const { frames, rest } = parseSmpChunks(this.rxText);
          this.rxText = rest;
          for (const f of frames) this.dispatch(f);
        }
      }
    } catch {
      /* port gone mid-read */
    }
  }

  // Resolve the waiter matching (group, cmdId, seq); anything else is a
  // late/foreign reply and is discarded silently.
  private dispatch(f: SmpFrame): void {
    const w = this.waiters.get(f.seq);
    if (!w || w.group !== f.group || w.cmdId !== f.cmdId) return;
    this.waiters.delete(f.seq);
    clearTimeout(w.timer);
    w.resolve(f);
  }

  async transceive(
    op: number,
    group: number,
    cmdId: number,
    payload?: Uint8Array,
    opts?: { timeoutMs?: number },
  ): Promise<SmpFrame> {
    if (this.closed) throw new Error('smp link closed');
    const seq = ++this.seq & 0xff;
    const line = encodeSmpLine(op, group, seq, cmdId, payload);
    const timeoutMs = opts?.timeoutMs ?? 5000;
    return new Promise<SmpFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(seq);
        reject(
          new Error(`smp timeout: ${group}/${cmdId} seq ${seq} after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      this.waiters.set(seq, { group, cmdId, timer, resolve, reject });
      this.writer.write(SMP_TEXT_ENC.encode(line)).catch((e: unknown) => {
        if (!this.waiters.has(seq)) return; // already timed out / resolved
        clearTimeout(timer);
        this.waiters.delete(seq);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  // Cancel the reader, release locks, close the port — every step swallowed,
  // second call a no-op.
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.reader.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.reader.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      this.writer.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await this.port.close?.();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// SmpDevice — the op layer on top of SmpLink: the calls the firmware flash
// procedure makes (port of OF firmware_upload.py:158-929 + recovery.py).
// The link is wire-safe under concurrency (seq-keyed waiters) but the upload
// loop still serializes its own transceives — every chunk awaits its reply
// before the next write, never fire-and-forget.
// ---------------------------------------------------------------------------

export const SMP_DEFAULT_TIMEOUTS = {
  chunkMs: 20_000, // per-chunk after the first
  eraseMs: 90_000, // offset-0 chunk: full secondary-slot erase (measured 6-19 s stalls)
  transceiveMs: 5_000, // everything that is not an upload chunk
  uploadTotalMs: 600_000, // whole-upload wall-clock bound (non-advancing `off` stall guard)
} as const;

// One entry of the image-state reply: { images: [ { slot, hash, flags… } ] }.
// flags are mcumgr strings — active / confirmed / pending / permanent.
export interface ImageSlot {
  slot: number;
  hash: Uint8Array;
  pending: boolean;
  permanent: boolean;
  confirmed: boolean;
  active: boolean;
}

// A failed SMP op replies {"rc": N}; success bodies carry rc: 0 or omit it.
function replyRc(m: { [key: string]: CborValue }): number | undefined {
  const rc = m.rc;
  return typeof rc === 'number' ? rc : undefined;
}

// Decode a reply body as a CBOR map (the only shape our ops answer with).
function replyMap(payload: Uint8Array, what: string): { [key: string]: CborValue } {
  const { value } = cborDecode(payload);
  if (
    typeof value !== 'object' || value === null ||
    Array.isArray(value) || value instanceof Uint8Array
  )
    throw new Error(`smp ${what}: reply is not a map`);
  return value as { [key: string]: CborValue };
}

// sha256 over WebCrypto — globalThis.crypto.subtle exists in every browser
// and in node 19+ (the SDK stays DOM-free). Computes the UPLOAD sha: the
// digest of the bytes actually on the wire.
async function sha256Digest(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle)
    throw new Error('smp upload: WebCrypto (crypto.subtle) unavailable for the upload sha');
  // slice(): a fresh ArrayBuffer-backed copy — accepts subarray views too
  // and satisfies BufferSource under TS's Uint8Array<ArrayBufferLike> split.
  return new Uint8Array(await subtle.digest('SHA-256', bytes.slice()));
}

const UPLOAD_CHUNK = 0x200; // 512 — min(remaining, 0x200), fixed (spec §1)

export class SmpDevice {
  private link: SmpLink;
  private timeouts: { chunkMs: number; eraseMs: number; transceiveMs: number; uploadTotalMs: number };

  constructor(link: SmpLink, timeouts?: Partial<typeof SMP_DEFAULT_TIMEOUTS>) {
    this.link = link;
    this.timeouts = { ...SMP_DEFAULT_TIMEOUTS, ...timeouts };
  }

  // os/0 echo — the cheapest liveness probe (bootloader port discovery).
  // Any reply at all means alive; the body is not inspected.
  async echo(opts?: { timeoutMs?: number }): Promise<void> {
    await this.link.transceive(
      SMP.OP_READ, SMP.GROUP_OS, SMP.ID_ECHO, undefined,
      { timeoutMs: opts?.timeoutMs ?? this.timeouts.transceiveMs },
    );
  }

  // img/0 READ — image state: { images: [ { slot, hash, flags… } ] }.
  async imageState(): Promise<ImageSlot[]> {
    const rsp = await this.link.transceive(
      SMP.OP_READ, SMP.GROUP_IMAGE, SMP.ID_IMAGE_STATE, undefined,
      { timeoutMs: this.timeouts.transceiveMs },
    );
    const m = replyMap(rsp.payload, 'image-state');
    const rc = replyRc(m);
    if (rc !== undefined && rc !== 0) throw new Error(`smp image-state rc ${rc}`);
    const images = m.images;
    if (!Array.isArray(images)) return [];
    const out: ImageSlot[] = [];
    for (const raw of images) {
      if (typeof raw !== 'object' || raw === null) continue;
      const e = raw as { [key: string]: CborValue };
      const flags = Array.isArray(e.flags)
        ? e.flags.filter((f): f is string => typeof f === 'string')
        : [];
      out.push({
        slot: typeof e.slot === 'number' ? e.slot : 0,
        hash: e.hash instanceof Uint8Array ? e.hash : new Uint8Array(0),
        pending: flags.includes('pending'),
        permanent: flags.includes('permanent'),
        confirmed: flags.includes('confirmed'),
        active: flags.includes('active'),
      });
    }
    return out;
  }

  // img/6 READ — the upload-image numbering map ("image,slot" → upload id).
  // This bootloader answers ENOTSUP (rc 8) where the map doesn't exist —
  // that returns null and callers fall back to the ASSUMED rules; they never
  // guess against a map they never saw.
  async slotInfoMap(): Promise<Map<string, number> | null> {
    const rsp = await this.link.transceive(
      SMP.OP_READ, SMP.GROUP_IMAGE, SMP.ID_SLOT_INFO, undefined,
      { timeoutMs: this.timeouts.transceiveMs },
    );
    const m = replyMap(rsp.payload, 'slot-info');
    const rc = replyRc(m);
    if (rc === 8) return null; // ENOTSUP — no numbering map on this build
    if (rc !== undefined && rc !== 0) throw new Error(`smp slot-info rc ${rc}`);
    const out = new Map<string, number>();
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'number') out.set(k, v);
    }
    return out;
  }

  // img/0 WRITE — set pending (and optionally confirm) the image with the
  // given hash. OF parity: the hash is plaintextSha256 (what the device
  // reports for a running image); no hash-less form is ever sent.
  async setPending(hash: Uint8Array, confirm: boolean): Promise<void> {
    const rsp = await this.link.transceive(
      SMP.OP_WRITE, SMP.GROUP_IMAGE, SMP.ID_IMAGE_STATE,
      cborEncode({ hash, confirm }),
      { timeoutMs: this.timeouts.transceiveMs },
    );
    const rc = replyRc(replyMap(rsp.payload, 'set-pending'));
    if (rc !== undefined && rc !== 0) throw new Error(`smp set-pending rc ${rc}`);
  }

  // os/5 WRITE — reboot into the (swapped) image. The reply usually never
  // comes: the device reboots mid-reply, so a missing/late reply IS success.
  async osReset(): Promise<void> {
    try {
      await this.link.transceive(
        SMP.OP_WRITE, SMP.GROUP_OS, SMP.ID_OS_RESET, undefined,
        { timeoutMs: this.timeouts.chunkMs },
      );
    } catch {
      /* missing reply = success (device reboots mid-reply) */
    }
  }

  // img/1 WRITE loop — the upload. First chunk {image, off:0, len, sha,
  // data}; later {image, off, data}. The device reply's off is THE resume
  // point (its ack is authoritative, never our own counter). The offset-0
  // chunk runs on the erase-class timeout, the rest on the chunk timeout.
  //
  // Two hashes, two jobs — never interchanged:
  //   - upload sha (the first-chunk `sha` field) is computed HERE, as the
  //     digest of `bytes` — the bytes actually on the wire. For an
  //     encrypted keyboard image that is the BLOB digest, not the
  //     plaintext one (spec §1 / OF firmware_upload parity).
  //   - `req.verifySha256` is never sent: it is the digest the device
  //     reports for the DECRYPTED image (the catalog's plaintextSha256),
  //     i.e. what a post-swap readback must equal. The CALLING procedure
  //     compares against it (keyboard swap.verify; the module flow
  //     verifies by the stored bundle version instead) — this method has
  //     no readback of its own to check it against.
  //
  // Pure upload: resolves when the last chunk is ACCEPTED — there is no
  // internal post-upload image-state read. A real bootloader goes silent
  // for ~100 s while the trailer-armed swap runs (OF SETTLED_TIMEOUT
  // 300 s, 2 s re-poll), a settle window only the procedure can own.
  // A device that keeps replying without advancing `off` is bounded by
  // maxTotalMs (default this.timeouts.uploadTotalMs): past the deadline
  // the loop throws instead of spinning forever.
  async uploadImage(
    req: { bytes: Uint8Array; verifySha256: Uint8Array; imageId: number },
    opts?: {
      onProgress?(p: { sent: number; total: number }): void;
      onFirstChunkAck?(): void;
      shouldContinue?(): boolean;
      maxTotalMs?: number; // whole-upload wall-clock bound (stall guard)
    },
  ): Promise<void> {
    const total = req.bytes.length;
    const uploadSha = await sha256Digest(req.bytes);
    const maxTotalMs = opts?.maxTotalMs ?? this.timeouts.uploadTotalMs;
    const deadline = Date.now() + maxTotalMs;
    let sent = 0;
    let firstAcked = false;
    for (;;) {
      if (opts?.shouldContinue && !opts.shouldContinue()) throw new Error('aborted');
      if (Date.now() > deadline) throw new Error(`smp upload stalled at off ${sent}`);
      const off = sent;
      const len = Math.min(total - off, UPLOAD_CHUNK);
      const body: CborValue = off === 0
        ? { image: req.imageId, off: 0, len: total, sha: uploadSha, data: req.bytes.subarray(0, len) }
        : { image: req.imageId, off, data: req.bytes.subarray(off, off + len) };
      const rsp = await this.link.transceive(
        SMP.OP_WRITE, SMP.GROUP_IMAGE, SMP.ID_IMAGE_UPLOAD, cborEncode(body),
        { timeoutMs: off === 0 ? this.timeouts.eraseMs : this.timeouts.chunkMs },
      );
      const m = replyMap(rsp.payload, 'upload');
      const rc = replyRc(m);
      if (rc !== undefined && rc !== 0)
        throw new Error(`smp upload rc ${rc} at off ${off}`);
      if (typeof m.off !== 'number') throw new Error('smp upload: reply missing off');
      sent = m.off; // device authority — never trust the local counter
      if (!firstAcked) {
        firstAcked = true;
        opts?.onFirstChunkAck?.();
      }
      opts?.onProgress?.({ sent, total });
      if (sent >= total) break;
    }
  }
}

// Upload-target numbering (firmware_upload.py:158-194, 304-353). A device-
// provided map WINS: keyboard must confirm "0,1" → 2, modules "0,2" → 4 —
// anything else throws. With no map at all: keyboard falls back to the
// ASSUMED rule 2*image + slot + 1 (= 2 here, allowed by the spec decision);
// modules may go unmapped only for an exactly-1 MiB bundle.
export function resolveUploadImageId(
  map: Map<string, number> | null,
  kind: 'keyboard' | 'modules',
  bundleSize?: number,
): number {
  if (kind === 'keyboard') {
    if (map) {
      const id = map.get('0,1');
      if (id !== 2)
        throw new Error(`keyboard upload id unconfirmed: map "0,1" → ${String(id)}, need 2`);
      return 2;
    }
    return 2; // ASSUMED 2*image + slot + 1 for image 0, slot 1
  }
  if (map) {
    const id = map.get('0,2');
    if (id !== 4)
      throw new Error(`modules upload id unconfirmed: map "0,2" → ${String(id)}, need 4`);
    return 4;
  }
  if (bundleSize === 1_048_576) return 4; // exact 1 MiB bundle, unmapped allowed
  throw new Error(
    `modules upload id unmapped and bundle size ${String(bundleSize)} is not exactly 1 MiB`,
  );
}
