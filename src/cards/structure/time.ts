/**
 * Compact relative timestamps for comment threads ('just now', '5m', '3h', 'Yesterday', 'Mar 5')
 * plus a shared clock so every visible comment re-renders from one timer.
 */
import { useSyncExternalStore } from 'react'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Formats `ts` relative to `now`. Timestamps from peers can be skewed into the future,
 * which reads as 'just now' rather than a negative duration.
 */
export function formatRelativeTime(ts: number, now: number, locale?: string): string {
  if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(now)) return ''
  const diff = now - ts
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`
  const today = startOfDay(now)
  if (ts >= today) return `${Math.floor(diff / HOUR)}h`
  // Day before `today` (DST-safe: step back from midnight, then snap to that day's midnight).
  const yesterday = startOfDay(today - 1)
  if (ts >= yesterday) return 'Yesterday'
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  try {
    return d.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return d.toDateString()
  }
}

/** Full timestamp for tooltips / <time title>. */
export function formatFullDate(ts: number, locale?: string): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  try {
    return new Date(ts).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return new Date(ts).toString()
  }
}

// ---------------------------------------------------------------------------
// Shared ticking clock

const TICK_MS = 30_000
let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  if (!timer) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      listeners.forEach((l) => l())
    }, TICK_MS)
  }
  return () => {
    listeners.delete(cb)
    if (!listeners.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

const getNow = () => now

/** Current time, refreshed every 30 s while any component uses it. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getNow)
}

/** Lets a fresh render show 'just now' for a message sent a moment ago. */
export function refreshNow() {
  now = Date.now()
  listeners.forEach((l) => l())
}
