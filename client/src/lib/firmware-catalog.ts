/* Firmware catalog over the vendored OpenFlow reference catalog
 * (client/src/data/firmware-catalog.source.json — a byte-identical copy of
 * openflow docs/reference/firmware-catalog.json, 101,398 B, cmp-verified;
 * no codegen: the file is already compact metadata).
 *
 * The loader memoizes its promise like app-shortcuts.ts: module-level
 * promise, `import(...)` cast through unknown, shape validated before use.
 * The dynamic import keeps the ~100 KB catalog out of the eager graph (its
 * own lazy chunk in the production build; the smoke bundle inlines it under
 * codeSplitting:false, §66 precedent).
 *
 * DOM-free at module top level — the smoke bundle runs under node.
 *
 * Validation note: the task brief says "every entry has string
 * file/target/blobSha256", but the real catalog's 30 module-component rows
 * (Touch_UserApp.sfb etc.) carry `sha256` + `container`/`containerBlobSha256`
 * and NO blobSha256 — a literal reading would reject the vendored file that
 * §69(a) requires to load. The check is therefore: string file/target on
 * every entry, and a string blobSha256 ?? sha256 (every entry is
 * hash-identified either way). */

export interface FwEntry {
  file: string;
  target: string;
  type: string;
  side: 'left' | 'right' | null;
  generation: 'A' | 'B' | null;
  flashable: boolean;
  withheldBecause?: string[];
  blobSha256: string;
  plaintextSha256?: string;
  resourceSize?: number;
  historyPath?: string;
  createFirmware?: string;
  moduleFirmware?: string;
  versionLabel?: string;
  versionConfidence?: string;
  releaseOrder?: number;
  bundle?: string;
  bundles?: string[];
  keyboardRange?: { from: string; below: string | null };
  component?: string;
  container?: string;
  sha256?: string;
  size?: number;
  [k: string]: unknown;
}

export interface FwCatalog {
  generated: string;
  images: FwEntry[];
  releases: unknown[];
  [k: string]: unknown;
}

export interface KeyboardVersion {
  label: string;
  declared: boolean;
  releaseOrder: number;
  bundle?: string;
}

/* Version label an entry groups under: the app-declared firmware version
 * when the release declared one, else the human versionLabel
 * (e.g. 'NayaFlow 1.14.3' for the no-number era). */
function entryLabel(e: FwEntry): string | undefined {
  return e.createFirmware ?? e.versionLabel;
}

/* Validate an already-unwrapped catalog object. Exported so the smoke can
 * exercise the throw paths on doctored shapes without a second file. */
export function parseFirmwareCatalog(raw: unknown): FwCatalog {
  if (raw === null || typeof raw !== 'object')
    throw new Error('firmware-catalog: not an object');
  const c = raw as FwCatalog;
  if (!Array.isArray(c.images) || c.images.length === 0)
    throw new Error('firmware-catalog: images must be a non-empty array');
  for (const row of c.images) {
    if (row === null || typeof row !== 'object')
      throw new Error('firmware-catalog: image entry is not an object');
    const e = row as FwEntry;
    if (typeof e.file !== 'string' || typeof e.target !== 'string')
      throw new Error(`firmware-catalog: entry without string file/target (${String(e.file)})`);
    const sha = typeof e.blobSha256 === 'string' ? e.blobSha256 : e.sha256;
    if (typeof sha !== 'string')
      throw new Error(`firmware-catalog: entry without blobSha256/sha256 (${e.file})`);
  }
  return c;
}

let catPromise: Promise<FwCatalog> | null = null;

export function loadFirmwareCatalog(): Promise<FwCatalog> {
  if (!catPromise) {
    catPromise = (async () => {
      const mod = (await import('../data/firmware-catalog.source.json')) as unknown;
      const raw = ((mod as { default?: unknown }).default ?? mod) as unknown;
      return parseFirmwareCatalog(raw);
    })();
  }
  return catPromise;
}

/* Distinct installable keyboard versions, newest releaseOrder first.
 * Only flashable keyboard entries group (the catalog withholds beta and
 * pre-history images as "not offered to install", and those rows carry
 * releaseOrder null — the version picker feeds flashing, so withheld
 * versions are not listed). Group identity is the label; the newest member
 * speaks for the group (declared flag + bundle). */
export function keyboardVersions(cat: FwCatalog): KeyboardVersion[] {
  const groups = new Map<string, FwEntry[]>();
  for (const e of cat.images) {
    if (e.target !== 'keyboard' || e.flashable !== true) continue;
    if (typeof e.releaseOrder !== 'number') continue;
    const label = entryLabel(e);
    if (typeof label !== 'string' || label === '') continue;
    const g = groups.get(label);
    if (g) g.push(e);
    else groups.set(label, [e]);
  }
  const out: KeyboardVersion[] = [];
  for (const [label, members] of groups) {
    const best = members.reduce((a, b) => (b.releaseOrder! > a.releaseOrder! ? b : a));
    out.push({
      label,
      declared: best.versionConfidence !== 'unknown',
      releaseOrder: best.releaseOrder!,
      bundle: typeof best.bundle === 'string' ? best.bundle : undefined,
    });
  }
  return out.sort((a, b) => b.releaseOrder - a.releaseOrder);
}

/* Find the flashable keyboard image for a half + generation + version label.
 * Matching is BY ENTRY (side+gen+label → the hash-bearing row) — never by
 * file name: kb_fwl.bin appears 14 times in the catalog across versions, so
 * a name-keyed lookup would be wrong. Ties (never in current data) resolve
 * to the newest releaseOrder. */
export function findKeyboardImage(
  cat: FwCatalog,
  side: 'left' | 'right',
  gen: 'A' | 'B',
  label: string,
): FwEntry | null {
  let best: FwEntry | null = null;
  for (const e of cat.images) {
    if (e.target !== 'keyboard' || e.flashable !== true) continue;
    if (e.side !== side || e.generation !== gen) continue;
    if (entryLabel(e) !== label) continue;
    if (best === null || (e.releaseOrder ?? -1) > (best.releaseOrder ?? -1)) best = e;
  }
  return best;
}
