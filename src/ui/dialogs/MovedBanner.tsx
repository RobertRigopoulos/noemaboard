/** At NoemaBoard's old web address: where it lives now, and how to move the boards kept here. */
import { useState } from 'react'
import { Archive, Info, X } from 'lucide-react'
import { WEBSITE_URL } from '../../config'
import { atOldAddress } from '../../app/moved'
import { loadJSON, saveJSON } from '../../collab/profile'
import { downloadFullBackup, useExportBusy } from '../export/exportActions'

const DISMISSED_KEY = 'moved-note-dismissed'
/** Hiding the note lasts this long; it then comes back as a reminder. */
const HIDE_FOR_MS = 14 * 24 * 60 * 60 * 1000

export function MovedBanner() {
  const [hiddenAt, setHiddenAt] = useState(() => {
    const v = loadJSON<unknown>(DISMISSED_KEY, 0)
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  })
  const busy = useExportBusy((s) => s.busy)
  if (!atOldAddress() || Date.now() - hiddenAt < HIDE_FOR_MS) return null
  const hide = () => {
    const now = Date.now()
    saveJSON(DISMISSED_KEY, now)
    setHiddenAt(now)
  }
  return (
    <div className="moved-banner" role="region" aria-label="NoemaBoard has moved">
      <Info size={16} aria-hidden className="moved-banner__icon" />
      <span className="moved-banner__text">
        <strong>NoemaBoard now lives at noemaboard.app.</strong> Your boards here keep working. To move them, export a full backup,
        then open noemaboard.app and choose <em>Import a backup</em> in the NoemaBoard menu.
      </span>
      <span className="moved-banner__actions">
        <button type="button" className="btn" onClick={() => void downloadFullBackup()} disabled={!!busy}>
          <Archive size={15} aria-hidden />
          Export a full backup
        </button>
        <a className="btn btn--primary" href={`${WEBSITE_URL}/app/`} target="_blank" rel="noopener noreferrer">
          Open noemaboard.app
        </a>
        <button type="button" className="icon-btn" aria-label="Hide this note for two weeks" title="Hide for two weeks" onClick={hide}>
          <X size={16} aria-hidden />
        </button>
      </span>
    </div>
  )
}
