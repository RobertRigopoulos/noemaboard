/** Remembered window bounds (userData/window.json). Pure validation + tiny fs helpers. */
import fs from 'node:fs'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  bounds: Rect | null
  maximized: boolean
}

export const DEFAULT_SIZE = { width: 1280, height: 820 }
export const MIN_SIZE = { width: 720, height: 480 }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 100_000

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Validates stored state against the current displays. Bounds that are malformed or mostly
 * off-screen (e.g. a monitor was unplugged) are dropped so the window opens centered.
 */
export function sanitizeWindowState(raw: unknown, workAreas: readonly Rect[]): WindowState {
  const out: WindowState = { bounds: null, maximized: false }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  out.maximized = r.maximized === true
  const b = r.bounds as Record<string, unknown> | undefined
  if (!b || typeof b !== 'object' || !isInt(b.x) || !isInt(b.y) || !isInt(b.width) || !isInt(b.height)) return out
  const largest = workAreas.reduce((m, a) => ({ width: Math.max(m.width, a.width), height: Math.max(m.height, a.height) }), {
    width: 0,
    height: 0,
  })
  const bounds: Rect = {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(Math.max(MIN_SIZE.width, Math.min(b.width, largest.width || b.width))),
    height: Math.round(Math.max(MIN_SIZE.height, Math.min(b.height, largest.height || b.height))),
  }
  // Require a meaningful part of the window (incl. its title bar area) to be visible somewhere.
  const visible = workAreas.some((a) => overlapArea(bounds, a) >= Math.min(bounds.width * bounds.height * 0.25, 200 * 120))
  const titleBar: Rect = { x: bounds.x + 40, y: bounds.y, width: Math.max(1, bounds.width - 80), height: 32 }
  const grabbable = workAreas.some((a) => overlapArea(titleBar, a) > 0)
  if (visible && grabbable) out.bounds = bounds
  return out
}

export function loadWindowState(file: string, workAreas: readonly Rect[]): WindowState {
  try {
    return sanitizeWindowState(JSON.parse(fs.readFileSync(file, 'utf8')), workAreas)
  } catch {
    return { bounds: null, maximized: false }
  }
}

export function saveWindowState(file: string, state: WindowState): void {
  try {
    fs.writeFileSync(file, JSON.stringify(state))
  } catch {
    // Not critical: the window just opens with default bounds next time.
  }
}
