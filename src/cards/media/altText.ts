/** Alt text for image cards and the label rule shared by the card, the lightbox and the clipboard. Pure. */

export const MAX_ALT = 1000
/** The caption stands in for alt text up to this many characters. */
const CAPTION_LABEL_CHARS = 200

// Bidi overrides and zero-width characters can disguise text; line breaks and tabs are whitespace.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g

/** One clean line: whitespace runs (line breaks included) become one space, control characters go. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').replace(CONTROL, '').replace(/ {2,}/g, ' ').trim()
}

/** Cuts to `max` UTF-16 units without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s
  let out = s.slice(0, max)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out.trimEnd()
}

/** The `alt` field as written by anyone: a single clean line of at most 1000 characters, else ''. */
export function readAlt(v: unknown): string {
  if (typeof v !== 'string') return ''
  return cut(collapse(v), MAX_ALT)
}

/** Names cameras and paste give files: they say nothing about the picture. */
export function isAutomaticName(name: string): boolean {
  return /^Pasted image \d{4}-\d{2}-\d{2}/.test(name) || /^(IMG|DSC|PXL)_\d+/i.test(name)
}

function baseName(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,10}$/, '').trim()
}

/**
 * What an image is called for people who can't see it: its alt text, else the start of its caption,
 * else its file name (without the extension, and not when the name is automatic), else 'Image'.
 */
export function imageLabel(alt: string, captionText: string, name: string): string {
  const a = readAlt(alt)
  if (a) return a
  const caption = cut(collapse(captionText), CAPTION_LABEL_CHARS)
  if (caption) return caption
  const n = collapse(name)
  if (n && !isAutomaticName(n)) {
    const base = baseName(n)
    if (base) return base
  }
  return 'Image'
}
