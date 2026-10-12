/* Naya USB identity: VID + PID family table (OF backend
 * backend/openflow_backend/device/recovery.py:34-62, from NayaCore 6.11.0's
 * setCreateFlashGenerationFromPid).
 *
 * PID families (mask off bit 0x1000): 0x064/0x06F/0x07A = left
 * app/mcuboot/third, 0x0C8/0x0D3/0x0DE = right. Generation B is bit 0x1000.
 * Unknown PIDs → null — reported as unknown, never guessed (OF pid_info).
 *
 * RECOVERY_PIDS is the phase-9 brief's raw re-enumeration match list,
 * verbatim. Note: it carries bit 0x100 (0x16f/0x1d3), whereas OF derives the
 * gen-B recovery values as base | 0x1000 (0x106f/0x10d3) — those DO decode
 * through this table. Consumers matching recovery ports should be aware
 * (flagged in the task-3 report). */

export interface PidInfo {
  side: 'left' | 'right';
  mode: 'app' | 'mcuboot' | 'third';
  generation: 'A' | 'B';
}

export const NAYA_VID = 0x37d1;

export const RECOVERY_PIDS = [0x06f, 0x16f, 0x0d3, 0x1d3] as const;

export function pidInfo(pid: number): PidInfo | null {
  const generation: 'A' | 'B' = (pid & 0x1000) !== 0 ? 'B' : 'A';
  switch (pid & 0xefff) {
    case 0x064: return { side: 'left', mode: 'app', generation };
    case 0x06f: return { side: 'left', mode: 'mcuboot', generation };
    case 0x07a: return { side: 'left', mode: 'third', generation };
    case 0x0c8: return { side: 'right', mode: 'app', generation };
    case 0x0d3: return { side: 'right', mode: 'mcuboot', generation };
    case 0x0de: return { side: 'right', mode: 'third', generation };
    default: return null;
  }
}
