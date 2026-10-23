/**
 * Full-screen views (document editor, image lightbox) sit above the canvas, which is what normally
 * accepts drops. A file or link dropped on them would otherwise get the browser's default treatment:
 * it opens the file (or follows the link) in place of the app.
 */
import type { DragEvent } from 'react'

/** True for a drag that carries files (from the computer or an image dragged out of a web page). */
export function carriesFiles(dt: DataTransfer | null | undefined): boolean {
  return Array.from(dt?.types ?? []).includes('Files')
}

/**
 * dragenter / dragover / drop handler for an overlay: keeps the event from the canvas underneath and
 * refuses the drop (no-drop cursor) unless something inside already accepted it, such as the text
 * editor taking a text drag. Plain text dragged into a text field keeps the browser's behaviour.
 */
export function refuseStrayDrop(e: DragEvent) {
  e.stopPropagation()
  if (e.nativeEvent.defaultPrevented) return
  const target = e.target as HTMLElement | null
  const field = target?.closest?.('input, textarea, [contenteditable="true"]')
  if (field && !carriesFiles(e.dataTransfer)) return
  e.preventDefault()
  if (e.type !== 'drop' && e.dataTransfer) e.dataTransfer.dropEffect = 'none'
}
