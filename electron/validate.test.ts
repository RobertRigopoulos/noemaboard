import { describe, expect, it } from 'vitest'
import { PDF_PAGE_SIZES } from '../src/lib/desktop'
import { PRINT_PAGE_SIZES, sanitizePrintOptions } from './validate'

describe('sanitizePrintOptions', () => {
  it('accepts exactly a known page size and a boolean orientation', () => {
    for (const pageSize of ['A4', 'Letter', 'A3']) {
      expect(sanitizePrintOptions({ pageSize, landscape: false })).toEqual({ pageSize, landscape: false })
      expect(sanitizePrintOptions({ pageSize, landscape: true })).toEqual({ pageSize, landscape: true })
    }
  })

  it('returns a fresh object, never the caller-controlled one', () => {
    const raw = { pageSize: 'A4', landscape: true }
    const clean = sanitizePrintOptions(raw)
    expect(clean).not.toBe(raw)
  })

  it('rejects other page sizes, spellings and custom sizes', () => {
    for (const pageSize of ['a4', 'A5', 'Legal', 'Tabloid', ' A4', 'A4 ', '', null, 4, { width: 100, height: 100 }]) {
      expect(sanitizePrintOptions({ pageSize, landscape: false }), String(pageSize)).toBeNull()
    }
  })

  it('rejects non-boolean orientation', () => {
    for (const landscape of ['true', 1, 0, null, undefined, {}]) {
      expect(sanitizePrintOptions({ pageSize: 'A4', landscape }), String(landscape)).toBeNull()
    }
  })

  it('rejects extra or missing keys, so nothing else reaches printToPDF', () => {
    expect(sanitizePrintOptions({ pageSize: 'A4' })).toBeNull()
    expect(sanitizePrintOptions({ landscape: true })).toBeNull()
    expect(sanitizePrintOptions({ pageSize: 'A4', landscape: false, printBackground: false })).toBeNull()
    expect(sanitizePrintOptions({ pageSize: 'A4', landscape: false, headerTemplate: '<img src=x>' })).toBeNull()
    expect(sanitizePrintOptions({ pageSize: 'A4', landscape: false, margins: { top: 5 } })).toBeNull()
  })

  it('rejects non-objects', () => {
    for (const raw of [null, undefined, 'A4', 42, true, [], ['A4', false]]) {
      expect(sanitizePrintOptions(raw), JSON.stringify(raw)).toBeNull()
    }
  })

  it('agrees with the page sizes the renderer offers', () => {
    expect([...PRINT_PAGE_SIZES]).toEqual([...PDF_PAGE_SIZES])
  })
})
