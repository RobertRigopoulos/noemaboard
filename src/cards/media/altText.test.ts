import { describe, expect, it } from 'vitest'
import { imageLabel, isAutomaticName, MAX_ALT, readAlt } from './altText'

describe('readAlt', () => {
  it('cleans and collapses the text', () => {
    expect(readAlt('  A red\n\n bicycle\tleaning  ')).toBe('A red bicycle leaning')
    expect(readAlt('evil‮txt.exe\u0007')).toBe('eviltxt.exe')
    expect(readAlt('zero​width')).toBe('zerowidth')
    expect(readAlt('﻿  bom⁦ and isolate⁩ ')).toBe('bom and isolate')
  })

  it('accepts only strings', () => {
    expect(readAlt(42)).toBe('')
    expect(readAlt(null)).toBe('')
    expect(readAlt({ toString: () => 'x' })).toBe('')
  })

  it('caps the length at 1000 characters', () => {
    expect(readAlt('a'.repeat(5000))).toHaveLength(MAX_ALT)
    // Never splits a surrogate pair.
    expect(readAlt('a'.repeat(MAX_ALT - 1) + '\u{1F600}')).toHaveLength(MAX_ALT - 1)
  })
})

describe('imageLabel', () => {
  it('prefers alt, then caption, then the name, then "Image"', () => {
    expect(imageLabel('A cat', 'Caption', 'cat.png')).toBe('A cat')
    expect(imageLabel('', '  My   caption ', 'cat.png')).toBe('My caption')
    expect(imageLabel('', '', 'Sunset at the pier.jpeg')).toBe('Sunset at the pier')
    expect(imageLabel('', '', '')).toBe('Image')
  })

  it('cuts long captions to 200 characters', () => {
    expect(imageLabel('', 'x'.repeat(500), 'a.png')).toHaveLength(200)
  })

  it('skips automatic file names', () => {
    expect(isAutomaticName('Pasted image 2026-10-22 17.03.11.png')).toBe(true)
    expect(isAutomaticName('IMG_2041.HEIC')).toBe(true)
    expect(isAutomaticName('dsc_0001.jpg')).toBe(true)
    expect(isAutomaticName('PXL_20260101_123456.jpg')).toBe(true)
    expect(isAutomaticName('IMG of the year.png')).toBe(false)
    expect(imageLabel('', '', 'Pasted image 2026-10-22 17.03.11.png')).toBe('Image')
    expect(imageLabel('', '', 'IMG_2041.jpg')).toBe('Image')
  })
})
