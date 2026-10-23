/**
 * Local UI state of the media cards. The lightbox is shown while usePanels.expanded is the id of an
 * active image card (see actions.tsx), in the mode kept here; the alt-text popover while `altFor` is
 * set; and a link card asked for through 'Add caption' focuses its caption instead of its address.
 */
import { create } from 'zustand'
import { usePanels, useSelection } from '../../board/store'

export type LightboxMode = 'view' | 'crop'

interface LightboxState {
  mode: LightboxMode
  /** Image the mode was chosen for. Showing anything else (or closing) goes back to 'view'. */
  target: string | null
  /** Where the cropper goes once applied: back to the viewer, or closed when it was opened for cropping. */
  cropReturn: 'view' | 'close'
  setMode: (mode: LightboxMode) => void
  /** Crop from inside the viewer: applying comes back to the viewer. */
  startCrop: () => void
}

export const useLightbox = create<LightboxState>((set) => ({
  mode: 'view',
  target: null,
  cropReturn: 'view',
  setMode: (mode) => set({ mode }),
  startCrop: () => set({ mode: 'crop', cropReturn: 'view', target: usePanels.getState().expanded }),
}))

/** Opens the lightbox on image card `id`, viewing it or straight in the cropper. */
export function openImage(id: string, mode: LightboxMode = 'view'): void {
  useLightbox.setState({ mode, target: id, cropReturn: mode === 'crop' ? 'close' : 'view' })
  usePanels.getState().setExpanded(id)
}

// Reset where the viewer actually closes or moves on, whoever does it (Escape, a deleted card, another
// panel). Not in an unmount cleanup: StrictMode runs those right after the first mount.
usePanels.subscribe((s, prev) => {
  if (s.expanded === prev.expanded) return
  const l = useLightbox.getState()
  if (l.mode !== 'view' && s.expanded !== l.target) useLightbox.setState({ mode: 'view', target: s.expanded })
})

interface AltEditorState {
  /** Image card whose alt text is being edited. */
  altFor: string | null
  /** Screen rect of the button or menu item that opened it, used when the card is not rendered. */
  anchor: DOMRect | null
  open: (id: string, anchor: DOMRect | null) => void
  close: () => void
}

export const useAltEditor = create<AltEditorState>((set) => ({
  altFor: null,
  anchor: null,
  open: (altFor, anchor) => set({ altFor, anchor }),
  close: () => set({ altFor: null, anchor: null }),
}))

/**
 * Card whose caption should take focus when its edit mode starts ('Add caption'). Editing a link
 * any other way puts the caret in its address. Kept for the whole edit session, so a caption editor
 * that mounts a moment later (its fragment created on demand) still gets focus.
 */
export const useCaptionFocus = create<{ cardId: string | null }>(() => ({ cardId: null }))

export function requestCaptionFocus(cardId: string): void {
  useCaptionFocus.setState({ cardId })
}

useSelection.subscribe((s) => {
  const want = useCaptionFocus.getState().cardId
  if (want && s.editing !== want) useCaptionFocus.setState({ cardId: null })
})
