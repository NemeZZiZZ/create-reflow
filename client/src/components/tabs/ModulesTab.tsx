// Modules tab (Phase 5b Task 3): the module-profile editor.
//
// Left rail: the docked modules (rail/FW info, ModuleRow idiom kept), the
// Read from keyboard button (capture-on-read lives in the hook), the
// profile list with type badges + live/dirty verdicts, and Add / Rename /
// Delete. Deleting names the layers whose bays reference the profile and
// refuses to remove the last profile of a type; more than 8 profiles gets
// a warning (the board's module list holds 8 entries — the planner
// refuses beyond that).
//
// Right pane, per selected profile: gesture rows grouped by target
// (button / finger-count tabs, target-less rows above) and a Settings tab
// with the modeled settings plus one-click "Use the keyboard's value"
// adoption when a read verdict disagrees.
//
// EVERY edit here mutates the hook's profile store — never the Draft.
// Draft ops for modules come only from flash planning (useFlash pre-step);
// flashing is the queue's job, this tab is the source of truth the plan
// reads FROM.
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { MODULE_LIST_WINDOW, SETTING_FIELDS, STOCK_PROFILES, toHex } from '@create-reflow/sdk';
import type {
  ConfigRecords,
  DiffRow,
  HalfSnapshot,
  ModuleProfile,
  ModuleType,
  Side,
} from '@create-reflow/sdk';
import { useModuleProfiles } from '../../hooks/useModuleProfiles';
import GestureRow from './modules/GestureRow';
import ModuleBindingDialog from './modules/ModuleBindingDialog';
import type { BindingEditorTarget } from './modules/ModuleBindingDialog';
import { fieldsOfGesture, gestureRows, groupByTarget, targetLabel } from './modules/bindings';
import { cn } from '../../lib/utils';

const TYPE_BADGE: Record<ModuleType, 'info' | 'ok' | 'default'> = {
  TOUCH: 'info',
  TRACK: 'ok',
  TUNE: 'default',
  FLOAT: 'default',
};

const SETTING_LABELS: Record<string, string> = {
  pointer_speed: 'Pointer speed',
  scroll_speed: 'Scroll speed',
  pointer_accel: 'Pointer acceleration',
  pointer_accel_on: 'Pointer acceleration on',
  ticks_per_rotation: 'Ticks per rotation',
  tick_strength: 'Tick strength',
  toggle_ticks: 'Toggle ticks',
};

/** One Add menu entry per module type that has a stock seed (the hook
 * clones the type's first stock map). */
const ADD_SEEDS: { type: ModuleType; label: string }[] = [
  ...new Set(STOCK_PROFILES.map((p) => p.type)),
].map((type) => ({ type, label: `${type.charAt(0)}${type.slice(1).toLowerCase()} profile` }));

/** One profile's read verdict, collapsed from the per-slot live map
 * (matched beats closest when two same-type slots carry the profile). */
interface ProfileLive {
  onDevice: boolean;
  slot: number | null;
  differs: number;
  drift: Map<string, DiffRow>;
  settings: Record<string, number>;
  records: ConfigRecords | null;
}

function ModuleRow({ half, info }: { half: string; info: HalfSnapshot }) {
  if (!info.modPresent)
    return (
      <div className="py-2 text-sm text-muted-foreground">
        {half}: no module docked
      </div>
    );
  const rail =
    info.modMv !== null
      ? `${info.modMv} mV${info.modPctVal !== null ? ` (≈${info.modPctVal}%)` : ''}`
      : 'rail n/a';
  return (
    <div className="py-2">
      <div className="text-sm font-medium">
        {half}: {info.modType}
      </div>
      <div className="text-xs tabular-nums text-muted-foreground">
        {info.modFw ? `FW ${info.modFw} · ` : ''}
        {rail}
      </div>
    </div>
  );
}

export default function ModulesTab({
  modules,
  halves,
  leftOn,
}: {
  modules: ReturnType<typeof useModuleProfiles>;
  halves: Record<Side, HalfSnapshot>;
  leftOn: boolean;
}) {
  const {
    profiles,
    bays,
    live,
    reading,
    readAll,
    setBinding,
    setSetting,
    addProfile,
    deleteProfile,
    renameProfile,
  } = modules;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = profiles.find((p) => p.id === selectedId) ?? profiles[0] ?? null;
  const [pane, setPane] = useState<'gestures' | 'settings'>('gestures');
  const [targetTab, setTargetTab] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [editor, setEditor] = useState<BindingEditorTarget | null>(null);

  const liveByProfile = useMemo(() => {
    const out = new Map<string, ProfileLive>();
    for (const v of Object.values(live)) {
      const id = v.matched?.id ?? v.closest?.id;
      if (id === undefined) continue;
      const entry: ProfileLive = {
        onDevice: v.matched !== null,
        slot: v.slot,
        differs: v.differs,
        drift: new Map(v.diffRows.map((r) => [r.gesture, r])),
        settings: v.settings,
        records: v.records,
      };
      const prev = out.get(id);
      if (prev === undefined || (entry.onDevice && !prev.onDevice)) out.set(id, entry);
    }
    return out;
  }, [live]);
  const liveEmpty = Object.keys(live).length === 0;
  const selectedLive = selected ? liveByProfile.get(selected.id) : undefined;

  const rows = useMemo(() => (selected ? gestureRows(selected.type) : []), [selected]);
  const groups = useMemo(() => groupByTarget(rows), [rows]);
  const targets = groups.filter((g) => g.target !== null);
  const targetless = groups.find((g) => g.target === null)?.rows ?? [];
  const activeTarget =
    groups.find((g) => g.target === targetTab)?.target ?? targets[0]?.target ?? null;
  const activeGroup = groups.find((g) => g.target === activeTarget);

  // Fields the profile model can express; the slot's remaining records are
  // the unmodelled-fields disclosure (the old raw-slots idea).
  const modeled = useMemo(() => {
    const s = new Set<number>();
    if (!selected) return s;
    for (const idx of Object.values(SETTING_FIELDS[selected.type])) s.add(idx);
    for (const r of rows) for (const f of fieldsOfGesture(selected.type, r.gesture)) s.add(f);
    return s;
  }, [selected, rows]);
  const unmodelled = selectedLive?.records
    ? [...selectedLive.records].filter(([f]) => !modeled.has(f))
    : [];

  const settingsEntries = selected ? Object.entries(SETTING_FIELDS[selected.type]) : [];
  const present = (['left', 'right'] as Side[]).filter((s) => halves[s].modPresent).length;

  function addOfType(type: ModuleType) {
    const p = addProfile(type, '');
    if (p === null) {
      toast.error(`No stock profile seeds a ${type} module`);
      return;
    }
    setSelectedId(p.id);
    toast.success(`Added "${p.name}" — flash plans it into a slot`);
  }

  function confirmDelete(p: ModuleProfile) {
    if (profiles.filter((x) => x.type === p.type).length <= 1) {
      toast.error(`"${p.name}" is the last ${p.type} profile — the last profile of a type cannot be deleted`);
      return;
    }
    const layersUsing = [...new Set(
      Object.entries(bays).flatMap(([lk, row]) =>
        Object.values(row).includes(p.id) ? [Number(lk)] : [],
      ),
    )].sort((a, b) => a - b);
    const detail =
      layersUsing.length > 0
        ? ` Layer ${layersUsing.join(', ')} bay assignment(s) use it and will be removed.`
        : '';
    if (!window.confirm(`Delete "${p.name}"?${detail}`)) return;
    deleteProfile(p.id);
    toast.success(`Deleted "${p.name}"`);
  }

  function saveRename(e: React.FormEvent) {
    e.preventDefault();
    if (selected !== null && renameValue !== null) renameProfile(selected.id, renameValue);
    setRenameValue(null);
  }

  function applyEditorPick(pick: { actionType: string; actionCode: string }) {
    if (editor === null) return;
    const p = profiles.find((x) => x.id === editor.profileId);
    if (!p) {
      setEditor(null);
      return;
    }
    const b = p.bindings[editor.gesture];
    if (editor.half !== null) {
      const nextSplit = {
        ...(b?.split ?? { '-': undefined, '+': undefined }),
        [editor.half]: pick.actionType === 'none' ? undefined : pick,
      };
      setBinding(p.id, editor.gesture, {
        actionType: b?.actionType ?? 'key',
        actionCode: b?.actionCode ?? '',
        split: nextSplit,
      });
    } else {
      // Combined rebind: the split is cleared EXPLICITLY (setBinding
      // otherwise preserves it — its halves would win on the overlay).
      setBinding(p.id, editor.gesture, { ...pick, split: null });
    }
    setEditor(null);
  }

  const editorProfile = editor !== null ? profiles.find((p) => p.id === editor.profileId) : undefined;
  const editorBinding =
    editor !== null && editorProfile
      ? editor.half !== null
        ? editorProfile.bindings[editor.gesture]?.split?.[editor.half]
        : editorProfile.bindings[editor.gesture]
      : undefined;

  const renderRow = (row: (typeof rows)[number]) => (
    <GestureRow
      key={row.gesture}
      row={row}
      type={selected!.type}
      binding={selected!.bindings[row.gesture]}
      live={{
        onDevice: selectedLive?.onDevice ?? false,
        drift: selectedLive?.drift ?? new Map(),
      }}
      busy={reading}
      onOpen={(gesture, half) => setEditor({ profileId: selected!.id, gesture, half })}
      onSetBinding={(gesture, edit) => setBinding(selected!.id, gesture, edit)}
    />
  );

  return (
    <div className="grid grid-cols-[260px_1fr] gap-4 p-4">
      <Card>
        <CardHeader>
          <div className="text-sm font-semibold">Modules</div>
          <div className="text-xs text-muted-foreground">
            {present === 0 ? 'none docked' : `${present} docked`}
          </div>
        </CardHeader>
        <CardContent>
          <ModuleRow half="Left half" info={halves.left} />
          <ModuleRow half="Right half" info={halves.right} />
          <Button
            size="sm"
            variant="outline"
            className="mt-2 w-full"
            disabled={!leftOn || reading}
            onClick={() => void readAll()}
          >
            {reading ? 'Reading…' : 'Read from keyboard'}
          </Button>
          {leftOn && liveEmpty && profiles.length > 0 && (
            <p className="mt-2 rounded bg-secondary px-2 py-1.5 text-xs leading-snug text-muted-foreground">
              Module changes flash against the slots read from the keyboard — none read yet
              this session. Read before flashing.
            </p>
          )}
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Profiles
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={reading}>
                  Add
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {ADD_SEEDS.map((s) => (
                  <DropdownMenuItem key={s.type} onSelect={() => addOfType(s.type)}>
                    {s.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {profiles.length > MODULE_LIST_WINDOW && (
            <p className="mt-1 text-xs text-yellow-500">
              the keyboard holds at most 8 module profiles
            </p>
          )}
          <div className="mt-1">
            {profiles.map((p) => {
              const lv = liveByProfile.get(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className={cn(
                    'flex w-full items-center justify-between gap-1 rounded px-1.5 py-1 text-left text-sm hover:bg-accent',
                    selected?.id === p.id && 'bg-accent',
                  )}
                >
                  <span className="truncate">{p.name}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {lv?.onDevice && <Badge variant="ok">on device</Badge>}
                    {lv && !lv.onDevice && lv.differs > 0 && (
                      <Badge title={`${lv.differs} gesture row(s) drift from slot ${lv.slot}`}>
                        {lv.differs} drift
                      </Badge>
                    )}
                    <Badge variant={TYPE_BADGE[p.type]}>{p.type}</Badge>
                  </span>
                </button>
              );
            })}
            {profiles.length === 0 && (
              <p className="py-2 text-sm text-muted-foreground">
                No profiles yet — Read from the keyboard or Add one.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {selected !== null ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {renameValue !== null ? (
                  <form onSubmit={saveRename} className="flex items-center gap-1">
                    <Input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      className="h-8 w-48 text-sm"
                      autoFocus
                      aria-label="Profile name"
                    />
                    <Button size="sm" variant="outline" type="submit">
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" type="button" onClick={() => setRenameValue(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="truncate text-sm font-semibold">{selected.name}</span>
                    <Badge variant={TYPE_BADGE[selected.type]}>{selected.type}</Badge>
                    {selectedLive?.onDevice && <Badge variant="ok">on device</Badge>}
                    {selectedLive && !selectedLive.onDevice && selectedLive.differs > 0 && (
                      <Badge
                        title={`${selectedLive.differs} gesture row(s) drift from slot ${selectedLive.slot}`}
                      >
                        {selectedLive.differs} drift
                      </Badge>
                    )}
                  </>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={reading}
                  onClick={() => setRenameValue(selected.name)}
                >
                  Rename
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={reading}
                  onClick={() => confirmDelete(selected)}
                >
                  Delete
                </Button>
                <Tabs value={pane} onValueChange={(v) => setPane(v as 'gestures' | 'settings')}>
                  <TabsList>
                    <TabsTrigger value="gestures">Gestures</TabsTrigger>
                    <TabsTrigger value="settings">Settings</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {pane === 'gestures' ? (
              <div>
                {rows.length === 0 && (
                  <p className="py-2 text-sm text-muted-foreground">
                    No gestures — the {selected.type} module has no field map yet.
                  </p>
                )}
                {targetless.map(renderRow)}
                {targets.length > 0 && (
                  <Tabs value={activeTarget ?? ''} onValueChange={(v) => setTargetTab(v)}>
                    <TabsList className="mt-1">
                      {targets.map((g) => (
                        <TabsTrigger key={g.target} value={g.target!}>
                          {targetLabel(g.target!)}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                )}
                <div className="mt-2">{activeGroup?.rows.map(renderRow)}</div>
                {unmodelled.length > 0 && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Unmodelled fields ({unmodelled.length}, read from the board)
                    </summary>
                    <div className="mt-1 space-y-0.5 break-all font-mono text-[11px] text-muted-foreground">
                      {unmodelled.map(([f, rec]) => (
                        <div key={f}>
                          0x{f.toString(16).padStart(2, '0')}: {toHex(rec)}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ) : (
              <div>
                {settingsEntries.length === 0 && (
                  <p className="py-2 text-sm text-muted-foreground">
                    No modeled settings for {selected.type} modules.
                  </p>
                )}
                {settingsEntries.map(([sid, idx]) => {
                  const v = selected.settings[sid];
                  const devVal = selectedLive?.settings[sid];
                  const adoptable = devVal !== undefined && v !== devVal;
                  const isFlag = sid === 'pointer_accel_on' || sid === 'toggle_ticks';
                  return (
                    <div key={sid} className="flex items-center justify-between gap-3 py-1.5">
                      <div className="min-w-0">
                        <div className="text-sm">
                          {SETTING_LABELS[sid] ?? sid}{' '}
                          <span className="font-mono text-[10px] text-muted-foreground">
                            field 0x{idx.toString(16).padStart(2, '0')}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {sid === 'ticks_per_rotation' && v !== undefined && v > 0 && (
                            <>{Math.round(360 / v)}° per detent on the wire (round(360/{v}))</>
                          )}
                          {adoptable && <> — board holds {devVal}</>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {adoptable && devVal !== undefined && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={reading}
                            onClick={() => {
                              if (devVal !== undefined) setSetting(selected.id, sid, devVal);
                            }}
                            title="Adopt the value the keyboard currently stores"
                          >
                            {"Use the keyboard's value"}
                          </Button>
                        )}
                        {isFlag ? (
                          <Checkbox
                            checked={(v ?? 0) === 1}
                            disabled={reading}
                            onCheckedChange={(c) => setSetting(selected.id, sid, c === true ? 1 : 0)}
                            aria-label={SETTING_LABELS[sid] ?? sid}
                          />
                        ) : (
                          <Input
                            type="number"
                            className="h-8 w-20 text-sm tabular-nums"
                            value={v ?? ''}
                            disabled={reading}
                            aria-label={SETTING_LABELS[sid] ?? sid}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              if (e.target.value !== '' && Number.isFinite(n)) {
                                setSetting(selected.id, sid, n);
                              }
                            }}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent>
            <p className="py-6 text-sm text-muted-foreground">
              Select a profile — or connect the left half and Read from the keyboard to capture
              what is on the board.
            </p>
          </CardContent>
        </Card>
      )}

      <ModuleBindingDialog
        target={editor}
        current={editorBinding}
        onClose={() => setEditor(null)}
        onPick={applyEditorPick}
      />
    </div>
  );
}
