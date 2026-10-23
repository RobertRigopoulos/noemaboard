import { describe, expect, it } from 'vitest'
import { dataUrlToBlob, isAnimatedImage, parseSvgSize } from './imageMeta'
import { mapLimit, withTimeout, TimeoutError } from './async'

describe('parseSvgSize', () => {
  it('reads width and height', () => {
    expect(parseSvgSize('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"></svg>')).toEqual({ w: 120, h: 80 })
    expect(parseSvgSize("<svg width='120px' height='80px'>")).toEqual({ w: 120, h: 80 })
  })

  it('falls back to the viewBox', () => {
    expect(parseSvgSize('<?xml version="1.0"?>\n<svg viewBox="0 0 24 12" xmlns="http://www.w3.org/2000/svg">')).toEqual({ w: 24, h: 12 })
    expect(parseSvgSize('<svg viewBox="0,0,300,150">')).toEqual({ w: 300, h: 150 })
  })

  it('scales a single dimension by the viewBox', () => {
    expect(parseSvgSize('<svg width="200" viewBox="0 0 100 50">')).toEqual({ w: 200, h: 100 })
    expect(parseSvgSize('<svg height="100" viewBox="0 0 100 50">')).toEqual({ w: 200, h: 100 })
  })

  it('ignores percentages and attributes that only end in width', () => {
    expect(parseSvgSize('<svg width="100%" height="100%" viewBox="0 0 40 30">')).toEqual({ w: 40, h: 30 })
    expect(parseSvgSize('<svg stroke-width="2" viewBox="0 0 10 10">')).toEqual({ w: 10, h: 10 })
  })

  it('converts absolute units', () => {
    expect(parseSvgSize('<svg width="1in" height="72pt">')).toEqual({ w: 96, h: 96 })
  })

  it('returns null without size information or markup', () => {
    expect(parseSvgSize('<svg>')).toBeNull()
    expect(parseSvgSize('not svg')).toBeNull()
    expect(parseSvgSize('<svg viewBox="0 0 0 0">')).toBeNull()
  })

  it('clamps absurd sizes', () => {
    expect(parseSvgSize('<svg width="1e9" height="10">')).toEqual({ w: 20000, h: 10 })
  })
})

describe('dataUrlToBlob', () => {
  it('decodes base64 data URLs', async () => {
    const b = dataUrlToBlob('data:image/png;base64,iVBORw0KGgo=', 1000)!
    expect(b.type).toBe('image/png')
    expect(Array.from(new Uint8Array(await b.arrayBuffer()))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('decodes percent-encoded data URLs', async () => {
    const b = dataUrlToBlob('data:image/svg+xml,%3Csvg%3E%3C/svg%3E', 1000)!
    expect(b.type).toBe('image/svg+xml')
    expect(await b.text()).toBe('<svg></svg>')
  })

  it('rejects malformed or oversized input', () => {
    expect(dataUrlToBlob('https://example.com/x.png', 1000)).toBeNull()
    expect(dataUrlToBlob('data:image/png;base64,' + 'A'.repeat(4000), 1000)).toBeNull()
    expect(dataUrlToBlob('data:image/png;base64,***', 1000)).toBeNull()
  })
})

const bytes = (...parts: (string | number[])[]) => {
  const out: number[] = []
  for (const p of parts) {
    if (typeof p === 'string') for (const c of p) out.push(c.charCodeAt(0))
    else out.push(...p)
  }
  return new Uint8Array(out)
}

describe('isAnimatedImage', () => {
  it('treats every GIF as possibly animated', () => {
    expect(isAnimatedImage(new Uint8Array(), 'image/gif')).toBe(true)
  })

  it('reads the WebP animation flag', () => {
    const head = (flags: number) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0], [flags, 0, 0, 0])
    expect(isAnimatedImage(head(0x02), 'image/webp')).toBe(true)
    expect(isAnimatedImage(head(0x10), 'image/webp')).toBe(false)
    expect(isAnimatedImage(bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 '), 'image/webp')).toBe(false)
  })

  it('detects APNG by its acTL chunk before IDAT', () => {
    expect(isAnimatedImage(bytes([0x89], 'PNG', [0, 0, 0, 0], 'IHDR', [0, 0], 'acTL', [0], 'IDAT'), 'image/png')).toBe(true)
    expect(isAnimatedImage(bytes([0x89], 'PNG', [0, 0, 0, 0], 'IHDR', [0, 0], 'IDAT'), 'image/png')).toBe(false)
  })

  it('detects AVIF image sequences', () => {
    expect(isAnimatedImage(bytes([0, 0, 0, 0x20], 'ftyp', 'avis', [0, 0, 0, 0], 'avif'), 'image/avif')).toBe(true)
    expect(isAnimatedImage(bytes([0, 0, 0, 0x20], 'ftyp', 'avif', [0, 0, 0, 0], 'mif1'), 'image/avif')).toBe(false)
  })

  it('treats other formats as still images', () => {
    expect(isAnimatedImage(bytes('anything'), 'image/jpeg')).toBe(false)
  })
})

describe('async helpers', () => {
  it('mapLimit keeps order and bounds concurrency', async () => {
    let active = 0
    let peak = 0
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, n))
      active--
      return n * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30])
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('withTimeout rejects slow promises', async () => {
    await expect(withTimeout(new Promise(() => {}), 5)).rejects.toBeInstanceOf(TimeoutError)
    await expect(withTimeout(Promise.resolve(1), 50)).resolves.toBe(1)
  })
})
