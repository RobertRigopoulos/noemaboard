/**
 * Presentation mode: the board fills the screen (fullscreen when the browser allows it), the
 * chrome hides (see :root[data-presenting] in panels.css), and a small exit button stays
 * available. Escape or leaving fullscreen ends it; the previous view is restored afterwards.
 */
import { useEffect, useRef, useState } from 'react'
import { Minimize2 } from 'lucide-react'
import type { BoardContextValue } from '../../board/BoardContext'
import { zoomToFit } from '../../board/actions'
import { useContextMenu, usePanels, useSelection, useView, type Viewport } from '../../board/store'
import { hasOpenDialog } from '../dialogs/Dialog'
import { keepControlKeys } from '../keyGuard'
import './panels.css'

const IDLE_MS = 2500

/** Fullscreen we requested (kept across board navigation while presenting). */
let ownsFullscreen = false

export function PresentationOverlay({ ctx }: { ctx: BoardContextValue }) {
  const presenting = usePanels((s) => s.presenting)
  const doc = ctx.doc

  useEffect(() => {
    if (!presenting) return
    const root = document.documentElement
    const saved: Viewport = useView.getState().viewport
    let disposed = false
    root.dataset.presenting = 'true'
    useContextMenu.getState().close()
    useSelection.getState().setTool('select')

    // Fit once the chrome is gone, and again after the fullscreen resize.
    const fit = () => requestAnimationFrame(() => !disposed && zoomToFit(doc))
    fit()
    if (!document.fullscreenElement && typeof root.requestFullscreen === 'function') {
      root
        .requestFullscreen({ navigationUI: 'hide' })
        .then(() => {
          ownsFullscreen = true
        })
        .catch(() => {
          /* not allowed (no user gesture, iframe policy...): present in the window */
        })
    }

    const onFullscreenChange = () => {
      if (document.fullscreenElement) return fit()
      // Browsers consume Escape to leave fullscreen without a keydown: end presenting too.
      if (ownsFullscreen) {
        ownsFullscreen = false
        usePanels.getState().setPresenting(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // Let text editing, open menus, an open document / image and dialogs take Escape first:
      // this capture listener runs before all of them.
      if (useSelection.getState().editing || useContextMenu.getState().menu || usePanels.getState().expanded || hasOpenDialog()) return
      e.preventDefault()
      usePanels.getState().setPresenting(false)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    window.addEventListener('keydown', onKey, true)
    return () => {
      disposed = true
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      window.removeEventListener('keydown', onKey, true)
      useView.getState().setViewport(saved)
      // Opening another board while presenting remounts this overlay: stay in presentation.
      if (usePanels.getState().presenting) return
      delete root.dataset.presenting
      if (ownsFullscreen && document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      ownsFullscreen = false
    }
  }, [presenting, doc])

  if (!presenting) return null
  return <ExitButton />
}

function ExitButton() {
  const [idle, setIdle] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const wake = () => {
      setIdle(false)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setIdle(true), IDLE_MS)
    }
    wake()
    window.addEventListener('pointermove', wake)
    window.addEventListener('keydown', wake)
    return () => {
      if (timer.current) clearTimeout(timer.current)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [])
  return (
    <button
      type="button"
      className={`present-exit${idle ? ' is-idle' : ''}`}
      onClick={() => usePanels.getState().setPresenting(false)}
      onKeyDown={keepControlKeys}
      title="Exit presentation (Esc)"
    >
      <Minimize2 size={16} strokeWidth={2} aria-hidden />
      Exit presentation
      <kbd>Esc</kbd>
    </button>
  )
}
