/**
 * Image decoding and re-encoding in the browser: intrinsic size, downscaling of very large images,
 * and small display thumbnails. Everything degrades gracefully: an image we cannot decode becomes
 * a file card instead.
 */
import { isAnimatedImage, parseSvgSize } from './imageMeta'
import { transformMatrix, type ImageTransform } from './transform'

/**
 * Images above any of these limits are stored downscaled so peer-to-peer transfers stay reasonable.
 * The limits are on the short edge and the pixel count, not the long edge: a full-page screenshot
 * (say 1440 × 12000) is kept as it is, so its text stays readable at full size and when downloaded.
 */
export const MAX_STORED_EDGE = 4096
export const MAX_STORED_PIXELS = 40_000_000
export const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024
/** Re-encoded copies stay within what every browser's canvas can draw. */
const MAX_CANVAS_EDGE = 16_384
/** Width of the thumbnail cards render from (sharp at 300px wide up to ~2.5x zoom/DPR). */
export const THUMB_WIDTH = 800
/** Images narrower (and shorter) than this display straight from the original. */
const THUMB_MIN_SOURCE_WIDTH = 1200
const THUMB_MAX_SOURCE_HEIGHT = MAX_STORED_EDGE
const THUMB_MIN_SOURCE_BYTES = 400 * 1024

/**
 * Whether an image of w × h pixels and `bytes` bytes is stored re-encoded, and at what scale.
 * scale < 1 means downscaled; scale 1 with reencode means "re-encode only if that is smaller".
 */
export function storagePlan(w: number, h: number, bytes: number): { reencode: boolean; scale: number } {
  const short = Math.min(w, h)
  const long = Math.max(w, h)
  const pixels = w * h
  if (bytes <= MAX_ORIGINAL_BYTES && short <= MAX_STORED_EDGE && pixels <= MAX_STORED_PIXELS) return { reencode: false, scale: 1 }
  const scale = Math.min(1, MAX_STORED_EDGE / short, Math.sqrt(MAX_STORED_PIXELS / pixels), MAX_CANVAS_EDGE / long)
  return { reencode: true, scale }
}

/** Size of the on-board display copy, or null when the stored image is shown directly. */
export function thumbSize(iw: number, ih: number, bytes: number): { w: number; h: number } | null {
  if (bytes <= THUMB_MIN_SOURCE_BYTES || (iw <= THUMB_MIN_SOURCE_WIDTH && ih <= THUMB_MAX_SOURCE_HEIGHT)) return null
  // Very tall images are limited by height so the display copy stays small to decode.
  const scale = Math.min(1, THUMB_WIDTH / iw, THUMB_MAX_SOURCE_HEIGHT / ih)
  return { w: Math.max(1, Math.round(iw * scale)), h: Math.max(1, Math.round(ih * scale)) }
}

export interface ProcessedImage {
  /** Bytes to store: the original, or a downscaled re-encode. */
  blob: Blob
  iw: number
  ih: number
  /** Smaller rendition for on-board display, when worthwhile. */
  thumb: Blob | null
}

type Source = ImageBitmap | HTMLImageElement

export function isSvg(mime: string, name = ''): boolean {
  return mime === 'image/svg+xml' || /\.svg$/i.test(name)
}

/** Decodes an image file. Returns null when the browser cannot decode it (HEIC, TIFF, corrupt...). */
export async function processImageFile(file: Blob, name = ''): Promise<ProcessedImage | null> {
  const mime = file.type.toLowerCase()
  if (isSvg(mime, name)) return processSvg(file)

  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  const animated = isAnimatedImage(head, mime)
  const decoded = await decode(file)
  if (!decoded) return null
  const { source, w, h } = decoded
  try {
    let blob: Blob = file
    let iw = w
    let ih = h
    const plan = storagePlan(w, h, file.size)
    if (!animated && plan.reencode) {
      const tw = Math.max(1, Math.round(w * plan.scale))
      const th = Math.max(1, Math.round(h * plan.scale))
      const re = await encode(source, tw, th, mime, 0.9)
      // Keep the original when re-encoding does not actually help (already compact, same size).
      if (re && (plan.scale < 1 || re.size < file.size)) {
        blob = re
        iw = tw
        ih = th
      }
    }
    let thumb: Blob | null = null
    const ts = animated ? null : thumbSize(iw, ih, blob.size)
    if (ts) {
      const t = await encode(source, ts.w, ts.h, mime, 0.85)
      if (t && t.size < blob.size * 0.8) thumb = t
    }
    return { blob, iw, ih, thumb }
  } finally {
    if ('close' in source) source.close()
  }
}

/** Makes a remote preview image (og:image) no wider than `maxWidth`; returns the input when small or undecodable. */
export async function shrinkImage(blob: Blob, maxWidth: number): Promise<Blob> {
  const mime = blob.type.toLowerCase()
  if (isSvg(mime)) return blob
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer())
  if (isAnimatedImage(head, mime)) return blob
  const decoded = await decode(blob)
  if (!decoded) return blob
  const { source, w, h } = decoded
  try {
    if (w <= maxWidth) return blob
    const re = await encode(source, maxWidth, Math.max(1, Math.round((h * maxWidth) / w)), mime, 0.85)
    return re && re.size < blob.size ? re : blob
  } finally {
    if ('close' in source) source.close()
  }
}

async function processSvg(file: Blob): Promise<ProcessedImage | null> {
  // The <img> load proves the SVG renders; markup gives the real intrinsic size.
  const img = await loadImage(file)
  if (!img) return null
  let size: { w: number; h: number } | null = null
  if (file.size < 5 * 1024 * 1024) {
    try {
      size = parseSvgSize(await file.text())
    } catch {
      size = null
    }
  }
  if (!size && img.naturalWidth > 0 && img.naturalHeight > 0) size = { w: img.naturalWidth, h: img.naturalHeight }
  size ??= { w: 300, h: 300 }
  return { blob: file, iw: size.w, ih: size.h, thumb: null }
}

async function decode(file: Blob): Promise<{ source: Source; w: number; h: number } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
      if (bmp.width > 0 && bmp.height > 0) return { source: bmp, w: bmp.width, h: bmp.height }
      bmp.close()
    } catch {
      // fall through to <img>
    }
  }
  const img = await loadImage(file)
  if (!img || !img.naturalWidth || !img.naturalHeight) return null
  return { source: img, w: img.naturalWidth, h: img.naturalHeight }
}

function loadImage(file: Blob): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    const done = (ok: boolean) => {
      URL.revokeObjectURL(url)
      resolve(ok ? img : null)
    }
    img.onload = () => {
      // decode() makes sure the pixels are ready before we draw them to a canvas.
      img.decode().then(
        () => done(true),
        () => done(img.naturalWidth > 0),
      )
    }
    img.onerror = () => done(false)
    img.decoding = 'async'
    img.src = url
  })
}

/**
 * Draws the source at w x h and encodes it: WebP (keeps transparency), falling back to JPEG for
 * JPEG sources or PNG otherwise on engines without a WebP encoder.
 */
async function encode(source: Source, w: number, h: number, sourceMime: string, quality: number): Promise<Blob | null> {
  try {
    const webp = await drawAndEncode(source, w, h, 'image/webp', quality)
    if (webp && webp.type === 'image/webp') return webp
    const fallback = sourceMime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    const b = await drawAndEncode(source, w, h, fallback, quality)
    return b && b.type === fallback ? b : null
  } catch {
    return null
  }
}

async function drawAndEncode(source: Source, w: number, h: number, type: string, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, 0, 0, w, h)
    return canvas.convertToBlob({ type, quality })
  }
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, w, h)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality))
}

const KEEP_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

/**
 * Renders an image card's crop, rotation and flips into a new image (for "Download edited" and
 * copying to the clipboard). The long edge is scaled down to `maxEdge`. Keeps PNG, JPEG (quality
 * 0.92) and WebP; anything else, or `type` when given, is encoded as that type (PNG by default).
 * Rejects when the image cannot be decoded or encoded.
 */
export async function renderTransformed(blob: Blob, t: ImageTransform, iw: number, ih: number, maxEdge = 8192, type?: string): Promise<Blob> {
  const mime = blob.type.toLowerCase()
  const outType = type ?? (KEEP_TYPES.has(mime) ? mime : 'image/png')
  const decoded = await decode(blob)
  if (!decoded) throw new Error('Image could not be decoded')
  const { source } = decoded
  try {
    // The decoded size wins over the card's stored size (crop fractions apply to either).
    const sw = decoded.w > 0 ? decoded.w : iw
    const sh = decoded.h > 0 ? decoded.h : ih
    if (!(sw > 0 && sh > 0)) throw new Error('Image has no size')
    const { width, height, matrix } = transformMatrix(t, sw, sh, Math.min(maxEdge, MAX_CANVAS_EDGE))
    const draw = (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => {
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.setTransform(...matrix)
      ctx.drawImage(source, 0, 0, sw, sh)
    }
    const quality = outType === 'image/jpeg' ? 0.92 : undefined
    let out: Blob | null = null
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('No 2D canvas')
      draw(ctx)
      out = await canvas.convertToBlob({ type: outType, quality })
    } else if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('No 2D canvas')
      draw(ctx)
      out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outType, quality))
    }
    if (!out) throw new Error('Image could not be encoded')
    return out
  } finally {
    if ('close' in source) source.close()
  }
}
