/**
 * Comment card: a discussion thread (Y.Array<Y.Map> field 'thread') with a reply composer,
 * @mentions, edit/delete of your own messages, resolve/reopen and collapse. Message text is plain
 * text (never HTML); links are detected and opened outside the app.
 *
 * The same body renders comments pinned to a card, inside the pin popover (variant 'popover').
 */
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Copy,
  Ellipsis,
  Maximize2,
  MessageSquare,
  Minimize2,
  Pencil,
  PinOff,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import type * as Y from 'yjs'
import type { CardProps } from '../types'
import type { CommentCard as CommentData } from '../../model/types'
import { deleteCards, getCardMap, isTrashed, updateCard } from '../../model/board'
import { getMembers, mentionCandidates, readMembers } from '../../model/members'
import { useBoard, useYVersion, type BoardContextValue } from '../../board/BoardContext'
import { stopUndoCapturing } from '../../board/actions'
import { getUser, useIdentity } from '../../collab/identity'
import { sanitizePresence } from '../../collab/presence'
import { openExternal } from '../../lib/desktop'
import { toast } from '../../ui/toast'
import { avatarInitials, commentCountLabel } from './helpers'
import { linkify, type MentionName } from './linkify'
import {
  addComment,
  COMMENT_MAX,
  deleteComment,
  editComment,
  foldThread,
  getThread,
  readThread,
  threadToText,
  type MentionRef,
  type ThreadMessage,
} from './thread'
import { formatFullDate, formatRelativeTime, refreshNow, useNow } from './time'
import { clearDraft, draftKey, editDraftKey, getDraft, hasUnsentText, setDraft, subscribeDraft, type CommentDraft } from './commentDrafts'
import { useMentionPicker, type MentionPerson } from './MentionPicker'
import { isCollapsedThread } from './attach'
import { useDiscardIfLeftEmpty } from '../text/discardEmpty'
import './actions'
import './comment.css'

const COMPOSER_MAX_HEIGHT = 200
const COUNTER_FROM = COMMENT_MAX - 500
const UNSENT_TOAST_MS = 8000
const EMPTY_DRAFT: CommentDraft = { text: '', mentions: [] }

/** Text fields inside the card handle their own pointer, double-click and context-menu events. */
const keepInside = {
  onPointerDown: (e: SyntheticEvent) => e.stopPropagation(),
  onDoubleClick: (e: SyntheticEvent) => e.stopPropagation(),
  onContextMenu: (e: SyntheticEvent) => e.stopPropagation(),
}

function isoDate(ts: number): string | undefined {
  try {
    return ts > 0 ? new Date(ts).toISOString() : undefined
  } catch {
    return undefined
  }
}

/** Grows a textarea with its content up to a maximum height, then scrolls. */
function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, max = COMPOSER_MAX_HEIGHT) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [ref, value, max])
}

/** Enter sends, Shift+Enter inserts a newline; IME composition is never interrupted. */
function isSendKey(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing
}

/** A draft from the module store (survives re-mounts); undefined when there is none. */
function useDraftEntry(key: string): CommentDraft | undefined {
  return useSyncExternalStore(
    (cb) => subscribeDraft(key, cb),
    () => getDraft(key),
  )
}

/** Sends a thread's unsent draft (from the 'Comment not sent' toast). */
export function sendDraft(doc: Y.Doc, cardId: string, key: string): boolean {
  const d = getDraft(key)
  if (!d?.text.trim()) return false
  const map = doc.isDestroyed ? undefined : getCardMap(doc, cardId)
  if (!map || map.get('type') !== 'comment' || isTrashed(map)) {
    toast('The comment could not be sent: its thread was deleted.', 'error')
    return false
  }
  stopUndoCapturing(doc)
  if (!addComment(doc, map, getUser(), d.text, Date.now(), d.mentions)) return false
  clearDraft(key)
  refreshNow()
  return true
}

/** Reminds about a draft left behind when its thread was deselected or its popover closed. */
export function remindUnsent(doc: Y.Doc, cardId: string, key: string) {
  if (!hasUnsentText(key)) return
  toast('Comment not sent', 'info', UNSENT_TOAST_MS, { label: 'Send', run: () => void sendDraft(doc, cardId, key) })
}

/** People who can be mentioned on this board right now (everyone but the current user). */
export function mentionPeople(board: BoardContextValue, messages: readonly ThreadMessage[], meId: string): MentionPerson[] {
  const extra: { id: string; name: string; color: string }[] = []
  board.awareness.getStates().forEach((state, clientId) => {
    if (clientId === board.awareness.clientID) return
    const p = sanitizePresence(state)
    if (p) extra.push({ id: p.user.id, name: p.user.name, color: p.user.color })
  })
  for (const m of messages) extra.push({ id: m.authorId, name: m.authorName, color: m.authorColor })
  return mentionCandidates(board.doc, extra, meId).filter((p) => p.id !== meId)
}

/** Name lookup for mention chips: the roster, then thread authors, then the current user. */
function useMentionNames(doc: Y.Doc, messages: readonly ThreadMessage[]): (id: string) => string | undefined {
  const membersVersion = useYVersion(getMembers(doc))
  const me = useIdentity((s) => s.user)
  return useMemo(() => {
    const names = new Map<string, string>()
    for (const m of readMembers(doc)) names.set(m.id, m.name)
    for (const msg of messages) if (msg.authorId && !names.has(msg.authorId)) names.set(msg.authorId, msg.authorName)
    if (me.name && !names.has(me.id)) names.set(me.id, me.name)
    return (id: string) => names.get(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, messages, membersVersion, me])
}

export function CommentCard(props: CardProps<CommentData>) {
  return <CommentThread {...props} variant="card" />
}

interface ThreadProps extends CardProps<CommentData> {
  /** 'card': a comment card on the board. 'popover': the thread of a pin, opened from its marker. */
  variant: 'card' | 'popover'
  /** Popover only: unpin the thread from its card. */
  onDetach?: () => void
  /** Popover only: close the popover (after the thread was deleted). */
  onClose?: () => void
}

export function CommentThread({ id, map, card, selected, editing, readOnly, startEditing, stopEditing, variant, onDetach, onClose }: ThreadProps) {
  const board = useBoard()
  const { doc, boardId } = board
  const myId = useIdentity((s) => s.user.id)
  const thread = getThread(map)
  const version = useYVersion(thread)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => readThread(thread), [thread, version])
  const now = useNow()
  const nameOf = useMentionNames(doc, messages)

  const key = draftKey(boardId, id)
  const draft = useDraftEntry(key) ?? EMPTY_DRAFT
  const writeDraft = (d: CommentDraft) => (d.text || d.mentions.length ? setDraft(key, d) : clearDraft(key))

  const popover = variant === 'popover'
  const resolved = card.resolved === true
  const [showResolved, setShowResolved] = useState(false)
  const [showAll, setShowAll] = useState(false)
  // Read-only viewers can look into a collapsed thread without changing the shared doc.
  const [peek, setPeek] = useState(false)
  const [editingMsg, setEditingMsg] = useState<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // A comment card made by accident and left without a message (or a draft) goes away again. Pins
  // handle this when their popover closes.
  useDiscardIfLeftEmpty(id, card, editing, readOnly || popover, () => messages.length === 0 && !hasUnsentText(key))

  const canWrite = !readOnly
  const collapsed = !popover && isCollapsedThread(card) && !editing && !peek
  const expanded = popover || !resolved || showResolved || (editing && messages.length > 0)
  const showComposer = canWrite && !resolved && (popover || selected || editing || messages.length === 0 || draft.text.length > 0)

  // Entering edit mode (new card from the toolbar, Enter, second click, a new pin) focuses the composer.
  useEffect(() => {
    if (editing && !editingMsg) composerRef.current?.focus({ preventScroll: true })
  }, [editing]) // eslint-disable-line react-hooks/exhaustive-deps

  // Collapse again once a reopened thread is resolved anew.
  useEffect(() => {
    if (!resolved) setShowResolved(false)
  }, [resolved])

  useEffect(() => {
    if (!isCollapsedThread(card)) setPeek(false)
  }, [card])

  // A message being edited may be deleted by its author on another device.
  useEffect(() => {
    if (editingMsg && !messages.some((m) => m.id === editingMsg)) setEditingMsg(null)
  }, [editingMsg, messages])

  // Deselecting a thread with an unsent reply: offer to send it.
  const wasSelected = useRef(selected)
  useEffect(() => {
    const was = wasSelected.current
    wasSelected.current = selected
    if (!popover && was && !selected && canWrite) remindUnsent(doc, id, key)
  }, [selected, popover, canWrite, doc, id, key])

  useAutoGrow(composerRef, draft.text)

  const people = () => mentionPeople(board, messages, myId)
  const picker = useMentionPicker({
    textareaRef: composerRef,
    text: draft.text,
    people,
    onInsert: (text, _caret, p) => writeDraft({ text, mentions: [...draft.mentions, { id: p.id, name: p.name }] }),
  })

  const send = () => {
    if (!canWrite) return
    stopUndoCapturing(doc)
    if (!addComment(doc, map, getUser(), draft.text, Date.now(), draft.mentions)) return
    clearDraft(key)
    refreshNow()
    composerRef.current?.focus({ preventScroll: true })
  }

  const toggleResolved = () => {
    if (!canWrite) return
    const next = !resolved
    board.undo.stopCapturing()
    updateCard(doc, id, { resolved: next }, getUser().id)
    if (next) {
      setShowResolved(false)
      if (!popover) stopEditing()
    }
  }

  const setCollapsed = (next: boolean) => {
    if (!canWrite) {
      setPeek(!next)
      return
    }
    if (next) stopEditing()
    board.undo.stopCapturing()
    updateCard(doc, id, { collapsed: next }, getUser().id)
    board.undo.stopCapturing()
  }

  if (resolved && !expanded) {
    const first = messages[0]
    return (
      <div className="cmt cmt--pill">
        <button
          type="button"
          className="cmt-pill"
          aria-expanded={false}
          aria-label={`Resolved thread, ${commentCountLabel(messages.length)}. Show thread`}
          onClick={() => setShowResolved(true)}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <CircleCheck size={15} className="cmt-pill__icon" aria-hidden />
          <span className="cmt-pill__label">Resolved</span>
          <span className="cmt-pill__count">{messages.length}</span>
          {first && <span className="cmt-pill__snippet">{first.text}</span>}
          <ChevronDown size={14} className="cmt-pill__chevron" aria-hidden />
        </button>
      </div>
    )
  }

  if (collapsed) return <CollapsedPill messages={messages} onExpand={() => setCollapsed(false)} />

  const folded = showAll || popover ? { head: messages, hidden: 0, tail: [] as ThreadMessage[] } : foldThread(messages)

  const renderMessage = (m: ThreadMessage) => (
    <CommentItem
      key={m.id}
      message={m}
      now={now}
      meId={myId}
      nameOf={nameOf}
      own={canWrite && m.authorId === myId}
      editing={editingMsg === m.id}
      draftKey={editDraftKey(boardId, id, m.id)}
      people={people}
      onStartEdit={() => {
        setEditingMsg(m.id)
        if (!editing) startEditing()
      }}
      onCancelEdit={() => {
        clearDraft(editDraftKey(boardId, id, m.id))
        setEditingMsg(null)
      }}
      onSave={(d) => {
        board.undo.stopCapturing()
        if (editComment(doc, map, m.id, getUser().id, d.text, Date.now(), d.mentions)) {
          clearDraft(editDraftKey(boardId, id, m.id))
          setEditingMsg(null)
        }
      }}
      onDelete={() => {
        board.undo.stopCapturing()
        deleteComment(doc, map, m.id, getUser().id)
      }}
    />
  )

  const listId = `cmt-list-${id}`

  return (
    <div className={`cmt${resolved ? ' is-resolved' : ''}${popover ? ' cmt--popover' : ''}`} role="group" aria-label="Comment thread">
      {(messages.length > 0 || popover) && (
        <div className="cmt__bar">
          <span className="cmt__count">
            <MessageSquare size={13} aria-hidden />
            {messages.length ? commentCountLabel(messages.length) : 'New comment'}
          </span>
          {popover && canWrite && onDetach && (
            <button type="button" className="cmt__bar-btn" onClick={onDetach} title="Detach from the card" {...keepInside}>
              <PinOff size={13} aria-hidden />
              Detach
            </button>
          )}
          {resolved ? (
            <>
              {!popover && (
                <span className="cmt__resolved-tag">
                  <CircleCheck size={13} aria-hidden />
                  Resolved
                </span>
              )}
              {canWrite && (
                <button type="button" className="cmt__bar-btn" onClick={toggleResolved} title="Reopen thread" {...keepInside}>
                  <RotateCcw size={13} aria-hidden />
                  Reopen
                </button>
              )}
              {!popover && (
                <button
                  type="button"
                  className="cmt__icon-btn"
                  aria-label="Collapse resolved thread"
                  title="Collapse"
                  onClick={() => {
                    setShowResolved(false)
                    stopEditing()
                  }}
                  {...keepInside}
                >
                  <ChevronUp size={15} aria-hidden />
                </button>
              )}
            </>
          ) : (
            <>
              {canWrite && messages.length > 0 && (
                <button
                  type="button"
                  className={`cmt__bar-btn${popover ? '' : ' cmt__resolve'}`}
                  onClick={toggleResolved}
                  title="Resolve thread"
                  {...keepInside}
                >
                  <Check size={13} aria-hidden />
                  Resolve
                </button>
              )}
              {!popover && messages.length > 0 && (
                <button
                  type="button"
                  className="cmt__icon-btn cmt__collapse"
                  aria-label="Collapse thread"
                  title="Collapse"
                  onClick={() => setCollapsed(true)}
                  {...keepInside}
                >
                  <Minimize2 size={14} aria-hidden />
                </button>
              )}
            </>
          )}
          {popover && <ThreadMenu canWrite={canWrite} messages={messages} onDelete={() => deleteThread(board, id, onClose)} />}
        </div>
      )}

      {messages.length > 0 && (
        <ol className={`cmt__list${popover ? ' scrollable' : ''}`} id={listId}>
          {folded.head.map(renderMessage)}
          {folded.hidden > 0 && (
            <li className="cmt__more">
              <button type="button" className="cmt__more-btn" onClick={() => setShowAll(true)} {...keepInside}>
                Show {folded.hidden} more {folded.hidden === 1 ? 'reply' : 'replies'}
              </button>
            </li>
          )}
          {folded.tail.map(renderMessage)}
        </ol>
      )}

      {messages.length === 0 && !showComposer && <div className="cmt__empty">No comments yet</div>}

      {showComposer && (
        <div className={`cmt-composer no-drag${messages.length ? '' : ' is-first'}`} {...keepInside}>
          <textarea
            ref={composerRef}
            className="cmt-composer__input scrollable"
            rows={1}
            value={draft.text}
            maxLength={COMMENT_MAX}
            placeholder={messages.length ? 'Reply… (@ to mention)' : 'Write a comment… (@ to mention)'}
            aria-label={messages.length ? 'Reply to thread' : 'Write a comment'}
            {...picker.inputProps}
            onChange={(e) => writeDraft({ text: e.target.value.slice(0, COMMENT_MAX), mentions: draft.mentions })}
            onFocus={() => {
              if (!editing) startEditing()
            }}
            onKeyDown={(e) => {
              if (picker.onKeyDown(e)) return
              if (isSendKey(e)) {
                e.preventDefault()
                send()
              }
            }}
          />
          {picker.picker}
          {draft.text.length > COUNTER_FROM && (
            <span className="cmt-composer__counter" aria-live="polite">
              {draft.text.length}/{COMMENT_MAX}
            </span>
          )}
          <button
            type="button"
            className="cmt-composer__send"
            aria-label="Send comment"
            title="Send (Enter)"
            disabled={!draft.text.trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={send}
          >
            <ArrowUp size={15} aria-hidden />
          </button>
        </div>
      )}
    </div>
  )
}

function deleteThread(board: BoardContextValue, id: string, onClose?: () => void) {
  board.undo.stopCapturing()
  deleteCards(board.doc, [id], getUser().id)
  board.undo.stopCapturing()
  onClose?.()
}

/** A free thread folded to a pill: who took part, how many messages, and how it starts. */
function CollapsedPill({ messages, onExpand }: { messages: readonly ThreadMessage[]; onExpand: () => void }) {
  const authors = useMemo(() => {
    const seen = new Map<string, { name: string; color: string }>()
    for (const m of messages) if (!seen.has(m.authorId)) seen.set(m.authorId, { name: m.authorName, color: m.authorColor })
    return Array.from(seen.values())
  }, [messages])
  const first = messages[0]
  return (
    <div className="cmt cmt--pill">
      <button
        type="button"
        className="cmt-pill cmt-pill--collapsed"
        aria-expanded={false}
        aria-label={`Collapsed thread, ${commentCountLabel(messages.length)}. Expand`}
        onClick={onExpand}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <span className="cmt-pill__avatars" aria-hidden>
          {authors.slice(0, 3).map((a, i) => (
            <span key={i} className="cmt-pill__avatar" style={{ background: a.color }}>
              {avatarInitials(a.name)}
            </span>
          ))}
          {!authors.length && <MessageSquare size={14} />}
        </span>
        <span className="cmt-pill__count">{messages.length}</span>
        {first && <span className="cmt-pill__snippet">{first.text}</span>}
        <Maximize2 size={13} className="cmt-pill__chevron" aria-hidden />
      </button>
    </div>
  )
}

/** The popover's 'More' menu: copy the thread as text, delete it. */
function ThreadMenu({ canWrite, messages, onDelete }: { canWrite: boolean; messages: readonly ThreadMessage[]; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) {
      setConfirm(false)
      return
    }
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(threadToText(messages))
      toast('Thread copied')
    } catch {
      toast('Could not copy the thread', 'error')
    }
    close()
  }

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = items.length
      if (n) items[(i + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n].focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
      }
      close(e.key === 'Escape')
    }
  }

  return (
    <span className="cmt-menu-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="cmt__icon-btn"
        aria-label="More thread actions"
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        {...keepInside}
      >
        <Ellipsis size={15} aria-hidden />
      </button>
      {open && (
        <div ref={menuRef} id={menuId} className="cmt-menu" role="menu" aria-label="Thread actions" onKeyDown={onMenuKey} {...keepInside}>
          <button type="button" role="menuitem" className="cmt-menu__item" tabIndex={-1} onClick={() => void copy()} disabled={!messages.length}>
            <Copy size={14} aria-hidden />
            Copy thread text
          </button>
          {canWrite && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="cmt-menu__item cmt-menu__item--danger"
              onClick={() => {
                if (!confirm) {
                  setConfirm(true)
                  return
                }
                setOpen(false)
                onDelete()
              }}
            >
              <Trash2 size={14} aria-hidden />
              {confirm ? 'Click again to delete' : 'Delete thread'}
            </button>
          )}
        </div>
      )}
    </span>
  )
}

interface ItemProps {
  message: ThreadMessage
  now: number
  meId: string
  nameOf: (id: string) => string | undefined
  own: boolean
  editing: boolean
  draftKey: string
  people: () => readonly MentionPerson[]
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: (draft: CommentDraft) => void
  onDelete: () => void
}

function CommentItem({ message: m, now, meId, nameOf, own, editing, draftKey: editKey, people, onStartEdit, onCancelEdit, onSave, onDelete }: ItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!confirmDelete) return
    const t = setTimeout(() => setConfirmDelete(false), 3000)
    return () => clearTimeout(t)
  }, [confirmDelete])

  const mentions = useMemo(() => {
    const out: MentionName[] = []
    for (const id of m.mentions) {
      const name = nameOf(id)
      if (name) out.push({ id, name })
    }
    return out
  }, [m.mentions, nameOf])

  const relative = formatRelativeTime(m.createdAt, now)
  return (
    <li className={`cmt-msg${editing ? ' is-editing' : ''}`}>
      <span className="cmt-msg__avatar" style={{ background: m.authorColor }} aria-hidden>
        {avatarInitials(m.authorName)}
      </span>
      <div className="cmt-msg__main">
        <div className="cmt-msg__head">
          <span className="cmt-msg__name" title={m.authorName}>
            {m.authorName}
          </span>
          {relative && (
            <time className="cmt-msg__time" dateTime={isoDate(m.createdAt)} title={formatFullDate(m.createdAt)}>
              {relative}
            </time>
          )}
          {m.editedAt && (
            <span className="cmt-msg__edited" title={`Edited ${formatFullDate(m.editedAt)}`}>
              (edited)
            </span>
          )}
          {own && !editing && (
            <span className="cmt-msg__actions">
              <button type="button" className="cmt__icon-btn" aria-label="Edit comment" title="Edit" onClick={onStartEdit} {...keepInside}>
                <Pencil size={13} aria-hidden />
              </button>
              <button
                type="button"
                className={`cmt__icon-btn${confirmDelete ? ' is-danger' : ''}`}
                aria-label={confirmDelete ? 'Click again to delete comment' : 'Delete comment'}
                title={confirmDelete ? 'Click again to delete' : 'Delete'}
                onClick={() => {
                  if (confirmDelete) onDelete()
                  else setConfirmDelete(true)
                }}
                {...keepInside}
              >
                <Trash2 size={13} aria-hidden />
              </button>
            </span>
          )}
        </div>
        {editing ? (
          <MessageEditor
            draftKey={editKey}
            initial={{ text: m.text, mentions: m.mentions.map((id): MentionRef => ({ id, name: nameOf(id) })) }}
            people={people}
            onSave={onSave}
            onCancel={onCancelEdit}
          />
        ) : (
          <div className="cmt-msg__text">
            <LinkifiedText text={m.text} mentions={mentions} meId={meId} />
          </div>
        )}
      </div>
    </li>
  )
}

function MessageEditor({
  draftKey: key,
  initial,
  people,
  onSave,
  onCancel,
}: {
  draftKey: string
  initial: CommentDraft
  people: () => readonly MentionPerson[]
  onSave: (draft: CommentDraft) => void
  onCancel: () => void
}) {
  // The edit survives the card re-mounting; until the first keystroke it is the message itself.
  const stored = useDraftEntry(key)
  const value = stored ?? initial
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(ref, value.text)

  const picker = useMentionPicker({
    textareaRef: ref,
    text: value.text,
    people,
    onInsert: (text, _caret, p) => setDraft(key, { text, mentions: [...value.mentions, { id: p.id, name: p.name }] }),
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const save = () => {
    if (value.text.trim()) onSave(value)
  }

  return (
    <div className="cmt-edit no-drag" {...keepInside}>
      <textarea
        ref={ref}
        className="cmt-edit__input scrollable"
        rows={1}
        value={value.text}
        maxLength={COMMENT_MAX}
        aria-label="Edit comment"
        {...picker.inputProps}
        onChange={(e) => setDraft(key, { text: e.target.value.slice(0, COMMENT_MAX), mentions: value.mentions })}
        onKeyDown={(e) => {
          if (picker.onKeyDown(e)) return
          if (e.key === 'Escape') {
            // Cancel just this edit; the card stays in edit mode.
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          } else if (isSendKey(e)) {
            e.preventDefault()
            save()
          }
        }}
      />
      {picker.picker}
      <div className="cmt-edit__actions">
        <button type="button" className="cmt-edit__btn" onMouseDown={(e) => e.preventDefault()} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="cmt-edit__btn cmt-edit__btn--primary"
          disabled={!value.text.trim()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={save}
        >
          Save
        </button>
      </div>
    </div>
  )
}

function LinkifiedText({ text, mentions, meId }: { text: string; mentions: readonly MentionName[]; meId: string }) {
  const segments = useMemo(() => linkify(text, mentions), [text, mentions])
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'text' ? (
          <Fragment key={i}>{s.text}</Fragment>
        ) : s.kind === 'mention' ? (
          <span key={i} className={`cmt-mention-chip${s.id === meId ? ' is-me' : ''}`} title={s.id === meId ? 'Mentions you' : undefined}>
            {s.text}
          </span>
        ) : (
          <a
            key={i}
            className="cmt-link"
            href={s.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title={s.href}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              openExternal(s.href)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {s.text}
          </a>
        ),
      )}
    </>
  )
}
