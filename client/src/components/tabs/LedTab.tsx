// LED Map tab: Brush/Fill/Pipette paint tools, H/S sliders, custom colors,
// and per-layer animations (plain actions — the device has no GET, so the
// active animation is unknown).
import { useState } from 'react';
import { Brush, CircleOff, PaintBucket, Pipette, Plus, type LucideIcon } from 'lucide-react';
import Keyboard, { type LedVal } from '../Keyboard';
import ColorDialog from '../ColorDialog';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';
import type { Draft } from '@create-reflow/sdk';
import type { LedRec } from '@create-reflow/sdk';
import { hsToHex, isLedNoColor, ledCss, LED_NO_COLOR } from '@create-reflow/sdk';import { ANIM_NAMES, animOp } from '@create-reflow/sdk';
import {
  BAY_LED_RANGES,
  queueBayColor,
  queueColor,
  queueFillLayer,
} from '@create-reflow/sdk';
import type { HsColor } from '../../hooks/useCustomColors';
import type { LogFn } from '../../hooks/useLog';
import { cn } from '../../lib/utils';

type LedTool = 'brush' | 'fill' | 'pipette';

const TOOLS: { id: LedTool; label: string; Icon: LucideIcon; hint: string }[] = [
  { id: 'brush', label: 'Brush', Icon: Brush, hint: 'Paint keys, strips and bays — click or drag across the board' },
  { id: 'fill', label: 'Fill', Icon: PaintBucket, hint: 'Paint the whole layer (ignores the clicked key)' },
  { id: 'pipette', label: 'Pipette', Icon: Pipette, hint: 'Pick the clicked key color, queues nothing' },
];

// Device hue is 9-bit (0..511, shared with the custom palette + ColorDialog);
// saturation 0..100. No Value channel — brightness is keyboard-wide.
// Outside that scale sits the NayaFlow "No colour" marker (h 0, s 150 wire
// bytes — LED off): armed as its own state, queued as the literal so the
// slider scale can never distort it (OF 571e126 / SCRUM-118 parity).
const HUE_MAX = 511;

const NO_SEL = new Set<number>();

/** Log/readout label for a queued colour: the marker names itself, real
 * colours read H/S. */
function colorLabel(c: { h: number; s: number }): string {
  return isLedNoColor(c.h, c.s) ? 'No colour (LED off)' : `H${c.h}/S${c.s}`;
}

export default function LedTab({
  layer,
  onLayer,
  layers,
  keymap,
  ledsByLayer,
  ledmap,
  dirtyKks,
  draftRef,
  bumpDraft,
  log,
  leftOn,
  customColors,
  onSaveCustomColors,
  onAnimQueued,
}: {
  layer: number;
  onLayer: (l: number) => void;
  /** layer idxs to offer (board inventory; App's exportIdxs falls back to [0,1,2] pre-read) */
  layers: number[];
  keymap: Map<number, Uint8Array>;
  ledsByLayer: LedRec[][];
  ledmap: Map<number, LedVal>;
  dirtyKks: Set<number>;
  draftRef: { current: Draft };
  bumpDraft: () => void;
  log: LogFn;
  leftOn: boolean;
  customColors: HsColor[];
  onSaveCustomColors: (cs: HsColor[]) => void;
  /** device has no GET for ed/1011 — App tracks last-known animations */
  onAnimQueued?: (layer: number, anim: number) => void;
}) {
  const [tool, setTool] = useState<LedTool>('brush');
  const [color, setColor] = useState<HsColor>({ h: 180, s: 100 });
  // "No colour" armed: brush/fill/bay queue the unset marker instead of
  // `color`. Separate state — the marker's s=150 lives on the wire's 0..255
  // scale and must never round-trip through the 0..100 S-slider.
  const [noColor, setNoColor] = useState(false);
  const [dlgOpen, setDlgOpen] = useState(false);
  const [dlgColor, setDlgColor] = useState<HsColor>({ h: 180, s: 100 });

  const leds = ledsByLayer[layer] ?? [];

  function toolClick(_pos: number, kk: number) {
    paintKey(kk, false);
  }

  // viaDrag: pointer-enter during a brush stroke — non-brush tools stay
  // click-only (fill/pipette on every enter would be chaos).
  function paintKey(kk: number, viaDrag: boolean) {
    if (!leftOn) return;
    if (viaDrag && tool !== 'brush') return;
    if (tool === 'pipette') {
      const cur = ledmap.get(kk);
      if (cur) {
        if (isLedNoColor(cur.h, cur.s)) {
          setNoColor(true);
          log('inf', `pipette KK ${kk} (0x${kk.toString(16)}) → No colour (LED off)`);
        } else {
          setNoColor(false);
          setColor({ h: cur.h, s: cur.s });
          log('inf', `pipette KK ${kk} (0x${kk.toString(16)}) → H${cur.h} S${cur.s}`);
        }
      } else {
        log('inf', `pipette KK ${kk} (0x${kk.toString(16)}): no LED there`);
      }
      return;
    }
    // Armed "No colour" queues the literal unset marker — an absent colour
    // must reach the keyboard as a real op (the LED turns off), it can't
    // ride "just don't write" (the LED would keep its old colour).
    const c = noColor ? LED_NO_COLOR : color;
    if (tool === 'fill') {
      const n = queueFillLayer(draftRef.current, layer, leds, c);
      bumpDraft();
      log('inf', `queued fill: ${n} LEDs L${layer} → ${colorLabel(c)}`);
      return;
    }
    const { queued } = queueColor(draftRef.current, [{ layer, kk }], c);
    bumpDraft();
    if (queued)
      log('inf', `queued color L${layer} KK ${kk} → ${colorLabel(c)}`);
    else log('err', `KK ${kk} (0x${kk.toString(16)}) has no LED — skipped`);
  }

  // Module bays paint as one swatch: pipette samples the bay block's first
  // LED (left 88 / right 112), brush and fill queue the whole 24-LED block —
  // per-LED targeting makes no sense on a single swatch.
  function bayClick(side: 'left' | 'right') {
    if (!leftOn) return;
    if (tool === 'pipette') {
      const cur = ledmap.get(BAY_LED_RANGES[side].first);
      if (cur) {
        if (isLedNoColor(cur.h, cur.s)) {
          setNoColor(true);
          log('inf', `pipette ${side} module bay → No colour (LED off)`);
        } else {
          setNoColor(false);
          setColor({ h: cur.h, s: cur.s });
          log('inf', `pipette ${side} module bay → H${cur.h} S${cur.s}`);
        }
      } else {
        log('inf', `pipette ${side} module bay: no LED there`);
      }
      return;
    }
    const c = noColor ? LED_NO_COLOR : color;
    queueBayColor(draftRef.current, layer, side, c.h, c.s);
    bumpDraft();
    log(
      'inf',
      `queued bay color L${layer} ${side} (24 LEDs) → ${colorLabel(c)}`,
    );
  }

  function queueAnim(i: number) {
    draftRef.current.add(animOp(layer, i));
    bumpDraft();
    onAnimQueued?.(layer, i);
    log('inf', `queued animation L${layer} → ${ANIM_NAMES[i]}`);
  }

  function addCustomColor() {
    const c = { h: dlgColor.h, s: dlgColor.s };
    if (!customColors.some((x) => x.h === c.h && x.s === c.s))
      onSaveCustomColors([...customColors, c]);
    setColor(c);
    setNoColor(false);
    setDlgOpen(false);
  }

  return (
    <div className="flex gap-4 items-start">
      <div className="flex-1 min-w-0">
        <Card className="mb-3">
          <CardHeader className="flex-wrap">
            <div className="flex items-center gap-1" role="tablist" aria-label="Layer">
              {layers.map((l) => (
                <Button
                  key={l}
                  variant={l === layer ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => onLayer(l)}
                >
                  L{l}
                </Button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              {leds.length} LEDs on L{layer}
            </span>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-sm bg-background p-4 min-h-60">
              <Keyboard
                keymap={keymap}
                ledmap={ledmap}
                ledMode
                sel={NO_SEL}
                onSelect={toolClick}
                onPaint={(kk) => paintKey(kk, true)}
                onBayPaint={bayClick}
                cursorClass={tool === 'brush' ? 'cursor-crosshair' : undefined}
                disabled={!leftOn}
                dirty={dirtyKks}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {leftOn
                ? 'Click — or drag with the Brush — to apply the tool; changes queue up, nothing writes until Flash.'
                : 'Connect the LEFT half — colors load automatically.'}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="w-80 shrink-0 flex flex-col gap-3">
        <Card>
          <CardContent className="flex flex-col gap-2 pt-4">
            <div className="text-xs font-medium text-muted-foreground">Tool</div>
            <div className="flex gap-1">
              {TOOLS.map(({ id, label, Icon, hint }) => (
                <Button
                  key={id}
                  variant={tool === id ? 'default' : 'outline'}
                  size="sm"
                  title={hint}
                  onClick={() => setTool(id)}
                  className="flex-1"
                >
                  <Icon /> {label}
                </Button>
              ))}
            </div>
            <Button
              variant={noColor ? 'default' : 'outline'}
              size="sm"
              title={
                noColor
                  ? 'No colour armed — Brush/Fill queue the unset marker; pick any colour to disarm'
                  : 'Queue the NayaFlow unset marker (hue 0, saturation 150) so the LED turns off'
              }
              aria-pressed={noColor}
              onClick={() => setNoColor((v) => !v)}
            >
              <CircleOff /> No colour — LED off
            </Button>
            <div className="flex items-center gap-2">
              {noColor ? (
                // Armed marker readout: an empty dashed swatch — never the
                // red hue-0 colour the raw h/s would suggest.
                <>
                  <span
                    className="inline-block h-6 w-6 shrink-0 rounded border border-dashed border-border"
                    title="No colour — LED off"
                  />
                  <span className="font-mono text-xs">No colour — LED off</span>
                </>
              ) : (
                <>
                  <span
                    className="inline-block h-6 w-6 shrink-0 rounded border border-border"
                    style={{ background: ledCss(color.h, color.s) }}
                    title="current tool color"
                  />
                  <span className="font-mono text-xs">
                    H{color.h} S{color.s} {hsToHex(color.h, color.s)}
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 font-mono text-xs">H</span>
              <input
                type="range"
                min={0}
                max={HUE_MAX}
                step={1}
                value={color.h}
                onChange={(e) => {
                  setNoColor(false);
                  setColor({ ...color, h: Number(e.target.value) });
                }}
                className="flex-1"
                style={{ accentColor: 'var(--primary)' }}
                aria-label="Hue (device 0–511)"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 font-mono text-xs">S</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={color.s}
                onChange={(e) => {
                  setNoColor(false);
                  setColor({ ...color, s: Number(e.target.value) });
                }}
                className="flex-1"
                style={{ accentColor: 'var(--primary)' }}
                aria-label="Saturation"
              />
            </div>
            {customColors.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {customColors.map((c, i) => (
                  <button
                    key={`${c.h}-${c.s}-${i}`}
                    type="button"
                    title={`H${c.h} S${c.s}`}
                    onClick={() => {
                      setNoColor(false);
                      setColor(c);
                    }}
                    className={cn(
                      'h-6 w-6 rounded border border-border',
                      c.h === color.h && c.s === color.s && 'outline-2 outline-primary',
                    )}
                    style={{ background: ledCss(c.h, c.s) }}
                  />
                ))}
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDlgColor(color);
                setDlgOpen(true);
              }}
            >
              <Plus /> Custom color…
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-2 pt-4">
            <div className="text-xs font-medium text-muted-foreground">
              Animation — L{layer} (last sent wins; device state unknown)
            </div>
            <div className="grid grid-cols-2 gap-1">
              {ANIM_NAMES.map((name, i) => (
                <Button
                  key={name}
                  variant="outline"
                  size="sm"
                  onClick={() => queueAnim(i)}
                >
                  {name}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <ColorDialog
        open={dlgOpen}
        onOpenChange={setDlgOpen}
        color={dlgColor}
        onColor={setDlgColor}
        onAdd={addCustomColor}
      />
    </div>
  );
}
