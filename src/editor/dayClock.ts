/**
 * Today's local date, as a store that changes at local midnight, so "due today" and "overdue"
 * states on to-dos move on without a reload. Waking from sleep or coming back to the tab re-checks,
 * because timers do not run while a computer sleeps.
 */
import { create } from 'zustand'
import { localDateKey } from './taskMeta'

export const useDayClock = create<{ today: string }>(() => ({ today: localDateKey(new Date()) }))

let started = false
let timer: ReturnType<typeof setTimeout> | null = null

function tick() {
  const today = localDateKey(new Date())
  if (useDayClock.getState().today !== today) useDayClock.setState({ today })
  arm()
}

function arm() {
  if (timer) clearTimeout(timer)
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1)
  timer = setTimeout(tick, Math.max(1000, Math.min(next.getTime() - now.getTime(), 6 * 3600 * 1000)))
}

function start() {
  if (started || typeof window === 'undefined') return
  started = true
  arm()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick()
  })
  window.addEventListener('focus', tick)
}

/** Today's local date key ("YYYY-MM-DD"); re-renders at midnight. */
export function useToday(): string {
  start()
  return useDayClock((s) => s.today)
}

/** Current value without subscribing (non-React code). */
export function today(): string {
  start()
  return useDayClock.getState().today
}
