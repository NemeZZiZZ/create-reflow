/* Troubleshooting knowledge base — one file per problem (plugin style).
 * Entry texts are live-proven on FW 0.3.41.0 — see docs/cdc-protocol.md,
 * toolkit/naya-undark.py and the KB recovery page. Cross-checked against
 * the Create Collective community KB (2026-10) — each scenario verified
 * against our own protocol ledger before inclusion.
 *
 * Deliberately NOT runnable (text-only, with warnings): 30/10ca factory
 * format (wipes the layer-list store), fa/* erase verbs, ee/10be / ee/10ae
 * resets, be/1004 UNPAIR ALL (drops every bond, computers included).
 * assertWireAllowed is the runtime guard. fe/100a is NOT banned: it is a
 * plain SET ACTIVITY TIMEOUTS write (the Behavior tab uses it) — recipes
 * simply never need it. */
import allKeysDead from "./all-keys-dead";
import batteryOdd from "./battery-odd";
import bootloaderParked from "./bootloader-parked";
import brightnessCapped from "./brightness-capped";
import brightnessWrap from "./brightness-wrap";
import darkHalf from "./dark-half";
import doubleTapEarly from "./double-tap-early";
import firmwareMismatch from "./firmware-mismatch";
import frozenWireless from "./frozen-wireless";
import layersDead from "./layers-dead";
import lightsWrongAfterFlash from "./lights-wrong-after-flash";
import moduleMissing from "./module-missing";
import nayaflowVerifyFail from "./nayaflow-verify-fail";
import overrideSilent from "./override-silent";
import partialFlash from "./partial-flash";
import portBusy from "./port-busy";
import rightCdcDeaf from "./right-cdc-deaf";
import splitLinkDead from "./split-link-dead";
import steppyAnim from "./steppy-anim";
import stuckLayer from "./stuck-layer";
import transportSulk from "./transport-sulk";
import type { TroubleEntry } from "./types";

export type {
  TroubleAction,
  TroubleCtx,
  TroubleEntry,
  WireStep,
} from "./types";
export { assertWireAllowed } from "./wire-guard";
export { UNDARK_LADDER, undarkSteps } from "./undark";

export const TROUBLES: TroubleEntry[] = [
  darkHalf,
  lightsWrongAfterFlash,
  brightnessCapped,
  steppyAnim,
  brightnessWrap,
  layersDead,
  portBusy,
  rightCdcDeaf,
  splitLinkDead,
  firmwareMismatch,
  bootloaderParked,
  moduleMissing,
  batteryOdd,
  overrideSilent,
  transportSulk,
  frozenWireless,
  allKeysDead,
  stuckLayer,
  doubleTapEarly,
  nayaflowVerifyFail,
  partialFlash,
];
