/**
 * Rich text bound to a card's Y.XmlFragment.
 *
 * Not editing: cached, sanitised static HTML (cheap, so hundreds of cards render fast); links open
 * externally, task checkboxes toggle and task chips (due date, assignee) open their popover without
 * entering edit mode.
 * Editing: a TipTap editor bound to the fragment (Collaboration) with remote carets from the board
 * awareness. Only the card being edited mounts an editor. Both modes share the `.rich-text__content`
 * styles so a card does not change size when switching.
 */
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { Extension } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import type { VirtualElement } from '@floating-ui/react'
import { BoardContext, useYVersion, type BoardContextValue } from '../board/BoardContext'
import { getUser, useIdentity } from '../collab/identity'
import { openExternal } from '../lib/desktop'
import { toast } from '../ui/toast'
import { isOfficeCopy } from '../cards/media/paste'
import { getMembers, readMembers } from '../model/members'
import { buildExtensions } from './extensions'
import { enableTextHistory } from './history'
import { fragmentToHtml, isFragmentEmpty, isFragmentProjectable } from './staticHtml'
import { findTaskItem, setTaskElementAttr, taskIndexOf, toggleTaskItem, type TaskAttrPatch } from './tasks'
import { isSafeHref, normalizeLinkInput } from './safeUrl'
import { FormatMenu } from './FormatMenu'
import { runEditorEscape, useActiveEditor } from './activeEditor'
import { moveListItem } from './listMove'
import { MentionSuggestions } from './MentionList'
import { TaskMetaPopover, type TaskMetaCloseReason } from './TaskMetaPopover'
import {
  memberInitials,
  refreshTaskViews,
  taskIndexAtPos,
  taskPosAtIndex,
  type TaskMember,
  type TaskMetaKind,
  type TaskMetaRequest,
} from './taskItem'
import { cleanAssignee, cleanDue, dueDescription, dueState } from './taskMeta'
import { useToday } from './dayClock'
import { focusDockedToolbar, returnToText } from './toolbarFocus'
import { isFilesOnlyPaste } from './pasteFiles'
import { markdownPaste } from './richNote'
import { isPlainTextPaste } from './plainPaste'
import './richtext.css'

export interface RichTextProps {
  /** The card's collaborative rich-text fragment. */
  fragment: Y.XmlFragment
  /** Mount a live editor (true) or render static HTML (false). */
  editing: boolean
  variant: 'note' | 'todo' | 'document' | 'caption'
  placeholder?: string
  readOnly?: boolean
  /** Called when the editor wants to leave edit mode (Escape). */
  onExit?: () => void
  className?: string
  /** Muted text shown instead of nothing when not editing and the fragment is empty. */
  emptyText?: string
  /**
   * Static mode: a task checkbox was clicked (index in document order, new state).
   * When omitted the task is toggled in the doc (LOCAL_ORIGIN, undoable).
   */
  onTaskToggle?: (index: number, checked: boolean) => void
  /** Receives the live editor once it is ready, and null when it goes away. */
  onEditor?: (editor: Editor | null) => void
  /** Caret position when editing starts without a click position. Default 'end'. */
  autofocus?: 'start' | 'end' | false
  /** Card the text belongs to (the active-editor store, so toolbars outside the card know it). */
  cardId?: string
  /**
   * Files pasted into the text (screenshots, copied files). Text cannot hold them; the card body
   * usually imports them as cards below itself. Without a handler the person is told why nothing happened.
   */
  onPasteFiles?: (files: File[]) => void
  /** Mod+Enter: leave the text and start a new card. Return false to let the editor handle the key. */
  onCreateNext?: () => boolean
}

const ARIA_LABEL: Record<RichTextProps['variant'], string> = {
  note: 'Note text',
  todo: 'To-do list',
  document: 'Document text',
  caption: 'Caption',
}

/** Where the person last pressed on static text, so the caret lands there when the editor mounts. */
let pendingCaret: { fragment: Y.XmlFragment; x: number; y: number; t: number } | null = null
/** Selection of the editor that just went away, for an editor of the same text mounted right after. */
let keptSelection: { fragment: Y.XmlFragment; anchor: number; head: number; t: number } | null = null
const CARET_MEMORY_MS = 1500

/** The board history records this fragment's edits when the fragment belongs to the open board. */
function boardHistoryFor(board: BoardContextValue | null, fragment: Y.XmlFragment): Y.UndoManager | null {
  if (!board || board.readOnly || !fragment.doc || fragment.doc !== board.doc) return null
  enableTextHistory(board.undo)
  return board.undo
}

/** People an assignee id can refer to: the board roster, with the current user from their profile. */
function useMemberLookup(board: BoardContextValue | null, enabled: boolean): (id: string) => TaskMember | null {
  const version = useYVersion(board && enabled ? getMembers(board.doc) : null)
  const me = useIdentity((s) => s.user)
  return useMemo(() => {
    const byId = new Map<string, TaskMember>()
    if (board && enabled) for (const m of readMembers(board.doc)) byId.set(m.id, { name: m.name, color: m.color, isMe: m.id === me.id })
    const myName = me.name.trim() || byId.get(me.id)?.name
    if (myName) byId.set(me.id, { name: myName, color: me.color, isMe: true })
    return (id: string) => byId.get(id) ?? null
    // `version` re-reads the roster when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, enabled, version, me])
}

export function RichText(props: RichTextProps) {
  const { fragment, editing, variant, className, readOnly } = props
  const board = useContext(BoardContext)
  // Text changed outside an editor (a ticked checkbox) is tagged in the board history too, so the
  // to-do's editor can undo it later.
  useEffect(() => {
    boardHistoryFor(board, fragment)
  }, [board, fragment])
  // Content from a newer app version cannot be bound safely: stay static and say why.
  // Checked when editing starts (not per keystroke: it renders the whole fragment).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const projectable = useMemo(() => isFragmentProjectable(fragment), [fragment, editing])
  const live = editing && !!fragment.doc && projectable
  // The live editor follows the fragment itself; only static HTML needs re-rendering on changes.
  const version = useYVersion(live ? null : fragment)
  const cls = ['rich-text', `rich-text--${variant}`, live && 'is-live', readOnly && 'is-readonly', className].filter(Boolean).join(' ')
  return (
    <div className={cls}>
      {live ? <LiveEditor {...props} /> : <StaticRichText {...props} version={version} />}
      {editing && !projectable && (
        <p className="rich-text__notice" role="status">
          This text was written with a newer version of the app and can only be viewed here.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Static mode

interface StaticMeta {
  kind: TaskMetaKind
  /**
   * The task's shared element. Its index changes whenever a teammate adds, removes or moves a task
   * above it, so the index is looked up again from the element whenever it is needed.
   */
  item: Y.XmlElement
}

function taskItems(root: Element): Element[] {
  return Array.from(root.querySelectorAll('li[data-type="taskItem"]'))
}

function chipAt(root: Element | null, index: number, kind: TaskMetaKind): HTMLElement | null {
  const li = root && index >= 0 ? taskItems(root)[index] : null
  return li?.querySelector<HTMLElement>(`:scope > .task-meta > .task-chip--${kind === 'due' ? 'due' : 'assignee'}`) ?? null
}

function StaticRichText({ fragment, variant, readOnly, emptyText, onTaskToggle, version }: RichTextProps & { version: number }) {
  const board = useContext(BoardContext)
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => fragmentToHtml(fragment), [fragment, version])
  const empty = useMemo(() => isFragmentEmpty(fragment), [fragment, version])
  const down = useRef<{ x: number; y: number } | null>(null)
  /** Task whose checkbox had focus when it was ticked: re-rendering the HTML replaces that element. */
  const refocus = useRef<number | null>(null)
  const [meta, setMeta] = useState<StaticMeta | null>(null)
  const hasChips = html.includes('task-chip')
  const hasMentions = html.includes('class="mention"')
  const today = useToday()
  const meId = useIdentity((s) => s.user.id)
  const member = useMemberLookup(board, html.includes('task-chip--assignee'))
  // Captions have no due dates or assignees to set (nothing would ever remind anyone of them).
  const interactive = !readOnly && !!board && !board.readOnly && variant !== 'caption'

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box) => {
      box.disabled = !!readOnly
      box.tabIndex = readOnly ? -1 : 0
    })
    if (hasChips) decorateChips(root, { today, member, interactive })
    if (hasMentions) {
      root.querySelectorAll<HTMLElement>('span.mention').forEach((m) => m.classList.toggle('is-me', m.getAttribute('data-id') === meId))
    }
    const pending = refocus.current
    if (pending === null) return
    refocus.current = null
    const active = document.activeElement
    // Only when focus was lost with the old element (never steal it from somewhere else).
    if (active && active !== document.body && active.isConnected) return
    const item = taskItems(root)[pending]
    item?.querySelector<HTMLInputElement>(':scope > label > input[type="checkbox"]')?.focus({ preventScroll: true })
  }, [html, readOnly, hasChips, hasMentions, today, member, interactive, meId])

  const openChip = (chip: HTMLElement): boolean => {
    const root = ref.current
    if (!root || !interactive) return false
    const li = chip.closest('li[data-type="taskItem"]')
    if (!li || chip.parentElement?.parentElement !== li) return false
    // The HTML is rendered from the fragment, so DOM order is the fragment's task order.
    const item = findTaskItem(fragment, taskItems(root).indexOf(li))
    if (!item) return false
    setMeta({ item, kind: chip.classList.contains('task-chip--due') ? 'due' : 'assign' })
    return true
  }

  /** Back to the task's chip (or its checkbox, when the chip went away) after the popover closes. */
  const focusTask = (meta: StaticMeta) => {
    const index = taskIndexOf(fragment, meta.item)
    const li = ref.current && index >= 0 ? taskItems(ref.current)[index] : null
    const target = chipAt(ref.current, index, meta.kind) ?? li?.querySelector<HTMLElement>(':scope > label > input[type="checkbox"]')
    target?.focus({ preventScroll: true })
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    down.current = { x: e.clientX, y: e.clientY }
    pendingCaret = { fragment, x: e.clientX, y: e.clientY, t: Date.now() }
  }

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const root = ref.current
    if (!root) return
    const chip = target.closest('.task-chip') as HTMLElement | null
    if (chip && root.contains(chip)) {
      e.preventDefault()
      e.stopPropagation()
      const d = down.current
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
      openChip(chip)
      return
    }
    const box = target.closest('input[type="checkbox"]') as HTMLInputElement | null
    if (box && root.contains(box)) {
      // Our HTML is re-rendered from the doc; never let the browser flip the box on its own.
      e.preventDefault()
      e.stopPropagation()
      if (readOnly) return
      const item = box.closest('li[data-type="taskItem"]')
      if (!item || box.parentElement?.parentElement !== item) return
      const index = taskItems(root).indexOf(item)
      if (index < 0) return
      const checked = item.getAttribute('data-checked') !== 'true'
      refocus.current = document.activeElement === box ? index : null
      if (onTaskToggle) onTaskToggle(index, checked)
      else toggleTaskItem(fragment, index, { checked })
      return
    }
    const link = target.closest('a') as HTMLAnchorElement | null
    if (link && root.contains(link)) {
      e.preventDefault()
      e.stopPropagation()
      // Ignore the click that ends a drag of the card.
      const d = down.current
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
      const href = link.getAttribute('href') ?? ''
      const url = isSafeHref(href) ? href : normalizeLinkInput(href)
      if (url) openExternal(url)
    }
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const chip = (e.target as HTMLElement).closest('.task-chip') as HTMLElement | null
    if (!chip || !openChip(chip)) return
    // The board would otherwise start editing the card (Enter) or pan (Space).
    e.preventDefault()
    e.stopPropagation()
  }

  const stopForControls = (e: MouseEvent<HTMLDivElement>) => {
    // Double-clicking a checkbox, chip or link should not enter edit mode.
    if ((e.target as HTMLElement).closest('input, a, .task-chip')) e.stopPropagation()
  }

  if (empty && emptyText) {
    return (
      <div className="rich-text__content rich-text__static rich-text__empty" onPointerDown={onPointerDown}>
        <p>{emptyText}</p>
      </div>
    )
  }
  return (
    <>
      <div
        ref={ref}
        className="rich-text__content rich-text__static"
        onPointerDown={onPointerDown}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onDoubleClick={stopForControls}
        onDragStart={(e) => e.preventDefault()}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {meta && board && (
        <StaticTaskMeta
          fragment={fragment}
          meta={meta}
          root={ref}
          onClose={(reason) => {
            setMeta(null)
            if (reason === 'outside') return
            focusTask(meta)
            // A change written on closing re-renders the HTML, replacing the element just focused.
            requestAnimationFrame(() => {
              const active = document.activeElement
              if (!active || active === document.body || !active.isConnected) focusTask(meta)
            })
          }}
        />
      )}
    </>
  )
}

/**
 * Fills in what static HTML cannot know: today's due states, assignees' initials and colours, and
 * (on editable boards) makes the chips keyboard-operable buttons.
 */
function decorateChips(
  root: HTMLElement,
  { today, member, interactive }: { today: string; member: (id: string) => TaskMember | null; interactive: boolean },
) {
  for (const li of taskItems(root)) {
    const meta = li.querySelector(':scope > .task-meta')
    if (!meta) continue
    const checked = li.getAttribute('data-checked') === 'true'
    const due = cleanDue(li.getAttribute('data-due'))
    const dueChip = meta.querySelector<HTMLElement>(':scope > .task-chip--due')
    if (dueChip && due) {
      const state = dueState(due, today)
      dueChip.classList.toggle('is-overdue', !checked && state === 'overdue')
      dueChip.classList.toggle('is-today', !checked && state === 'today')
      dueChip.setAttribute('aria-label', interactive ? `${dueDescription(due, today)}. Change due date` : dueDescription(due, today))
    }
    const assigneeChip = meta.querySelector<HTMLElement>(':scope > .task-chip--assignee')
    const assignee = cleanAssignee(li.getAttribute('data-assignee'))
    if (assigneeChip && assignee) {
      const who = member(assignee)
      const name = who?.name ?? 'Someone who is not on this board'
      assigneeChip.textContent = who ? memberInitials(who.name) : '?'
      assigneeChip.style.background = who?.color ?? ''
      assigneeChip.classList.toggle('is-me', !!who?.isMe)
      assigneeChip.classList.toggle('is-unknown', !who)
      assigneeChip.title = who?.isMe ? `${name} (you)` : name
      assigneeChip.setAttribute('aria-label', interactive ? `Assigned to ${name}. Change assignee` : `Assigned to ${name}`)
    }
    for (const chip of [dueChip, assigneeChip]) {
      if (!chip) continue
      if (interactive) {
        chip.setAttribute('role', 'button')
        chip.tabIndex = 0
        chip.classList.add('no-drag')
      } else {
        chip.removeAttribute('role')
        chip.removeAttribute('tabindex')
        chip.classList.remove('no-drag')
      }
    }
  }
}

function StaticTaskMeta({
  fragment,
  meta,
  root,
  onClose,
}: {
  fragment: Y.XmlFragment
  meta: StaticMeta
  root: { current: HTMLElement | null }
  onClose: (reason: TaskMetaCloseReason) => void
}) {
  const version = useYVersion(fragment)
  // Where the task is now (-1: deleted, by anyone). Re-read on every change of the text, which also
  // re-renders the due date and assignee shown below.
  const index = useMemo(() => taskIndexOf(fragment, meta.item), [fragment, meta.item, version])
  const indexRef = useRef(index)
  useLayoutEffect(() => {
    indexRef.current = index
  })
  const lastRect = useRef<DOMRect | null>(null)
  const anchor = useMemo<VirtualElement>(
    () => ({
      // The chip element is replaced whenever the HTML re-renders: find it again on every measure.
      getBoundingClientRect: () => {
        const li = root.current && indexRef.current >= 0 ? taskItems(root.current)[indexRef.current] : null
        const el = chipAt(root.current, indexRef.current, meta.kind) ?? li?.querySelector(':scope > .task-meta') ?? li
        if (el) lastRect.current = el.getBoundingClientRect()
        return lastRect.current ?? new DOMRect()
      },
      contextElement: root.current ?? undefined,
    }),
    [root, meta],
  )
  useEffect(() => {
    // The task went away (deleted by a teammate): nothing left to edit.
    if (index < 0) onClose('outside')
  }, [index, onClose])
  if (index < 0) return null
  return (
    <TaskMetaPopover
      mode={meta.kind}
      anchor={anchor}
      due={cleanDue(meta.item.getAttribute('due'))}
      assignee={cleanAssignee(meta.item.getAttribute('assignee'))}
      onChange={(patch) => setTaskElementAttr(meta.item, patch)}
      onClose={onClose}
    />
  )
}

// ---------------------------------------------------------------------------
// Live mode

interface KeyOptions {
  onExit: () => void
  onLink: () => boolean
  /** Escape for menus (an open dropdown or the link field). True when consumed. */
  onEscape: () => boolean
  /** Mod+Enter. True when consumed. */
  onCreateNext: () => boolean
  /** Alt+F10. True when a toolbar took focus. */
  onToolbarFocus: () => boolean
  /** Files pasted without text that could go in instead. */
  onPasteFiles: (files: File[]) => void
}

/** True for a drag carrying files (from the OS or a web page) rather than text. */
function draggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

const CardEditorKeys = Extension.create<KeyOptions>({
  name: 'cardEditorKeys',
  // Above the default (100): Mod-Enter must reach us before the hard-break shortcut.
  priority: 1000,
  addOptions() {
    return {
      onExit: () => {},
      onLink: () => false,
      onEscape: () => false,
      onCreateNext: () => false,
      onToolbarFocus: () => false,
      onPasteFiles: () => {},
    }
  },
  addKeyboardShortcuts() {
    return {
      Escape: () => {
        // An open style/color dropdown (focus stays in the text) closes first; only then the editor.
        if (this.options.onEscape()) return true
        this.options.onExit()
        return true
      },
      'Mod-k': () => this.options.onLink(),
      'Mod-Shift-x': () => this.editor.commands.toggleStrike(),
      'Mod-Enter': () => this.options.onCreateNext(),
      'Alt-F10': () => this.options.onToolbarFocus(),
      'Alt-Shift-ArrowUp': () => moveListItem('up')(this.editor.state, this.editor.view.dispatch),
      'Alt-Shift-ArrowDown': () => moveListItem('down')(this.editor.state, this.editor.view.dispatch),
    }
  },
  addProseMirrorPlugins() {
    const options = this.options
    return [
      new Plugin({
        key: new PluginKey('cardEditorLinkClick'),
        props: {
          // While editing, a plain click places the caret; Ctrl/Cmd-click follows the link.
          handleClick: (_view, _pos, event) => {
            if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false
            const link = (event.target as HTMLElement | null)?.closest?.('a')
            const href = link?.getAttribute('href') ?? ''
            const url = isSafeHref(href) ? href : normalizeLinkInput(href)
            if (!url) return false
            openExternal(url)
            return true
          },
          // Text has no place for files. Without this, ProseMirror leaves a file drop unhandled and
          // the browser opens the file in place of the app.
          handleDrop: (_view, event, slice, moved) => {
            if (moved || slice.content.size > 0 || !draggedFiles(event)) return false
            toast('Files can’t go inside text. Drop them on the board instead.', 'info', 5000)
            return true
          },
          handlePaste: (view, event) => {
            const data = event.clipboardData
            if (!data) return false
            // Clipboard data is only readable during the event: copy everything now.
            const files = Array.from(data.files ?? [])
            const text = data.getData('text/plain')
            const html = data.getData('text/html')
            if (files.length) {
              if (!isFilesOnlyPaste(files.length, text, html) || isOfficeCopy(files, text, html)) return false
              options.onPasteFiles(files)
              return true
            }
            return pasteMarkdown(view, text, html)
          },
        },
      }),
    ]
  },
})

/**
 * Plain text written in Markdown, pasted into open text, goes in formatted, as it does when pasted
 * on the board. Not with Ctrl+Shift+V (plain text, which ProseMirror then pastes itself) and not
 * into a code block.
 */
function pasteMarkdown(view: EditorView, text: string, html: string): boolean {
  if (isPlainTextPaste() || view.state.selection.$from.parent.type.spec.code) return false
  const doc = markdownPaste({ text, html })
  if (!doc) return false
  try {
    // Built with the static schema: the editor only accepts nodes of its own schema (same definitions).
    const content = Fragment.fromJSON(view.state.schema, doc.content.toJSON())
    // The first block goes in as it is; the last one stays open, so the text after the caret joins it.
    const slice = new Slice(content, 0, Slice.maxOpen(content).openEnd)
    view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'))
    return true
  } catch {
    return false
  }
}

/** Writes a task's due date / assignee through the editor, so the change joins the text history. */
function updateTaskNode(editor: Editor, pos: number, patch: TaskAttrPatch): boolean {
  if (editor.isDestroyed) return false
  return editor
    .chain()
    .command(({ tr }) => {
      const node = tr.doc.nodeAt(pos)
      if (!node || node.type.name !== 'taskItem') return false
      const attrs = { ...node.attrs }
      if (patch.due !== undefined) {
        const due = patch.due === null ? null : cleanDue(patch.due)
        if (patch.due !== null && !due) return false
        attrs.due = due
      }
      if (patch.assignee !== undefined) {
        const assignee = patch.assignee === null ? null : cleanAssignee(patch.assignee)
        if (patch.assignee !== null && !assignee) return false
        attrs.assignee = assignee
      }
      tr.setNodeMarkup(pos, undefined, attrs)
      return true
    })
    .run()
}

function LiveEditor(props: RichTextProps) {
  const { fragment, variant, placeholder, readOnly = false, autofocus = 'end' } = props
  const board = useContext(BoardContext)
  const awareness: Awareness | null = board?.awareness ?? null
  const onExitRef = useRef(props.onExit)
  const onEditorRef = useRef(props.onEditor)
  const onPasteFilesRef = useRef(props.onPasteFiles)
  const onCreateNextRef = useRef(props.onCreateNext)
  const cardIdRef = useRef(props.cardId)
  const readOnlyRef = useRef(readOnly)
  const [linkRequest, setLinkRequest] = useState(0)
  const [taskMeta, setTaskMeta] = useState<TaskMetaRequest | null>(null)
  const today = useToday()
  const member = useMemberLookup(board, variant !== 'caption')
  const memberRef = useRef(member)
  useLayoutEffect(() => {
    onExitRef.current = props.onExit
    onEditorRef.current = props.onEditor
    onPasteFilesRef.current = props.onPasteFiles
    onCreateNextRef.current = props.onCreateNext
    cardIdRef.current = props.cardId
    readOnlyRef.current = readOnly
    memberRef.current = member
  })
  // Bookkeeping per editor instance: React StrictMode (dev) builds a throwaway editor next to the
  // real one, and its lifecycle events must not touch the real one's state.
  const current = useRef<Editor | null>(null)
  const reported = useRef<Editor | null>(null)
  const guards = useRef(new WeakMap<Editor, () => void>())
  const menuEscape = useRef<(() => boolean) | null>(null)
  const menuFocus = useRef<(() => boolean) | null>(null)
  // Text edits go to the board history, so they can be undone after this editor closes.
  const undoManager = boardHistoryFor(board, fragment)

  const report = (editor: Editor) => {
    reported.current = editor
    onEditorRef.current?.(editor)
    useActiveEditor.getState().set(editor, variant, cardIdRef.current ?? null)
  }

  const extensions = useMemo(
    () => [
      ...buildExtensions({
        variant,
        placeholder,
        fragment,
        awareness,
        undoManager,
        user: getUser(),
        meId: getUser().id,
        // Captions get no due dates or assignees: nothing on the board would ever show or remind of them.
        onTaskMeta:
          variant === 'caption'
            ? null
            : (request) => {
                if (!readOnlyRef.current) setTaskMeta(request)
              },
        taskMember: (id) => memberRef.current(id),
      }),
      CardEditorKeys.configure({
        onExit: () => onExitRef.current?.(),
        onLink: () => {
          if (readOnlyRef.current) return false
          setLinkRequest((n) => n + 1)
          return true
        },
        onEscape: () => (menuEscape.current?.() ?? false) || runEditorEscape(),
        onCreateNext: () => (readOnlyRef.current ? false : (onCreateNextRef.current?.() ?? false)),
        onToolbarFocus: () => (menuFocus.current?.() ?? false) || focusDockedToolbar(),
        onPasteFiles: (files) => {
          const handler = onPasteFilesRef.current
          if (handler && !readOnlyRef.current) handler(files)
          else toast('Files can’t go inside text. Paste them on the board instead.', 'info', 5000)
        },
      }),
    ],
    [variant, placeholder, fragment, awareness, undoManager],
  )

  const editor = useEditor(
    {
      extensions,
      editable: !readOnly,
      editorProps: {
        attributes: {
          class: 'rich-text__content',
          'aria-label': ARIA_LABEL[variant],
          'aria-multiline': 'true',
          role: 'textbox',
          spellcheck: 'true',
        },
        // On the canvas the board must never be scrolled by the browser; the document view scrolls normally.
        handleScrollToSelection: variant === 'document' ? undefined : () => true,
      },
      onCreate: ({ editor }) => {
        if (editor.isDestroyed || editor !== current.current) return
        if (variant !== 'document' && !guards.current.has(editor)) {
          const remove = guardCanvasScroll(editor)
          if (remove) guards.current.set(editor, remove)
        }
        // Not cleared after use: React StrictMode mounts editors twice in development.
        const caret = pendingCaret && pendingCaret.fragment === fragment && Date.now() - pendingCaret.t < CARET_MEMORY_MS ? pendingCaret : null
        let target: number | 'start' | 'end' | null = autofocus || null
        const kept = keptSelection && keptSelection.fragment === fragment && Date.now() - keptSelection.t < CARET_MEMORY_MS ? keptSelection : null
        if (caret) {
          const hit = editor.view.posAtCoords({ left: caret.x, top: caret.y })
          if (hit) target = hit.pos
        } else if (kept && target !== null) {
          // The card was re-mounted while being edited (e.g. a teammate dragged it into a column):
          // continue where the caret was instead of jumping to the end.
          editor.commands.setTextSelection({ from: kept.anchor, to: kept.head })
          target = null
          editor.commands.focus(null, { scrollIntoView: variant === 'document' })
        }
        if (target !== null) editor.commands.focus(target, { scrollIntoView: variant === 'document' })
        report(editor)
      },
    },
    [extensions],
  )

  // Assigned during render: the editor's create event (a timeout after construction) may fire before commit.
  current.current = editor

  useEffect(() => {
    // Re-mounted (StrictMode) after the editor was already created: report it again.
    if (editor.isInitialized && !editor.isDestroyed && reported.current !== editor) report(editor)
    const map = guards.current
    return () => {
      map.get(editor)?.()
      map.delete(editor)
      useActiveEditor.getState().clear(editor)
      if (reported.current === editor) {
        reported.current = null
        onEditorRef.current?.(null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // A layout effect: its cleanup runs before EditorContent detaches the editor (which drops focus).
  useLayoutEffect(
    () => () => {
      if (!editor.isInitialized || editor.isDestroyed || !editor.view.hasFocus()) return
      const { anchor, head } = editor.state.selection
      keptSelection = { fragment, anchor, head, t: Date.now() }
    },
    [editor, fragment],
  )

  useEffect(() => {
    if (editor.isEditable === !readOnly) return
    editor.setEditable(!readOnly)
    // Task rows show their add buttons and active chips only while the text can be edited.
    if (editor.isInitialized && !editor.isDestroyed) refreshTaskViews(editor.view)
  }, [editor, readOnly])

  // Task chips show today's due state and members' names: refresh them when either changes.
  useEffect(() => {
    if (editor.isInitialized && !editor.isDestroyed) refreshTaskViews(editor.view)
  }, [editor, today, member])

  return (
    <>
      <EditorContent editor={editor} className="rich-text__editor" />
      {!readOnly && (
        <FormatMenu editor={editor} variant={variant} linkRequest={linkRequest} escapeRef={menuEscape} focusRef={menuFocus} />
      )}
      {!readOnly && board && <MentionSuggestions editor={editor} />}
      {!readOnly && board && taskMeta && <LiveTaskMeta editor={editor} fragment={fragment} request={taskMeta} onDone={() => setTaskMeta(null)} />}
    </>
  )
}

/**
 * The due date / assignee popover of a task in the live editor. The task is followed through its
 * shared element, not a document position: a teammate's change replaces the whole top-level list the
 * task sits in (position mapping then loses it), and tasks added or removed above shift positions.
 * The editor's document and the fragment are in step after every transaction, so the element's task
 * index in the fragment is also its index in the document.
 */
function LiveTaskMeta({
  editor,
  fragment,
  request,
  onDone,
}: {
  editor: Editor
  fragment: Y.XmlFragment
  request: TaskMetaRequest
  onDone: () => void
}) {
  const item = useMemo(() => findTaskItem(fragment, taskIndexAtPos(editor.state.doc, request.pos)), [editor, fragment, request])
  const pos = useRef<number | null>(request.pos)
  const [node, setNode] = useState(() => editor.state.doc.nodeAt(request.pos))
  const onDoneRef = useRef(onDone)
  useLayoutEffect(() => {
    onDoneRef.current = onDone
  })

  useEffect(() => {
    if (!item) {
      onDoneRef.current()
      return
    }
    const sync = () => {
      if (editor.isDestroyed) return
      const index = taskIndexOf(fragment, item)
      // Deleted, here or by a teammate: nothing left to edit.
      if (index < 0) {
        onDoneRef.current()
        return
      }
      const at = taskPosAtIndex(editor.state.doc, index)
      // Not in step (a change still being applied): keep what is shown until the next transaction.
      if (at === null || editor.state.doc.nodeAt(at)?.type.name !== 'taskItem') return
      pos.current = at
      setNode(editor.state.doc.nodeAt(at))
    }
    sync()
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) sync()
    }
    editor.on('transaction', onTransaction)
    return () => {
      editor.off('transaction', onTransaction)
    }
  }, [editor, fragment, item])

  const anchor = useMemo<VirtualElement>(() => {
    let last = request.anchor instanceof Element ? request.anchor.getBoundingClientRect() : request.anchor
    const chipClass = request.kind === 'due' ? '.task-chip--due' : '.task-chip--assignee'
    return {
      getBoundingClientRect: () => {
        const dom = !editor.isDestroyed && pos.current !== null ? editor.view.nodeDOM(pos.current) : null
        const meta = dom instanceof HTMLElement ? dom.querySelector(':scope > .task-meta') : null
        if (meta) {
          // The pressed button, while it is still on this task's row (an "add" button becomes a
          // chip, and a row can be re-rendered); else the row's chip, else the row's chip area.
          const pressed = request.anchor instanceof Element && meta.contains(request.anchor) ? request.anchor : null
          const el = pressed ?? meta.querySelector(`:scope > ${chipClass}`) ?? meta
          if (el.getClientRects().length) last = el.getBoundingClientRect()
        } else if (request.anchor instanceof Element && request.anchor.isConnected) last = request.anchor.getBoundingClientRect()
        return last
      },
      contextElement: editor.isDestroyed ? undefined : editor.view.dom,
    }
  }, [editor, request])

  if (!item || !node || node.type.name !== 'taskItem') return null
  return (
    <TaskMetaPopover
      mode={request.kind}
      anchor={anchor}
      due={cleanDue(node.attrs.due)}
      assignee={cleanAssignee(node.attrs.assignee)}
      onChange={(patch) => {
        const index = taskIndexOf(fragment, item)
        const at = index < 0 ? null : taskPosAtIndex(editor.state.doc, index)
        if (at !== null) updateTaskNode(editor, at, patch)
      }}
      onClose={(reason) => {
        onDone()
        if (reason !== 'outside') returnToText(editor)
      }}
    />
  )
}

/**
 * Typing near the edge of the visible board makes browsers scroll the nearest scroll container to
 * reveal the caret. The canvas positions everything with transforms, so any such scroll would
 * offset the whole board; undo it immediately.
 */
function guardCanvasScroll(editor: Editor): (() => void) | null {
  const canvas = editor.view.dom.closest('.canvas') as HTMLElement | null
  if (!canvas) return null
  const reset = () => {
    if (canvas.scrollTop) canvas.scrollTop = 0
    if (canvas.scrollLeft) canvas.scrollLeft = 0
  }
  canvas.addEventListener('scroll', reset)
  return () => canvas.removeEventListener('scroll', reset)
}
