/**
 * "People on this board" for the share dialog (pure): the board's member roster merged with who is
 * here right now. Roster entries and presence both come from peers; callers pass validated values.
 */

export interface RosterPerson {
  id: string
  name: string
  color: string
  /** When they last opened the board, by their clock (display only). 0 when unknown. */
  seenAt: number
}

export interface LivePerson {
  id: string
  name: string
  color: string
  editing: boolean
}

export interface PersonRow {
  id: string
  name: string
  color: string
  isMe: boolean
  online: boolean
  editing: boolean
  seenAt: number
}

const byName = (a: PersonRow, b: PersonRow) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * One row per person: you first, then everyone online now (by name), then the rest of the roster,
 * most recently seen first. A live name and colour win over the roster's (they are current).
 */
export function mergePeople(roster: readonly RosterPerson[], live: readonly LivePerson[], me: { id: string; name: string; color: string }): PersonRow[] {
  const rows = new Map<string, PersonRow>()
  for (const m of roster) {
    if (!m.id || rows.has(m.id)) continue
    rows.set(m.id, { id: m.id, name: m.name, color: m.color, isMe: false, online: false, editing: false, seenAt: m.seenAt > 0 ? m.seenAt : 0 })
  }
  for (const p of live) {
    if (!p.id) continue
    const prev = rows.get(p.id)
    rows.set(p.id, {
      id: p.id,
      name: p.name || prev?.name || 'Someone',
      color: p.color || prev?.color || '',
      isMe: false,
      online: true,
      editing: p.editing || !!prev?.editing,
      seenAt: prev?.seenAt ?? 0,
    })
  }
  const prevMe = rows.get(me.id)
  rows.set(me.id, {
    id: me.id,
    name: me.name || prevMe?.name || 'You',
    color: me.color || prevMe?.color || '',
    isMe: true,
    online: true,
    editing: false,
    seenAt: prevMe?.seenAt ?? 0,
  })
  const all = [...rows.values()]
  const mine = all.filter((r) => r.isMe)
  const online = all.filter((r) => !r.isMe && r.online).sort(byName)
  const offline = all.filter((r) => !r.isMe && !r.online).sort((a, b) => b.seenAt - a.seenAt || byName(a, b))
  return [...mine, ...online, ...offline]
}

/** Rows shown before "Show all". */
export const PEOPLE_SHOWN = 50

/** The invitation text for chat or mail: 'Join “Plan” in <App>: <link>'. */
export function invitationText(appName: string, title: string, link: string): string {
  const t = title.replace(/\s+/g, ' ').trim() || 'Untitled board'
  return `Join “${t}” in ${appName}: ${link}`
}
