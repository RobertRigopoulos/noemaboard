/** Which comment pin has its thread open (local UI state, one popover at a time). */
import { create } from 'zustand'

export interface OpenPin {
  commentId: string
  /** Focus the reply composer when the popover opens (new comment, keyboard shortcut). */
  focusComposer: boolean
}

interface PinState {
  open: OpenPin | null
  openPin: (commentId: string, opts?: { focusComposer?: boolean }) => void
  closePin: () => void
}

export const usePins = create<PinState>((set) => ({
  open: null,
  openPin: (commentId, opts = {}) => set({ open: { commentId, focusComposer: opts.focusComposer === true } }),
  closePin: () => set({ open: null }),
}))

/**
 * Pins created on this device by the 'Comment' action and still without a message. Closing such a
 * popover without writing anything removes the pin again, like an empty note.
 */
const fresh = new Set<string>()

export function markFreshPin(id: string) {
  fresh.add(id)
}

/** True (once) when `id` was a fresh pin; it no longer is afterwards. */
export function takeFreshPin(id: string): boolean {
  return fresh.delete(id)
}
