/* Firmware image fetch layer: in-memory blob vault + sha256-gated downloads
 * from the Create legacy firmware-history mirror.
 *
 * DOM-free: globalThis.crypto.subtle (node 22 + browsers) for the digest,
 * web Response/ReadableStream for the size-capped body read. The fetchFn is
 * injectable — tests pass a fake; production callers omit it and get global
 * fetch with an abort timeout.
 *
 * Nothing is stored on any failure: fetchImage validates historyPath,
 * blobSha256, HTTP status, the 8 MiB cap and the sha256 BEFORE returning,
 * and only fetchVersion (or the later flash caller) writes the vault —
 * after fetchImage has resolved. */

import type { FwCatalog, FwEntry } from './firmware-catalog';

export const FIRMWARE_SOURCE_BASE =
  'https://raw.githubusercontent.com/create-collective/create-legacy-firmware/main/firmware-history/';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MiB — largest catalog resource is 663,552 B
const DEFAULT_TIMEOUT_MS = 30_000;

/* In-memory blob store keyed by blobSha256. Nothing persists — the vault
 * lives for the flash session only. set() with a sha-less entry is a no-op
 * (unkeyable). */
export interface Vault {
  has(sha: string): boolean;
  set(e: FwEntry, bytes: Uint8Array): void;
  get(sha: string): Uint8Array | undefined;
  count(): number;
}

export function newVault(): Vault {
  const store = new Map<string, Uint8Array>();
  return {
    has: (sha) => store.has(sha),
    set: (e, bytes) => {
      const sha = e.blobSha256;
      if (typeof sha === 'string' && sha !== '') store.set(sha, bytes);
    },
    get: (sha) => store.get(sha),
    count: () => store.size,
  };
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* Real-fetch timeout: AbortSignal.timeout where it exists (node 22, modern
 * browsers), plain AbortController + setTimeout otherwise. Never applied to
 * an injected fetchFn — the injectee owns its timing. */
function timeoutSignal(ms: number): AbortSignal {
  const asAny = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof asAny.timeout === 'function') return asAny.timeout(ms);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), ms);
  return ctl.signal;
}

/* Fetch one catalog entry's blob, fully validated, or throw. The error
 * message for a digest mismatch ends with "— nothing was written": the
 * caller must treat the vault as untouched. */
export async function fetchImage(
  entry: FwEntry,
  opts?: { fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<Uint8Array> {
  if (typeof entry.historyPath !== 'string' || entry.historyPath === '')
    throw new Error(`firmware ${entry.file}: no historyPath in catalog entry`);
  const expected = entry.blobSha256;
  if (typeof expected !== 'string' || expected === '')
    throw new Error(`firmware ${entry.file}: no blobSha256 in catalog entry`);

  const url = FIRMWARE_SOURCE_BASE + entry.historyPath;
  const doFetch = opts?.fetchFn ?? fetch;
  const signal = opts?.fetchFn === undefined ? timeoutSignal(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS) : undefined;
  let res: Response;
  try {
    res = await doFetch(url, signal ? { signal } : undefined);
  } catch (err) {
    throw new Error(
      `firmware ${entry.historyPath}: fetch failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) throw new Error(`firmware ${entry.historyPath}: HTTP ${res.status}`);

  // Stream with the cap enforced DURING the read — never buffer first.
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`firmware ${entry.historyPath}: empty response body`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value == null || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      void reader.cancel().catch(() => {});
      throw new Error(
        `firmware ${entry.historyPath}: image exceeds the 8 MiB limit (over ${total} bytes)`,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, off);
    off += chunk.byteLength;
  }

  const got = toHex(await crypto.subtle.digest('SHA-256', bytes));
  if (got !== expected.toLowerCase())
    throw new Error(
      `firmware ${entry.historyPath}: sha256 mismatch — expected ${expected}, got ${got} — nothing was written`,
    );
  return bytes;
}

/* Fetch every historyPath-bearing catalog entry under a version label.
 * One failure never stops the rest; each attempt is reported through onOne.
 * Returns the split so callers can surface partial success. */
export async function fetchVersion(
  cat: FwCatalog,
  label: string,
  vault: Vault,
  opts?: {
    fetchFn?: typeof fetch;
    onOne?(r: { entry: FwEntry; ok: boolean; reason?: string }): void;
  },
): Promise<{ fetched: number; failed: { path: string; reason: string }[] }> {
  const targets = cat.images.filter(
    (e) =>
      (e.createFirmware ?? e.versionLabel) === label &&
      typeof e.historyPath === 'string' &&
      e.historyPath !== '',
  );
  let fetched = 0;
  const failed: { path: string; reason: string }[] = [];
  for (const entry of targets) {
    try {
      const bytes = await fetchImage(entry, opts?.fetchFn ? { fetchFn: opts.fetchFn } : undefined);
      vault.set(entry, bytes);
      fetched++;
      opts?.onOne?.({ entry, ok: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ path: entry.historyPath as string, reason });
      opts?.onOne?.({ entry, ok: false, reason });
    }
  }
  return { fetched, failed };
}
