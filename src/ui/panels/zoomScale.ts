/**
 * Zoom slider maths (pure): a logarithmic scale between MIN_ZOOM and MAX_ZOOM, so every doubling
 * takes the same slider distance, with detents at the preset levels.
 */
import { MAX_ZOOM, MIN_ZOOM } from '../../board/store'

/** Preset zoom levels offered as buttons and menu items. */
export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4] as const

/** Slider positions run from 0 to SLIDER_STEPS. */
export const SLIDER_STEPS = 1000

/** Within this relative distance of a preset the slider settles on the preset. */
export const SNAP_TOLERANCE = 0.03

/** Arrow keys on the slider zoom by this factor. */
export const KEY_FACTOR = 1.1

const clamp = (z: number, min = MIN_ZOOM, max = MAX_ZOOM) => Math.min(max, Math.max(min, z))

/** Zoom level for a slider position (0..SLIDER_STEPS). */
export function sliderToZoom(pos: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  const t = Number.isFinite(pos) ? Math.min(SLIDER_STEPS, Math.max(0, pos)) / SLIDER_STEPS : 0
  return clamp(min * Math.pow(max / min, t), min, max)
}

/** Slider position (0..SLIDER_STEPS, not rounded) for a zoom level. */
export function zoomToSlider(zoom: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  const z = clamp(Number.isFinite(zoom) && zoom > 0 ? zoom : 1, min, max)
  return (Math.log(z / min) / Math.log(max / min)) * SLIDER_STEPS
}

/** The preset within SNAP_TOLERANCE of `zoom`, else `zoom` itself. */
export function snapToPreset(zoom: number, tolerance = SNAP_TOLERANCE): number {
  for (const p of ZOOM_PRESETS) if (Math.abs(zoom / p - 1) <= tolerance) return p
  return zoom
}

/** The next preset above (dir 1) or below (dir -1) `zoom`, or null at the end of the list. */
export function nextPreset(zoom: number, dir: 1 | -1): number | null {
  const eps = 1e-3
  if (dir === 1) return ZOOM_PRESETS.find((p) => p > zoom * (1 + eps)) ?? null
  for (let i = ZOOM_PRESETS.length - 1; i >= 0; i--) if (ZOOM_PRESETS[i] < zoom * (1 - eps)) return ZOOM_PRESETS[i]
  return null
}

/** True when `zoom` shows as this preset (the percentage readout rounds the same way). */
export function isPreset(zoom: number, preset: number): boolean {
  return Math.round(zoom * 100) === Math.round(preset * 100)
}

/** "125%" */
export const zoomPercent = (zoom: number) => `${Math.round(zoom * 100)}%`

/**
 * The zoom a slider key leads to: arrows step by KEY_FACTOR, Page keys jump between presets,
 * Home/End go to the limits. null for keys the slider does not handle.
 */
export function zoomForKey(key: string, zoom: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(snapToPreset(zoom * KEY_FACTOR, 0.01))
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(snapToPreset(zoom / KEY_FACTOR, 0.01))
    case 'PageUp':
      return nextPreset(zoom, 1) ?? MAX_ZOOM
    case 'PageDown':
      return nextPreset(zoom, -1) ?? MIN_ZOOM
    case 'Home':
      return MIN_ZOOM
    case 'End':
      return MAX_ZOOM
    default:
      return null
  }
}
