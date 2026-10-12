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

/* Naya devices report a leading-zero form ('v0.3.41.0' on fe/1002,
 * 'v0.2.3.3' on de/1008) while the catalog labels bare semver ('3.41.0',
 * '2.3.3') — live-proven on real hardware on both verbs (phase 10,
 * 2026-10-13). Drop one leading zero component when it leaves a valid
 * remainder with a nonzero head; genuine '0.0.x' is never mangled. */
export function stripNayaLeadingZero(v: string): string {
  if (!v.startsWith('0.')) return v;
  const rest = v.slice(2);
  if (!/^\d+(\.\d+)*$/.test(rest)) return v;
  const head = rest.split('.')[0];
  return head !== undefined && head !== '' && head !== '0' ? rest : v;
}

/* Strict dot-version tuple ('3.41.0' → [3,41,0], Naya '0.3.41.0' → [3,41,0]);
 * null when the string is not one (anchored pattern, no nesting — safe). */
function parseDotVersion(v: string): number[] | null {
  const s = stripNayaLeadingZero(v);
  if (!/^\d+(\.\d+)*$/.test(s)) return null;
  return s.split('.').map((p) => Number.parseInt(p, 10));
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

/* ---- module bundle plan (spec §6 preconditions) --------------------------- */

/* The label a module bundle entry groups under: the catalog's declared
 * module firmware version when the row carries one, else versionLabel
 * (the no-number era rows — all withheld anyway). */
function moduleLabel(e: FwEntry): string | undefined {
  return e.moduleFirmware ?? e.versionLabel;
}

/* Newest flashable module bundle row for a label. */
function newestModuleBundle(cat: FwCatalog, label: string): FwEntry | null {
  let best: FwEntry | null = null;
  for (const e of cat.images) {
    if (e.target !== 'module' || e.type !== 'littlefs' || e.flashable !== true) continue;
    if (moduleLabel(e) !== label) continue;
    if (best === null || (e.releaseOrder ?? -1) > (best.releaseOrder ?? -1)) best = e;
  }
  return best;
}

export interface ModulePlan {
  side: 'module';
  /** The picked bundle entry (null = nothing usable — see reason). */
  entry: FwEntry | null;
  /** moduleFirmware ?? versionLabel of the entry. */
  target: string | null;
  /** Pairing guard (OF firmware_upload.py:953-994): the bundle's
   * keyboardRange.from is NEWER than the running keyboard firmware. */
  bundleNewerThanKeyboard: boolean;
  downgrade: boolean;
  /** The docked module already reports the target version. */
  unchanged: boolean;
  /** True when a specific label was requested but no flashable bundle
   * carries it (the dialog disables those options; the procedure refuses). */
  noSuchBundle: boolean;
  reason?: string;
}

/* Module bundle selection (spec §6): the newest flashable littlefs
 * target=module entry whose `keyboardRange.from` ≤ the running keyboard
 * firmware — pairing guard by construction. A specific `label` picks that
 * version instead (the dialog offers older bundles; newer-than-keyboard
 * ones come back flagged, and the gate refuses them). keyboardFw null (the
 * half's version was unreadable) cannot prove any range: refused honestly,
 * never guessed. Downgrade/unchanged compare the dock-reported module fw
 * (de/1008) against the target with trailing-zero-insensitive tuples —
 * the wire carries '2.3.3.0', the catalog labels '2.3.3'. */
export function resolveModulePlan(
  cat: FwCatalog,
  keyboardFw: string | null,
  currentModuleFw: string | null,
  label?: string,
): ModulePlan {
  const kbTuple = keyboardFw !== null ? parseDotVersion(keyboardFw) : null;
  if (keyboardFw !== null && kbTuple === null) {
    return {
      side: 'module', entry: null, target: null, bundleNewerThanKeyboard: false,
      downgrade: false, unchanged: false, noSuchBundle: false,
      reason: `the keyboard reports "${keyboardFw}" — not a comparable version`,
    };
  }

  // The keyboard must at least MEET the bundle's range floor: from ≤ kbFw.
  const rangeOk = (e: FwEntry): boolean => {
    const from = e.keyboardRange?.from;
    if (typeof from !== 'string') return true; // no declared range — not bundle-gated
    const t = parseDotVersion(from);
    return t === null || (kbTuple !== null && tupleCompare(kbTuple, t) >= 0);
  };

  if (label !== undefined) {
    const entry = newestModuleBundle(cat, label);
    if (entry === null) {
      return {
        side: 'module', entry: null, target: null, bundleNewerThanKeyboard: false,
        downgrade: false, unchanged: false, noSuchBundle: true,
        reason: `no flashable module bundle labeled ${label}`,
      };
    }
    const newer = !rangeOk(entry);
    const target = moduleLabel(entry) ?? null;
    const curTuple = currentModuleFw !== null ? parseDotVersion(currentModuleFw) : null;
    const tgtTuple = target !== null ? parseDotVersion(target) : null;
    const downgrade = curTuple !== null && tgtTuple !== null && tupleCompare(curTuple, tgtTuple) > 0;
    const unchanged = curTuple !== null && tgtTuple !== null && tupleCompare(curTuple, tgtTuple) === 0;
    const plan: ModulePlan = {
      side: 'module', entry, target, bundleNewerThanKeyboard: newer,
      downgrade, unchanged, noSuchBundle: false,
    };
    if (newer && entry.keyboardRange?.from !== undefined) {
      plan.reason = `the ${label} bundle needs keyboard ${entry.keyboardRange.from} or newer`;
    }
    return plan;
  }

  // Auto-pick: newest releaseOrder among the flashable bundles the running
  // keyboard firmware can take.
  let best: FwEntry | null = null;
  for (const e of cat.images) {
    if (e.target !== 'module' || e.type !== 'littlefs' || e.flashable !== true) continue;
    if (!rangeOk(e)) continue;
    if (best === null || (e.releaseOrder ?? -1) > (best.releaseOrder ?? -1)) best = e;
  }
  if (best === null) {
    return {
      side: 'module', entry: null, target: null, bundleNewerThanKeyboard: false,
      downgrade: false, unchanged: false, noSuchBundle: false,
      reason: keyboardFw === null
        ? 'the keyboard firmware version is unreadable — cannot check bundle compatibility'
        : 'no flashable module bundle is compatible with this keyboard firmware',
    };
  }
  const target = moduleLabel(best) ?? null;
  const curTuple = currentModuleFw !== null ? parseDotVersion(currentModuleFw) : null;
  const tgtTuple = target !== null ? parseDotVersion(target) : null;
  return {
    side: 'module',
    entry: best,
    target,
    bundleNewerThanKeyboard: false,
    downgrade: curTuple !== null && tgtTuple !== null && tupleCompare(curTuple, tgtTuple) > 0,
    unchanged: curTuple !== null && tgtTuple !== null && tupleCompare(curTuple, tgtTuple) === 0,
    noSuchBundle: false,
  };
}

/* Distinct installable module bundle versions, newest releaseOrder first —
 * the module dialog's version picker. Only flashable littlefs rows group
 * (withheld bundles are not offered), same discipline as keyboardVersions. */
export function moduleBundles(cat: FwCatalog): Array<{ label: string; entry: FwEntry; keyboardFrom: string | null }> {
  const groups = new Map<string, FwEntry>();
  for (const e of cat.images) {
    if (e.target !== 'module' || e.type !== 'littlefs' || e.flashable !== true) continue;
    const label = moduleLabel(e);
    if (typeof label !== 'string' || label === '') continue;
    const cur = groups.get(label);
    if (cur === undefined || (e.releaseOrder ?? -1) > (cur.releaseOrder ?? -1)) groups.set(label, e);
  }
  return [...groups.entries()]
    .map(([label, entry]) => ({
      label,
      entry,
      keyboardFrom: typeof entry.keyboardRange?.from === 'string' ? entry.keyboardRange.from : null,
    }))
    .sort((a, b) => (b.entry.releaseOrder ?? -1) - (a.entry.releaseOrder ?? -1));
}
