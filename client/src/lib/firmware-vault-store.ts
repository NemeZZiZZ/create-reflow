/* Persistent firmware vault backing store (IndexedDB, client-only).
 *
 * The in-memory Vault (lib/firmware-fetch) stays the runtime source of
 * truth and keeps its synchronous reads; this module only (a) rehydrates
 * persisted blobs into it at FirmwareTab mount — hydrateVault is
 * idempotent and never rejects — and (b) hands fetchVersion a write-
 * through sink so VERIFIED blobs (digest-gated, nothing else ever) survive
 * a page reload.
 *
 * Node-safe by construction: every indexedDB access sits behind a
 * `typeof indexedDB` guard, so importing the module (and calling
 * hydrateVault / vaultStore) in the node smoke bundle is a plain no-op.
 * The store is injectable — tests pass a fake; production callers omit it
 * and get the raw indexedDB singleton, dependency-free. A failed open,
 * read, or write degrades to "nothing persisted": persistence is
 * best-effort and never surfaces to the user. */

import type { FwEntry } from './firmware-catalog';
import type { Vault, VaultWriter } from './firmware-fetch';

const DB_NAME = 'create-reflow-fw-vault';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

/* One persisted blob. IDB structured-clones Uint8Array fine — no base64.
 * ArrayBuffer (never SharedArrayBuffer) so the hydrate digest accepts it. */
export interface VaultRow {
  sha: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/* What hydrateVault consumes and fetchVersion writes through: the real
 * IndexedDB store below satisfies it; tests inject fakes. */
export interface VaultStore extends VaultWriter {
  loadAll(): Promise<VaultRow[]>;
}

/* Memoized connection — one open per page; null once a open fails (then
 * every op is a no-op for the session, never a retry storm). */
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise === null) {
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME, { keyPath: 'sha' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      // blocked / onerror (private mode, quota, corruption) → no persistence
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return dbPromise;
}

async function putRow(sha: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  if (db === null) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ sha, bytes });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('vault store put failed'));
    tx.onabort = () => reject(tx.error ?? new Error('vault store put aborted'));
  });
}

async function loadRows(): Promise<VaultRow[]> {
  const db = await openDb();
  if (db === null) return [];
  return new Promise<VaultRow[]>((resolve) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const rows: unknown = req.result;
      resolve(Array.isArray(rows) ? (rows as VaultRow[]) : []);
    };
    req.onerror = () => resolve([]); // unreadable store hydrates nothing
  });
}

/* The app-wide IndexedDB store. In node (no indexedDB) every op degrades
 * to a no-op, so callers need no environment branch of their own. */
export function vaultStore(): VaultStore {
  return {
    put: (sha, bytes) => {
      void putRow(sha, bytes).catch(() => {}); // fire-and-forget by contract
    },
    loadAll: () => loadRows(),
  };
}

/* Load every persisted row into the in-memory vault. Idempotent (a row
 * whose key the vault already holds just overwrites with equal bytes),
 * never rejects, and silently skips anything corrupt: shape, hex sha, and
 * — the vault contract — the digest of the bytes themselves are all
 * re-verified before a row lands. With no store injected and no indexedDB
 * (node) this resolves having done nothing. */
export async function hydrateVault(vault: Vault, store?: VaultStore | null): Promise<void> {
  const s = store !== undefined ? store : typeof indexedDB === 'undefined' ? null : vaultStore();
  if (s === null || s === undefined) return;
  let rows: unknown;
  try {
    rows = await s.loadAll();
  } catch {
    return; // an unreadable store hydrates nothing — never throws
  }
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const { sha, bytes } = row as VaultRow;
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/i.test(sha)) continue;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) continue;
    let got = '';
    try {
      got = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      continue;
    }
    if (got !== sha.toLowerCase()) continue; // corrupt/tampered — skip
    // set() only reads blobSha256; the synthetic carrier keeps the stored
    // sha VERBATIM (uppercase catalog shas round-trip their own key form).
    const carrier: FwEntry = {
      file: '(persisted)',
      target: 'keyboard',
      type: 'app',
      side: null,
      generation: null,
      flashable: false,
      blobSha256: sha,
    };
    vault.set(carrier, bytes);
  }
}
