// Interrupt Flavor policy dictionary.
//
// NayaFlow exposes Interrupt Flavor as a 4-way policy: how a hold-tap key
// resolves when interrupted by another keypress. It is INDEPENDENT of the
// tapping term (milliseconds, 10-1000 slider).
//
// Wire encoding (cross-source, Create-knowledge-base, measured by typing
// test 2026-09): the flavor byte is the "body flags" byte inside EVERY
// hold-tap record — T03 byte 5 / T10 byte 8: 00 = hold-preferred,
// 01 = balanced, 02 = tap-preferred, 03 = tap-unless-interrupted
// (03 inferred, not measured). Notably NayaFlow's default "Balanced"
// writes 00 = hold-preferred. We have not yet re-verified this on our own
// hardware (flavor-diff pending), so bytes ride only when the user
// explicitly picks a flavor in the UI.

export type FlavorId =
  | 'balanced'
  | 'hold-preferred'
  | 'tap-preferred'
  | 'tap-unless-interrupted';

/** FlavorId → wire byte (hold-tap body flags). */
export const FLAVOR_BYTES: Record<FlavorId, number> = {
  'hold-preferred': 0x00,
  balanced: 0x01,
  'tap-preferred': 0x02,
  'tap-unless-interrupted': 0x03,
};

/** Wire byte → FlavorId; unknown bytes map to hold-preferred (stock 00). */
export function flavorOfByte(b: number): FlavorId {
  return (Object.keys(FLAVOR_BYTES) as FlavorId[]).find(
    (k) => FLAVOR_BYTES[k] === b,
  ) ?? 'hold-preferred';
}

export interface Flavor {
  id: FlavorId;
  name: string;
  blurb: string;
}

export const FLAVORS: Flavor[] = [
  {
    id: 'balanced',
    name: 'Balanced',
    blurb: 'Default. Tap wins on quick press, hold wins when held past the tapping term.',
  },
  {
    id: 'hold-preferred',
    name: 'Hold–Preferred',
    blurb: 'Bias toward hold: interrupted presses resolve as hold more often.',
  },
  {
    id: 'tap-preferred',
    name: 'Tap–Preferred',
    blurb: 'Bias toward tap: interrupted presses resolve as tap more often.',
  },
  {
    id: 'tap-unless-interrupted',
    name: 'Tap–Unless Interrupted',
    blurb: 'Always tap unless another key interrupts the press.',
  },
];

export function flavorById(id: string): Flavor | undefined {
  return FLAVORS.find((f) => f.id === id);
}
