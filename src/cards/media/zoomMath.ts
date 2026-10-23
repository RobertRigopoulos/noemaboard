/**
 * Zoom and pan of the lightbox picture. `scale` is relative to the picture's natural pixels (1 = 100%);
 * x and y offset the picture's centre from the stage centre, in screen pixels. Pure.
 */

export interface ZoomState {
  scale: number
  x: number
  y: number
}

export interface Size {
  w: number
  h: number
}

export const MIN_SCALE = 0.1
export const MAX_SCALE = 8
/** Wheel zoom per pixel of scroll. */
const WHEEL_BASE = 1.0015

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Scale that fits the picture in the stage, never enlarging it past 100%. */
export function fitScale(content: Size, stage: Size): number {
  if (!(content.w > 0 && content.h > 0 && stage.w > 0 && stage.h > 0)) return 1
  return Math.min(1, stage.w / content.w, stage.h / content.h)
}

/** Allowed scales: 0.1x-8x, and always down to "fit" for pictures larger than 10x the stage. */
export function scaleLimits(fit: number): { min: number; max: number } {
  return { min: Math.min(MIN_SCALE, fit), max: MAX_SCALE }
}

export function fitState(content: Size, stage: Size): ZoomState {
  return { scale: fitScale(content, stage), x: 0, y: 0 }
}

/**
 * Zooms by `factor` keeping `point` (relative to the stage centre) over the same spot of the picture.
 */
export function zoomAround(state: ZoomState, factor: number, point: { x: number; y: number }, limits = { min: MIN_SCALE, max: MAX_SCALE }): ZoomState {
  const scale = clamp(state.scale * factor, limits.min, limits.max)
  const k = scale / state.scale
  return { scale, x: point.x - (point.x - state.x) * k, y: point.y - (point.y - state.y) * k }
}

/** Keeps the picture centred on axes where it fits, and its edges at or past the stage edges where it does not. */
export function clampPan(state: ZoomState, content: Size, stage: Size): ZoomState {
  const maxX = Math.max(0, (content.w * state.scale - stage.w) / 2)
  const maxY = Math.max(0, (content.h * state.scale - stage.h) / 2)
  return { scale: state.scale, x: clamp(state.x, -maxX, maxX), y: clamp(state.y, -maxY, maxY) }
}

/** Zoom factor for a wheel event (deltaMode 1 = lines, 2 = pages). */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  return WHEEL_BASE ** -clamp(px, -600, 600)
}

/** True when the picture is larger than the stage in either direction (so dragging pans). */
export function canPan(state: ZoomState, content: Size, stage: Size): boolean {
  return content.w * state.scale > stage.w + 0.5 || content.h * state.scale > stage.h + 0.5
}
