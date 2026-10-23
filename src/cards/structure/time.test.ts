import { describe, expect, it } from 'vitest'
import { formatFullDate, formatRelativeTime } from './time'

// Local-time dates keep the calendar logic independent of the machine's time zone.
const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()

describe('formatRelativeTime', () => {
  const now = at(2026, 3, 18, 15, 30)

  it('says just now for the last minute and for future (skewed) times', () => {
    expect(formatRelativeTime(now, now)).toBe('just now')
    expect(formatRelativeTime(now - 59_000, now)).toBe('just now')
    expect(formatRelativeTime(now + 5 * 60_000, now)).toBe('just now')
  })

  it('uses minutes under an hour', () => {
    expect(formatRelativeTime(now - 60_000, now)).toBe('1m')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m')
    expect(formatRelativeTime(now - 59 * 60_000 - 59_000, now)).toBe('59m')
  })

  it('uses hours earlier today', () => {
    expect(formatRelativeTime(now - 60 * 60_000, now)).toBe('1h')
    expect(formatRelativeTime(at(2026, 3, 18, 0, 5), now)).toBe('15h')
  })

  it('says Yesterday for the previous calendar day', () => {
    expect(formatRelativeTime(at(2026, 3, 17, 23, 59), now)).toBe('Yesterday')
    expect(formatRelativeTime(at(2026, 3, 17, 0, 0), now)).toBe('Yesterday')
    // Just after midnight, a message from late last night is "Yesterday", not hours.
    expect(formatRelativeTime(at(2026, 3, 17, 22, 0), at(2026, 3, 18, 0, 30))).toBe('Yesterday')
  })

  it('shows a short date for older messages', () => {
    expect(formatRelativeTime(at(2026, 3, 16, 10), now, 'en-US')).toBe('Mar 16')
    expect(formatRelativeTime(at(2026, 1, 5, 10), now, 'en-US')).toBe('Jan 5')
  })

  it('adds the year for other years', () => {
    expect(formatRelativeTime(at(2024, 12, 24, 10), now, 'en-US')).toBe('Dec 24, 2024')
  })

  it('handles the first days of a month and year', () => {
    const newYear = at(2026, 1, 1, 9)
    expect(formatRelativeTime(at(2025, 12, 31, 20), newYear)).toBe('Yesterday')
    expect(formatRelativeTime(at(2025, 12, 30, 20), newYear, 'en-US')).toBe('Dec 30, 2025')
  })

  it('returns an empty string for invalid input', () => {
    expect(formatRelativeTime(0, now)).toBe('')
    expect(formatRelativeTime(Number.NaN, now)).toBe('')
    expect(formatRelativeTime(-5, now)).toBe('')
  })
})

describe('formatFullDate', () => {
  it('formats a full timestamp and rejects invalid ones', () => {
    expect(formatFullDate(at(2026, 3, 18, 15, 30), 'en-US')).toMatch(/Mar 18, 2026/)
    expect(formatFullDate(0)).toBe('')
  })
})
