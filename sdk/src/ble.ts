/* BLE verbs (type 0xBE) on a NayaSession + the 239B be/100C status decode,
 * split-pairing/link verdicts, and the negative-only capability cache.
 * No DOM, no React — pure protocol layer, same rules as naya.ts.
 *
 * WIRE CONVENTION — the GET-param spelling: OpenFlow sends EMPTY payloads on
 * BLE GETs; OUR answered convention (every aux GET in aux.ts, proven live on
 * be/1006 + be/100f) sends a single [0x00] param. The discrepancy is
 * UNRESOLVED — the Phase-10 live probe settles it. We implement GETs with
 * [0x00], the spelling that answers on our units; both spellings are
 * documented here so the probe can flip the constant in one place.
 *
 * Verb map (c0 0x10): 1002 getPairAddress, 1005 getAllPairs, 1008 getAddress,
 * 1009 selectProfile, 100A clearProfile, 100C getStatus. The wire-guard
 * (troubleshooting/wire-guard.ts) blocks only be/1004 (UNPAIR ALL) among BLE
 * verbs — 1009/100A/100C pass through, but 100A (clear) is a caller-confirmed
 * danger op: the SDK never adds confirmation logic, it just refuses reserved
 * slots before any wire traffic.
 */

import type { Frame } from './naya';
import { NayaSession } from './naya';

/** Optional busy-guard handle, forwarded to NayaSession.cmd (same discipline
 * as every other verb family: background sweeps never race a dump/flash). */
export type BleBusyGuard = { current: boolean };

const BLE_GET_PARAM = 0x00; // OUR convention (see header note); OF sends none

/* be/1002 GET PAIR ADDRESS → 6B MAC (the PEER this half points at), or null
 * when the answer is missing or too short. Null is a NO-ANSWER, not an
 * unpaired half — an unpaired half still answers (zeros). */
export async function bleGetPairAddress(
  ses: NayaSession,
  guard?: BleBusyGuard,
): Promise<Uint8Array | null> {
  let f: Frame;
  try {
    f = await ses.cmd(0xbe, 0x10, 0x02, Uint8Array.from([BLE_GET_PARAM]), guard);
  } catch {
    return null;
  }
  return f.payload.length >= 6 ? f.payload.slice(0, 6) : null;
}

/* be/1008 GET OWN ADDRESS → 6B MAC, or null on no/short answer. */
export async function bleGetAddress(
  ses: NayaSession,
  guard?: BleBusyGuard,
): Promise<Uint8Array | null> {
  let f: Frame;
  try {
    f = await ses.cmd(0xbe, 0x10, 0x08, Uint8Array.from([BLE_GET_PARAM]), guard);
  } catch {
    return null;
  }
  return f.payload.length >= 6 ? f.payload.slice(0, 6) : null;
}

export interface BlePairs {
  count: number;
  macs: Uint8Array[];
}

/** Pure parser for the be/1005 bond table: payload = [count][6B MAC ×count].
 * GUARD: count<=8 && len>=1+6*count, else null (unparseable — NOT an empty
 * table). The empty table [0] is a VALID answer: {count:0, macs:[]}, distinct
 * from null (no/invalid answer). */
export function parseBlePairs(p: Uint8Array): BlePairs | null {
  if (p.length < 1) return null;
  const count = p[0]!;
  if (count > 8 || p.length < 1 + 6 * count) return null;
  const macs: Uint8Array[] = [];
  for (let i = 0; i < count; i++) macs.push(p.slice(1 + 6 * i, 7 + 6 * i));
  return { count, macs };
}

/* be/1005 GET ALL PAIRS → parsed table or null (no answer / guard trip). */
export async function bleGetAllPairs(
  ses: NayaSession,
  guard?: BleBusyGuard,
): Promise<BlePairs | null> {
  let f: Frame;
  try {
    f = await ses.cmd(0xbe, 0x10, 0x05, Uint8Array.from([BLE_GET_PARAM]), guard);
  } catch {
    return null;
  }
  return parseBlePairs(f.payload);
}

/* be/100C GET STATUS → the raw reply Frame (239B payload on healthy fw).
 * Throws on no reply — callers decide; decodeBleStatus never raises on the
 * payload itself. Uses the deep-read action's busy-guard discipline upstream. */
export async function bleGetStatus(
  ses: NayaSession,
  guard?: BleBusyGuard,
): Promise<Frame> {
  return ses.cmd(0xbe, 0x10, 0x0c, Uint8Array.from([BLE_GET_PARAM]), guard);
}

/* Slot pre-validation, BEFORE any wire traffic. Slot 0 is reserved (dongle
 * mode) — the refusal error names it; 1..4 are the user-facing profiles. */
function bleCheckSlot(slot: number): void {
  if (slot === 0)
    throw new Error('BLE slot 0 is reserved (dongle mode) — profiles are 1..4');
  if (!(Number.isInteger(slot) && slot >= 1 && slot <= 4))
    throw new Error(
      `BLE slot ${slot} out of range — profiles are 1..4 (slot 0 is reserved for the dongle)`,
    );
}

export interface BleProfileOp {
  /** select: the read-back activeProfile === slot. clear: the write acked. */
  ok: boolean;
  /** activeProfile from the be/100C read-back (null = status unreadable). */
  activeProfile: number | null;
  /** target slot's hasPeerData from the same read-back (null = unreadable,
   * slot index not found). For clear this reports whether the slot STILL
   * holds peer data after the wipe. */
  bonded: boolean | null;
  /** the be/100C payload, always kept beside the decode. */
  statusRaw: Uint8Array | null;
}

/* Read-back-verify via be/100C after a profile write. */
async function bleProfileReadback(
  ses: NayaSession,
  slot: number,
  guard?: BleBusyGuard,
): Promise<BleProfileOp> {
  let raw: Uint8Array | null = null;
  try {
    raw = (await bleGetStatus(ses, guard)).payload;
  } catch {
    /* status unreadable — reported as ok:false, not raised */
  }
  if (raw === null)
    return { ok: false, activeProfile: null, bonded: null, statusRaw: null };
  const st = decodeBleStatus(raw);
  if (st.layout === null)
    return { ok: false, activeProfile: null, bonded: null, statusRaw: raw };
  const prof = st.layout.profiles.find((p) => p.index === slot) ?? null;
  return {
    ok: st.layout.activeProfile === slot,
    activeProfile: st.layout.activeProfile,
    bonded: prof ? prof.hasPeerData : null,
    statusRaw: raw,
  };
}

/* be/1009 SELECT PROFILE: pre-validate 1..4 (pre-wire), write [slot], then
 * read-back-verify via be/100C — ok = activeProfile is NOW the slot. */
export async function bleSelectProfile(
  ses: NayaSession,
  slot: number,
  guard?: BleBusyGuard,
): Promise<BleProfileOp> {
  bleCheckSlot(slot);
  await ses.cmd(0xbe, 0x10, 0x09, Uint8Array.from([slot]), guard);
  return bleProfileReadback(ses, slot, guard);
}

/* be/100A CLEAR PROFILE: pre-validate 1..4 (pre-wire), write [slot], then a
 * be/100C read-back reporting the slot's hasPeerData as `bonded`. NO confirm
 * logic in the SDK — callers own the danger confirmation. */
export async function bleClearProfile(
  ses: NayaSession,
  slot: number,
  guard?: BleBusyGuard,
): Promise<BleProfileOp> {
  bleCheckSlot(slot);
  await ses.cmd(0xbe, 0x10, 0x0a, Uint8Array.from([slot]), guard);
  const r = await bleProfileReadback(ses, slot, guard);
  return { ...r, ok: true }; // ok = the write acked (cmd resolved)
}

export interface BleProfileStatus {
  index: number; // blk[0]
  configured: boolean; // blk[1] 0x01
  bonded: boolean; // blk[1] 0x02
  connected: boolean; // blk[1] 0x04
  active: boolean; // blk[1] 0x08
  hasPeerAddr: boolean; // blk[1] 0x10
  encrypted: boolean; // blk[1] 0x20
  authenticated: boolean; // blk[1] 0x40
  securityLevel: number; // blk[2]
  /** blk[2:5] = 00 01 02 in every capture — a CONSTANT prefix, not state. */
  constantPrefix: Uint8Array;
  /** any nonzero byte in blk[5:37]. */
  hasPeerData: boolean;
  /** blk[6:12], only when hasPeerAddr (0x10). */
  peerAddress: Uint8Array | null;
  /** the full 37B block, kept verbatim. */
  raw: Uint8Array;
}

export interface BleSplitStatus {
  peerAddress: Uint8Array; // [4:10]
  connectionIntervalMs: number; // u16BE [10:12] × 1.25
  connectionLatency: number; // u16BE [12:14]
  supervisionTimeoutMs: number; // u16BE [14:16] × 10
  unknownHead: Uint8Array; // [0:4], raw unknown
  unknownTail: Uint8Array; // [16:39], raw unknown
}

export interface BleStatusLayout {
  revision: number; // u32BE [0:4]
  profileCount: number; // [4]
  activeProfile: number; // [5]
  advertising: boolean; // flags [6] 0x01
  hostConnected: boolean; // flags [6] 0x02
  localAddrValid: boolean; // flags [6] 0x04
  /** header bytes [7:9], raw unknown. */
  unknownBytes: Uint8Array;
  /** 6B MAC [9:15]. */
  localAddress: Uint8Array;
  profiles: BleProfileStatus[];
  split: BleSplitStatus;
}

export interface BleStatus {
  /** null when the payload is the wrong length (never raises). */
  layout: BleStatusLayout | null;
  raw: Uint8Array;
  rawHex: string;
}

// 239B = header 15 + 5×37B profiles @15 + split block 39B @200.
const BLE_STATUS_LEN = 239;

/** Decode the be/100C 239B status blob. NEVER raises; a wrong length passes
 * through as {layout:null, raw, rawHex} (statusRaw is always kept beside the
 * decode). All multi-byte ints are BIG-ENDIAN.
 *
 * Deliberately NOT ported from the vendor nayactl parser: its EXPERIMENTAL
 * extra fields (conn interval at +12..23, PHY, role, MTU) carry known
 * indexing bugs — we keep only the layout above plus the raw blocks. */
export function decodeBleStatus(raw: Uint8Array): BleStatus {
  const rawHex = toHexBlk(raw);
  try {
    if (raw.length !== BLE_STATUS_LEN) return { layout: null, raw, rawHex };
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const flags = raw[6]!;
    const profiles: BleProfileStatus[] = [];
    for (let i = 0; i < 5; i++) {
      const blk = raw.slice(15 + i * 37, 15 + (i + 1) * 37);
      const f = blk[1]!;
      const hasPeerAddr = (f & 0x10) !== 0;
      let data = false;
      for (let k = 5; k < 37; k++) {
        if (blk[k] !== 0) {
          data = true;
          break;
        }
      }
      profiles.push({
        index: blk[0]!,
        configured: (f & 0x01) !== 0,
        bonded: (f & 0x02) !== 0,
        connected: (f & 0x04) !== 0,
        active: (f & 0x08) !== 0,
        hasPeerAddr,
        encrypted: (f & 0x20) !== 0,
        authenticated: (f & 0x40) !== 0,
        securityLevel: blk[2]!,
        constantPrefix: blk.slice(2, 5),
        hasPeerData: data,
        peerAddress: hasPeerAddr ? blk.slice(6, 12) : null,
        raw: blk,
      });
    }
    const s = raw.subarray(200);
    return {
      layout: {
        revision: dv.getUint32(0, false),
        profileCount: raw[4]!,
        activeProfile: raw[5]!,
        advertising: (flags & 0x01) !== 0,
        hostConnected: (flags & 0x02) !== 0,
        localAddrValid: (flags & 0x04) !== 0,
        unknownBytes: raw.slice(7, 9),
        localAddress: raw.slice(9, 15),
        profiles,
        split: {
          peerAddress: s.slice(4, 10),
          connectionIntervalMs: dv.getUint16(200 + 10, false) * 1.25,
          connectionLatency: dv.getUint16(200 + 12, false),
          supervisionTimeoutMs: dv.getUint16(200 + 14, false) * 10,
          unknownHead: s.slice(0, 4),
          unknownTail: s.slice(16),
        },
      },
      raw,
      rawHex,
    };
  } catch {
    return { layout: null, raw, rawHex };
  }
}

/* Local hex helper (avoids importing naya's toHex and its array churn here;
 * byte-for-byte identical output, space-separated lowercase). */
function toHexBlk(u: Uint8Array): string {
  let out = '';
  for (let i = 0; i < u.length; i++) {
    if (i > 0) out += ' ';
    out += u[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function macEq(
  a: Uint8Array | number[] | null | undefined,
  b: Uint8Array | number[] | null | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const ZERO_MAC: number[] = [0, 0, 0, 0, 0, 0];

/** A half "points at" its peer only when the pairAddress matches AND is not
 * the all-zero address — 00:00:00:00:00:00 is a FRESH/unpaired half, which
 * points at nobody (never grades as mutual/healthy). */
function pointsAt(pair: Uint8Array, peer: Uint8Array): boolean {
  return !macEq(pair, ZERO_MAC) && macEq(pair, peer);
}

export interface PairingHalf {
  /** be/1008 — this half's own BLE address. */
  bleAddress: Uint8Array | null;
  /** be/1002 — CRITICAL SEMANTICS: this half's pairAddress is its PEER's
   * address, so left.pairAddress === right.bleAddress means LEFT points at
   * RIGHT. */
  pairAddress: Uint8Array | null;
  /** be/1005 MACs, this half's bond table. ABSENT (undefined) = not read;
   * null = read attempted but no answer. Only array-valued tables are
   * judged. */
  pairedPeers?: Uint8Array[] | null;
}

export type PairingVerdict =
  | 'healthy'
  | 'half-paired'
  | 'bond-missing'
  | 'unknown';

/** Pure verdict over two halves' identity reads.
 *  - healthy: pairAddresses MUTUAL (left→right AND right→left) and BOTH
 *    bond tables READ (array-valued) and holding the partner. An unread
 *    (undefined) or unanswered (null) table is NO evidence of a bond —
 *    mutual addresses alone never grade healthy (the 2026-09-25 live case:
 *    mutual addresses over an empty bond table).
 *  - bond-missing: mutual addresses and a READ table lacks the partner —
 *    positive evidence, judged before the read-requirement below.
 *  - half-paired: exactly one direction points at the partner. ZERO
 *    directions (both halves point elsewhere, or all-zero pairAddresses on
 *    fresh/unpaired halves) is pairing-incomplete too — grouped here so the
 *    repair flow triggers.
 *  - unknown: an identity read is missing (null bleAddress/pairAddress), or
 *    a mutual pair with an unread (undefined) / unanswered (null) be/1005
 *    table on either half. */
export function pairingVerdict(left: PairingHalf, right: PairingHalf): PairingVerdict {
  if (
    !left.bleAddress ||
    !left.pairAddress ||
    !right.bleAddress ||
    !right.pairAddress
  )
    return 'unknown';
  const directions =
    (pointsAt(left.pairAddress, right.bleAddress) ? 1 : 0) +
    (pointsAt(right.pairAddress, left.bleAddress) ? 1 : 0);
  if (directions === 2) {
    if (Array.isArray(left.pairedPeers) &&
      !left.pairedPeers.some((m) => macEq(m, right.bleAddress)))
      return 'bond-missing';
    if (Array.isArray(right.pairedPeers) &&
      !right.pairedPeers.some((m) => macEq(m, left.bleAddress)))
      return 'bond-missing';
    // Mutual + every READ table holds the partner — still not 'healthy'
    // unless BOTH tables were actually read (undefined = not asked, null =
    // asked but unanswered; neither is evidence of a bond).
    if (!Array.isArray(left.pairedPeers) || !Array.isArray(right.pairedPeers))
      return 'unknown';
    return 'healthy';
  }
  return 'half-paired';
}

export interface SplitLinkReport {
  leftConnected: boolean;
  rightConnected: boolean;
  leftFw: string | null;
  rightFw: string | null;
  /** the pairingVerdict over the two halves. */
  pairing: PairingVerdict;
}

export interface PartnerProbe {
  /** true only when the partner-via-left relay probe got a NON-empty
   * answer through the LEFT half's transport to the RIGHT destination. */
  reached: boolean;
}

export type SplitLinkVerdict =
  | 'connect-both'
  | 'firmware-mismatch'
  | 'pairing-repair'
  | 'link-down'
  | 'ok';

/** Pure, ORDERED verdict (first match wins):
 *  1. connect-both — either half missing from the transport;
 *  2. firmware-mismatch — fw strings differ (pairing repair refuses on
 *     mismatch; fix firmware first);
 *  3. pairing-repair — pairingVerdict ∈ {half-paired, bond-missing};
 *  4. link-down — partnerViaLeft.reached === false. An EMPTY payload reply
 *     is NOT an answer: a linkless left half still replies with one —
 *     classify via probeReached, never by frame arrival alone;
 *  5. ok. */
export function splitLinkVerdict(
  report: SplitLinkReport,
  partnerProbe: PartnerProbe | null,
): SplitLinkVerdict {
  if (!report.leftConnected || !report.rightConnected) return 'connect-both';
  if (
    report.leftFw !== null &&
    report.rightFw !== null &&
    report.leftFw !== report.rightFw
  )
    return 'firmware-mismatch';
  if (report.pairing === 'half-paired' || report.pairing === 'bond-missing')
    return 'pairing-repair';
  if (partnerProbe !== null && partnerProbe.reached === false) return 'link-down';
  return 'ok';
}

/** Relay-probe classifier: reached only on a non-empty payload. An EMPTY
 * payload reply is NOT an answer — a linkless left half still sends one. */
export function probeReached(payload: Uint8Array | null): boolean {
  return payload !== null && payload.length > 0;
}

/** Negative-only BLE capability memory, keyed (side, fwVersion, verb-sub).
 * A verb recorded unanswered for a firmware skips the wire ENTIRELY until
 * the firmware changes (a new fw key simply misses → fresh probes).
 * Positive answers are never cached — answered verbs are re-asked. */
export class BleCapabilityCache {
  /** key → false = probed and UNANSWERED. */
  private neg = new Map<string, boolean>();
  /** side → last base-FW text seen. Feeds the be/1006 key, which is asked
   * BEFORE fe/1002 in the aux sweep (the first sweep ever probes under ''). */
  private fwSeen = new Map<string, string>();

  fwOf(side: string): string {
    return this.fwSeen.get(side) ?? '';
  }

  rememberFw(side: string, fw: string): void {
    if (fw) this.fwSeen.set(side, fw);
  }

  /** Ask a BLE verb through the cache: skip wire when negatively remembered,
   * else run fn() (the wire ask) and record payload absence as a negative.
   * fn returns null for "unanswered"; exceptions propagate (BusySkipError
   * must never be swallowed). */
  async ask(
    side: string,
    fw: string,
    sub: number,
    fn: () => Promise<Frame | null>,
  ): Promise<Frame | null> {
    const key = `${side}|${fw}|${sub.toString(16)}`;
    if (this.neg.get(key) === false) return null;
    const f = await fn();
    if (f === null) this.neg.set(key, false);
    else this.neg.delete(key);
    return f;
  }
}
