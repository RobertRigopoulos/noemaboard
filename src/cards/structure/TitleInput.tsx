/**
 * Single-line inline title editor used by column and board cards. Saves on Enter, Escape and
 * blur, and also when it unmounts because edit mode ended elsewhere (click on the canvas, etc.).
 */
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react'
import { truncate } from './helpers'

interface Props {
  value: string
  placeholder: string
  maxLength: number
  ariaLabel: string
  className?: string
  /** Called with the trimmed draft whenever it differs from what was last saved. */
  onCommit: (value: string) => void
  /** Enter / Escape: the user is done editing. */
  onDone: () => void
  /** Blur handler after the draft was saved (decide whether to leave edit mode). */
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void
  /** Mod+Enter: save, finish editing, then create the next card below this one. */
  onCreateNext?: () => void
}

export function TitleInput({ value, placeholder, maxLength, ariaLabel, className, onCommit, onDone, onBlur, onCreateNext }: Props) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const saved = useRef(value)
  const latest = useRef({ draft, onCommit })
  latest.current = { draft, onCommit }

  const commit = () => {
    const next = truncate(latest.current.draft.replace(/\s+/g, ' ').trim(), maxLength).trim()
    if (next === saved.current) return
    saved.current = next
    latest.current.onCommit(next)
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.select()
  }, [])

  // Edit mode can end without a blur event (the input is simply removed), so save on unmount too.
  useEffect(() => () => commit(), []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <input
      ref={ref}
      className={className}
      value={draft}
      placeholder={placeholder}
      maxLength={maxLength}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          if (e.nativeEvent.isComposing) return
          e.preventDefault()
          e.stopPropagation()
          commit()
          onDone()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) onCreateNext?.()
        }
      }}
      onBlur={(e) => {
        commit()
        onBlur?.(e)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      // Keep the browser's text menu (cut/copy/paste) instead of the card menu.
      onContextMenu={(e) => e.stopPropagation()}
    />
  )
}
