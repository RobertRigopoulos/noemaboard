/**
 * Can this device save? Board databases (IndexedDB) and the keyring (localStorage) report
 * failures here, so a broken or full storage is never silent: the user gets a warning toast
 * (repeated now and then while it lasts) and the UI can show a persistent notice from
 * `useStorageHealth`.
 */
import { create } from 'zustand'
import { toast } from '../ui/toast'

export interface StorageHealthState {
  /** Boards whose local database could not be opened, loaded or written: their changes are not saved. */
  unsavedBoards: string[]
  /** The list of known boards (keys, titles, shared flags) could not be saved. */
  libraryUnsaved: boolean
}

export const useStorageHealth = create<StorageHealthState>(() => ({ unsavedBoards: [], libraryUnsaved: false }))

export const STORAGE_WARNING =
  "Changes can't be saved on this device. Export a backup (Export & backup) to keep your work, then free up disk space or check the browser's storage settings and reload."

/** How often the warning is repeated while storage stays broken. */
const REPEAT_MS = 5 * 60_000
const TOAST_MS = 30_000
let lastWarned = 0

function warn(now = Date.now()) {
  if (lastWarned && now - lastWarned < REPEAT_MS) return
  lastWarned = now
  try {
    toast(STORAGE_WARNING, 'error', TOAST_MS)
  } catch {
    // no UI (tests, workers)
  }
}

/** A board's database failed (open, load or write). Idempotent; repeats the warning at most every few minutes. */
export function reportBoardStorageFailure(boardId: string, err?: unknown) {
  const s = useStorageHealth.getState()
  if (!s.unsavedBoards.includes(boardId)) {
    console.warn('[storage] changes to board', boardId, 'are not being saved', err)
    useStorageHealth.setState({ unsavedBoards: [...s.unsavedBoards, boardId] })
  }
  warn()
}

/** The board's database works again (e.g. a slow open finished after all). */
export function reportBoardStorageOk(boardId: string) {
  const s = useStorageHealth.getState()
  if (s.unsavedBoards.includes(boardId)) useStorageHealth.setState({ unsavedBoards: s.unsavedBoards.filter((id) => id !== boardId) })
}

/** The keyring was (not) saved. */
export function reportLibrarySave(ok: boolean) {
  if (useStorageHealth.getState().libraryUnsaved !== !ok) useStorageHealth.setState({ libraryUnsaved: !ok })
  if (!ok) {
    console.warn('[storage] the list of boards could not be saved')
    warn()
  }
}

/** True while some changes on this device are not being saved. */
export function storageBroken(): boolean {
  const s = useStorageHealth.getState()
  return s.libraryUnsaved || s.unsavedBoards.length > 0
}

/** For tests. */
export function resetStorageHealth() {
  lastWarned = 0
  useStorageHealth.setState({ unsavedBoards: [], libraryUnsaved: false })
}
