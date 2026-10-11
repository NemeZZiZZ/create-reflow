/* Device I/O forensic log — a bounded ring of wire records captured by the
 * roundtrip() tap in naya.ts. Framework-free, pure TS, no timers of its own:
 * records are pushed synchronously on the exchange path and UIs bind via
 * subscribe() (fire-on-push, return-an-unsubscribe).
 *
 * One record = one wire event:
 *   dir '>' — host → device command, recorded BEFORE the port write.
 *   dir '<' — device → host frame; OR a host-side failure (err set, e.g. the
 *             sync-lost timeout): '<' reads as "outcome at the wire — nothing
 *             came back". The failure record carries the expected verb in
 *             type/c0/c1 and len 0 / empty hex.
 *
 * hex is the PAYLOAD bytes only (the bytes after C0C1 — the same slice the
 * device calls params), space-separated UPPERCASE, truncated to the first 48
 * bytes with a trailing `…+N` note naming the dropped tail. The envelope
 * (sender/dst/id/xor/footer) is deliberately not stored: it is derivable
 * (session dst, buildFrame), and the log stays compact for 48-byte caps.
 *
 * ms scheme (simple, unambiguous): roundtrips are serialized per session by
 * the cmd mutex, so a call's own TX record is THE matching one. The tap notes
 * performance.now() at send and stamps elapsed ms on the TX record per
 * received frame; the frame that satisfies the matcher is the last write
 * before return, so a completed exchange's TX record holds ITS elapsed, and
 * a failed exchange leaves ms unset (the error record carries the outcome).
 *
 * snapshot() hands out the live backing array as readonly and the entries
 * are plain mutable objects — that is what makes the ms backfill visible to
 * subscribers without re-pushing. Records are 8 small fields; nobody should
 * mutate anything but ms.
 */

export interface IoLogEntry {
  seq: number; // ring-wide monotonic counter (ordering survives eviction)
  t: number; // wall clock ms (Date.now()) at record creation
  dir: '>' | '<';
  type: number; // frame t byte
  c0: number;
  c1: number;
  len: number; // payload byte count (0 on error records)
  hex: string; // payload hex, ≤48 bytes + `…+N` note when truncated
  ms?: number; // '>' only: exchange elapsed once the awaited reply lands
  err?: string; // '<' only: short failure text (timeout path)
}

/** What a caller may push: everything but seq/t, which the ring assigns. */
export type IoLogEntryish = Omit<IoLogEntry, 'seq' | 't'>;

export interface IoLog {
  /** Internal use (the roundtrip tap + tests): append one record. */
  push(entry: IoLogEntryish): IoLogEntry;
  /** Oldest-first view of the ring (live array — see ms note above). */
  snapshot(): readonly IoLogEntry[];
  /** Drop every record (subscribers fire so a UI can reset). */
  clear(): void;
  /** Fire fn on every push/clear; returns an unsubscribe. */
  subscribe(fn: () => void): () => void;
}

export const IO_LOG_CAP = 500;
export const IO_LOG_HEX_HEAD = 48;

/** Uppercase space-separated hex of the first `max` bytes; a trailing
 * `…+N` names how many bytes were dropped (the length note). */
export function hexHead(u8: Uint8Array, max: number = IO_LOG_HEX_HEAD): string {
  const parts: string[] = [];
  const n = Math.min(u8.length, max);
  for (let i = 0; i < n; i++)
    parts.push((u8[i] ?? 0).toString(16).toUpperCase().padStart(2, '0'));
  const s = parts.join(' ');
  return u8.length > max ? `${s} …+${u8.length - max}` : s;
}

/** Bounded ring (oldest evicted past `cap`, default 500). No timers: pushes
 * are synchronous and cheap; subscribers decide when to re-render. */
export function createIoLog(cap: number = IO_LOG_CAP): IoLog {
  const buf: IoLogEntry[] = [];
  const subs = new Set<() => void>();
  let seq = 0;
  const fire = (): void => {
    for (const fn of subs) fn();
  };
  return {
    push(entry) {
      const rec: IoLogEntry = { seq: seq++, t: Date.now(), ...entry };
      buf.push(rec);
      if (buf.length > cap) buf.splice(0, buf.length - cap);
      fire();
      return rec;
    },
    snapshot: () => buf,
    clear() {
      buf.length = 0;
      fire();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
