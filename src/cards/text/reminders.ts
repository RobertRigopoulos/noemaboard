/**
 * Local reminders for tasks assigned to the current user that are due today or overdue, in to-dos,
 * notes and documents (every card whose text can hold tasks with due dates). No server is involved:
 * the app looks at the open board and shows a toast, once per task per day. Which reminders were
 * shown is remembered per board in localStorage (this device only).
 */
import * as Y from 'yjs'
import { forEachActiveCard } from '../../model/board'
import { listTasks, textHash } from '../../editor/tasks'
import { dueState } from '../../editor/taskMeta'

export interface Reminder {
  cardId: string
  /** Task index in the card (pre-order), as used by findTaskItem. Changes as tasks come and go. */
  index: number
  text: string
  state: 'today' | 'overdue'
  /**
   * cardId:textHash:due, plus :n for the n-th repeat of the same task text and due date in the card.
   * Built from the task itself, not its position, so deleting or moving other tasks does not make it
   * a new reminder; rewriting or rescheduling it does.
   */
  key: string
}

/** Card types whose `content` text can hold tasks with due dates and assignees. */
const TASK_CARD_TYPES: ReadonlySet<unknown> = new Set(['todo', 'note', 'document'])

/** Seen entries kept per board. */
export const MAX_SEEN = 500
export const REMINDER_INTERVAL_MS = 10 * 60 * 1000

export const seenStorageKey = (boardId: string) => `taskReminders:${boardId}`

/** Unchecked tasks assigned to `meId` that are due today or overdue, in board order. */
export function dueReminders(doc: Y.Doc, meId: string, today: string): Reminder[] {
  const out: Reminder[] = []
  forEachActiveCard(doc, (m, cardId) => {
    if (!TASK_CARD_TYPES.has(m.get('type'))) return
    const content = m.get('content')
    if (!(content instanceof Y.XmlFragment)) return
    const repeats = new Map<string, number>()
    for (const t of listTasks(content)) {
      if (t.checked || !t.due || t.assignee !== meId) continue
      const state = dueState(t.due, today)
      if (state === 'upcoming') continue
      const base = `${cardId}:${textHash(t.text)}:${t.due}`
      const n = repeats.get(base) ?? 0
      repeats.set(base, n + 1)
      out.push({ cardId, index: t.index, text: t.text, state, key: n ? `${base}:${n}` : base })
    }
  })
  return out
}

/** Validates stored seen entries ("YYYY-MM-DD|key" strings). */
export function readSeen(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((e): e is string => typeof e === 'string' && e.length <= 300 && /^\d{4}-\d{2}-\d{2}\|/.test(e)).slice(-MAX_SEEN)
}

/**
 * Splits reminders into the ones not shown yet today, and returns the seen list to store: today's
 * entries only (a task still due tomorrow is reminded again), at most MAX_SEEN of the newest.
 */
export function pickFresh(reminders: readonly Reminder[], seen: readonly string[], today: string): { fresh: Reminder[]; seen: string[] } {
  const prefix = `${today}|`
  const kept = seen.filter((e) => e.startsWith(prefix))
  const known = new Set(kept)
  const fresh: Reminder[] = []
  for (const r of reminders) {
    const entry = prefix + r.key
    if (known.has(entry)) continue
    known.add(entry)
    kept.push(entry)
    fresh.push(r)
  }
  return { fresh, seen: kept.slice(-MAX_SEEN) }
}

export function loadSeen(boardId: string): string[] {
  try {
    const raw = localStorage.getItem(seenStorageKey(boardId))
    return raw ? readSeen(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

export function saveSeen(boardId: string, seen: readonly string[]): void {
  try {
    localStorage.setItem(seenStorageKey(boardId), JSON.stringify(seen.slice(-MAX_SEEN)))
  } catch {
    /* storage full or blocked: reminders may repeat, nothing else breaks */
  }
}

/** Toast text: "Due today: …" / "Overdue: …" with the task text cut to 60 characters. */
export function reminderMessage(r: Pick<Reminder, 'state' | 'text'>): string {
  const chars = Array.from(r.text.replace(/\s+/g, ' ').trim())
  const text = chars.length ? (chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : chars.join('')) : 'Untitled task'
  return `${r.state === 'overdue' ? 'Overdue' : 'Due today'}: ${text}`
}
