/** Persistent warning while this device cannot save boards (storage full, blocked or broken). */
import { AlertTriangle } from 'lucide-react'
import { STORAGE_WARNING, useStorageHealth } from '../../collab/storageHealth'
import { useDialogs } from '../uiStore'

export function StorageBanner() {
  const broken = useStorageHealth((s) => s.unsavedBoards.length > 0 || s.libraryUnsaved)
  if (!broken) return null
  return (
    <div className="storage-banner" role="alert">
      <AlertTriangle size={16} aria-hidden />
      <span>{STORAGE_WARNING}</span>
      <button type="button" className="btn btn--ghost" onClick={() => useDialogs.getState().open('settings')}>
        Open settings
      </button>
    </div>
  )
}
