/**
 * Local storage namespace. In development you can run several independent "people" in one
 * browser by adding ?profile=alice to the URL; each profile gets its own identity and databases.
 */
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
const raw = params.get('profile') ?? ''

export const PROFILE: string = /^[a-z0-9_-]{1,32}$/i.test(raw) ? raw : ''

/** Prefix for IndexedDB database names and localStorage keys. */
export const STORAGE_PREFIX = PROFILE ? `noema:${PROFILE}:` : 'noema:'

export function storageKey(key: string): string {
  return STORAGE_PREFIX + key
}

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(storageKey(key))
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

/** Returns false when the value could not be stored (storage full or unavailable). */
export function saveJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(value))
    return true
  } catch {
    // Storage full or unavailable: non-fatal for preferences; callers that must persist check the result.
    return false
  }
}