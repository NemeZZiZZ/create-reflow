/* Keyboard flash plan: given what is plugged in (per-half PID + reported
 * firmware) and a target version label, resolve per half whether an image
 * exists, whether it is already in the vault, and whether the write would
 * be an upgrade, a no-op, or a downgrade.
 *
 * Downgrade rule (spec §4): when both the current firmware and the target
 * label are DECLARED (present among the catalog's createFirmware values —
 * clean dot-versions by construction), compare dot-version tuples. When
 * either side is undeclared (the no-number era: labels like
 * 'NayaFlow 1.14.3', or an unrecognised device string), fall back to the
 * catalog's releaseOrder; if the current version has no releaseOrder either,
 * no downgrade claim is made. unknownCurrent is reported separately so the
 * UI can warn without guessing.
 *
 * reason, when there is no image, distinguishes the two "no" cases:
 *  - 'no image for this half+generation' — nothing catalogued (or the half
 *    is unprobed: pid null / unknown family);
 *  - 'not flashable: …' — an entry EXISTS but the catalog withholds it
 *    (beta channel, pre-production); the withheldBecause text follows. */

import type { FwCatalog, FwEntry } from './firmware-catalog';
import { findKeyboardImage } from './firmware-catalog';
import type { Vault } from './firmware-fetch';
import { pidInfo } from './firmware-plat';

export interface HalfInput {
  side: 'left' | 'right';
  pid: number | null;
  fw: string | null;
}

export interface HalfPlan {
  side: 'left' | 'right';
  generation: 'A' | 'B' | null;
  currentVersion: string | null;
  image: FwEntry | null;
  present: boolean;
  fetchable: boolean;
  unchanged: boolean;
  downgrade: boolean;
  unknownCurrent: boolean;
  reason?: string;
}

/* createFirmware values across all keyboard entries — the "declared" set.
 * Collected once per resolveKeyboardPlan call. */
function declaredSet(cat: FwCatalog): Set<string> {
  const s = new Set<string>();
  for (const e of cat.images) {
    if (e.target === 'keyboard' && typeof e.createFirmware === 'string')
      s.add(e.createFirmware);
  }
  return s;
}

/* Newest releaseOrder among keyboard entries grouped under a label
 * (createFirmware ?? versionLabel); null when the label is unknown to the
 * catalog or its rows carry no order (beta rows). */
function groupReleaseOrder(cat: FwCatalog, label: string): number | null {
  let best: number | null = null;
  for (const e of cat.images) {
    if (e.target !== 'keyboard') continue;
    if ((e.createFirmware ?? e.versionLabel) !== label) continue;
    const ro = e.releaseOrder;
    if (typeof ro === 'number' && (best === null || ro > best)) best = ro;
  }
  return best;
}

/* Strict dot-version tuple ('3.41.0' → [3,41,0]); null when the string is
 * not one (anchored pattern, no nesting — safe). */
function parseDotVersion(v: string): number[] | null {
  if (!/^\d+(\.\d+)*$/.test(v)) return null;
  return v.split('.').map((p) => Number.parseInt(p, 10));
}

function tupleCompare(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/* Newest same-side/same-gen catalog row for the label, ignoring flashable —
 * only used to explain WHY nothing flashable matched. */
function anyCandidate(cat: FwCatalog, side: 'left' | 'right', gen: 'A' | 'B', label: string): FwEntry | null {
  let best: FwEntry | null = null;
  for (const e of cat.images) {
    if (e.target !== 'keyboard' || e.side !== side || e.generation !== gen) continue;
    if ((e.createFirmware ?? e.versionLabel) !== label) continue;
    if (best === null || (e.releaseOrder ?? -1) > (best.releaseOrder ?? -1)) best = e;
  }
  return best;
}

export function resolveKeyboardPlan(
  cat: FwCatalog,
  halves: HalfInput[],
  vault: Vault,
  label: string,
): { halves: HalfPlan[] } {
  const declared = declaredSet(cat);
  const targetDeclared = declared.has(label);
  const targetRo = groupReleaseOrder(cat, label);
  const targetTuple = parseDotVersion(label);

  return {
    halves: halves.map((h) => {
      const info = h.pid === null ? null : pidInfo(h.pid);
      const generation = info === null ? null : info.generation;
      const currentVersion = h.fw ?? null;
      const currentDeclared = currentVersion !== null && declared.has(currentVersion);
      const unknownCurrent = currentVersion !== null && !declared.has(currentVersion);

      let downgrade = false;
      if (currentVersion !== null) {
        if (currentDeclared && targetDeclared && targetTuple !== null) {
          const cur = parseDotVersion(currentVersion);
          downgrade = cur !== null && tupleCompare(cur, targetTuple) > 0;
        } else {
          const curRo = groupReleaseOrder(cat, currentVersion);
          downgrade = curRo !== null && targetRo !== null && curRo > targetRo;
        }
      }

      let image: FwEntry | null = null;
      let reason: string | undefined;
      if (generation !== null) {
        image = findKeyboardImage(cat, h.side, generation, label);
        if (image === null) {
          const candidate = anyCandidate(cat, h.side, generation, label);
          if (candidate !== null) {
            const why = Array.isArray(candidate.withheldBecause) && candidate.withheldBecause.length > 0
              ? candidate.withheldBecause.join('; ')
              : 'withheld in the catalog';
            reason = `not flashable: ${why}`;
          } else {
            reason = 'no image for this half+generation';
          }
        }
      } else {
        reason = 'no image for this half+generation';
      }

      const present = image !== null && vault.has(image.blobSha256);
      const fetchable = image !== null
        && typeof image.historyPath === 'string'
        && image.historyPath !== '';
      const unchanged = currentVersion !== null && currentVersion === label;

      const plan: HalfPlan = {
        side: h.side,
        generation,
        currentVersion,
        image,
        present,
        fetchable,
        unchanged,
        downgrade,
        unknownCurrent,
      };
      if (reason !== undefined) plan.reason = reason;
      return plan;
    }),
  };
}
