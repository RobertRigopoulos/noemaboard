import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blobAvailabilityVersion, blobUnavailable, MISSING_TTL_MS, reportBlob, subscribeBlobAvailability } from './blobAvailability'

const hash = (c: string) => c.repeat(64)

describe('blobAvailability', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('treats unknown blobs as available and no hash as unavailable', () => {
    expect(blobUnavailable(hash('0'))).toBe(false)
    expect(blobUnavailable(null)).toBe(true)
  })

  it('forgets a missing report after a while, since a teammate may come online', () => {
    const h = hash('1')
    reportBlob(h, 'missing', 1000)
    expect(blobUnavailable(h, 1000 + MISSING_TTL_MS - 1)).toBe(true)
    expect(blobUnavailable(h, 1000 + MISSING_TTL_MS)).toBe(false)
  })

  it('a blob that arrived stays available', () => {
    const h = hash('2')
    reportBlob(h, 'missing')
    reportBlob(h, 'local')
    expect(blobUnavailable(h)).toBe(false)
    reportBlob(h, 'missing')
    expect(blobUnavailable(h)).toBe(false)
  })

  it('tells subscribers about changes, including expiry', () => {
    const h = hash('3')
    const listener = vi.fn()
    const off = subscribeBlobAvailability(listener)
    const before = blobAvailabilityVersion()
    reportBlob(h, 'missing')
    expect(listener).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(MISSING_TTL_MS)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(blobAvailabilityVersion()).toBe(before + 2)
    reportBlob(h, 'local')
    reportBlob(h, 'local')
    expect(listener).toHaveBeenCalledTimes(3)
    off()
    reportBlob(hash('4'), 'missing')
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
