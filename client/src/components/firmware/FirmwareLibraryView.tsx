/* Catalog library view — the FirmwareLibrary.jsx port (spec §9 surface 1):
 * the vendored catalog browsed as groups (keyboard before module, newest
 * releaseOrder first), each row carrying its file, size, 12-char sha256
 * prefix and a flashable badge (withheld entries show "—" with the
 * catalog's own why in a tooltip). This is the catalog, not the flasher —
 * the header prose says so; downloads fetch on demand and are hash-checked
 * before any use (the fetch lib refuses everything else).
 *
 * Grouping is a pure local fold over the catalog (display-shaped rows for
 * the table); the download itself is FirmwareTab's state machine calling
 * lib/firmware-fetch.fetchVersion — this component only reports what the
 * vault already holds. */

import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Download } from 'lucide-react';
import type { FwCatalog, FwEntry } from '../../lib/firmware-catalog';
import type { Vault } from '../../lib/firmware-fetch';

/* One download's outcome, per group label — FirmwareTab owns the state. */
export interface LibraryNotice {
  fetched: number;
  failed: { path: string; reason: string }[];
}

interface LibRow {
  entry: FwEntry;
  sha12: string;
  size: number | null;
}

interface LibGroup {
  target: 'keyboard' | 'module';
  label: string;
  releaseOrder: number | null;
  declared: boolean;
  bundle?: string;
  rows: LibRow[];
  fetchable: boolean;
  bytes: number | null;
}

/* Display size: entry.size when the row carries a raw file size, else the
 * slot/resource size (mcuboot + littlefs rows). */
function sizeOf(e: FwEntry): number | null {
  if (typeof e.size === 'number') return e.size;
  if (typeof e.resourceSize === 'number') return e.resourceSize;
  return null;
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

/* The library groups: every catalog entry that carries a label, grouped by
 * (target, label); keyboard before module, newest releaseOrder first
 * (order-less groups sink), rows alphabetical by file within a group. */
export function libraryGroups(cat: FwCatalog): LibGroup[] {
  const map = new Map<string, LibGroup>();
  for (const e of cat.images) {
    if (e.target !== 'keyboard' && e.target !== 'module') continue;
    const label = e.createFirmware ?? e.versionLabel;
    if (typeof label !== 'string' || label === '') continue;
    const key = `${e.target}\u0000${label}`;
    let g = map.get(key);
    if (g === undefined) {
      g = {
        target: e.target,
        label,
        releaseOrder: typeof e.releaseOrder === 'number' ? e.releaseOrder : null,
        declared: e.versionConfidence !== 'unknown',
        bundle: typeof e.bundle === 'string' ? e.bundle : undefined,
        rows: [],
        fetchable: false,
        bytes: null,
      };
      map.set(key, g);
    }
    if (typeof e.releaseOrder === 'number' &&
        (g.releaseOrder === null || e.releaseOrder > g.releaseOrder)) {
      // The newest member speaks for the group (declared flag + bundle) —
      // the same rule lib/firmware-catalog.keyboardVersions applies.
      g.releaseOrder = e.releaseOrder;
      g.declared = e.versionConfidence !== 'unknown';
      g.bundle = typeof e.bundle === 'string' ? e.bundle : undefined;
    }
    g.rows.push({ entry: e, sha12: e.blobSha256.slice(0, 12), size: sizeOf(e) });
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.rows.sort((a, b) => a.entry.file.localeCompare(b.entry.file));
    let bytes = 0;
    let fetchable = false;
    for (const r of g.rows) {
      if (typeof r.entry.historyPath === 'string' && r.entry.historyPath !== '') {
        fetchable = true;
        if (r.size !== null) bytes += r.size;
      }
    }
    g.fetchable = fetchable;
    g.bytes = fetchable && bytes > 0 ? bytes : null;
  }
  const rank = (t: 'keyboard' | 'module'): number => (t === 'keyboard' ? 0 : 1);
  return groups.sort(
    (a, b) =>
      rank(a.target) - rank(b.target) ||
      (b.releaseOrder ?? -1) - (a.releaseOrder ?? -1) ||
      a.label.localeCompare(b.label),
  );
}

/* Side/generation chip text for keyboard rows ('left · A'); module rows
 * carry no side. */
function rowTag(e: FwEntry): string | null {
  if (e.target !== 'keyboard') return null;
  const parts: string[] = [];
  if (e.side !== null) parts.push(e.side);
  if (e.generation !== null) parts.push(`gen ${e.generation}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function GroupRow({ g, vault }: { g: LibGroup; vault: Vault }) {
  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{g.label}</div>
          <div className="text-xs text-muted-foreground">
            {g.declared
              ? g.bundle !== undefined
                ? `shipped in ${g.bundle}`
                : 'keyboard firmware'
              : 'no version number declared'}
            {g.releaseOrder !== null && ` · release order ${g.releaseOrder}`}
          </div>
        </div>
        <span className="ml-auto flex items-center gap-2">
          {g.bytes !== null && (
            <span className="tabular-nums text-xs text-muted-foreground">
              {fmtSize(g.bytes)}
            </span>
          )}
          {!g.fetchable && (
            <span className="text-xs text-muted-foreground">no fetchable source</span>
          )}
        </span>
      </div>
      <table className="w-full text-[13px]">
        <tbody>
          {g.rows.map((r) => {
            const held = vault.has(r.entry.blobSha256);
            const flashable = r.entry.flashable === true;
            const withheld =
              Array.isArray(r.entry.withheldBecause) && r.entry.withheldBecause.length > 0
                ? r.entry.withheldBecause.join(' ')
                : null;
            const tag = rowTag(r.entry);
            return (
              <tr key={r.entry.file + (tag ?? '')} className="border-t border-border first:border-t-0">
                <td className="px-3 py-1.5 font-mono text-xs">{r.entry.file}</td>
                <td className="px-2 py-1.5 text-xs text-muted-foreground">{tag ?? ''}</td>
                <td className="px-2 py-1.5 tabular-nums text-xs text-muted-foreground">
                  {r.size !== null ? fmtSize(r.size) : ''}
                </td>
                <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground" title={`sha256 ${r.entry.blobSha256}`}>
                  {r.sha12}…
                </td>
                <td className="px-2 py-1.5">
                  {flashable ? (
                    <Badge variant="ok">installable</Badge>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help text-muted-foreground" tabIndex={0}>—</span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        {withheld ?? 'withheld in the catalog'}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {held && <Badge variant="info">Downloaded</Badge>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function FirmwareLibraryView({
  catalog,
  vault,
  downloading,
  notices,
  onDownload,
}: {
  catalog: FwCatalog | null;
  vault: Vault;
  downloading: string | null;
  notices: Record<string, LibraryNotice>;
  onDownload: (label: string) => void;
}) {
  const groups = catalog !== null ? libraryGroups(catalog) : [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Firmware catalog</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-[13px] text-muted-foreground">
          This is the catalog, not the flasher — nothing here touches the
          keyboard. Images download on demand from the firmware-history mirror
          and are sha256-checked before any use; the Firmware tab flashes only
          what the catalog marks installable.
          {catalog !== null && (
            <>
              {' '}
              <span className="tabular-nums">
                {groups.length} version group{groups.length === 1 ? '' : 's'}
              </span>
              .
            </>
          )}
        </p>
        {catalog === null && (
          <p className="text-sm text-muted-foreground">Loading the catalog…</p>
        )}
        {groups.map((g) => {
          const n = notices[g.label];
          const busy = downloading === g.label;
          const allHeld =
            g.fetchable &&
            g.rows
              .filter((r) => typeof r.entry.historyPath === 'string' && r.entry.historyPath !== '')
              .every((r) => vault.has(r.entry.blobSha256));
          return (
            <div key={`${g.target}\u0000${g.label}`} className="flex flex-col gap-1.5">
              <GroupRow g={g} vault={vault} />
              <div className="flex flex-wrap items-center gap-2">
                {g.fetchable && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={downloading !== null}
                    onClick={() => onDownload(g.label)}
                  >
                    <Download />
                    {busy
                      ? `Fetching ${g.label}…`
                      : allHeld
                        ? `Re-download ${g.label}`
                        : `Download ${g.label}`}
                  </Button>
                )}
                {n !== undefined && (
                  <span className="text-xs text-muted-foreground">
                    {n.fetched > 0 &&
                      `${n.fetched} image${n.fetched === 1 ? '' : 's'} fetched, sha256 verified`}
                    {n.fetched > 0 && n.failed.length > 0 && ' · '}
                    {n.failed.length > 0 &&
                      `${n.failed.length} failed — ${n.failed[0]!.reason}`}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
