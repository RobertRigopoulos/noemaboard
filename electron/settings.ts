/** Desktop settings persisted in userData/settings.json (validated; both features opt-in). */
import fs from 'node:fs'
import path from 'node:path'
import type { DesktopSettings } from '../src/lib/desktop'

export const DEFAULT_SETTINGS: DesktopSettings = { closeToTray: false, openAtLogin: false }

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof DesktopSettings)[]

export function sanitizeSettings(raw: unknown, base: DesktopSettings = DEFAULT_SETTINGS): DesktopSettings {
  const out = { ...base }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const r = raw as Record<string, unknown>
  for (const k of KEYS) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean
  return out
}

/** Validates a renderer-provided patch: only known boolean keys survive. */
export function sanitizePatch(raw: unknown): Partial<DesktopSettings> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const out: Partial<DesktopSettings> = {}
  for (const k of Object.keys(r)) {
    if (!(KEYS as string[]).includes(k)) return null
    if (typeof r[k] !== 'boolean') return null
    out[k as keyof DesktopSettings] = r[k] as boolean
  }
  return out
}

export class SettingsStore {
  private value: DesktopSettings
  constructor(private readonly file: string) {
    let raw: unknown = null
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      // First run or unreadable file: defaults.
    }
    this.value = sanitizeSettings(raw)
  }

  get(): DesktopSettings {
    return { ...this.value }
  }

  set(patch: Partial<DesktopSettings>): DesktopSettings {
    this.value = sanitizeSettings(patch, this.value)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('[settings] could not save', err)
    }
    return this.get()
  }
}
