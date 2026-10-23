/**
 * The @mention picker of a live editor. mention.ts notices "@query" before the caret; while it does,
 * this lists matching people (board members, people online now, prefix match on any word of the
 * name, at most 8) under the "@". Focus stays in the text: the list is a listbox the editor points
 * at with aria-activedescendant, Up/Down move, Enter or Tab pick, Escape closes the list without
 * ending editing.
 */
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { autoUpdate, flip, FloatingPortal, offset, shift, size, useFloating, type VirtualElement } from '@floating-ui/react'
import { useEditorState, type Editor } from '@tiptap/react'
import { BoardContext } from '../board/BoardContext'
import { useIdentity } from '../collab/identity'
import type { Member } from '../model/members'
import { activeMention, dismissMention, setMentionKeyHandler, type MentionMatch } from './mention'
import { nameMatches } from './mentionAttrs'
import { memberInitials } from './taskItem'
import { useAssignablePeople } from './TaskMetaPopover'

export const MAX_MENTION_ITEMS = 8

/** People matching a mention query: prefix of any word of the name, the current user last. */
export function mentionItems(people: readonly Member[], query: string, meId: string): Member[] {
  const others = people.filter((p) => p.id !== meId && nameMatches(p.name, query))
  const me = people.find((p) => p.id === meId && nameMatches(p.name, query))
  return [...others, ...(me ? [me] : [])].slice(0, MAX_MENTION_ITEMS)
}

/** Inserts a mention node (and a space) in place of the "@query" being typed. */
export function insertMention(editor: Editor, match: MentionMatch, person: { id: string; name: string }): boolean {
  return editor
    .chain()
    .focus()
    .insertContentAt({ from: match.from, to: match.to }, [
      { type: 'mention', attrs: { id: person.id, label: person.name } },
      { type: 'text', text: ' ' },
    ])
    .run()
}

export function MentionSuggestions({ editor }: { editor: Editor }) {
  const board = useContext(BoardContext)
  // Only while the text has focus: the picker's keys go through the editor, and a list left on
  // screen over the title field, a toolbar or a popover would be dead.
  const match = useEditorState({
    editor,
    selector: ({ editor: ed }) => (ed && !ed.isDestroyed && ed.isEditable && ed.isFocused ? activeMention(ed.state) : null),
  })
  if (!match || !board) return null
  return <MentionList editor={editor} match={match} />
}

function MentionList({ editor, match }: { editor: Editor; match: MentionMatch }) {
  const people = useAssignablePeople()
  const meId = useIdentity((s) => s.user.id)
  const items = useMemo(() => mentionItems(people, match.query, meId), [people, match.query, meId])
  const [active, setActive] = useState(0)
  const listId = useId()
  const optionId = (i: number) => `${listId}-opt-${i}`
  const current = Math.min(active, Math.max(0, items.length - 1))

  // A new query starts at the top of the list.
  useEffect(() => setActive(0), [match.query, match.from])

  const latest = useRef({ items, current, match })
  latest.current = { items, current, match }

  useEffect(() => {
    const view = editor.view
    setMentionKeyHandler(view, (event) => {
      const { items: list, current: at, match: m } = latest.current
      if (!list.length || event.isComposing) return false
      const plain = !event.altKey && !event.ctrlKey && !event.metaKey
      switch (event.key) {
        case 'ArrowDown':
          if (!plain) return false
          setActive((at + 1) % list.length)
          return true
        case 'ArrowUp':
          if (!plain) return false
          setActive((at + list.length - 1) % list.length)
          return true
        case 'Enter':
        case 'Tab':
          if (!plain || event.shiftKey) return false
          insertMention(editor, m, list[at])
          return true
        case 'Escape':
          dismissMention(view)
          return true
        default:
          return false
      }
    })
    return () => setMentionKeyHandler(view, null)
  }, [editor])

  // The editor (a textbox) owns the list: screen readers follow the highlighted person.
  useLayoutEffect(() => {
    const dom = editor.view.dom
    if (!items.length) return
    dom.setAttribute('aria-autocomplete', 'list')
    dom.setAttribute('aria-expanded', 'true')
    dom.setAttribute('aria-controls', listId)
    dom.setAttribute('aria-activedescendant', optionId(current))
    return () => {
      for (const a of ['aria-autocomplete', 'aria-expanded', 'aria-controls', 'aria-activedescendant']) dom.removeAttribute(a)
    }
  })

  const reference = useMemo<VirtualElement>(
    () => ({
      getBoundingClientRect: () => {
        try {
          const c = editor.view.coordsAtPos(Math.min(match.from, editor.state.doc.content.size))
          return new DOMRect(c.left, c.top, 0, c.bottom - c.top)
        } catch {
          return new DOMRect()
        }
      },
      contextElement: editor.view.dom,
    }),
    [editor, match.from],
  )

  const { refs, floatingStyles } = useFloating({
    open: true,
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(120, Math.min(320, availableHeight))}px`
        },
      }),
    ],
    whileElementsMounted: (ref, floating, update) => autoUpdate(ref, floating, update, { animationFrame: true }),
  })
  useLayoutEffect(() => {
    refs.setPositionReference(reference)
  }, [refs, reference])

  // Keep the highlighted person in view in a long list.
  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  if (!items.length) return null
  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        id={listId}
        className="mention-list"
        role="listbox"
        aria-label="Mention someone"
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {items.map((p, i) => (
          <div
            key={p.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === current}
            className={`mention-list__item${i === current ? ' is-active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => insertMention(editor, latest.current.match, p)}
          >
            <span className="mention-list__avatar" style={{ background: p.color }} aria-hidden>
              {memberInitials(p.name)}
            </span>
            <span className="mention-list__name">{p.name}</span>
            {p.id === meId && <span className="mention-list__you">You</span>}
          </div>
        ))}
      </div>
    </FloatingPortal>
  )
}
