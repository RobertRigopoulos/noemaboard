/** Applies the saved theme (light / dark / system) to <html data-theme>. */
import { create } from 'zustand'
import { loadJSON, saveJSON, storageKey } from '../collab/profile'

export type Theme = 'light' | 'dark' | 'system'

const THEMES: readonly Theme[] = ['light', 'dark', 'system']

const isTheme = (v: unknown): v is Theme => typeof v === 'string' && (THEMES as readonly string[]).includes(v)

function systemPrefersDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

interface ThemeState {
  theme: Theme
  /** The theme actually shown ('system' resolved through prefers-color-scheme). */
  resolved: 'light' | 'dark'
  setTheme: (t: Theme) => void
}

const initial: Theme = (() => {
  const saved = loadJSON<unknown>('theme', 'system')
  return isTheme(saved) ? saved : 'system'
})()

const resolve = (t: Theme): 'light' | 'dark' => (t === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : t)

export const useTheme = create<ThemeState>((set) => ({
  theme: initial,
  resolved: resolve(initial),
  setTheme: (theme) => {
    if (!isTheme(theme)) return
    saveJSON('theme', theme)
    set({ theme, resolved: resolve(theme) })
    apply(theme)
  },
}))

export const getTheme = (): Theme => useTheme.getState().theme
export const setTheme = (t: Theme) => useTheme.getState().setTheme(t)

function apply(theme: Theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  // 'system' leaves the attribute off so the prefers-color-scheme rules in base.css apply.
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  updateThemeColor(resolve(theme))
}

/** Keeps the browser/OS title bar colour in step with the app header. */
function updateThemeColor(resolved: 'light' | 'dark') {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
  }
  meta.content = resolved === 'dark' ? '#24272c' : '#ffffff'
}

let started = false

export function initTheme(): void {
  if (started || typeof document === 'undefined') return
  started = true
  apply(getTheme())
  if (typeof matchMedia === 'undefined') return
  const mq = matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    const { theme } = useTheme.getState()
    if (theme !== 'system') return
    useTheme.setState({ resolved: resolve(theme) })
    apply(theme)
  }
  mq.addEventListener?.('change', onChange)
  // Another window of the app changed the theme.
  window.addEventListener('storage', (e) => {
    if (e.key !== storageKey('theme')) return
    const saved = loadJSON<unknown>('theme', 'system')
    if (isTheme(saved) && saved !== useTheme.getState().theme) {
      useTheme.setState({ theme: saved, resolved: resolve(saved) })
      apply(saved)
    }
  })
}
