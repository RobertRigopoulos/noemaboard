/** Desktop-app-only settings (tray, start at login). */
import { useEffect, useState } from 'react'
import { desktop, type DesktopSettings } from '../../../lib/desktop'
import { toast } from '../../toast'

export function DesktopSection() {
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop
      .getSettings()
      .then((s) => !cancelled && setSettings(s))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [])

  if (!desktop) return null

  const change = async (patch: Partial<DesktopSettings>) => {
    if (!settings || !desktop) return
    const prev = settings
    setSettings({ ...settings, ...patch })
    setSaving(true)
    try {
      setSettings(await desktop.setSettings(patch))
    } catch {
      setSettings(prev)
      toast('The setting could not be changed.', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <h3>Desktop app</h3>
      {failed && <p className="field__error">Desktop settings could not be loaded.</p>}
      {!settings && !failed && <p className="muted">Loading…</p>}
      {settings && (
        <>
          <label className="switch">
            <input type="checkbox" checked={settings.closeToTray} disabled={saving} onChange={(e) => void change({ closeToTray: e.target.checked })} />
            <span className="switch__text">
              <strong>Keep boards online when the window is closed</strong>
              <span>
                The app keeps running in the system tray so teammates can sync with this computer even when the window is closed.
              </span>
            </span>
          </label>
          <label className="switch">
            <input type="checkbox" checked={settings.openAtLogin} disabled={saving} onChange={(e) => void change({ openAtLogin: e.target.checked })} />
            <span className="switch__text">
              <strong>Start at login</strong>
              <span>Open quietly in the tray when you sign in to your computer.</span>
            </span>
          </label>
        </>
      )}
    </div>
  )
}
