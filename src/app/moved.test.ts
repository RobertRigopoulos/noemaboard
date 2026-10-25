import { describe, expect, it } from 'vitest'
import SCRIPT from '../../public/moved.js?raw'
import { OLD_APP_URL, WEBSITE_URL } from '../config'
import { atNewAddress, atOldAddress } from './moved'

const OLD_HOST = new URL(OLD_APP_URL).hostname

interface Run {
  /** Where the page was sent, or null. */
  target: string | null
  /** The old page was stopped before it was sent on. */
  stoppedFirst: boolean
}

/** Runs public/moved.js as a browser would, on a page at `url` with this localStorage content. */
function run(url: string, stored: Record<string, string> | 'blocked' = {}): Run {
  const u = new URL(url)
  const calls: string[] = []
  let target: string | null = null
  const ctx: Record<string, unknown> = {
    location: {
      hostname: u.hostname,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      replace: (to: string) => {
        calls.push('replace')
        target = to
      },
    },
    stop: () => calls.push('stop'),
  }
  if (stored === 'blocked')
    Object.defineProperty(ctx, 'localStorage', {
      get() {
        throw new Error('SecurityError: storage is disabled')
      },
    })
  else ctx.localStorage = { getItem: (k: string) => (k in stored ? stored[k] : null) }
  // The page's own `window` and `location`, nothing from the test runner's globals.
  new Function('window', 'location', SCRIPT)(ctx, ctx.location)
  return { target, stoppedFirst: calls[0] === 'stop' && calls.includes('replace') }
}

const named = { 'noema:profile': JSON.stringify({ id: 'p1', name: 'Ada', color: '#e5484d' }) }

describe('public/moved.js', () => {
  it('sends new visitors of the old address to noemaboard.app, keeping path and invite fragment', () => {
    expect(run(`https://${OLD_HOST}/`)).toEqual({ target: `${WEBSITE_URL}/`, stoppedFirst: true })
    expect(run(`https://${OLD_HOST}/app/#/join/abcDEF123_-xyz`).target).toBe(`${WEBSITE_URL}/app/#/join/abcDEF123_-xyz`)
    expect(run(`https://${OLD_HOST}/#faq`).target).toBe(`${WEBSITE_URL}/#faq`)
  })

  it('treats a profile that never got a name as a new visitor', () => {
    const unnamed = { 'noema:profile': JSON.stringify({ id: 'p1', name: '  ', color: '#e5484d' }) }
    expect(run(`https://${OLD_HOST}/app/`, unnamed).target).toBe(`${WEBSITE_URL}/app/`)
  })

  it('keeps people who already use the old address there (their boards are saved for it)', () => {
    expect(run(`https://${OLD_HOST}/app/`, named).target).toBeNull()
    expect(run(`https://${OLD_HOST}/`, named).target).toBeNull()
    expect(run(`https://${OLD_HOST}/app/#/join/abcDEF123_-xyz`, named).target).toBeNull()
    expect(run(`https://${OLD_HOST}/app/`, { 'noema:library': JSON.stringify({ someBoardId: {} }) }).target).toBeNull()
    // Unreadable data is still someone's data.
    expect(run(`https://${OLD_HOST}/app/`, { 'noema:profile': '{broken' }).target).toBeNull()
  })

  it('moves visitors whose browser blocks storage (nothing can be saved at the old address)', () => {
    expect(run(`https://${OLD_HOST}/app/`, 'blocked').target).toBe(`${WEBSITE_URL}/app/`)
  })

  it('does nothing anywhere else: the new address, the desktop app, local development, other copies', () => {
    for (const url of [`${WEBSITE_URL}/app/`, 'app://bundle/index.html', 'http://localhost:5173/', 'https://boards.example.com/app/']) {
      expect(run(url).target, url).toBeNull()
    }
  })

  it('names the same addresses as src/config.ts', () => {
    expect(SCRIPT).toContain(`var NEW_HOME = '${WEBSITE_URL}'`)
    expect(SCRIPT).toContain(`'${OLD_HOST}'`)
  })
})

describe('atOldAddress / atNewAddress', () => {
  it('recognises the two public addresses only', () => {
    expect(atOldAddress(OLD_HOST)).toBe(true)
    expect(atOldAddress('noemaboard.app')).toBe(false)
    expect(atNewAddress('noemaboard.app')).toBe(true)
    expect(atNewAddress('www.noemaboard.app')).toBe(false)
    expect(atNewAddress(OLD_HOST)).toBe(false)
  })
})
