/** Tiny toast queue. Call toast('Saved') from anywhere; AppOverlays renders them. */
import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error'
export interface ToastAction {
  label: string
  run: () => void
}
export interface Toast {
  id: number
  message: string
  kind: ToastKind
  action?: ToastAction
}

/** Toasts with a button stay long enough to reach it by keyboard or pointer. */
export const ACTION_TOAST_MIN_MS = 6000
const MAX_TOASTS = 4

interface Timer {
  handle: ReturnType<typeof setTimeout> | null
  /** Time left when paused, or the full duration before the first start. */
  remaining: number
  startedAt: number
  /** Hover and focus can overlap; the timer runs only when nothing holds it. */
  holds: number
}

const timers = new Map<number, Timer>()
let nextId = 1

interface ToastState {
  toasts: Toast[]
  dismiss: (id: number) => void
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  dismiss: (id) => {
    const t = timers.get(id)
    if (t?.handle) clearTimeout(t.handle)
    timers.delete(id)
    set({ toasts: get().toasts.filter((x) => x.id !== id) })
  },
}))

function start(id: number) {
  const t = timers.get(id)
  if (!t || t.handle || t.holds > 0) return
  t.startedAt = Date.now()
  t.handle = setTimeout(() => useToasts.getState().dismiss(id), t.remaining)
}

/** Stops the dismiss countdown while the toast is hovered or focused. */
export function holdToast(id: number) {
  const t = timers.get(id)
  if (!t) return
  t.holds++
  if (t.handle) {
    clearTimeout(t.handle)
    t.handle = null
    t.remaining = Math.max(1500, t.remaining - (Date.now() - t.startedAt))
  }
}

export function releaseToast(id: number) {
  const t = timers.get(id)
  if (!t) return
  t.holds = Math.max(0, t.holds - 1)
  start(id)
}

/** Runs a toast's action and dismisses it. An action that throws still dismisses. */
export function runToastAction(id: number) {
  const t = useToasts.getState().toasts.find((x) => x.id === id)
  useToasts.getState().dismiss(id)
  try {
    t?.action?.run()
  } catch (err) {
    console.warn('Toast action failed', err)
  }
}

export function toast(message: string, kind: ToastKind = 'info', ms = 4000, action?: ToastAction): number {
  const id = nextId++
  const duration = action ? Math.max(ms, ACTION_TOAST_MIN_MS) : ms
  const entry: Toast = action ? { id, message, kind, action } : { id, message, kind }
  const all = [...useToasts.getState().toasts, entry]
  // Oldest toasts fall off the stack; their timers go with them.
  for (const dropped of all.slice(0, Math.max(0, all.length - MAX_TOASTS))) {
    const t = timers.get(dropped.id)
    if (t?.handle) clearTimeout(t.handle)
    timers.delete(dropped.id)
  }
  timers.set(id, { handle: null, remaining: duration, startedAt: Date.now(), holds: 0 })
  useToasts.setState({ toasts: all.slice(-MAX_TOASTS) })
  start(id)
  return id
}
