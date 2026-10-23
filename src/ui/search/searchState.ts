/** Search dialog options chosen before it opens (scope) and remembered while the app runs. */
import { create } from 'zustand'
import { useDialogs } from '../uiStore'

export type SearchScope = 'all' | 'board'

export const useSearchScope = create<{ scope: SearchScope; setScope: (s: SearchScope) => void }>((set) => ({
  scope: 'all',
  setScope: (scope) => set({ scope }),
}))

/** Opens the search dialog searching every board, or only the open board. */
export function openSearch(scope: SearchScope = 'all') {
  useSearchScope.setState({ scope })
  useDialogs.getState().open('search')
}
