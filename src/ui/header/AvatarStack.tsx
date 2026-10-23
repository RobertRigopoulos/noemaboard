/** Who is on this board right now: you + teammates (deduplicated across their tabs). */
import { useMemo } from 'react'
import { usePeers } from '../../board/BoardContext'
import { centerOn } from '../../board/actions'
import { useIdentity } from '../../collab/identity'
import { useDialogs } from '../uiStore'
import { toast } from '../toast'
import { Avatar, safeColor, safeName } from './Avatar'
import { Menu } from './Menu'

const MAX_SHOWN = 5

export interface Person {
  id: string
  name: string
  color: string
  pointer: { x: number; y: number } | null
  editing: boolean
}

/** Remote people on the board, one entry per user id (a person may have several tabs open). */
export function usePeople(): Person[] {
  const peers = usePeers()
  const me = useIdentity((s) => s.user.id)
  return useMemo(() => {
    const byId = new Map<string, Person>()
    for (const { clientId, state } of peers) {
      const u = state.user
      const id = typeof u.id === 'string' && u.id ? u.id.slice(0, 64) : `client-${clientId}`
      if (id === me) continue
      const p = state.pointer
      const pointer = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null
      const prev = byId.get(id)
      byId.set(id, {
        id,
        name: safeName(u.name),
        color: safeColor(u.color),
        pointer: pointer ?? prev?.pointer ?? null,
        editing: !!state.editing || !!prev?.editing,
      })
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [peers, me])
}

function goTo(p: Person) {
  if (p.pointer) centerOn(p.pointer)
  else toast(`${p.name} is not pointing at anything on this board right now.`)
}

export function AvatarStack() {
  const people = usePeople()
  const me = useIdentity((s) => s.user)
  const shown = people.slice(0, MAX_SHOWN - 1)
  const rest = people.slice(MAX_SHOWN - 1)

  return (
    <div className="avatars" role="group" aria-label={people.length ? `${people.length + 1} people on this board` : 'Only you on this board'}>
      {shown.map((p) => (
        <button
          key={p.id}
          type="button"
          className="avatars__btn"
          title={`${p.name}${p.editing ? ' (editing)' : ''} – click to go to their pointer`}
          aria-label={`${p.name}. Go to their pointer`}
          onClick={() => goTo(p)}
        >
          <Avatar name={p.name} color={p.color} size={28} />
        </button>
      ))}
      {rest.length > 0 && (
        <Menu
          label={`${rest.length} more ${rest.length === 1 ? 'person' : 'people'} on this board`}
          className="avatars__btn avatars__more"
          items={rest.map((p) => ({ label: p.name, icon: <Avatar name={p.name} color={p.color} size={18} />, onSelect: () => goTo(p) }))}
        >
          +{rest.length}
        </Menu>
      )}
      <button
        type="button"
        className="avatars__btn avatars__me"
        title={`${me.name || 'You'} (you) – edit your profile`}
        aria-label="Your profile"
        onClick={() => useDialogs.getState().open('profile')}
      >
        <Avatar name={me.name || '?'} color={me.color} size={28} />
      </button>
    </div>
  )
}
