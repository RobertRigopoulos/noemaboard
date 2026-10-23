/**
 * Due dates and assignees of to-do tasks (`due` / `assignee` attributes of TipTap task items).
 * Both arrive from peers, so every reader goes through cleanDue / cleanAssignee.
 *
 * A due value is a local calendar date, optionally with a local time: "2026-10-22" or
 * "2026-10-22T14:30". It is deliberately not an instant: "due on the 22nd" means the 22nd wherever
 * the teammate who reads it happens to be.
 */

const DUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/
const ASSIGNEE = /^[A-Za-z0-9_-]{1,64}$/

/** A valid due value, or null. Rejects dates that do not exist (Feb 30) and times past 23:59. */
export function cleanDue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = DUE.exec(value)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  // Round trip through a UTC date: an impossible day rolls over into the next month.
  const t = new Date(Date.UTC(2000, 0, 1))
  t.setUTCFullYear(y, mo - 1, d)
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59)) return null
  return value
}

/** A valid member id for `assignee`, or null. */
export function cleanAssignee(value: unknown): string | null {
  return typeof value === 'string' && ASSIGNEE.test(value) ? value : null
}

/** The calendar date of a (clean) due value: "2026-10-22". */
export function dueDate(due: string): string {
  return due.slice(0, 10)
}

/** The time of a (clean) due value ("14:30"), or null for an all-day task. */
export function dueTime(due: string): string | null {
  return due.length > 10 ? due.slice(11, 16) : null
}

/**
 * True for a date input value worth saving. While a year is typed, browsers report every step of it
 * (0002-10-22, 0020-10-22, 0202-10-22), and each one is a real date.
 */
export function isPlausibleDueDate(date: string): boolean {
  if (date.length !== 10 || !cleanDue(date)) return false
  const year = Number(date.slice(0, 4))
  return year >= 1900 && year <= 2200
}

/** Builds a due value from a date input and an optional time input; null when the date is not valid. */
export function joinDue(date: string, time: string | null | undefined): string | null {
  if (!date) return null
  return cleanDue(time ? `${date}T${time}` : date)
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0')

/** "YYYY-MM-DD" of a moment in local time. */
export function localDateKey(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fromKey(key: string): Date {
  const d = new Date(2000, 0, 1)
  d.setFullYear(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))
  return d
}

/** Local Date for a clean due value (midnight for all-day tasks). */
export function dueToDate(due: string): Date {
  const d = fromKey(due)
  const time = dueTime(due)
  if (time) d.setHours(Number(time.slice(0, 2)), Number(time.slice(3, 5)), 0, 0)
  return d
}

/** Date key `days` after `key` (calendar days, so DST changes do not matter). */
export function addDays(key: string, days: number): string {
  const d = fromKey(key)
  d.setDate(d.getDate() + days)
  return localDateKey(d)
}

export type DueState = 'overdue' | 'today' | 'upcoming'

/**
 * How a due value relates to `today` (a local date key). Only the date counts: a task due at 9:00
 * today is "due today" all day, so the state only changes at midnight (see dayClock.ts).
 */
export function dueState(due: string, today: string): DueState {
  const date = dueDate(due)
  if (date < today) return 'overdue'
  return date === today ? 'today' : 'upcoming'
}

/** Quick picks offered by the due date popover. */
export function quickDates(now: Date): { today: string; tomorrow: string; nextMonday: string } {
  const today = localDateKey(now)
  // getDay(): Sunday 0 ... Saturday 6. Next Monday is never today.
  const untilMonday = ((8 - now.getDay()) % 7) || 7
  return { today, tomorrow: addDays(today, 1), nextMonday: addDays(today, untilMonday) }
}

/** Short chip text: "Oct 22", "Oct 22, 2027" outside this year, plus the time when set. */
export function formatDueLabel(due: string, now: Date = new Date()): string {
  const d = dueToDate(due)
  const sameYear = d.getFullYear() === now.getFullYear()
  const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(d)
  if (!dueTime(due)) return date
  return `${date}, ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d)}`
}

/** Spoken / tooltip text: "Thursday, October 22, 2026" plus the time when set. */
export function formatDueLong(due: string): string {
  const d = dueToDate(due)
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
  if (dueTime(due)) Object.assign(opts, { hour: 'numeric', minute: '2-digit' })
  return new Intl.DateTimeFormat(undefined, opts).format(d)
}

/** Chip text with the day's relation spelled out for screen readers. */
export function dueDescription(due: string, today: string): string {
  const state = dueState(due, today)
  const when = formatDueLong(due)
  if (state === 'overdue') return `Overdue, was due ${when}`
  if (state === 'today') return `Due today, ${when}`
  return `Due ${when}`
}
