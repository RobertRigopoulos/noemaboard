/**
 * Compact formatting bubble shown above a non-empty text selection in the live editor:
 * the shared FormatControls, plus a link field. Rendered into document.body with fixed
 * positioning so it is never scaled by the canvas zoom.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BubbleMenu } from '@tiptap/react/menus'
import type { Editor } from '@tiptap/react'
import { NodeSelection, PluginKey, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { Check, ExternalLink, Link2, Unlink } from 'lucide-react'
import { useView } from '../board/store'
import { openExternal } from '../lib/desktop'
import { normalizeLinkInput } from './safeUrl'
import type { RichTextVariant } from './extensions'
import { focusFirstControl, FormatControls, keepFocus, type FormatPopover } from './FormatControls'
import { returnToText } from './toolbarFocus'

/** Selects the word around an empty cursor (for Mod-k without a selection). */
export function selectWordAtCursor(editor: Editor) {
  const { $from } = editor.state.selection
  const parent = $from.parent
  if (!parent.isTextblock) return
  const text = parent.textBetween(0, parent.content.size, '\0', '\0')
  let start = $from.parentOffset
  let end = start
  while (start > 0 && /\S/.test(text[start - 1])) start--
  while (end < text.length && /\S/.test(text[end])) end++
  if (end > start) editor.commands.setTextSelection({ from: $from.start() + start, to: $from.start() + end })
}

function dispatchMeta(editor: Editor, key: PluginKey, value: unknown) {
  if (editor.isDestroyed || !editor.isInitialized) return
  editor.view.dispatch(editor.state.tr.setMeta(key, value))
}

interface FormatMenuProps {
  editor: Editor
  variant: RichTextVariant
  /** Bumped by Mod-k: open the link field. */
  linkRequest: number
  /**
   * Filled with a handler for Escape pressed in the editor: it closes an open dropdown (or the link
   * field) and returns true, so Escape does not end editing or close the document at the same time.
   */
  escapeRef?: { current: (() => boolean) | null }
  /** Filled with a handler for Alt+F10: focuses the bubble's first control when it is showing. */
  focusRef?: { current: (() => boolean) | null }
}

export function FormatMenu({ editor, variant, linkRequest, escapeRef, focusRef }: FormatMenuProps) {
  const menuKey = useMemo(() => new PluginKey('cardFormatMenu'), [])
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [mode, setMode] = useState<'format' | 'link'>('format')
  const [popover, setPopover] = useState<FormatPopover>(null)
  const modeRef = useRef(mode)
  const popoverRef = useRef(popover)
  useLayoutEffect(() => {
    modeRef.current = mode
    popoverRef.current = popover
  }, [mode, popover])

  const shouldShow = useCallback(
    ({ editor: ed, view, state, element, from, to }: { editor: Editor; view: EditorView; state: EditorState; element: HTMLElement; from: number; to: number }) => {
      if (!ed.isEditable) return false
      if (!view.hasFocus() && !element.contains(document.activeElement)) return false
      if (modeRef.current === 'link') return true
      if (state.selection.empty || state.selection instanceof NodeSelection) return false
      return state.doc.textBetween(from, to, ' ').trim().length > 0
    },
    [],
  )

  const closeLink = useCallback(() => {
    setMode('format')
    if (editor.isDestroyed) return
    editor.commands.focus(undefined, { scrollIntoView: false })
    if (editor.state.selection.empty) requestAnimationFrame(() => dispatchMeta(editor, menuKey, 'hide'))
  }, [editor, menuKey])

  const openLink = useCallback(() => {
    if (editor.isDestroyed) return
    if (editor.state.selection.empty) {
      if (editor.isActive('link')) editor.chain().extendMarkRange('link').run()
      else selectWordAtCursor(editor)
    }
    setPopover(null)
    setMode('link')
    requestAnimationFrame(() => dispatchMeta(editor, menuKey, 'show'))
  }, [editor, menuKey])

  // Escape in the text while a dropdown is open: focus never leaves the editor (menu buttons keep
  // it there), so the editor asks the menu first.
  useLayoutEffect(() => {
    if (!escapeRef) return
    escapeRef.current = () => {
      if (popoverRef.current) {
        popoverRef.current = null
        setPopover(null)
        return true
      }
      if (modeRef.current === 'link') {
        closeLink()
        return true
      }
      return false
    }
    return () => {
      escapeRef.current = null
    }
  }, [escapeRef, closeLink])

  // Alt+F10: into the bubble, when it is showing (the plugin detaches the element when hidden).
  useLayoutEffect(() => {
    if (!focusRef) return
    focusRef.current = () => {
      const el = menuRef.current
      if (!el?.isConnected || el.style.visibility === 'hidden' || modeRef.current !== 'format') return false
      return focusFirstControl(el)
    }
    return () => {
      focusRef.current = null
    }
  }, [focusRef])

  // Mod-k from the editor.
  const lastLinkRequest = useRef(linkRequest)
  useEffect(() => {
    if (linkRequest === lastLinkRequest.current) return
    lastLinkRequest.current = linkRequest
    openLink()
  }, [linkRequest, openLink])

  // Follow the selection while the board pans/zooms or anything scrolls.
  useEffect(() => {
    let raf = 0
    const update = () => {
      if (raf || !menuRef.current?.isConnected) return
      raf = requestAnimationFrame(() => {
        raf = 0
        dispatchMeta(editor, menuKey, 'updatePosition')
      })
    }
    const unsubscribe = useView.subscribe(update)
    window.addEventListener('scroll', update, true)
    return () => {
      unsubscribe()
      window.removeEventListener('scroll', update, true)
      cancelAnimationFrame(raf)
    }
  }, [editor, menuKey])

  // Hide when focus leaves both the editor and the menu (the plugin can miss this after a menu click).
  useEffect(() => {
    const onBlur = () => {
      setTimeout(() => {
        if (editor.isDestroyed || !editor.isInitialized) return
        const menu = menuRef.current
        const active = document.activeElement
        if (editor.view.hasFocus() || (menu && menu.contains(active))) return
        // A dropdown of the bubble (in its own portal) that a keyboard user is in.
        if (active?.closest('.rt-pop')) return
        setPopover(null)
        setMode('format')
        dispatchMeta(editor, menuKey, 'hide')
      }, 0)
    }
    // Going back to the text (click, or after applying a link) leaves the link field.
    const onFocus = () => {
      if (modeRef.current === 'link') setMode('format')
    }
    editor.on('blur', onBlur)
    editor.on('focus', onFocus)
    return () => {
      editor.off('blur', onBlur)
      editor.off('focus', onFocus)
    }
  }, [editor, menuKey])

  const options = useMemo(
    () => ({
      strategy: 'fixed' as const,
      placement: 'top' as const,
      offset: 8,
      flip: { padding: 8 },
      shift: { padding: 8 },
      onHide: () => {
        setPopover(null)
        setMode('format')
      },
    }),
    [],
  )

  return (
    <BubbleMenu
      ref={menuRef}
      editor={editor}
      pluginKey={menuKey}
      updateDelay={120}
      appendTo={() => document.body}
      shouldShow={shouldShow}
      options={options}
      className="rt-menu"
    >
      <div
        className="rt-menu__bar"
        onMouseDown={keepFocus}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        {mode === 'link' ? (
          <LinkForm editor={editor} onDone={closeLink} />
        ) : (
          <FormatControls
            editor={editor}
            orientation="horizontal"
            compact={variant === 'caption'}
            onLink={openLink}
            popover={popover}
            setPopover={setPopover}
            onEscape={() => {
              setPopover(null)
              returnToText(editor)
            }}
          />
        )}
      </div>
    </BubbleMenu>
  )
}

// ---------------------------------------------------------------------------

export function LinkForm({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const existing = (editor.getAttributes('link').href as string | undefined) ?? ''
  const [value, setValue] = useState(existing)
  const [invalid, setInvalid] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // The menu element is attached to the page only once the bubble shows; focus as soon as it is.
  useEffect(() => {
    let tries = 0
    let raf = 0
    const tryFocus = () => {
      const input = inputRef.current
      if (input?.isConnected) {
        input.focus({ preventScroll: true })
        input.select()
      } else if (tries++ < 20) raf = requestAnimationFrame(tryFocus)
    }
    tryFocus()
    return () => cancelAnimationFrame(raf)
  }, [])

  const apply = () => {
    const href = normalizeLinkInput(value)
    if (!href) {
      setInvalid(true)
      return
    }
    if (editor.state.selection.empty && !editor.isActive('link')) {
      const text = value.trim()
      editor.chain().focus().insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }).run()
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    }
    onDone()
  }

  const safeExisting = existing ? normalizeLinkInput(existing) : null

  return (
    <form
      className="rt-link"
      onSubmit={(e) => {
        e.preventDefault()
        apply()
      }}
    >
      <Link2 size={14} className="rt-link__icon" aria-hidden />
      <input
        ref={inputRef}
        className={`rt-link__input${invalid ? ' is-invalid' : ''}`}
        value={value}
        placeholder="Paste or type a link…"
        aria-label="Link address"
        aria-invalid={invalid}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setValue(e.target.value)
          setInvalid(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onDone()
          }
        }}
      />
      <button type="submit" className="rt-btn" aria-label="Apply link" title="Apply (Enter)">
        <Check size={15} />
      </button>
      {safeExisting && (
        <button type="button" className="rt-btn" aria-label="Open link" title="Open link" onClick={() => openExternal(safeExisting)}>
          <ExternalLink size={15} />
        </button>
      )}
      {existing && (
        <button
          type="button"
          className="rt-btn"
          aria-label="Remove link"
          title="Remove link"
          onClick={() => {
            editor.chain().focus().extendMarkRange('link').unsetLink().run()
            onDone()
          }}
        >
          <Unlink size={15} />
        </button>
      )}
    </form>
  )
}
