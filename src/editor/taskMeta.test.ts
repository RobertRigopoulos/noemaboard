import { describe, expect, it } from 'vitest'
import {
  addDays,
  cleanAssignee,
  cleanDue,
  dueDate,
  dueState,
  dueTime,
  formatDueLabel,
  isPlausibleDueDate,
  joinDue,
  localDateKey,
  quickDates,
} from './taskMeta'

describe('cleanDue', () => {
  it('accepts real dates with an optional time', () => {
    expect(cleanDue('2026-10-22')).toBe('2026-10-22')
    expect(cleanDue('2026-10-22T09:05')).toBe('2026-10-22T09:05')
    expect(cleanDue('2024-02-29')).toBe('2024-02-29')
    expect(cleanDue('2026-12-31T23:59')).toBe('2026-12-31T23:59')
  })

  it('rejects dates that do not exist', () => {
    expect(cleanDue('2026-02-30')).toBeNull()
    expect(cleanDue('2023-02-29')).toBeNull()
    expect(cleanDue('2026-13-01')).toBeNull()
    expect(cleanDue('2026-00-10')).toBeNull()
    expect(cleanDue('2026-04-31')).toBeNull()
  })

  it('rejects impossible times and anything that is not exactly the format', () => {
    expect(cleanDue('2026-10-22T24:00')).toBeNull()
    expect(cleanDue('2026-10-22T12:60')).toBeNull()
    expect(cleanDue('2026-10-22T12:00:00')).toBeNull()
    expect(cleanDue('2026-10-22 ')).toBeNull()
    expect(cleanDue('26-10-22')).toBeNull()
    expect(cleanDue('2026-10-22"><script>alert(1)</script>')).toBeNull()
    expect(cleanDue('2026-10-22\n')).toBeNull()
    expect(cleanDue(20261022)).toBeNull()
    expect(cleanDue(null)).toBeNull()
    expect(cleanDue({ toString: () => '2026-10-22' })).toBeNull()
  })
})

describe('cleanAssignee', () => {
  it('accepts member ids only', () => {
    expect(cleanAssignee('abc_DEF-123')).toBe('abc_DEF-123')
    expect(cleanAssignee('a'.repeat(64))).toBe('a'.repeat(64))
    expect(cleanAssignee('a'.repeat(65))).toBeNull()
    expect(cleanAssignee('')).toBeNull()
    expect(cleanAssignee('x" onmouseover="alert(1)')).toBeNull()
    expect(cleanAssignee('name with spaces')).toBeNull()
    expect(cleanAssignee(42)).toBeNull()
  })
})

describe('due helpers', () => {
  it('splits and joins date and time', () => {
    expect(dueDate('2026-10-22T14:30')).toBe('2026-10-22')
    expect(dueTime('2026-10-22T14:30')).toBe('14:30')
    expect(dueTime('2026-10-22')).toBeNull()
    expect(joinDue('2026-10-22', '14:30')).toBe('2026-10-22T14:30')
    expect(joinDue('2026-10-22', '')).toBe('2026-10-22')
    expect(joinDue('', '14:30')).toBeNull()
    expect(joinDue('2026-02-30', null)).toBeNull()
  })

  it('only treats fully typed, plausible years as a date to save', () => {
    expect(isPlausibleDueDate('2026-10-22')).toBe(true)
    expect(isPlausibleDueDate('1900-01-01')).toBe(true)
    expect(isPlausibleDueDate('2200-12-31')).toBe(true)
    // What a date input reports while "2026" is being typed.
    expect(isPlausibleDueDate('0002-10-22')).toBe(false)
    expect(isPlausibleDueDate('0020-10-22')).toBe(false)
    expect(isPlausibleDueDate('0202-10-22')).toBe(false)
    expect(isPlausibleDueDate('9999-10-22')).toBe(false)
    expect(isPlausibleDueDate('2026-02-30')).toBe(false)
    expect(isPlausibleDueDate('2026-10-22T10:00')).toBe(false)
    expect(isPlausibleDueDate('')).toBe(false)
  })

  it('counts calendar days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29')
  })

  it('offers today, tomorrow and the next Monday', () => {
    // Thursday 22 October 2026, local time.
    expect(quickDates(new Date(2026, 9, 22, 15, 0))).toEqual({ today: '2026-10-22', tomorrow: '2026-10-23', nextMonday: '2026-10-26' })
    // On a Monday, "next Monday" is a week later.
    expect(quickDates(new Date(2026, 9, 26, 9, 0)).nextMonday).toBe('2026-11-02')
    // On a Sunday it is tomorrow.
    expect(quickDates(new Date(2026, 9, 25, 9, 0)).nextMonday).toBe('2026-10-26')
  })

  it('formats a local date key', () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })

  it('formats chips with the time only when set', () => {
    const now = new Date(2026, 9, 1)
    const plain = formatDueLabel('2026-10-22', now)
    expect(plain).toMatch(/22/)
    expect(plain).not.toMatch(/2026/)
    expect(formatDueLabel('2027-01-03', now)).toMatch(/2027/)
    expect(formatDueLabel('2026-10-22T14:30', now).length).toBeGreaterThan(plain.length)
  })
})

describe('dueState with a fixed clock', () => {
  const today = '2026-10-22'
  it('classifies by calendar date', () => {
    expect(dueState('2026-10-21', today)).toBe('overdue')
    expect(dueState('2025-12-31T23:59', today)).toBe('overdue')
    expect(dueState('2026-10-22', today)).toBe('today')
    expect(dueState('2026-10-22T00:01', today)).toBe('today')
    expect(dueState('2026-10-23', today)).toBe('upcoming')
    expect(dueState('2027-01-01', today)).toBe('upcoming')
  })
})
