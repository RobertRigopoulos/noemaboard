/**
 * What this device last learned about a blob: here ('local'), or recently not here with no teammate
 * online who has it ('missing'). Card bodies report it as they load. Only a hint (Ctrl+C uses it to
 * skip offering a picture it cannot copy): 'missing' expires after a short while, because a teammate
 * may come online, and actions that need the bytes fetch them on demand anyway. Card actions are not
 * disabled by it. Changes can be watched with useSyncExternalStore(subscribe, version).
 */
import { onBlobPut } from '../../collab/blobs'

export type Availability = 'local' | 'missing'

/** How long a 'missing' report holds before the blob counts as unknown again. */
export const MISSING_TTL_MS = 20_000

const local = new Set<string>()
const missing = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> | null }>()
const listeners = new Set<() => void>()
let version = 0

function changed() {
  version++
  listeners.forEach((l) => l())
}

function forgetMissing(hash: string): boolean {
  const m = missing.get(hash)
  if (!m) return false
  if (m.timer) clearTimeout(m.timer)
  missing.delete(hash)
  return true
}

function markLocal(hash: string) {
  const dropped = forgetMissing(hash)
  if (local.has(hash) && !dropped) return
  local.add(hash)
  changed()
}

onBlobPut((hash) => markLocal(hash))

export function reportBlob(hash: string | null, state: Availability | null, now = Date.now()): void {
  if (!hash || !state) return
  if (state === 'local') return markLocal(hash)
  // Once here, a blob stays here (the store never evicts).
  if (local.has(hash)) return
  forgetMissing(hash)
  const timer =
    typeof setTimeout === 'function'
      ? setTimeout(() => {
          if (forgetMissing(hash)) changed()
        }, MISSING_TTL_MS)
      : null
  missing.set(hash, { at: now, timer })
  changed()
}

/** True when the bytes were recently found to be unavailable (no hash at all counts too). */
export function blobUnavailable(hash: string | null, now = Date.now()): boolean {
  if (!hash) return true
  const m = missing.get(hash)
  return !!m && now - m.at < MISSING_TTL_MS
}

export function subscribeBlobAvailability(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Changes whenever any blob's availability does. */
export function blobAvailabilityVersion(): number {
  return version
}
