import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { ensureFragment } from '../../model/board'
import type { CardMap } from '../../model/types'

/**
 * The card's rich-text fragment. Cards from older or foreign clients may lack it; it is then created
 * (SYSTEM_ORIGIN, not undoable) unless the board is read-only. Replacements of the field (restore,
 * remote overwrite) re-render the card through CardShell, so the latest fragment is always returned.
 */
export function useCardFragment(map: CardMap, field: string, readOnly: boolean): Y.XmlFragment | null {
  const value = map.get(field)
  const fragment = value instanceof Y.XmlFragment ? value : null
  useEffect(() => {
    if (fragment || readOnly || !map.doc) return
    ensureFragment(map.doc, map, field)
  }, [fragment, map, field, readOnly])
  return fragment
}

/** Plain string field from a card snapshot (peers may send anything). */
export function cardString(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * Local draft for a text input bound to a shared field: every keystroke is written through, but a
 * remote change only replaces the text while the person is not typing in it (no caret jumps).
 */
export function useDraftField(value: string, commit: (next: string) => void, max = 300) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const latest = useRef(value)
  useEffect(() => {
    latest.current = value
    if (!focused.current) setDraft(value)
  }, [value])
  return {
    value: draft,
    onChange: (next: string) => {
      const clipped = next.slice(0, max)
      setDraft(clipped)
      commit(clipped)
    },
    onFocus: () => {
      focused.current = true
    },
    onBlur: () => {
      focused.current = false
      setDraft(latest.current)
    },
  }
}
