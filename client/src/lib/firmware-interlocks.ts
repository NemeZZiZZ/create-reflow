/* Flash interlock gate — the safety check every flash procedure consults
 * before any byte is written to a device. Pure: no I/O and no device calls;
 * the procedure assembles the input from live values (held artifact digest,
 * device-reported slot-0 hash, PID-derived side/generation, sizes, dock
 * state) and the gate answers with the list of refusal strings — an empty
 * list is the only green light. Multiple violations all collect, so the run
 * log can show everything wrong at once.
 *
 * Rule set and refusal copy mirror OpenFlow's firmware_upload.py refusal
 * logic (spec §7): the arm token must be the device-reported slot-0 hash of
 * THIS run, never boolean, never cached (firmware_upload.py:574-576,
 * 683-686); slot caps 663,552 B keyboard / exactly 1,048,576 B module bundle
 * (180-183, 555-558); catalog flashability and the sha256 gate (374-414);
 * side/generation agreement (528-536, 417-429); downgrade needs allowOlder
 * (432-450); unknown current firmware needs consent (453-473); keyboard
 * flash refuses with any module docked (flash_procedure.py:290-306); a
 * module bundle newer than the keyboard firmware is a pairing refusal
 * (firmware_upload.py:953-994); and the type cross — littlefs is never a
 * keyboard image, mcuboot never a module image (497-501, 1042-1046).
 *
 * forceType lifts ONLY the module type-identification blocker — never the
 * bay, undocked, right-half, arm-token, or catalog-flashable rules. */

import type { FwEntry } from './firmware-catalog';

export interface KeyboardGateInput {
  kind: 'keyboard';
  entry: FwEntry;
  heldSha256: string;
  arm: string | null;
  slot0Hash: string | null;
  pidSide: 'left' | 'right';
  pidGeneration: 'A' | 'B';
  fileSize: number;
  downgrade: boolean;
  allowOlder: boolean;
  unknownCurrent: boolean;
  consented: boolean;
  modulesDocked: boolean;
  uploadImageId: number;
}

export interface ModuleGateInput {
  kind: 'module';
  entry: FwEntry;
  heldSha256: string;
  arm: string | null;
  slot0Hash: string | null;
  fileSize: number;
  bundleNewerThanKeyboard: boolean;
  downgrade: boolean;
  allowOlder: boolean;
  rightConnected: boolean;
  moduleDockedSide: 'left' | 'right' | null;
  uploadImageId: number;
  forceType: string | null;
}

/* Keyboard slot cap (OF firmware_upload.py:180-183, 555-558) and the module
 * bundle size (unmapped bundles are exactly 1 MiB). Keyboard uploads target
 * image 2, module uploads image 4 (upload-target numbering, 158-194). */
const KB_SLOT_MAX = 663_552;
const MODULE_BUNDLE_BYTES = 1_048_576;
const KB_UPLOAD_IMAGE_ID = 2;
const MOD_UPLOAD_IMAGE_ID = 4;

export function checkFlashGate(input: KeyboardGateInput | ModuleGateInput): string[] {
  const refusals: string[] = [];

  /* sha gate (OF 374-414): the held bytes must be THIS catalog image,
   * verified by digest — never name-keyed, never unverified. */
  if (input.heldSha256 !== input.entry.blobSha256)
    refusals.push('sha mismatch: held bytes are not this catalog image');

  /* catalog flashability: the catalog can withhold images (beta channel,
   * pre-history); the withheldBecause text travels with the refusal. */
  if (!input.entry.flashable) {
    const why = input.entry.withheldBecause;
    refusals.push(why !== undefined && why.length > 0
      ? `not flashable: ${why.join('; ')}`
      : 'not flashable');
  }

  /* arm token (OF 574-576, 683-686): the flash call must carry the
   * device-reported slot-0 hash of THIS run — null or stale refuses. */
  if (input.arm === null || input.arm !== input.slot0Hash)
    refusals.push('arm token must equal the device-reported slot-0 hash from this run');

  if (input.kind === 'keyboard') {
    /* type cross (OF 497-501): a littlefs bundle is never a keyboard image. */
    if (input.entry.type === 'littlefs')
      refusals.push('type cross: littlefs is never a keyboard image');
    if (input.uploadImageId !== KB_UPLOAD_IMAGE_ID)
      refusals.push('uploadImageId must be 2 for a keyboard');
    if (input.fileSize > KB_SLOT_MAX)
      refusals.push('keyboard image exceeds the 663,552-byte slot cap');
    /* any module on either half blocks the keyboard flash
     * (flash_procedure.py:290-306). */
    if (input.modulesDocked)
      refusals.push('modules are docked — undock them before flashing the keyboard');
    if (input.downgrade && !input.allowOlder)
      refusals.push('downgrade refused without allowOlder');
    if (input.unknownCurrent && !input.consented)
      refusals.push('current firmware is unknown — consent required before flashing');
    /* side/generation agreement (OF 528-536, 417-429): the running half
     * (PID-derived) must be the half the catalog entry was built for. */
    if (input.entry.side !== input.pidSide || input.entry.generation !== input.pidGeneration)
      refusals.push('catalog entry side/generation does not match the half');
  } else {
    /* type cross (OF 1042-1046): an mcuboot image is never a module bundle.
     * forceType lifts ONLY this identification blocker. */
    if (input.forceType === null && input.entry.type === 'mcuboot')
      refusals.push('type cross: mcuboot is never a module image');
    if (input.uploadImageId !== MOD_UPLOAD_IMAGE_ID)
      refusals.push('uploadImageId must be 4 for a module');
    if (input.fileSize !== MODULE_BUNDLE_BYTES)
      refusals.push('module bundle must be exactly 1,048,576 bytes');
    if (input.rightConnected)
      refusals.push('right half is connected — unplug it before flashing modules');
    /* bay rule: the module programs only from the LEFT bay. forceType never
     * lifts this — it is physical position, not identification. */
    if (input.moduleDockedSide !== 'left')
      refusals.push('module must be docked in the left bay');
    if (input.downgrade && !input.allowOlder)
      refusals.push('downgrade refused without allowOlder');
    /* pairing (OF 953-994): bundle must not be newer than the keyboard. */
    if (input.bundleNewerThanKeyboard)
      refusals.push('bundle is newer than the keyboard firmware — update the keyboard first');
  }

  return refusals;
}
