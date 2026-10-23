import { describe, expect, it } from 'vitest'
import { MAX_ZOOM, MIN_ZOOM } from '../../board/store'
import { isPreset, nextPreset, sliderToZoom, SLIDER_STEPS, snapToPreset, zoomForKey, zoomPercent, zoomToSlider, ZOOM_PRESETS } from './zoomScale'

describe('slider scale', () => {
  it('maps the ends of the slider to the zoom limits', () => {
    expect(sliderToZoom(0)).toBeCloseTo(MIN_ZOOM, 10)
    expect(sliderToZoom(SLIDER_STEPS)).toBeCloseTo(MAX_ZOOM, 10)
    expect(zoomToSlider(MIN_ZOOM)).toBeCloseTo(0, 10)
    expect(zoomToSlider(MAX_ZOOM)).toBeCloseTo(SLIDER_STEPS, 10)
  })

  it('round-trips zoom levels and slider positions', () => {
    for (const z of [MIN_ZOOM, 0.13, 0.25, 0.5, 1, 1.37, 2, 3.9, MAX_ZOOM]) expect(sliderToZoom(zoomToSlider(z))).toBeCloseTo(z, 8)
    for (const pos of [0, 1, 250, 500, 777, SLIDER_STEPS]) expect(zoomToSlider(sliderToZoom(pos))).toBeCloseTo(pos, 6)
  })

  it('is logarithmic: every doubling takes the same distance', () => {
    const d1 = zoomToSlider(1) - zoomToSlider(0.5)
    const d2 = zoomToSlider(2) - zoomToSlider(1)
    expect(d1).toBeCloseTo(d2, 8)
  })

  it('clamps out-of-range and invalid input', () => {
    expect(sliderToZoom(-50)).toBeCloseTo(MIN_ZOOM, 10)
    expect(sliderToZoom(SLIDER_STEPS * 3)).toBeCloseTo(MAX_ZOOM, 10)
    expect(sliderToZoom(Number.NaN)).toBeCloseTo(MIN_ZOOM, 10)
    expect(zoomToSlider(100)).toBeCloseTo(SLIDER_STEPS, 10)
    expect(zoomToSlider(0)).toBeCloseTo(zoomToSlider(1), 10)
  })
})

describe('presets', () => {
  it('snaps within 3% of a preset and nowhere else', () => {
    expect(snapToPreset(1.02)).toBe(1)
    expect(snapToPreset(0.98)).toBe(1)
    expect(snapToPreset(1.04)).toBe(1.04)
    expect(snapToPreset(0.257)).toBe(0.25)
    expect(snapToPreset(3.9)).toBe(4)
    expect(snapToPreset(1.2)).toBe(1.2)
  })

  it('finds the next preset in each direction', () => {
    expect(nextPreset(1, 1)).toBe(1.5)
    expect(nextPreset(1, -1)).toBe(0.75)
    expect(nextPreset(1.2, 1)).toBe(1.5)
    expect(nextPreset(1.2, -1)).toBe(1)
    expect(nextPreset(4, 1)).toBeNull()
    expect(nextPreset(0.25, -1)).toBeNull()
    expect(nextPreset(0.1, 1)).toBe(0.25)
  })

  it('every preset lies inside the zoom range', () => {
    for (const p of ZOOM_PRESETS) expect(p >= MIN_ZOOM && p <= MAX_ZOOM).toBe(true)
  })

  it('compares and formats like the readout', () => {
    expect(isPreset(0.996, 1)).toBe(true)
    expect(isPreset(1.01, 1)).toBe(false)
    expect(zoomPercent(1.254)).toBe('125%')
  })
})

describe('slider keys', () => {
  it('steps, jumps between presets and stops at the limits', () => {
    expect(zoomForKey('ArrowRight', 1)).toBeCloseTo(1.1, 10)
    expect(zoomForKey('ArrowLeft', 1)).toBeCloseTo(1 / 1.1, 10)
    // A step that lands right next to a preset settles on it.
    expect(zoomForKey('ArrowRight', 0.91)).toBe(1)
    expect(zoomForKey('PageUp', 1)).toBe(1.5)
    expect(zoomForKey('PageDown', 1)).toBe(0.75)
    expect(zoomForKey('PageUp', 4)).toBe(MAX_ZOOM)
    expect(zoomForKey('PageDown', 0.2)).toBe(MIN_ZOOM)
    expect(zoomForKey('Home', 2)).toBe(MIN_ZOOM)
    expect(zoomForKey('End', 2)).toBe(MAX_ZOOM)
    expect(zoomForKey('ArrowUp', MAX_ZOOM)).toBe(MAX_ZOOM)
    expect(zoomForKey('Enter', 1)).toBeNull()
  })
})
