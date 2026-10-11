/* BLE slot state for the Devices tab: per-half identity + slot reads,
 * painted from an EXPLICIT "Read BLE" action only (no navigation-triggered
 * reads), plus the confirmed Select / Clear & pair verbs and the
 * pairingVerdict over both halves.
 *
 * Busy discipline = the app-wide one: every action checks busyRef up front
 * (a dump/flash in flight refuses new traffic) and holds busyRef.current
 * true for its own duration so the pollers yield. The verbs are called
 * WITHOUT the guard ref — the holder of the gate must not trip itself.
 *
 * Read sequence per half: be/1008 (own address) → be/1002 (pair address)
 * → be/100C (239B status). The 100C ask runs through the negative-only
 * BleCapabilityCache, so firmware that never answers it skips the wire on
 * every later read. Degradation: when 100C is unavailable, be/1005 (bond
 * table) is read instead and the panel shows identity-only rows — the
 * slot rows need the 239B block.
 */

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  BleCapabilityCache,
  bleGetAddress,
  bleGetAllPairs,
  bleGetPairAddress,
  bleClearProfile,
  bleSelectProfile,
  bleGetStatus,
  decodeBleStatus,
  pairingVerdict,
} from '@create-reflow/sdk';
import type {
  BlePairs,
  BleProfileOp,
  BleStatus,
  NayaSession,
  PairingVerdict,
  Side,
} from '@create-reflow/sdk';
import type { LogFn } from './useLog';

/** One half's painted BLE state — whatever the last explicit read got. */
export interface BleHalfData {
  at: number;
  /** be/1008 own address (null = no/short answer). */
  address: Uint8Array | null;
  /** be/1002 pair address — the PEER this half points at. */
  pairAddress: Uint8Array | null;
  /** be/100C decode; null = unanswered (or unparseable — layout null). */
  status: BleStatus | null;
  /** be/1005 bond table, read ONLY when 100C was unavailable:
   * undefined = not attempted, null = attempted but unanswered. */
  pairs: BlePairs | null | undefined;
}

const macText = (m: Uint8Array | null): string =>
  m === null
    ? '—'
    : Array.from(m)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(':');

/** Bond evidence for pairingVerdict from one half's painted data.
 *  - 1005 path (degradation): the table itself (undefined = not read,
 *    null = unanswered).
 *  - 239B path: the peer MACs of slots whose bonded flag (blk[1] 0x02)
 *    is set — but ONLY when every bonded slot carries a readable peer
 *    address; a bonded slot without one is partial evidence, and
 *    partial ⇒ undefined (the verdict must stay 'unknown' rather than
 *    guess). */
export function pairedPeersOf(d: BleHalfData): Uint8Array[] | null | undefined {
  if (d.pairs !== undefined) return d.pairs === null ? null : d.pairs.macs;
  const layout = d.status?.layout;
  if (!layout) return undefined;
  const peers: Uint8Array[] = [];
  for (const p of layout.profiles) {
    if (p.index === 0 || !p.bonded) continue; // slot 0 = dongle reserve
    if (!p.peerAddress) return undefined; // bonded but unreadable peer ⇒ partial evidence
    peers.push(p.peerAddress);
  }
  return peers;
}

export function useBleSlots({
  sesRef,
  busyRef,
  halves,
  log,
}: {
  sesRef: React.RefObject<Map<Side, NayaSession>>;
  busyRef: React.RefObject<boolean>;
  halves: Record<Side, { fw: string }>;
  log: LogFn;
}) {
  const [data, setData] = useState<Record<Side, BleHalfData | null>>({
    left: null,
    right: null,
  });
  const [busySide, setBusySide] = useState<Side | null>(null);
  // Negative-only 100C memory per (side, fw): a firmware that never
  // answers the 239B status skips the wire on every later read.
  const capsRef = useRef(new BleCapabilityCache());

  const paint = useCallback(
    (side: Side, patch: Partial<BleHalfData>) => {
      setData((prev) => ({
        ...prev,
        [side]: {
          at: Date.now(),
          address: null,
          pairAddress: null,
          status: null,
          pairs: undefined,
          ...prev[side],
          ...patch,
        },
      }));
    },
    [],
  );

  /** Paint the slot table from a write's be/100C read-back (select/clear
   * return the raw status alongside the verdict). */
  const paintFromOp = useCallback(
    (side: Side, r: BleProfileOp) => {
      if (r.statusRaw === null) return;
      paint(side, { status: decodeBleStatus(r.statusRaw) });
    },
    [paint],
  );

  const gate = useCallback(
    (side: Side): NayaSession | null => {
      const ses = sesRef.current.get(side);
      if (!ses) {
        toast.error(`Connect the ${side} half first`);
        return null;
      }
      if (busyRef.current) {
        toast.error('Device busy (flash or dump in flight) — try again after');
        return null;
      }
      return ses;
    },
    [sesRef, busyRef],
  );

  const run = useCallback(
    async (side: Side, fn: (ses: NayaSession) => Promise<void>) => {
      busyRef.current = true;
      setBusySide(side);
      try {
        await fn(sesRef.current.get(side)!);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`BLE action failed: ${msg}`);
        log('err', `ble ${side}: ${msg}`);
      } finally {
        busyRef.current = false;
        setBusySide(null);
      }
    },
    [sesRef, busyRef, log],
  );

  /** The explicit deep read: 1008 + 1002 + 100C (cache-aware), falling
   * back to 1005 when the 239B block is unavailable. */
  const readBle = useCallback(
    (side: Side) => {
      const ses = gate(side);
      if (!ses) return;
      void run(side, async (s) => {
        // Feed the cache key: negatives are scoped to (side, fw), so an
        // upgrade re-probes 100C automatically.
        const fw = halves[side].fw !== '—' ? halves[side].fw : '';
        capsRef.current.rememberFw(side, fw);
        const address = await bleGetAddress(s);
        const pairAddress = await bleGetPairAddress(s);
        let status: BleStatus | null = null;
        try {
          const f = await capsRef.current.ask(
            side,
            capsRef.current.fwOf(side),
            0x0c,
            () => bleGetStatus(s).catch(() => null),
          );
          status = f ? decodeBleStatus(f.payload) : null;
        } catch {
          status = null; // unreachable while we hold the gate — belt & braces
        }
        // Degradation: no 239B block → ask the bond table instead so the
        // verdict keeps table evidence even on older firmware.
        const pairs =
          status === null || status.layout === null
            ? await bleGetAllPairs(s)
            : undefined;
        paint(side, { address, pairAddress, status, pairs });
        log(
          'inf',
          `ble read ${side}: addr ${macText(address)}, pair → ${macText(pairAddress)}, ` +
            (status?.layout
              ? `status ok (${status.layout.profileCount} slots)`
              : `status unavailable — identity only, bond table ${
                  pairs === null
                    ? 'no reply from the keyboard'
                    : `${pairs?.count ?? 0} entry(ies)`
                }`),
        );
      });
    },
    [gate, run, halves, log, paint],
  );

  /** Select = the same as pressing BT n. Confirmed (typing can stop);
   * read-back verdict surfaced honestly. */
  const selectProfile = useCallback(
    (side: Side, slot: number) => {
      const ses = gate(side);
      if (!ses) return;
      if (
        !window.confirm(
          `Select BLE slot ${slot} on the ${side} half? ` +
            `Same as pressing BT${slot} on the keyboard — if nothing is paired there, ` +
            'typing stops until USB-C or power cycle.',
        )
      )
        return;
      void run(side, async (s) => {
        const r = await bleSelectProfile(s, slot);
        paintFromOp(side, r);
        if (r.ok) {
          toast.success(`Slot ${slot} selected — read-back confirms it active`);
          log('inf', `ble select ${side} slot ${slot}: ok (read-back)`);
        } else {
          toast.error(
            r.activeProfile === null
              ? `Slot ${slot} select sent but read-back unreadable — Read BLE to verify`
              : `Slot ${slot} select NOT confirmed — device reports slot ${r.activeProfile} active`,
          );
          log('err', `ble select ${side} slot ${slot}: read-back mismatch`);
        }
      });
    },
    [gate, run, paintFromOp, log],
  );

  /** Clear & pair: the danger op. The write acks (ok) — the read-back's
   * hasPeerData tells whether the slot is REALLY empty afterwards. */
  const clearProfile = useCallback(
    (side: Side, slot: number) => {
      const ses = gate(side);
      if (!ses) return;
      if (
        !window.confirm(
          `Clear & pair BLE slot ${slot} on the ${side} half? ` +
            `Whatever is paired in slot ${slot} is forgotten — that keyboard or computer ` +
            'must pair again from scratch. Use this to prepare the slot for a fresh pairing.',
        )
      )
        return;
      void run(side, async (s) => {
        const r = await bleClearProfile(s, slot);
        paintFromOp(side, r);
        if (r.bonded === false) {
          toast.success(`Slot ${slot} cleared — read-back shows it empty; pair the new device now`);
          log('inf', `ble clear ${side} slot ${slot}: ok (slot empty)`);
        } else if (r.bonded === true) {
          toast.warning(`Slot ${slot} wipe acked but read-back still shows peer data — clear again`);
          log('err', `ble clear ${side} slot ${slot}: peer data still present`);
        } else {
          toast.info(`Slot ${slot} wipe acked — read-back unreadable, Read BLE to verify`);
          log('inf', `ble clear ${side} slot ${slot}: acked, read-back unreadable`);
        }
      });
    },
    [gate, run, paintFromOp, log],
  );

  /** pairingVerdict over both halves — null until both have been read. */
  const verdict: PairingVerdict | null =
    data.left && data.right
      ? pairingVerdict(
          {
            bleAddress: data.left.address,
            pairAddress: data.left.pairAddress,
            pairedPeers: pairedPeersOf(data.left),
          },
          {
            bleAddress: data.right.address,
            pairAddress: data.right.pairAddress,
            pairedPeers: pairedPeersOf(data.right),
          },
        )
      : null;

  return { data, busySide, verdict, readBle, selectProfile, clearProfile };
}

export type BleSlots = ReturnType<typeof useBleSlots>;
