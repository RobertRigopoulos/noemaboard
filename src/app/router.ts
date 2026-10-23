/**
 * Minimal hash router. Hash routing works on static hosts (GitHub Pages) and inside the desktop
 * app, and keeps invite secrets in the fragment where no server ever sees them.
 *
 *   #/            Home board
 *   #/b/<id>      a board
 *   #/join/<p>    accept an invite
 */
import { useMemo, useSyncExternalStore } from 'react'
import { HOME_BOARD_ID } from '../config'

export type Route = { name: 'board'; boardId: string } | { name: 'join'; payload: string }

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '')
  let m = h.match(/^\/b\/([0-9A-Za-z_-]{1,64})/)
  if (m) return { name: 'board', boardId: m[1] }
  m = h.match(/^\/join\/([A-Za-z0-9_-]+)/)
  if (m) return { name: 'join', payload: m[1] }
  return { name: 'board', boardId: HOME_BOARD_ID }
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash)
  // Stable per hash, so effects that depend on the route run when it changes, not on every render.
  return useMemo(() => parseRoute(hash), [hash])
}

export function navigate(path: string, replace = false) {
  const url = `${location.pathname}${location.search}#${path}`
  if (replace) history.replaceState(null, '', url)
  else history.pushState(null, '', url)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export const openBoard = (boardId: string, replace = false) =>
  navigate(boardId === HOME_BOARD_ID ? '/' : `/b/${boardId}`, replace)
