// Firmware tab (spec §9): the catalog library + the keyboard flash dialog.
// Wiring-only at this level — the procedure runs in useFirmwareFlash (App
// level), the fetch/planning in lib/firmware-fetch + lib/firmware-plan; the
// tab owns the catalog load and the library's download state machine.
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Cpu, Package } from 'lucide-react';
import FirmwareLibraryView from '../firmware/FirmwareLibraryView';
import type { LibraryNotice } from '../firmware/FirmwareLibraryView';
import KeyboardFlashDialog from '../firmware/KeyboardFlashDialog';
import type { KeyboardFlash } from '../firmware/KeyboardFlashDialog';
import ModuleFlashDialog from '../firmware/ModuleFlashDialog';
import { loadFirmwareCatalog } from '../../lib/firmware-catalog';
import type { FwCatalog } from '../../lib/firmware-catalog';
import { fetchVersion } from '../../lib/firmware-fetch';
import type { Vault } from '../../lib/firmware-fetch';
import type { SerialWorld } from '../../lib/serial-world';
import type { HalfSnapshot, Side } from '@create-reflow/sdk';

export default function FirmwareTab({
  flash,
  halves,
  world,
  vault,
  grant,
}: {
  flash: KeyboardFlash;
  halves: Record<Side, HalfSnapshot>;
  world: SerialWorld;
  vault: Vault;
  grant: { open: boolean; onGrant: () => Promise<void> };
}) {
  const [catalog, setCatalog] = useState<FwCatalog | null>(null);
  const [dlgOpen, setDlgOpen] = useState(false);
  const [modDlgOpen, setModDlgOpen] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, LibraryNotice>>({});

  // The loader memoizes its promise — remounts never re-parse the JSON.
  useEffect(() => {
    let cancelled = false;
    void loadFirmwareCatalog().then((c) => {
      if (!cancelled) setCatalog(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Library download: one version at a time; the fetch lib reports per
  // entry and never stores an unverified byte, so the notice is honest.
  const download = useCallback(
    async (label: string) => {
      if (catalog === null || downloading !== null) return;
      setDownloading(label);
      setNotices((p) => ({ ...p, [label]: { fetched: 0, failed: [] } }));
      const r = await fetchVersion(catalog, label, vault, {
        onOne: (one) => {
          if (one.ok) {
            setNotices((p) => ({ ...p, [label]: { ...(p[label] ?? { fetched: 0, failed: [] }), fetched: (p[label]?.fetched ?? 0) + 1 } }));
          } else {
            setNotices((p) => {
              const cur = p[label] ?? { fetched: 0, failed: [] };
              return {
                ...p,
                [label]: {
                  fetched: cur.fetched,
                  failed: [...cur.failed, { path: one.entry.historyPath ?? one.entry.file, reason: one.reason ?? 'fetch failed' }],
                },
              };
            });
          }
        },
      });
      setNotices((p) => ({
        ...p,
        [label]: { fetched: r.fetched, failed: r.failed },
      }));
      setDownloading(null);
    },
    [catalog, downloading, vault],
  );

  const anyOn = halves.left.connected || halves.right.connected;

  return (
    <div className="flex flex-col gap-3 p-1">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Keyboard firmware</div>
            <div className="text-[13px] text-muted-foreground">
              {anyOn
                ? 'Flash catalog versions onto connected halves — one run at a time, left half first.'
                : 'Connect a half first; the flash procedure refuses to run without a live session.'}
            </div>
          </div>
          <Button disabled={catalog === null} onClick={() => setDlgOpen(true)}>
            <Cpu /> Flash keyboard firmware…
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Module firmware</div>
            <div className="text-[13px] text-muted-foreground">
              Dock the module in the LEFT bay, unplug the right half — the module programs itself
              from a stored bundle.
            </div>
          </div>
          <Button disabled={catalog === null} onClick={() => setModDlgOpen(true)}>
            <Package /> Update module firmware…
          </Button>
        </CardContent>
      </Card>

      <FirmwareLibraryView
        catalog={catalog}
        vault={vault}
        downloading={downloading}
        notices={notices}
        onDownload={(label) => void download(label)}
      />

      <KeyboardFlashDialog
        open={dlgOpen}
        onOpenChange={setDlgOpen}
        catalog={catalog}
        halves={halves}
        world={world}
        vault={vault}
        flash={flash}
        grant={grant}
      />

      <ModuleFlashDialog
        open={modDlgOpen}
        onOpenChange={setModDlgOpen}
        catalog={catalog}
        left={halves.left}
        right={halves.right}
        vault={vault}
        flash={flash}
      />
    </div>
  );
}
