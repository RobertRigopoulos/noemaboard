import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { linuxAutostartEntry, quoteExecArg } from './autostartEntry'
import { APP_INDEX_URL, CONTENT_SECURITY_POLICY, contentTypeFor, resolveBundlePath, wantsSpaFallback } from './bundle'
import { isPermissionAllowed } from './permissions'
import { RECOVERY_DELAYS_MS, RecoverySchedule, shouldRecoverRenderer, STABLE_AFTER_MS } from './rendererRecovery'
import { DeepLinkInbox, findDeepLink, normalizeDeepLink } from './deeplink'
import { sanitizePatch, sanitizeSettings, SettingsStore } from './settings'
import { defaultFiltersFor, isAllowedExternalUrl, isValidSaveData, sanitizeFileName, sanitizeFilters } from './validate'
import { sanitizeWindowState } from './windowState'

describe('app://bundle path resolution', () => {
  const root = path.resolve('/srv/renderer')

  it('maps paths inside the bundle', () => {
    expect(resolveBundlePath(root, '/index.html')).toBe(path.join(root, 'index.html'))
    expect(resolveBundlePath(root, '/')).toBe(path.join(root, 'index.html'))
    expect(resolveBundlePath(root, '/assets/app-1.js')).toBe(path.join(root, 'assets', 'app-1.js'))
    expect(resolveBundlePath(root, '/assets/a%20b.css')).toBe(path.join(root, 'assets', 'a b.css'))
  })

  it('blocks traversal in every spelling', () => {
    for (const p of ['/../secret', '/assets/../../secret', '/%2e%2e/secret', '/..%2fsecret', '/..%5csecret', '/a\\..\\..\\b', '/C:/Windows', '/%00', '/%E0%A4%A']) {
      expect(resolveBundlePath(root, p), p).toBeNull()
    }
  })

  it('uses SPA fallback only for extension-less routes', () => {
    expect(wantsSpaFallback('/b/123')).toBe(true)
    expect(wantsSpaFallback('/assets/missing.js')).toBe(false)
  })

  it('serves correct content types and a strict CSP', () => {
    expect(contentTypeFor('a/index.html')).toMatch(/^text\/html/)
    expect(contentTypeFor('x.JS')).toMatch(/^text\/javascript/)
    expect(contentTypeFor('font.woff2')).toBe('font/woff2')
    expect(contentTypeFor('noext')).toBe('application/octet-stream')
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'")
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*unsafe/)
    expect(APP_INDEX_URL).toBe('app://bundle/index.html')
  })

  it('lets the renderer reach plain ws:// and http:// relays on this computer or the local network', () => {
    const connect = CONTENT_SECURITY_POLICY.split(';')
      .map((d) => d.trim().split(/\s+/))
      .find((d) => d[0] === 'connect-src')
    expect(connect).toBeDefined()
    // A WebSocket relay at ws://192.168.1.5:8787 also needs http:// for files and the health check.
    for (const source of ['ws:', 'wss:', 'http:', 'https:']) expect(connect).toContain(source)
  })
})

describe('deep links', () => {
  it('normalizes only our scheme', () => {
    expect(normalizeDeepLink(' noema://join/abc ', 'noema')).toBe('noema://join/abc')
    expect(normalizeDeepLink('https://evil.example/', 'noema')).toBeNull()
    expect(normalizeDeepLink('noema://join/a b', 'noema')).toBeNull()
    expect(normalizeDeepLink(`noema://${'x'.repeat(9000)}`, 'noema')).toBeNull()
    expect(normalizeDeepLink(null, 'noema')).toBeNull()
  })

  it('finds the link in argv', () => {
    expect(findDeepLink(['app.exe', '--hidden', 'noema://join/abc'], 'noema')).toBe('noema://join/abc')
    expect(findDeepLink(['electron.exe', '.', '--flag'], 'noema')).toBeNull()
  })

  it('queues links until the renderer listens, keeping the newest', () => {
    const inbox = new DeepLinkInbox()
    inbox.push('noema://join/1')
    inbox.push('noema://join/2')
    const delivered: string[] = []
    inbox.setDelivery((u) => (delivered.push(u), true))
    expect(inbox.take()).toBe('noema://join/2')
    expect(inbox.take()).toBeNull()
    inbox.push('noema://join/3')
    expect(delivered).toEqual(['noema://join/3'])
    inbox.setDelivery(() => false)
    inbox.push('noema://join/4')
    expect(inbox.take()).toBe('noema://join/4')
  })
})

describe('settings', () => {
  it('sanitizes stored and incoming values', () => {
    expect(sanitizeSettings({ closeToTray: true, openAtLogin: 'yes', extra: 1 })).toEqual({ closeToTray: true, openAtLogin: false })
    expect(sanitizeSettings(null)).toEqual({ closeToTray: false, openAtLogin: false })
    expect(sanitizePatch({ openAtLogin: true })).toEqual({ openAtLogin: true })
    expect(sanitizePatch({ openAtLogin: 1 })).toBeNull()
    expect(sanitizePatch({ __proto__: { x: 1 }, evil: true })).toBeNull()
    expect(sanitizePatch([])).toBeNull()
  })

  it('persists to disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noema-settings-'))
    const file = path.join(dir, 'settings.json')
    try {
      const a = new SettingsStore(file)
      expect(a.get()).toEqual({ closeToTray: false, openAtLogin: false })
      a.set({ closeToTray: true })
      expect(new SettingsStore(file).get()).toEqual({ closeToTray: true, openAtLogin: false })
      fs.writeFileSync(file, '{not json')
      expect(new SettingsStore(file).get()).toEqual({ closeToTray: false, openAtLogin: false })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('IPC argument validation', () => {
  it('sanitizes file names', () => {
    expect(sanitizeFileName('My board: v2/final?.zip')).toBe('My board- v2-final-.zip')
    expect(sanitizeFileName('../../etc/passwd')).toBe('-..-etc-passwd')
    expect(sanitizeFileName('CON')).toBe('untitled')
    expect(sanitizeFileName('  ...  ')).toBe('untitled')
    expect(sanitizeFileName(42)).toBe('untitled')
    const long = sanitizeFileName(`${'a'.repeat(300)}.png`)
    expect(long.length).toBe(200)
    expect(long.endsWith('.png')).toBe(true)
  })

  it('validates dialog filters', () => {
    expect(sanitizeFilters([{ name: 'Images', extensions: ['png', 'jpg', '../x', 5] }])).toEqual([{ name: 'Images', extensions: ['png', 'jpg'] }])
    expect(sanitizeFilters('nope')).toBeUndefined()
    expect(sanitizeFilters(undefined)).toBeUndefined()
    expect(defaultFiltersFor('board.zip')).toEqual([
      { name: 'ZIP file', extensions: ['zip'] },
      { name: 'All files', extensions: ['*'] },
    ])
    expect(defaultFiltersFor('README')).toBeUndefined()
  })

  it('allows only web and mail links to leave the app', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true)
    expect(isAllowedExternalUrl('mailto:a@b.c')).toBe(true)
    for (const u of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'smb://host/share', 'noema://join/x', 42]) {
      expect(isAllowedExternalUrl(u), String(u)).toBe(false)
    }
  })

  it('checks save data', () => {
    expect(isValidSaveData(new Uint8Array(3))).toBe(true)
    expect(isValidSaveData('text')).toBe(false)
    expect(isValidSaveData(new ArrayBuffer(3))).toBe(false)
  })
})

describe('window state', () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }]

  it('keeps bounds that are on screen', () => {
    const s = sanitizeWindowState({ bounds: { x: 100, y: 80, width: 1200, height: 800 }, maximized: true }, screens)
    expect(s).toEqual({ bounds: { x: 100, y: 80, width: 1200, height: 800 }, maximized: true })
  })

  it('drops bounds on a monitor that is gone and clamps sizes', () => {
    expect(sanitizeWindowState({ bounds: { x: 3000, y: 100, width: 1200, height: 800 } }, screens).bounds).toBeNull()
    expect(sanitizeWindowState({ bounds: { x: 100, y: -500, width: 1200, height: 400 } }, screens).bounds).toBeNull()
    expect(sanitizeWindowState({ bounds: { x: 0, y: 0, width: 100, height: 5000 } }, screens).bounds).toEqual({ x: 0, y: 0, width: 720, height: 1040 })
    expect(sanitizeWindowState({ bounds: { x: 'a' } }, screens).bounds).toBeNull()
    expect(sanitizeWindowState('garbage', screens)).toEqual({ bounds: null, maximized: false })
  })
})

describe('linux autostart entry', () => {
  it('quotes Exec arguments per the desktop entry spec', () => {
    expect(quoteExecArg('/opt/Noema/noema')).toBe('/opt/Noema/noema')
    expect(quoteExecArg('/home/me/Apps/Mila No Fee.AppImage')).toBe('"/home/me/Apps/Mila No Fee.AppImage"')
    expect(quoteExecArg('/tmp/$weird"`\\')).toBe('"/tmp/\\$weird\\"\\`\\\\"')
    const entry = linuxAutostartEntry('Noema', '/home/me/My Apps/Noema.AppImage', ['--hidden'], '100% synced\nInjected=1')
    expect(entry).toContain('Exec="/home/me/My Apps/Noema.AppImage" --hidden')
    expect(entry).toContain('Comment=100% synced Injected=1')
    expect(entry.split('\n').filter((l) => l.startsWith('Injected'))).toHaveLength(0)
  })
})

describe('web permissions', () => {
  it('lets the app page read and write the clipboard (context-menu Paste), nothing else', () => {
    const app = { trusted: true, isMainFrame: true }
    for (const p of ['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'persistent-storage']) {
      expect(isPermissionAllowed(p, app), p).toBe(true)
      // Permission checks carry no frame information.
      expect(isPermissionAllowed(p, { trusted: true }), p).toBe(true)
    }
    for (const p of ['media', 'geolocation', 'openExternal', 'hid', 'midiSysex']) expect(isPermissionAllowed(p, app), p).toBe(false)
  })

  it('never grants app permissions to embedded frames or other origins', () => {
    expect(isPermissionAllowed('clipboard-read', { trusted: true, isMainFrame: false })).toBe(false)
    expect(isPermissionAllowed('clipboard-read', { trusted: false, isMainFrame: true })).toBe(false)
    expect(isPermissionAllowed('clipboard-read', { trusted: false })).toBe(false)
    expect(isPermissionAllowed('fullscreen', { trusted: false, isMainFrame: false })).toBe(true)
  })
})

describe('renderer recovery', () => {
  it('recovers from every kind of renderer loss unless the app is shutting down', () => {
    expect(shouldRecoverRenderer({ quitting: false, destroyed: false })).toBe(true)
    expect(shouldRecoverRenderer({ quitting: true, destroyed: false })).toBe(false)
    expect(shouldRecoverRenderer({ quitting: false, destroyed: true })).toBe(false)
  })

  it('backs off on repeated crashes but never gives up', () => {
    const s = new RecoverySchedule()
    let now = 0
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      const d = s.crashed(now)
      delays.push(d)
      now += d
      s.reloaded(now)
      now += 1000 // crashes again a second after each reload
    }
    expect(delays).toEqual([...RECOVERY_DELAYS_MS, ...Array(3).fill(RECOVERY_DELAYS_MS.at(-1))])
    expect(s.consecutiveFailures).toBe(7)
  })

  it('starts over after the page stayed up for a while', () => {
    const s = new RecoverySchedule()
    expect(s.crashed(0)).toBe(RECOVERY_DELAYS_MS[0])
    s.reloaded(5_000)
    expect(s.crashed(6_000)).toBe(RECOVERY_DELAYS_MS[1])
    s.reloaded(36_000)
    expect(s.crashed(36_000 + STABLE_AFTER_MS)).toBe(RECOVERY_DELAYS_MS[0])
    expect(s.consecutiveFailures).toBe(1)
  })
})
