/** App settings: profile, appearance, network, desktop, data (backups) and about. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Archive, Database, Info, Laptop, LayoutGrid, Monitor, Moon, Palette, Sun, Upload, User, Wifi, type LucideIcon } from 'lucide-react'
import { create } from 'zustand'
import { APP_NAME, COMMUNITY_URL, DEFAULT_RELAY, REPO_URL } from '../../config'
import { desktop } from '../../lib/desktop'
import { useTheme, type Theme } from '../theme'
import { downloadFullBackup, pickAndImportBackup, useExportBusy } from '../export/exportActions'
import { useDialogs } from '../uiStore'
import { toast } from '../toast'
import { Dialog } from './Dialog'
import { ProfileForm } from './ProfileDialog'
import { NetworkSection } from './settings/NetworkSection'
import { DesktopSection } from './settings/DesktopSection'
import { CanvasSection } from './settings/CanvasSection'

export type SettingsTab = 'profile' | 'appearance' | 'boards' | 'network' | 'desktop' | 'data' | 'about'

/** Which tab the settings dialog shows (lets other UI open e.g. the Network tab directly). */
export const useSettingsTab = create<{ tab: SettingsTab }>(() => ({ tab: 'profile' }))

export function openSettings(tab: SettingsTab = 'profile') {
  useSettingsTab.setState({ tab })
  useDialogs.getState().open('settings')
}

const APP_VERSION: string = desktop?.appVersion ?? ((import.meta.env.VITE_APP_VERSION as string | undefined) || '')

const TABS: { id: SettingsTab; label: string; icon: LucideIcon; show: boolean }[] = [
  { id: 'profile', label: 'Profile', icon: User, show: true },
  { id: 'appearance', label: 'Appearance', icon: Palette, show: true },
  { id: 'boards', label: 'Boards', icon: LayoutGrid, show: true },
  { id: 'network', label: 'Network', icon: Wifi, show: true },
  { id: 'desktop', label: 'Desktop app', icon: Laptop, show: !!desktop },
  { id: 'data', label: 'Data & backups', icon: Database, show: true },
  { id: 'about', label: 'About', icon: Info, show: true },
]

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Settings">
      <SettingsBody />
    </Dialog>
  )
}

function SettingsBody() {
  const tab = useSettingsTab((s) => s.tab)
  const id = useId()
  const tabs = TABS.filter((t) => t.show)
  const current = tabs.some((t) => t.id === tab) ? tab : 'profile'
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  const select = (t: SettingsTab, focus = false) => {
    useSettingsTab.setState({ tab: t })
    if (focus) refs.current[t]?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === current)
    let next = -1
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    select(tabs[next].id, true)
  }

  let panel: ReactNode
  switch (current) {
    case 'profile':
      panel = (
        <div>
          <h3>Profile</h3>
          <ProfileForm autoFocus={false} onSaved={() => toast('Profile saved', 'success')} />
        </div>
      )
      break
    case 'appearance':
      panel = <AppearanceSection />
      break
    case 'boards':
      panel = <CanvasSection />
      break
    case 'network':
      panel = <NetworkSection />
      break
    case 'desktop':
      panel = <DesktopSection />
      break
    case 'data':
      panel = <DataSection />
      break
    case 'about':
      panel = <AboutSection />
      break
  }

  return (
    <div className="settings">
      <div className="settings__nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections" onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${t.id}`}
            aria-selected={current === t.id}
            aria-controls={`${id}-panel`}
            tabIndex={current === t.id ? 0 : -1}
            className="settings__tab"
            data-autofocus={current === t.id || undefined}
            onClick={() => select(t.id)}
          >
            <t.icon size={16} aria-hidden />
            {t.label}
          </button>
        ))}
      </div>
      <div className="settings__panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${current}`} tabIndex={0}>
        {panel}
      </div>
    </div>
  )
}

const THEMES: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

function AppearanceSection() {
  const theme = useTheme((s) => s.theme)
  const resolved = useTheme((s) => s.resolved)
  const setTheme = useTheme((s) => s.setTheme)
  const labelId = useId()
  return (
    <div>
      <h3>Appearance</h3>
      <p className="dlg-text" id={labelId}>
        Theme
      </p>
      <div className="seg" role="radiogroup" aria-labelledby={labelId}>
        {THEMES.map((t) => (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={theme === t.value}
            className="seg__opt"
            onClick={() => setTheme(t.value)}
            onKeyDown={(e) => {
              const i = THEMES.findIndex((x) => x.value === theme)
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                setTheme(THEMES[(i + 1) % THEMES.length].value)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                setTheme(THEMES[(i - 1 + THEMES.length) % THEMES.length].value)
              }
            }}
            tabIndex={theme === t.value ? 0 : -1}
          >
            <t.icon size={15} aria-hidden />
            {t.label}
          </button>
        ))}
      </div>
      <p className="dlg-small" style={{ marginTop: 10 }}>
        {theme === 'system' ? `Follows your device setting (currently ${resolved}).` : 'Applies to this device only.'}
      </p>
    </div>
  )
}

function StorageUsage() {
  const [usage, setUsage] = useState<{ used: number; quota: number; persisted: boolean | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const est = await navigator.storage?.estimate?.()
        const persisted = (await navigator.storage?.persisted?.()) ?? null
        if (!cancelled && est) setUsage({ used: est.usage ?? 0, quota: est.quota ?? 0, persisted })
      } catch {
        // not available
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  if (!usage) return null
  const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, n / 1024 ** 2).toFixed(1)} MB`)
  return (
    <p className="dlg-small" style={{ marginTop: 14 }}>
      Boards and files use {mb(usage.used)} on this device{usage.quota ? ` (of ${mb(usage.quota)} available)` : ''}.
      {usage.persisted === false && ' Your browser may clear this data when storage is low — keep a backup.'}
    </p>
  )
}

function DataSection() {
  const busy = useExportBusy((s) => s.busy)
  return (
    <div>
      <h3>Data & backups</h3>
      <p className="dlg-text">
        Your boards are saved on this device.{' '}
        {DEFAULT_RELAY
          ? "Shared boards are also on your teammates' devices, and the sync service keeps an encrypted copy it can't read."
          : "Shared boards are also on your teammates' devices."}{' '}
        Download a backup to keep a copy or to move your boards to another computer. Importing a backup merges it with what you already have,
        so nothing is overwritten.
      </p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="btn btn--primary" onClick={() => void downloadFullBackup()} disabled={!!busy}>
          <Archive size={15} aria-hidden />
          Export a full backup
        </button>
        <button type="button" className="btn" onClick={() => void pickAndImportBackup()} disabled={!!busy}>
          <Upload size={15} aria-hidden />
          Import a backup…
        </button>
        {busy && <span className="muted" role="status">{busy} in progress…</span>}
      </div>
      <div className="callout callout--warn" style={{ marginTop: 14 }}>
        <Info size={16} aria-hidden />
        <span>A backup contains the keys to your boards: anyone with the file can open them and join them. Store it somewhere safe.</span>
      </div>
      <StorageUsage />
    </div>
  )
}

function AboutSection() {
  return (
    <div>
      <div className="row" style={{ gap: 14, marginBottom: 14 }}>
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={48} height={48} style={{ borderRadius: 10 }} />
        <div>
          <h3 style={{ margin: 0 }}>{APP_NAME}</h3>
          {APP_VERSION && <span className="muted">Version {APP_VERSION}</span>}
        </div>
      </div>
      <p className="dlg-text">
        <strong>Free &amp; open source (MIT). No accounts, no limits.</strong>
      </p>
      <p className="dlg-text">
        Visual boards for notes, to-dos, links, images, files and sketches. Your boards are saved on this device.{' '}
        {DEFAULT_RELAY
          ? "Shared boards also sync directly between teammates' devices and through an always-on sync service, so changes arrive even when nobody else is online. Boards are end-to-end encrypted whenever they sync, so the sync service only stores data it can't read."
          : "Shared boards sync directly between teammates' devices, end-to-end encrypted. A board can also use a sync server your team runs, which only stores data it can't read."}
      </p>
      <p className="dlg-text">
        Found a problem or have an idea?{' '}
        <a href={COMMUNITY_URL} target="_blank" rel="noopener noreferrer">
          Tell us on Discord
        </a>{' '}
        or{' '}
        <a href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer">
          on GitHub
        </a>
        . Please never post a board's invite link there.
      </p>
      <p className="dlg-small">Fonts: Inter and Fraunces (SIL Open Font License). Icons: Lucide (ISC).</p>
    </div>
  )
}
