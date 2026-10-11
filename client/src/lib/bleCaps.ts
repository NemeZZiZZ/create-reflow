/** App-wide BLE capability cache — ONE module-level instance shared by all
 * readAux() callers (30s sweep, manual refresh, connect-time read), so a
 * be/1006 + be/100f verb recorded unanswered for a (side, fw) skips the wire
 * on every sweep until the firmware changes. Negative-only: answered verbs
 * are always re-asked. */
import { BleCapabilityCache } from '@create-reflow/sdk';

export const bleCaps = new BleCapabilityCache();
