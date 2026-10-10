/** 0-padded 2-digit hex with 0x prefix: 0x3e, 0x0a, … */
export const hex2 = (n: number) => '0x' + n.toString(16).padStart(2, '0');
