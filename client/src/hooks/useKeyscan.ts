/* Keyscan live test mode hook — fe/1008 ON + the raw fe/1009 event stream
 * through NayaSession.keyscanListen.
 *
 * Busy discipline: test mode must block ALL other device traffic for the
 * whole session (an interleaved cmd() would flush the RX buffer and
 * destroy queued events), so start() refuses while a flash/dump/read is in
 * flight (busyRef) or while the draft queue is non-empty, then holds
 * busyRef.current true until the listen settles. The SDK listener holds
 * its own tail mutex for the same span — this ref is the client-side half.
 *
 * Exits: the SDK listener ALWAYS sends fe/1008 OFF in its own finally —
 * the hook never sends OFF itself. Aborts ride the listener's caller-abort
 * channel (a throw from onEvent ends the stream): Escape and unmount set
 * an abort flag, and the next event (or the deadline) ends the session.
 * A dead port surfaces as a reader error the SDK rethrows after OFF;
 * caught here → toast + error log (auto-exit on disconnect).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { NayaSession, Side } from '@create-reflow/sdk';
import type { LogFn } from './useLog';

/** One raw keyscan event for the live tail: the wire row/col, the
 * INVERTED press state (STATE 0 = PRESS) and the wall-clock ms it was
 * dispatched at. No KK mapping — raw row/col is the truth (Phase-10 probe
 * may pin a mapping later). */
export interface KeyscanEvent {
  row: number;
  col: number;
  pressed: boolean;
  t: number;
}

/** Live-tail length: the panel shows the last ~64 events, older fall off. */
const EVENTS_TAIL = 64;

export function useKeyscan({
  sesRef,
  busyRef,
  draftSize,
  side,
  log,
}: {
  sesRef: React.RefObject<Map<Side, NayaSession>>;
  busyRef: React.RefObject<boolean>;
  /** Queued (unflashed) draft ops — test mode refuses to interleave. */
  draftSize: number;
  /** Which half to listen on (the keymap editor is the left half). */
  side: Side;
  log: LogFn;
}) {
  const [pressed, setPressed] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<KeyscanEvent[]>([]);
  // Caller-abort flag: set by stop()/Escape/unmount, the next onEvent
  // throws on it and the SDK listener ends the stream (OFF in its finally).
  const abortRef = useRef(false);
  // Mirrors `running` inside the async runner (re-entry guard before state
  // commits, same pattern as connRef in useSessions).
  const runningRef = useRef(false);

  const stop = useCallback(() => {
    abortRef.current = true;
  }, []);

  // Escape exits the session (BindingsTab ctx-popover shape: ONE window
  // listener, mounted only while running, removed on cleanup).
  useEffect(() => {
    if (!running) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [running, stop]);

  // Unmount auto-exit: flag the abort; the listener still holds busyRef
  // until the stream actually ends (next event or deadline) so no other
  // traffic can slip in under it. Bounded by the listen duration.
  useEffect(
    () => () => {
      abortRef.current = true;
    },
    [],
  );

  const start = useCallback(
    (durationMs?: number) => {
      if (runningRef.current) {
        toast.warning('Keyscan test already running');
        return;
      }
      if (busyRef.current) {
        toast.error('Device busy (flash, dump or read in flight) — try again after');
        return;
      }
      if (draftSize > 0) {
        toast.error(
          `Draft has ${draftSize} queued change(s) — flash or discard them before testing keys`,
        );
        return;
      }
      const ses = sesRef.current.get(side);
      if (!ses) {
        toast.error(`Connect the ${side} half first`);
        return;
      }
      runningRef.current = true;
      abortRef.current = false;
      busyRef.current = true;
      setPressed(new Set());
      setEvents([]);
      setRunning(true);
      log('inf', `keyscan: test mode ON (${side}) — other device traffic locked`);
      void (async () => {
        try {
          await ses.keyscanListen((ev) => {
            // Caller-abort channel: a throw here ends the stream; the
            // listener's finally sends OFF either way.
            if (abortRef.current) throw new Error('aborted');
            setPressed((prev) => {
              const next = new Set(prev);
              const key = `${ev.row}:${ev.col}`;
              if (ev.pressed) next.add(key);
              else next.delete(key);
              return next;
            });
            setEvents((prev) => {
              const next = [
                ...prev,
                { row: ev.row, col: ev.col, pressed: ev.pressed, t: Date.now() },
              ];
              return next.length > EVENTS_TAIL
                ? next.slice(next.length - EVENTS_TAIL)
                : next;
            });
            log(
              'inf',
              `keyscan ${side}: r${ev.row} c${ev.col} ${ev.pressed ? 'PRESS' : 'RELEASE'}`,
            );
          }, durationMs === undefined ? undefined : { durationMs });
        } catch (e) {
          // Dead port / mid-stream reader failure — the SDK has already
          // sent OFF before rethrowing.
          const msg = e instanceof Error ? e.message : String(e);
          toast.error(`Keyscan test ended with an error: ${msg}`);
          log('err', `keyscan ${side}: ${msg}`);
        } finally {
          const aborted = abortRef.current;
          runningRef.current = false;
          abortRef.current = false;
          busyRef.current = false;
          setRunning(false);
          log(
            'inf',
            `keyscan: test mode OFF (${side}) — ${aborted ? 'stopped' : 'ended'}, traffic unlocked`,
          );
        }
      })();
    },
    [sesRef, busyRef, draftSize, side, log],
  );

  return { pressed, running, events, start, stop };
}

export type Keyscan = ReturnType<typeof useKeyscan>;
