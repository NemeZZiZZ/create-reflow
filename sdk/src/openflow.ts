/* OpenFlow layer-doc parser (kind:'layer', version 1) → SnapMaps.
 * Pure — no device access, no React — fully smoke-testable. Records are
 * emitted by the exact builders behaviorSetOps queues (t10.ts / plainRecord),
 * so the parsed maps diff cleanly against live dumps via diffSnapshotToDraft.
 * Never throws on data: structural failures return {error}; every per-key
 * problem degrades to skip + a specific English warning (they surface
 * verbatim in the app log — partial restore is the point of subset imports).
 * Format: docs/superpowers/specs/2026-10-01-openflow-native-format-design.md */

import { hexToHs, hsToHex } from './naya';
import type { KeyRec, LedRec } from './naya';
import {
  plainRecord,
  t03Record,
  t10Primary,
  t10ShadowMini,
  t10ShadowFull,
  TAIL_T10,
  behaviorSetOf,
} from './t10';
import { nameToUsage, usageToName } from './host-table';
import { matchAction } from './actions';
import { ANIM_NAMES } from './settings';
import type { SnapMaps } from './importers';

/** Deterministic per-layer UUIDs (ours): layer L uses index L. Fixed so
 * exports are stable and layerRefs always resolve without any storage.
 * 8 entries — the app's layer window (the board stores layers 0..7). */
export const OF_LAYER_UUIDS: string[] = Array.from(
  { length: 8 },
  (_, L) => '6e726600-0000-4000-8000-00000000000' + L,
);

/** Whole-file result shape consumed by the importers/backups wrappers
 * (anims keyed by layer index). Defined here so later tasks share one type. */
export type ParseFileResult =
  | { maps: SnapMaps; anims: Record<number, number>; warnings: string[] }
  | { error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

interface Usage {
  page: number;
  usage: number;
}
type ResolvedAction =
  | ({ kind: 'usage' } & Usage)
  | { kind: 'layer'; order: number };

interface Slots {
  press: Usage | null;
  tap: Usage | null;
  hold: Usage | null;
  double: Usage | null;
  taphold: Usage | null;
}

const BEHAVIOR_SLOT: Record<string, keyof Slots> = {
  press: 'press',
  tap: 'tap',
  hold: 'hold',
  double_tap: 'double',
  tap_hold: 'taphold',
};

/* Layer-switch prefixes with no proven wire form on this device (special
 * family ORDER 1 = MO, 2 = hold-layer-2 only) — skip with a named warning. */
const LAYER_SKIP_PREFIXES = ['TO_LAYER_', 'TOGGLE_LAYER_', 'STICKY_LAYER_'];

/** Consumer-page (0x000c) plain T01 record — same shape plainRecord emits
 * for page 0x0007. Only usable for a base-only key: the T03/T10 behavior
 * quads hardcode page 0x0007 (their wire form has no page field). */
function consumerRecord(kk: number, usage: number): Uint8Array {
  return Uint8Array.from([kk & 0xff, 0x01, 0x04, usage & 0xff, 0x00, 0x0c, 0x00]);
}

/** One binding → a usage (page-tagged) or a layer action (T05 order).
 * Null (+warning) for anything unknown or unwritable. */
function resolveBinding(
  pos: number,
  actionType: string,
  actionCode: string,
  layerRefs: Record<string, unknown>,
  warnings: string[],
): ResolvedAction | null {
  if (actionType === 'key' || actionType === 'modifier') {
    const u = nameToUsage(actionCode);
    if (!u) {
      warnings.push(`key ${pos}: unknown actionCode '${actionCode}' — binding skipped`);
      return null;
    }
    if (u.page !== 0x0007 && u.page !== 0x000c) {
      warnings.push(
        `key ${pos}: '${actionCode}' is usage page 0x${u.page.toString(16).padStart(4, '0')} (only 0x0007/0x000c writable) — binding skipped`,
      );
      return null;
    }
    return { kind: 'usage', page: u.page, usage: u.usage };
  }
  if (actionType === 'layer_polite_hold') {
    if (actionCode.startsWith('MO_LAYER_')) {
      const uuid = actionCode.slice('MO_LAYER_'.length);
      const target = layerRefs[uuid];
      if (typeof target !== 'number') {
        warnings.push(`key ${pos}: MO_LAYER_ ref ${uuid} not in layerRefs — binding skipped`);
        return null;
      }
      if (target < 1 || target > 7) {
        warnings.push(
          `key ${pos}: MO_LAYER_ target layer ${target} invalid (0 = self; writable targets are 1-7) — binding skipped`,
        );
        return null;
      }
      return { kind: 'layer', order: target };
    }
    for (const p of LAYER_SKIP_PREFIXES) {
      if (actionCode.startsWith(p)) {
        warnings.push(`key ${pos}: ${p} actions unsupported (no proven wire form) — binding skipped`);
        return null;
      }
    }
    warnings.push(`key ${pos}: unknown layer actionCode '${actionCode}' — binding skipped`);
    return null;
  }
  warnings.push(`key ${pos}: unsupported actionType '${actionType}' — binding skipped`);
  return null;
}

/** Clamp the parsed slots to the wire behavior chain (spec §0.2), then emit
 * the exact record selection behaviorSetOps makes: tap_hold → primary + full
 * shadow + tail; double → primary + mini shadow + tail; hold → T03 (stale-
 * shadow cleanup is the flash-time diff's job, not the parser's); base-only
 * → plain T01. A non-page-7 base (consumer) clamps to the base-only record
 * with a warning — the T03/T10 quads hardcode page 0x0007. Returns []
 * (+warning) when nothing valid remains. */
function buildKeyRecords(pos: number, slots: Slots, warnings: string[]): Uint8Array[] {
  const { tap, hold } = slots;
  let { press, double, taphold } = slots;
  if (press && tap) {
    warnings.push(`key ${pos}: both press and tap set — tap set wins, press dropped`);
    press = null;
  }
  const base = tap ?? press;
  if (!base) {
    warnings.push(`key ${pos}: hold/double_tap/tap_hold without press or tap — key skipped`);
    return [];
  }
  if (double && !hold) {
    warnings.push(`key ${pos}: Double Tap dropped (hold missing) — device requires Hold before Double Tap`);
    double = null;
  }
  if (taphold && !double) {
    warnings.push(`key ${pos}: Tap+Hold dropped (double_tap missing) — device requires Double Tap first`);
    taphold = null;
  }
  const baseOnly = () => [
    base.page === 0x000c ? consumerRecord(pos, base.usage) : plainRecord(pos, base.usage),
  ];
  if (!hold) return baseOnly();
  // The chain quads hardcode page 0x0007 (t10.ts quad()) — a non-page-7 base
  // would be silently embedded as a keyboard usage and re-parse as a
  // different valid key. Clamp to the base-only record, same keep-the-safe-
  // subset rule as the press+double_tap clamp above (spec §0.2).
  if (base.page !== 0x0007) {
    warnings.push(
      `key ${pos}: hold chain dropped — consumer keys cannot combine with hold/double-tap`,
    );
    return baseOnly();
  }
  if (!double) return [t03Record(pos, hold.usage, base.usage)];
  return taphold
    ? [
        t10Primary(pos, hold.usage, base.usage),
        t10ShadowFull(pos, taphold.usage, double.usage),
        new Uint8Array(TAIL_T10),
      ]
    : [
        t10Primary(pos, hold.usage, base.usage),
        t10ShadowMini(pos, double.usage),
        new Uint8Array(TAIL_T10),
      ];
}

interface ParsedKey {
  pos: number;
  records: Uint8Array[];
  led: { h: number; s: number } | null;
}

/** Parse one OpenFlow layer doc into per-layer key/LED maps + the layer's
 * animation index (null when absent/unknown). The doc's single orderId
 * selects the layer: maps.layers === [L], records in keys[L]/leds[L].
 * KeyRec.t = record type byte, offset = index within the layer's record
 * list (same convention diffSnapshotToDraft consumers already see). */
export function parseOpenFlowLayer(
  obj: unknown,
): { maps: SnapMaps; anim: number | null; warnings: string[] } | { error: string } {
  if (!isObj(obj)) return { error: 'not an OpenFlow JSON object' };
  // Peek version BEFORE the kind check (UHK pattern): files from a newer
  // app must fail with an actionable message, never a cryptic shape error.
  if (typeof obj.version === 'number' && obj.version > 1)
    return {
      error: `OpenFlow version ${obj.version} is newer than this app supports (version 1) — update create-reflow`,
    };
  if (obj.version !== 1)
    return { error: `unsupported OpenFlow version ${String(obj.version)} (expected version 1)` };
  if (obj.kind !== 'layer')
    return { error: `unsupported kind '${String(obj.kind)}' — only kind 'layer' is importable` };
  if (!isObj(obj.layer)) return { error: 'OpenFlow layer doc missing the layer object' };
  const layer = obj.layer;
  const L = layer.orderId;
  if (typeof L !== 'number' || !Number.isInteger(L) || L < 0 || L > 7)
    return { error: `layer index ${String(L)} is outside this app's window (0-7)` };
  if (!Array.isArray(layer.keys)) return { error: 'layer.keys missing or not an array' };
  if (obj.layerRefs !== undefined && obj.layerRefs !== null && !isObj(obj.layerRefs))
    return { error: 'layerRefs malformed (expected an object mapping uuid → layer index)' };
  const layerRefs = isObj(obj.layerRefs) ? obj.layerRefs : {};

  const warnings: string[] = [];
  const parsed: ParsedKey[] = [];
  const seen = new Map<number, number>(); // positionId → index into parsed
  let strips = 0;
  let bays = 0;

  for (const entry of layer.keys as unknown[]) {
    if (!isObj(entry) || typeof entry.positionId !== 'number' || !Number.isInteger(entry.positionId)) {
      warnings.push('malformed key entry (no integer positionId) — skipped');
      continue;
    }
    const pos = entry.positionId;
    if (pos < 0 || pos > 96) {
      warnings.push(`positionId ${pos} out of range (0-96) — key skipped`);
      continue;
    }
    // 74–87 = LED strips, 88–96 = module bays: not backed by writable
    // device stores yet — counted, never records (not even LED records).
    if (pos >= 74 && pos <= 87) {
      strips++;
      continue;
    }
    if (pos >= 88) {
      bays++;
      continue;
    }
    if (seen.has(pos)) warnings.push(`positionId ${pos} duplicated — last wins`);

    let led: { h: number; s: number } | null = null;
    if (typeof entry.colorHex === 'string') led = hexToHs(entry.colorHex);

    const slots: Slots = { press: null, tap: null, hold: null, double: null, taphold: null };
    let layerOrder: number | null = null;
    if (entry.bindings !== undefined && !Array.isArray(entry.bindings))
      warnings.push(`key ${pos}: bindings is not an array — treated as empty`);
    const bindings = Array.isArray(entry.bindings) ? (entry.bindings as unknown[]) : [];
    for (const b of bindings) {
      if (
        !isObj(b) ||
        typeof b.behavior !== 'string' ||
        typeof b.actionType !== 'string' ||
        typeof b.actionCode !== 'string'
      ) {
        warnings.push(`key ${pos}: malformed binding — skipped`);
        continue;
      }
      const res = resolveBinding(pos, b.actionType, b.actionCode, layerRefs, warnings);
      if (!res) continue;
      if (res.kind === 'layer') {
        if (b.behavior !== 'press') {
          warnings.push(`key ${pos}: layer action only writable as press — binding skipped`);
          continue;
        }
        layerOrder = res.order;
        continue;
      }
      const slot = BEHAVIOR_SLOT[b.behavior];
      if (!slot) {
        warnings.push(`key ${pos}: unknown behavior '${b.behavior}' — binding skipped`);
        continue;
      }
      if (slot !== 'press' && res.page !== 0x0007) {
        warnings.push(
          `key ${pos}: consumer-page usage in the ${b.behavior} slot unsupported (behavior quads are page 0x0007 only) — binding skipped`,
        );
        continue;
      }
      if (slots[slot]) warnings.push(`key ${pos}: duplicate ${b.behavior} binding — last wins`);
      slots[slot] = { page: res.page, usage: res.usage };
    }

    const anySlot = slots.press ?? slots.tap ?? slots.hold ?? slots.double ?? slots.taphold;
    let records: Uint8Array[] = [];
    if (layerOrder !== null) {
      if (anySlot) {
        warnings.push(`key ${pos}: layer action combined with other bindings — layer action skipped`);
      } else {
        // T05 special record: [KK, 05, 04, ORDER u24LE] (1 = MO layer n).
        records = [Uint8Array.from([pos, 0x05, 0x04, layerOrder, 0x00, 0x00, 0x00])];
      }
    }
    if (records.length === 0 && anySlot) records = buildKeyRecords(pos, slots, warnings);

    const item: ParsedKey = { pos, records, led };
    const prev = seen.get(pos);
    if (prev !== undefined) parsed[prev] = item;
    else {
      seen.set(pos, parsed.length);
      parsed.push(item);
    }
  }

  if (strips > 0)
    warnings.push(`skipped ${strips} LED strip position(s) (74-87) — no writable device store yet`);
  if (bays > 0)
    warnings.push(`skipped ${bays} module bay position(s) (88-96) — no writable device store yet`);

  let anim: number | null = null;
  const animId = layer.animationId;
  if (typeof animId === 'string') {
    const idx = ANIM_NAMES.findIndex((n) => n.toLowerCase() === animId.toLowerCase());
    if (idx >= 0) anim = idx;
    else warnings.push(`unknown animationId '${animId}' — no animation op queued`);
  }

  if (Array.isArray(obj.macros) && obj.macros.length > 0)
    warnings.push(`skipped ${obj.macros.length} macro(s) — host-side only, firmware discards macro writes`);

  const keys: KeyRec[][] = Array.from({ length: 8 }, () => [] as KeyRec[]);
  const leds: LedRec[][] = Array.from({ length: 8 }, () => [] as LedRec[]);
  for (const item of parsed) {
    for (const rec of item.records)
      keys[L].push({ kk: rec[0], t: rec[1], rec, offset: keys[L].length });
    if (item.led)
      leds[L].push({ kk: item.pos, h: item.led.h, s: item.led.s, offset: leds[L].length });
  }
  return { maps: { keys, leds, layers: [L] }, anim, warnings };
}

/* ---- Export: one layer's caches → OpenFlow layer doc (spec §3) ---- */

/** Whole-file export envelope. Moved here from exporters.ts (deleted in
 * the legacy-snapshot clean break); counts keys are 'keys' (non-empty
 * binding keys), 'leds' (colorHex emitted), 'unknown' (records dropped
 * as unexportable). */
export interface ExportResult {
  fileName: string;
  data: unknown;
  counts: Record<string, number>;
}

interface OfBinding {
  behavior: string;
  actionType: string;
  actionCode: string;
  context: null;
}

interface OfKeyEntry {
  positionId: number;
  colorHex?: string;
  bindings: OfBinding[];
}

/* HID usages 0xe0–0xe7 are the modifier range (HID_MODS in actions.ts). */
const isModUsage = (u: number) => u >= 0xe0 && u <= 0xe7;

/** One key position → OpenFlow bindings. Uses behaviorSetOf (key families)
 * and matchAction (special/vendor families) — never re-derives record bytes
 * by hand. Anything unexportable (BT/mouse/LED/out-select/vendor families,
 * hold-layer2, matchAction misses, unmapped usages) drops to bindings []
 * plus counts.unknown++ — never guessed (spec §3). */
function bindingsFor(recs: KeyRec[], kk: number, counts: Record<string, number>): OfBinding[] {
  const prim = recs.find((r) => r.kk === kk);
  if (!prim) return [];
  const set = behaviorSetOf(recs, kk);
  if (set) {
    const out: OfBinding[] = [];
    // T10 chains export their base slot as 'tap'; plain T01 and T03 as
    // 'press' (parse maps press+hold → T03, tap+hold… → T10 — mirror image).
    const baseBehavior = prim.rec[1] === 0x10 ? 'tap' : 'press';
    const push = (behavior: string, usage: number | null) => {
      if (usage == null) return;
      const actionCode = usageToName(0x0007, usage);
      if (!actionCode) {
        counts.unknown++;
        return;
      }
      out.push({
        behavior,
        actionType: isModUsage(usage) ? 'modifier' : 'key',
        actionCode,
        context: null,
      });
    };
    push(baseBehavior, set.tap);
    push('hold', set.hold);
    push('double_tap', set.double);
    push('tap_hold', set.taphold);
    return out;
  }
  const act = matchAction(prim.rec);
  if (act?.id === 'special:1') {
    // T05 ORDER 1 = MO layer 1 → MO_LAYER_ ref to the deterministic uuid.
    return [
      {
        behavior: 'press',
        actionType: 'layer_polite_hold',
        actionCode: 'MO_LAYER_' + OF_LAYER_UUIDS[1],
        context: null,
      },
    ];
  }
  if (act && act.id.startsWith('cons:')) {
    // Consumer-page plain T01: behaviorSetOf only knows page 0x0007, so the
    // page-0x000c base-only key resolves here (quads are page-7-only by wire).
    const actionCode = usageToName(0x000c, prim.rec[3]);
    if (actionCode)
      return [{ behavior: 'press', actionType: 'key', actionCode, context: null }];
  }
  counts.unknown++;
  return [];
}

/** Export one layer's key/LED caches as an OpenFlow layer doc.
 * keys/leds are ONE layer's caches (KeyRec[]/LedRec[] as diffSnapshotToDraft
 * consumes; looked up by kk). Fully deterministic: fixed uuids, no
 * timestamps — two calls with equal inputs are deep-equal. Keys array is
 * exactly 97 entries ordered by positionId; strips (74–87) and bays (88–96)
 * are emitted with empty bindings and NO colorHex field (parse ignores
 * colorHex there, so no placeholder is written). Throws when layer is
 * outside the app's window 0..7 — an out-of-window srcId would produce a
 * doc no import can ever resolve. */
export function buildOpenFlowLayer(
  keys: KeyRec[],
  leds: LedRec[],
  layer: number,
  animId: string | null,
): ExportResult {
  if (!Number.isInteger(layer) || layer < 0 || layer > 7)
    throw new Error(`layer index ${layer} is outside this app's window (0-7)`);
  const counts: Record<string, number> = { keys: 0, leds: 0, unknown: 0 };
  const ledByKk = new Map<number, LedRec>();
  for (const l of leds) if (!ledByKk.has(l.kk)) ledByKk.set(l.kk, l);
  const ofKeys: OfKeyEntry[] = [];
  for (let pos = 0; pos <= 96; pos++) {
    const entry: OfKeyEntry = { positionId: pos, bindings: [] };
    if (pos <= 73) {
      const led = ledByKk.get(pos);
      if (led) {
        entry.colorHex = hsToHex(led.h, led.s);
        counts.leds++;
      }
      entry.bindings = bindingsFor(keys, pos, counts);
      if (entry.bindings.length > 0) counts.keys++;
    }
    ofKeys.push(entry);
  }
  const data = {
    version: 1,
    kind: 'layer',
    layer: {
      srcId: OF_LAYER_UUIDS[layer],
      name: `Layer ${layer}`,
      orderId: layer,
      iconId: null,
      animationId: animId ?? 'solid',
      keys: ofKeys,
    },
    macros: [] as unknown[],
    layerRefs: { [OF_LAYER_UUIDS[1]]: 1, [OF_LAYER_UUIDS[2]]: 2 },
  };
  return { fileName: `Layer_${layer}.openflow-layer.json`, data, counts };
}
