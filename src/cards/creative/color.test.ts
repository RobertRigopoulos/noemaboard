import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  formatHsl,
  formatRgb,
  hexToRgb,
  hslToRgb,
  isHex6,
  isVeryLight,
  parseColor,
  readableTextColor,
  relativeLuminance,
  rgbToHex,
  rgbToHsl,
} from './color'

describe('parseColor', () => {
  it('accepts short and long hex with or without #', () => {
    expect(parseColor('#abc')).toBe('#aabbcc')
    expect(parseColor('abc')).toBe('#aabbcc')
    expect(parseColor('#AABBCC')).toBe('#aabbcc')
    expect(parseColor('7c6cf0')).toBe('#7c6cf0')
    expect(parseColor('  #7C6CF0  ')).toBe('#7c6cf0')
  })

  it('ignores alpha in 4 and 8 digit hex', () => {
    expect(parseColor('#abcd')).toBe('#aabbcc')
    expect(parseColor('#7c6cf080')).toBe('#7c6cf0')
  })

  it('parses rgb() / rgba() with commas, spaces and percentages', () => {
    expect(parseColor('rgb(124, 108, 240)')).toBe('#7c6cf0')
    expect(parseColor('RGB(124,108,240)')).toBe('#7c6cf0')
    expect(parseColor('rgb(124 108 240)')).toBe('#7c6cf0')
    expect(parseColor('rgba(124, 108, 240, 0.5)')).toBe('#7c6cf0')
    expect(parseColor('rgb(124 108 240 / 50%)')).toBe('#7c6cf0')
    expect(parseColor('rgb(100%, 0%, 50%)')).toBe('#ff0080')
  })

  it('clamps out-of-range channels', () => {
    expect(parseColor('rgb(300, -5, 128)')).toBe('#ff0080')
  })

  it('parses hsl()', () => {
    expect(parseColor('hsl(0, 100%, 50%)')).toBe('#ff0000')
    expect(parseColor('hsl(120deg 100% 25%)')).toBe('#008000')
    expect(parseColor('hsla(0.5turn, 100%, 50%, 1)')).toBe('#00ffff')
  })

  it('accepts a bare r, g, b triple', () => {
    expect(parseColor('124, 108, 240')).toBe('#7c6cf0')
    expect(parseColor('124 108 240')).toBe('#7c6cf0')
  })

  it('rejects garbage and non-strings', () => {
    for (const bad of ['', '#ab', '#abcde', 'zzz', 'rgb(1,2)', 'rgb(a, b, c)', 'rgb(1, 2, 3, 4, 5)', 'url(x)', 'red; x', '1 2 3 4', 'rgb(1px, 2, 3)']) {
      expect(parseColor(bad), bad).toBeNull()
    }
    expect(parseColor(null)).toBeNull()
    expect(parseColor(123)).toBeNull()
    expect(parseColor({})).toBeNull()
    expect(parseColor('#' + 'a'.repeat(100))).toBeNull()
  })
})

describe('formatting', () => {
  it('converts between hex and rgb', () => {
    expect(hexToRgb('#7c6cf0')).toEqual({ r: 124, g: 108, b: 240 })
    expect(hexToRgb('nope')).toBeNull()
    expect(rgbToHex({ r: 124, g: 108, b: 240 })).toBe('#7c6cf0')
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000')
    expect(rgbToHex({ r: 400, g: -1, b: 15.6 })).toBe('#ff0010')
  })

  it('formats rgb like CSS', () => {
    expect(formatRgb({ r: 124, g: 108, b: 240 })).toBe('rgb(124, 108, 240)')
  })

  it('round-trips hsl', () => {
    const rgb = { r: 124, g: 108, b: 240 }
    const hsl = rgbToHsl(rgb)
    expect(Math.round(hsl.h)).toBe(247)
    expect(hslToRgb(hsl)).toEqual(rgb)
    expect(formatHsl(rgb)).toBe('hsl(247, 81%, 68%)')
    expect(formatHsl({ r: 128, g: 128, b: 128 })).toBe('hsl(0, 0%, 50%)')
  })

  it('validates the stored form strictly', () => {
    expect(isHex6('#7c6cf0')).toBe(true)
    expect(isHex6('#7C6CF0')).toBe(false)
    expect(isHex6('#abc')).toBe(false)
    expect(isHex6('7c6cf0')).toBe(false)
    expect(isHex6(5)).toBe(false)
  })
})

describe('contrast', () => {
  it('computes WCAG luminance and contrast', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0)
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6)
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 6)
    expect(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 })).toBe(1)
    // Known value: #767676 on white is the classic 4.54:1
    expect(contrastRatio({ r: 118, g: 118, b: 118 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(4.54, 2)
  })

  it('picks readable ink for a background', () => {
    expect(readableTextColor('#ffffff')).toBe('#1f2328')
    expect(readableTextColor('#f2c23b')).toBe('#1f2328')
    expect(readableTextColor('#000000')).toBe('#ffffff')
    expect(readableTextColor('#2b2d31')).toBe('#ffffff')
    expect(readableTextColor('#e5484d')).toBe('#1f2328')
    expect(readableTextColor('#0b3d91')).toBe('#ffffff')
    expect(readableTextColor('garbage')).toBe('#1f2328')
  })

  it('flags very light colors', () => {
    expect(isVeryLight('#ffffff')).toBe(true)
    expect(isVeryLight('#fafafa')).toBe(true)
    expect(isVeryLight('#7c6cf0')).toBe(false)
  })
})
