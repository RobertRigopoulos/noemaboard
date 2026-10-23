/** Which app dialog is open. Shared by the header, toolbar and home screen. */
import { create } from 'zustand'

export type DialogName = 'share' | 'join' | 'settings' | 'profile' | 'shortcuts' | 'search' | 'export' | 'templates' | 'imageExport' | null

export const useDialogs = create<{ dialog: DialogName; open: (d: Exclude<DialogName, null>) => void; close: () => void }>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}))

export type BoardPickerMode = 'move' | 'copy'

/**
 * "Move to board… / Copy to board…": the cards the picker acts on, and the board they are on (the
 * picker closes when another board opens, so the ids never apply to the wrong board).
 */
export const useBoardPicker = create<{
  request: { mode: BoardPickerMode; ids: string[]; boardId: string } | null
  open: (mode: BoardPickerMode, ids: readonly string[], boardId: string) => void
  close: () => void
}>((set) => ({
  request: null,
  open: (mode, ids, boardId) => set({ request: { mode, ids: [...ids], boardId } }),
  close: () => set({ request: null }),
}))
