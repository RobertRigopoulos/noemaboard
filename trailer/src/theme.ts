/** Brand colours, fonts and per-format layout (design/brand.md). */
import { loadFont } from '@remotion/fonts'
import { continueRender, delayRender, staticFile } from 'remotion'

export const COLORS = {
  canvas: '#17191c',
  tile: '#24282e',
  card: '#22252a',
  paper: '#eceef1',
  muted: '#9da3ad',
  yellow: '#f2c23b',
  ada: '#0090ff',
  ben: '#f76b15',
  line: 'rgba(255, 255, 255, 0.09)',
}

export const DISPLAY = 'Fraunces, Georgia, serif'
export const TEXT = 'Inter, system-ui, sans-serif'

const fonts = delayRender('Loading fonts')
Promise.all([
  loadFont({ family: 'Fraunces', url: staticFile('brand/fraunces.woff2'), weight: '100 900' }),
  loadFont({ family: 'Inter', url: staticFile('brand/inter.woff2'), weight: '100 900' }),
])
  .then(() => continueRender(fonts))
  .catch((e) => {
    console.error(e)
    continueRender(fonts)
  })

export type Format = '16x9' | '4x5' | '9x16'
export const FORMATS: Format[] = ['16x9', '4x5', '9x16']

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  width: number
  height: number
  /** Top of the caption block and the size of its lines. */
  captionTop: number
  headline: number
  sub: number
  /** Width the caption may use (centered). */
  captionWidth: number
  /** The app window in feature scenes. */
  panel: Box
  /** The two windows in the "together" scene. */
  pair: [Box, Box]
  /** Pointer height in output pixels. */
  pointer: number
  /** Largest camera zoom, clip pixels to output pixels (more would look soft). */
  maxZoom: number
}

export const LAYOUTS: Record<Format, Layout> = {
  '16x9': {
    width: 1920,
    height: 1080,
    captionTop: 58,
    headline: 70,
    sub: 30,
    captionWidth: 1600,
    panel: { x: 236, y: 226, w: 1448, h: 815 },
    pair: [
      { x: 92, y: 262, w: 852, h: 760 },
      { x: 976, y: 262, w: 852, h: 760 },
    ],
    pointer: 34,
    maxZoom: 1.0,
  },
  '4x5': {
    width: 1080,
    height: 1350,
    captionTop: 86,
    headline: 74,
    sub: 32,
    captionWidth: 960,
    panel: { x: 54, y: 372, w: 972, h: 912 },
    pair: [
      { x: 54, y: 404, w: 972, h: 410 },
      { x: 54, y: 874, w: 972, h: 410 },
    ],
    pointer: 36,
    maxZoom: 1.2,
  },
  '9x16': {
    width: 1080,
    height: 1920,
    captionTop: 230,
    headline: 84,
    sub: 36,
    captionWidth: 940,
    panel: { x: 54, y: 640, w: 972, h: 1040 },
    pair: [
      { x: 54, y: 676, w: 972, h: 500 },
      { x: 54, y: 1236, w: 972, h: 500 },
    ],
    pointer: 40,
    maxZoom: 1.3,
  },
}
