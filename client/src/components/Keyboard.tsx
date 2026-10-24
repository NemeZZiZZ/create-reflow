// Keyboard view — faithful NayaFlow look (transcribed from app.asar renderer:
// EY board grid, Zdt position map, f6/jtt shape selector, Xtt keycap outlines).
// Styled with Tailwind utilities (2.75rem cols = w-11); only data-driven
// legend anchors (top/left per shape) stay inline. Controlled component:
// legends/fills come from props (paint after layer / LED dumps),
// selection lives in the parent.
import type { SVGProps } from "react";
import { useRef } from "react";
import {
  contrastStroke,
  describeRecord,
  hsToHex,
  isLedNoColor,
  ledCss,
  readableInk,
  toHex,
} from "@create-reflow/sdk";
import { keyIconName, shortLabel } from "../lib/key-icon-map";
import { KEY_ICONS } from "../lib/key-icons";
import { POS_KEY, POS_SHAPE, SHAPES } from "../lib/kb-data";
import type { KeyShape } from "../lib/kb-data";
import { cn } from "../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

export interface LedVal {
  h: number;
  s: number;
}

/** Tooltip colour row shared by keys, strip dots and bay swatches: a real
 * colour shows swatch + hex + H/S; the NayaFlow unset marker (h 0, s 150 —
 * OF "No colour") shows "No colour" instead — it is NOT the red hue-0
 * colour a naïve ledCss would render. */
function LedColorRow({ led }: { led: LedVal }) {
  if (isLedNoColor(led.h, led.s))
    return <div className="text-muted-foreground">No colour (LED off)</div>;
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block size-3 rounded-sm border border-border"
        style={{ background: ledCss(led.h, led.s) }}
      />
      <span className="font-mono">{hsToHex(led.h, led.s)}</span>
      <span className="text-muted-foreground">
        H {led.h} · S {led.s}
      </span>
    </div>
  );
}

function attrName(k: string): string {
  return k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function ShapeSvg({
  name,
  fill,
  stroke,
  className,
}: {
  name: string;
  fill?: string;
  stroke?: string;
  className?: string;
}) {
  const sh: KeyShape = SHAPES[name] ?? SHAPES["Ve"];
  return (
    <svg
      width={Number(sh.w)}
      height={Number(sh.h)}
      viewBox={sh.vb}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {sh.inners.map((el, i) => {
        const props: Record<string, string> = {};
        for (const [k, v] of el.attrs)
          props[attrName(k)] = v
            .split("{F}")
            .join(fill)
            .split("{S}")
            .join(stroke)
            .split("{O}")
            .join("1");
        if (el.tag === "circle")
          return <circle key={i} {...(props as SVGProps<SVGCircleElement>)} />;
        if (el.tag === "rect")
          return <rect key={i} {...(props as SVGProps<SVGRectElement>)} />;
        return <path key={i} {...(props as SVGProps<SVGPathElement>)} />;
      })}
    </svg>
  );
}

interface KeyProps {
  pos: number;
  rec?: Uint8Array;
  led?: LedVal;
  ledMode: boolean;
  selected: boolean;
  dirty?: boolean;
  onSelect: (
    pos: number,
    kk: number,
    additive: boolean,
    allLayers: boolean,
  ) => void;
  /** paint mode (drag): pointer events paint; click stays as fallback */
  onPaintDown?: (kk: number) => void;
  onPaintEnter?: (kk: number) => void;
  /** click fallback for click-only activation (a11y/automation); the parent
   *  skips it right after a pointer paint so real clicks queue once */
  onPaintClick?: (kk: number) => void;
  /** keymap-mode right click: open the config popover anchored here */
  onContext?: (kk: number, x: number, y: number) => void;
  /** host-side note for this key (UHK corner-marker pattern) */
  note?: string;
  /** live test-mode press on this KK */
  pressed?: boolean;
}

function Key({
  pos,
  rec,
  led,
  ledMode,
  selected,
  dirty,
  pressed,
  onSelect,
  onPaintDown,
  onPaintEnter,
  onPaintClick,
  onContext,
  note,
}: KeyProps) {
  const kk = pos; // positionId == KK index (proven: 0=Esc/LA1, 0x30=Z/LC4 …)
  const label = rec ? shortLabel(rec) : (POS_KEY[String(pos)] ?? "");
  // action glyph for non-standard keys (currentColor => follows legend color);
  // null -> text legend fallback (letters, digits, Shift, Menu, F-keys …)
  const iconName = rec ? keyIconName(describeRecord(rec)) : null;
  const icon = iconName ? KEY_ICONS[iconName] : undefined;
  // LED fills get readability-driven ink + (when selected) a max-delta ring
  // instead of the hardcoded white-fill selection (UHK a11y pattern).
  // The unset marker (h 0, s 150) renders as NO fill — an absent colour
  // must not masquerade as the red hue-0 colour ledCss would show.
  const ledFill =
    ledMode && led && !isLedNoColor(led.h, led.s) ? ledCss(led.h, led.s) : null;
  // Test-mode press overlay (KK-keyed; stays EMPTY until a verified
  // row/col→KK mapping exists — Phase-10 probe): translucent green fill +
  // ring, winning over LED paint and selection so a live press stays
  // legible in either mode.
  const pressedFill = pressed ? "rgba(74, 222, 128, 0.55)" : null; // green-400 @ 55%
  const fill = pressedFill ?? ledFill ?? (selected ? "#ffffff" : "transparent");
  const ink = pressedFill ? null : ledFill ? readableInk(ledFill) : null;
  const stroke = pressedFill
    ? "#4ade80"
    : ledFill && selected
      ? contrastStroke(ledFill)
      : "#E5E1E6";
  // UHK-style hover tooltip: full action breakdown (slot lines + raw hex),
  // in LED mode the color row leads.
  const desc = rec ? describeRecord(rec) : null;
  const tip = (
    <div className="grid gap-0.5">
      <div className="font-medium">
        {POS_KEY[String(pos)] ?? "?"}
        <span className="ml-2 font-normal text-muted-foreground">
          pos {pos} · KK 0x{kk.toString(16)}
        </span>
      </div>
      {ledMode && led && <LedColorRow led={led} />}
      {desc
        ? desc.split(" / ").map((line, i) =>
            i === 0 && !ledMode ? (
              <div key={i}>{line}</div>
            ) : (
              <div key={i} className="text-muted-foreground">
                {line}
              </div>
            ),
          )
        : !ledMode && (
            <div className="text-muted-foreground">no record — transparent</div>
          )}
      {rec && (
        <div className="font-mono text-[10px] text-muted-foreground">
          {toHex(rec)}
        </div>
      )}
      {note && (
        <div className="max-w-60 whitespace-normal text-amber-300/90">
          Note: {note}
        </div>
      )}
    </div>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="kb-key"
          data-pos={pos}
          style={
            pressed
              ? { outline: "2px solid #4ade80", outlineOffset: 1 }
              : selected && ledFill
                ? {
                    outline: `2px solid ${contrastStroke(ledFill)}`,
                    outlineOffset: 1,
                  }
                : undefined
          }
          onClick={
            onPaintDown
              ? onPaintClick
                ? () => onPaintClick(kk)
                : undefined
              : (e) => onSelect(pos, kk, e.shiftKey, e.altKey)
          }
          onPointerDown={
            onPaintDown
              ? (e) => {
                  e.preventDefault();
                  onPaintDown(kk);
                }
              : undefined
          }
          onPointerEnter={onPaintEnter ? () => onPaintEnter(kk) : undefined}
          onContextMenu={
            onContext
              ? (e) => {
                  e.preventDefault();
                  onContext(kk, e.clientX, e.clientY);
                }
              : undefined
          }
        >
          <div className="relative">
            <ShapeSvg name={POS_SHAPE[pos]} fill={fill} stroke={stroke} />
            <span
              className={cn(
                "absolute text-sm left-1/2 top-1/2 -translate-1/2 font-medium whitespace-nowrap [&_svg]:block [&_svg]:size-8",
                !ink && {
                  "text-gray-900": selected,
                  "text-gray-100 text-shadow-[-1px_-1px_0_rgba(0,0,0,.5),1px_-1px_0_rgba(0,0,0,.5),-1px_1px_0_rgba(0,0,0,.5),1px_1px_0_rgba(0,0,0,.5)]":
                    !selected,
                },
              )}
              style={ink ? { color: ink } : undefined}
              dangerouslySetInnerHTML={{ __html: icon ? icon : label }}
            />
            {dirty && (
              <span
                className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-amber-400"
                title="queued change — not flashed yet"
              />
            )}
            {note && (
              <span
                className="absolute left-0 top-0 size-0 border-l-[9px] border-l-amber-400/80 border-t-[9px] border-t-transparent"
                title={`Note: ${note}`}
              />
            )}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

interface StripDotProps {
  kk: number;
  led?: LedVal;
  selected: boolean;
  /** live test-mode press on this KK */
  pressed?: boolean;
  dirty?: boolean;
  onSelect: (
    pos: number,
    kk: number,
    additive: boolean,
    allLayers: boolean,
  ) => void;
  /** same pointer pipeline as Key: drag paints, click is the fallback */
  onPaintDown?: (kk: number) => void;
  onPaintEnter?: (kk: number) => void;
  onPaintClick?: (kk: number) => void;
}

/** Edge LED-strip dot (kks 74-87): a compact bar driven by the same paint /
 *  select pipeline and dirty marker as the keys. Rendered only in LED mode,
 *  flanking the halves' outer edges. */
function StripDot({
  kk,
  led,
  selected,
  pressed,
  dirty,
  onSelect,
  onPaintDown,
  onPaintEnter,
  onPaintClick,
}: StripDotProps) {
  // Marker (h 0, s 150) → no fill, same as a dot with no LED.
  const fill = led && !isLedNoColor(led.h, led.s) ? ledCss(led.h, led.s) : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`LED strip ${kk}`}
          className="relative h-4 w-2 shrink-0 rounded-[3px] border border-border hover:brightness-125"
          style={
            pressed
              ? {
                  background: "#4ade80",
                  outline: "2px solid #4ade80",
                  outlineOffset: 1,
                }
              : selected && fill
                ? {
                    background: fill,
                    outline: `2px solid ${contrastStroke(fill)}`,
                    outlineOffset: 1,
                  }
                : { background: fill ?? "transparent" }
          }
          onClick={
            onPaintDown
              ? onPaintClick
                ? () => onPaintClick(kk)
                : undefined
              : (e) => onSelect(kk, kk, e.shiftKey, e.altKey)
          }
          onPointerDown={
            onPaintDown
              ? (e) => {
                  e.preventDefault();
                  onPaintDown(kk);
                }
              : undefined
          }
          onPointerEnter={onPaintEnter ? () => onPaintEnter(kk) : undefined}
        >
          {dirty && (
            <span
              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-amber-400"
              title="queued change — not flashed yet"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div className="grid gap-0.5">
          <div className="font-medium">
            LED strip {kk}
            <span className="ml-2 font-normal text-muted-foreground">
              KK 0x{kk.toString(16)}
            </span>
          </div>
          {led && <LedColorRow led={led} />}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

interface KeyboardProps {
  keymap: Map<number, Uint8Array>;
  ledmap: Map<number, LedVal>;
  ledMode: boolean;
  /** selected KKs of the viewed layer (Shift+click multi, Alt+click all layers) */
  sel: Set<number>;
  onSelect: (
    pos: number,
    kk: number,
    additive: boolean,
    allLayers: boolean,
  ) => void;
  /** disconnected: ignore clicks, render semi-transparent */
  disabled?: boolean;
  /** KKs with queued (not yet flashed) changes — get a dot marker */
  dirty?: Set<number>;
  /** drag-paint mode: pointer-down starts a stroke, pointer-enter paints */
  onPaint?: (kk: number) => void;
  /** LED-mode bay swatch click (no drag — a bay is one swatch): paints the
   *  whole 24-LED block of that side; absent → bays render as indicators */
  onBayPaint?: (side: "left" | "right") => void;
  /** cursor override for paint tools (e.g. "cursor-crosshair") */
  cursorClass?: string;
  /** keymap-mode right click on a key: (kk, viewport x, viewport y) */
  onContext?: (kk: number, x: number, y: number) => void;
  /** per-key notes of the viewed layer — amber corner-triangle marker */
  keyNotes?: Map<number, string>;
  /** KK-keyed live test presses. Stays EMPTY until a verified row/col→KK
   *  mapping exists (Phase-10 probe) — the caps overlay then shows nothing
   *  and the raw row/col panel carries the truth. */
  pressed?: ReadonlySet<number>;
}

export default function Keyboard({
  keymap,
  ledmap,
  ledMode,
  sel,
  onSelect,
  disabled = false,
  dirty,
  onPaint,
  cursorClass,
  onContext,
  keyNotes,
  pressed,
}: KeyboardProps) {
  const paintingRef = useRef(false);
  const lastPtrPaint = useRef(0);
  const paintDown = onPaint
    ? (kk: number) => {
        paintingRef.current = true;
        lastPtrPaint.current = Date.now();
        onPaint(kk);
      }
    : undefined;
  const paintEnter = onPaint
    ? (kk: number) => {
        if (paintingRef.current) {
          lastPtrPaint.current = Date.now();
          onPaint(kk);
        }
      }
    : undefined;
  // click-only activation (a11y, automation): paint unless the same gesture
  // just painted via pointerdown (real mouse clicks queue once)
  const paintClick = onPaint
    ? (kk: number) => {
        if (Date.now() - lastPtrPaint.current < 400) return;
        onPaint(kk);
      }
    : undefined;
  const endPaint = onPaint ? () => (paintingRef.current = false) : undefined;
  const pick = (
    pos: number,
    kk: number,
    additive: boolean,
    allLayers: boolean,
  ) => {
    if (!disabled) onSelect(pos, kk, additive, allLayers);
  };
  const K = (pos: number) => (
    <Key
      key={pos}
      pos={pos}
      rec={keymap.get(pos)}
      led={ledmap.get(pos)}
      ledMode={ledMode}
      selected={sel.has(pos)}
      dirty={dirty?.has(pos) ?? false}
      onSelect={pick}
      onPaintDown={paintDown}
      onPaintEnter={paintEnter}
      onPaintClick={paintClick}
      note={keyNotes?.get(pos)}
      pressed={pressed?.has(pos) ?? false}
      onContext={onPaint ? undefined : onContext}
    />
  );
  const col = (extra: string, keys: number[]) => (
    <div className={cn("flex flex-col gap-1 w-11 flex-nowrap", extra)}>
      {keys.map(K)}
    </div>
  );

  // Edge LED strips (LED mode only): 7 individual dots per side, wired into
  // the same paint/drag/select pipeline and dirty marker as the keys.
  const stripCol = (kks: number[]) => (
    <div className="flex flex-col items-center justify-center gap-1">
      {kks.map((kk) => (
        <StripDot
          key={kk}
          kk={kk}
          led={ledmap.get(kk)}
          selected={sel.has(kk)}
          pressed={pressed?.has(kk) ?? false}
          dirty={dirty?.has(kk) ?? false}
          onSelect={pick}
          onPaintDown={paintDown}
          onPaintEnter={paintEnter}
          onPaintClick={paintClick}
        />
      ))}
    </div>
  );

  const halfLeft = (
    <div className="flex h-full justify-self-end gap-1">
      {ledMode && stripCol([81, 82, 83, 84, 85, 86, 87])}
      {col("mt-[1.5rem]", [0, 16, 30, 46, 62])}
      {col("mt-[1rem]", [1, 17, 31, 47, 63])}
      {col("mt-[0.5rem]", [2, 18, 32, 48, 64])}
      {col("mt-[0.2rem]", [3, 19, 33, 49, 65])}
      <div className="flex flex-col gap-1 flex-nowrap w-11">
        {[4, 20, 34].map(K)}
        {K(50)}
        <span className="-mr-17">{K(66)}</span>
      </div>
      {col("gap-0.75", [5, 21, 35, 51])}
      <div className="flex flex-col gap-0.5 flex-nowrap w-11 mt-[0.15rem]">
        {[6, 22].map(K)}
        <span>{K(36)}</span>
        {K(52)}
      </div>
      <div className="flex flex-col gap-1 flex-nowrap w-11 mt-[0.3rem]">
        {K(7)}
      </div>
    </div>
  );

  const halfRight = (
    <div className="flex h-full justify-self-start gap-1">
      {col("mt-[0.3rem]", [8])}
      <div className="flex flex-col gap-0.5 flex-nowrap w-11 mt-[0.15rem]">
        {[9, 23].map(K)}
        <span className="-ml-2">{K(39)}</span>
        {K(55)}
      </div>
      {col("gap-0.75", [10, 24, 40, 56])}
      <div className="flex flex-col gap-1 flex-nowrap w-11">
        {[11, 25, 41].map(K)}
        {K(57)}
        <span className="-ml-17">{K(69)}</span>
      </div>
      {col("mt-[0.2rem]", [12, 26, 42, 58, 70])}
      {col("mt-[0.5rem]", [13, 27, 43, 59, 71])}
      {col("mt-[1rem]", [14, 28, 44, 60, 72])}
      {col("mt-[1.5rem]", [15, 29, 45, 61, 73])}
      {ledMode && stripCol([74, 75, 76, 77, 78, 79, 80])}
    </div>
  );

  const middle = (
    <div className="flex flex-col gap-4 justify-between pb-4 items-center h-full">
      <div className="flex justify-center gap-[3.3rem] h-full items-end pt-4">
        <div
          className="size-26 rounded-full rounded-tr-[20px] border-2 border-[#555] bg-[#222]"
          data-testid="dock-left"
        />
        <div
          className="size-26 rounded-full rounded-tl-[20px] border-2 border-[#555] bg-[#222]"
          data-testid="dock-right"
        />
      </div>
      <div className="-mx-12 flex items-center justify-between gap-8">
        <div className="flex gap-1">{[37, 53, 67].map(K)}</div>
        <div className="flex gap-1">{[68, 54, 38].map(K)}</div>
      </div>
    </div>
  );

  return (
    <TooltipProvider delayDuration={250}>
      <div
        className={cn(
          "grid w-full min-w-235 grid-cols-[1fr_14rem_1fr] gap-1 select-none",
          {
            "opacity-50 saturate-50 cursor-default": disabled,
            "cursor-pointer": !disabled && !cursorClass,
            "touch-none": !!onPaint,
          },
          cursorClass,
        )}
        onPointerUp={endPaint}
        onPointerCancel={endPaint}
        onPointerLeave={endPaint}
      >
        {halfLeft}
        {middle}
        {halfRight}
      </div>
    </TooltipProvider>
  );
}
