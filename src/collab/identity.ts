import { create } from 'zustand'
import { newId } from '../model/ids'
import type { UserProfile } from '../model/types'
import { loadJSON, saveJSON } from './profile'

export const USER_COLORS = [
  '#e5484d',
  '#f76b15',
  '#d6a40b',
  '#30a46c',
  '#12a594',
  '#0090ff',
  '#6e56cf',
  '#d6409f',
  '#8e4ec6',
  '#3e63dd',
]

function initialProfile(): UserProfile {
  const saved = loadJSON<Partial<UserProfile> | null>('profile', null)
  if (saved && typeof saved.id === 'string' && typeof saved.name === 'string') {
    return { id: saved.id, name: saved.name, color: typeof saved.color === 'string' ? saved.color : USER_COLORS[0] }
  }
  const p: UserProfile = {
    id: newId(),
    name: '',
    color: USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)],
  }
  saveJSON('profile', p)
  return p
}

interface IdentityState {
  user: UserProfile
  /** True until the person has chosen a display name. */
  needsName: boolean
  setProfile: (patch: Partial<Omit<UserProfile, 'id'>>) => void
}

export const useIdentity = create<IdentityState>((set, get) => {
  const user = initialProfile()
  return {
    user,
    needsName: !user.name,
    setProfile: (patch) => {
      const next = { ...get().user, ...patch }
      next.name = next.name.trim().slice(0, 40)
      saveJSON('profile', next)
      set({ user: next, needsName: !next.name })
    },
  }
})

export const getUser = () => useIdentity.getState().user

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}
