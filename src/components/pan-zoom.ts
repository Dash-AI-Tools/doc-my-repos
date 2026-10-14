/**
 * Pure pan and zoom math for the diagram viewer (task 7.8). No React, no DOM.
 *
 * The view is `translate(x px, y px) scale(s)` applied with `transform-origin: center` to content
 * that is centered in the stage. So `x` and `y` are the offset of the content's center from the
 * stage's center, in CSS pixels, and points are given relative to the stage's center too.
 */

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;
/** One click on a zoom button or one `+`/`-` key press. */
export const ZOOM_STEP = 1.25;
/** One arrow key press, in CSS pixels. */
export const PAN_STEP = 48;
/** Shift + arrow key moves this many times further. */
export const PAN_FAST_FACTOR = 4;
/** Part of the diagram that always stays inside the stage, in CSS pixels. */
const KEEP_VISIBLE = 48;

export interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export const INITIAL_VIEW: View = { scale: 1, x: 0, y: 0 };

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Keeps the diagram from being dragged out of sight: at least `KEEP_VISIBLE` pixels of it (or the
 * whole of a smaller one) stay inside the stage. Without a measured size (zero, as in tests) the
 * offset is left alone.
 */
export function clampPan(view: View, size: Size | undefined): View {
  if (size === undefined || size.width <= 0 || size.height <= 0) return view;
  const limitX = Math.max(0, (size.width * (view.scale + 1)) / 2 - KEEP_VISIBLE);
  const limitY = Math.max(0, (size.height * (view.scale + 1)) / 2 - KEEP_VISIBLE);
  return {
    scale: view.scale,
    x: Math.min(limitX, Math.max(-limitX, view.x)),
    y: Math.min(limitY, Math.max(-limitY, view.y)),
  };
}

/** Moves the view by a pixel delta (dragging). */
export function panBy(view: View, dx: number, dy: number, size?: Size): View {
  return clampPan({ scale: view.scale, x: view.x + dx, y: view.y + dy }, size);
}

/**
 * Changes the scale while the point `(px, py)` (relative to the stage center) stays under the
 * same spot of the diagram. Scale is clamped; at a limit the view does not move.
 */
export function zoomAt(view: View, nextScale: number, px: number, py: number, size?: Size): View {
  const scale = clampScale(nextScale);
  if (scale === view.scale) return view;
  const ratio = scale / view.scale;
  return clampPan({ scale, x: px - ratio * (px - view.x), y: py - ratio * (py - view.y) }, size);
}

/** Zoom factor for a wheel event. Pinch gestures on trackpads arrive as `ctrlKey` wheel events. */
export function wheelFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  // Cap one event so a hardware that reports huge deltas cannot jump from min to max.
  const bounded = Math.max(-240, Math.min(240, pixels));
  return Math.exp(-bounded * (ctrlKey ? 0.01 : 0.0015));
}

export function transformOf(view: View): string {
  return `translate(${round(view.x)}px, ${round(view.y)}px) scale(${round(view.scale)})`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function percentOf(view: View): number {
  return Math.round(view.scale * 100);
}
