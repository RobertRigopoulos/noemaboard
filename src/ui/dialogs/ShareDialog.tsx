/** Invite links, the people on this board, optional sync server, leaving a joined board. */
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import type * as Y from 'yjs'
import { Check, ChevronRight, CircleAlert, CircleCheck, Copy, Info, LoaderCircle, LogOut, MessageSquareText, Share } from 'lucide-react'
import { APP_NAME, HOME_BOARD_ID, PUBLIC_URL } from '../../config'
import type { BoardContextValue } from '../../board/BoardContext'
import { createInvite, leaveBoard } from '../../collab/boards'
import { docs } from '../../collab/docs'
import { useIdentity } from '../../collab/identity'
import { useLibrary } from '../../collab/library'
import { effectiveRelay, parseRelayUrl, setBoardRelay, testRelay, useBoardRelayStatus, type BoardRelayStatus } from '../../collab/relay'
import { openBoard } from '../../app/router'
import { getCards, isTrashed } from '../../model/board'
import { getMembers, readMembers, type Member } from '../../model/members'
import { useDialogs } from '../uiStore'
import { toast } from '../toast'
import { Avatar, safeColor } from '../header/Avatar'
import { usePeople } from '../header/AvatarStack'
import { useBoardMeta } from '../header/hooks'
import { useBoardTitle } from '../header/BoardTitle'
import { syncScope } from '../header/SyncStatus'
import { relativeTime } from '../panels/trashSummary'
import { copyText } from './clipboard'
import { Dialog } from './Dialog'
import { invitationText, mergePeople, PEOPLE_SHOWN, type PersonRow } from './people'

export const MAX_RELAY_URL = 2048

/** Empty (no server) or anything the relay client can parse (ws/wss/http/https or a bare host). */
export function validRelayUrl(v: string): boolean {
  return !v || !!parseRelayUrl(v)
}

export function ShareDialog({ ctx }: { ctx: BoardContextValue }) {
  const open = useDialogs((s) => s.dialog === 'share')
  const close = useDialogs((s) => s.close)
  const title = useBoardTitle(ctx)

  // Home is private to this device and cannot be shared.
  useEffect(() => {
    if (!open || !ctx.isHome) return
    close()
    toast('Home stays on this device. Open a board to share it.')
  }, [open, ctx.isHome, close])

  return (
    <Dialog open={open && !ctx.isHome} onClose={close} size="md" title={`Share “${title}”`}>
      <ShareBody ctx={ctx} title={title} onClose={close} />
    </Dialog>
  )
}

type Links = { web: string; desktop: string }

function ShareBody({ ctx, title, onClose }: { ctx: BoardContextValue; title: string; onClose: () => void }) {
  const entry = useLibrary((s) => s.entries[ctx.boardId])
  const entries = useLibrary((s) => s.entries)
  const meta = useBoardMeta(ctx.doc)
  const [links, setLinks] = useState<Links | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'web' | 'desktop' | 'text' | null>(null)
  const id = useId()
  const shared = !!entry?.shared || meta.shared
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const make = async (): Promise<Links | null> => {
    if (links) return links
    setCreating(true)
    setError(null)
    try {
      const res = await createInvite(ctx.boardId)
      if (!res) {
        setError("This board's key is missing on this device, so it can't be shared from here.")
        return null
      }
      const l = { web: res.web, desktop: res.desktop }
      setLinks(l)
      return l
    } catch {
      setError('The invite link could not be created. Please try again.')
      return null
    } finally {
      setCreating(false)
    }
  }

  // Boards that are already shared show their link right away (creating it changes nothing).
  useEffect(() => {
    if (shared) void make()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copy = async (which: 'web' | 'desktop' | 'text') => {
    const l = await make()
    if (!l) return
    const value = which === 'web' ? l.web : which === 'desktop' ? l.desktop : invitationText(APP_NAME, title, l.web)
    const ok = await copyText(value)
    if (ok) {
      setCopied(which)
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 2000)
      toast(which === 'web' ? 'Invite link copied' : which === 'desktop' ? 'Desktop app link copied' : 'Invitation copied', 'success')
    } else toast('Could not copy. Select the link and copy it manually.', 'error')
  }

  const share = async () => {
    const l = await make()
    if (!l) return
    try {
      // The link goes in the text: share targets accept it there whatever its scheme.
      await navigator.share({ title: `Join “${title}”`, text: invitationText(APP_NAME, title, l.web) })
    } catch (err) {
      if ((err as { name?: string } | null)?.name !== 'AbortError') toast('Sharing is not available here. Copy the invitation instead.', 'error')
    }
  }

  // Shared through a parent board: everyone in the parent can already open this one.
  const scope = useMemo(() => syncScope(ctx.boardId, entries), [ctx.boardId, entries])
  const parentScopeTitle = scope && scope !== ctx.boardId ? entries[scope]?.title || 'a parent board' : null

  return (
    <>
      <p className="dlg-text">
        Anyone with this link can view and edit this board and every board inside it. Boards sync directly between your teammates' devices —
        no account, no server, no limits.
      </p>

      {parentScopeTitle && (
        <div className="callout" style={{ marginBottom: 12 }}>
          <Info size={16} aria-hidden />
          <span>
            This board is inside “{parentScopeTitle}”, which is already shared. Everyone who has “{parentScopeTitle}” can open this board too.
          </span>
        </div>
      )}

      <div className="row">
        <input
          className="input"
          readOnly
          aria-label="Invite link"
          value={links?.web ?? ''}
          placeholder={creating ? 'Creating link…' : 'Click “Copy invite link” to create a link'}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className="btn btn--primary" onClick={() => void copy('web')} disabled={creating} data-autofocus>
          {creating ? <LoaderCircle size={14} className="spin" aria-hidden /> : copied === 'web' ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied === 'web' ? 'Copied' : 'Copy invite link'}
        </button>
      </div>
      {error && (
        <p className="field__error" role="alert" style={{ marginTop: 6 }}>
          {error}
        </p>
      )}
      {!PUBLIC_URL ? (
        <p className="dlg-small" style={{ marginTop: 8 }}>
          Teammates open this link in the {APP_NAME} desktop app (or paste it into Home → Join a board).
        </p>
      ) : (
        <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
          <span className="dlg-small">The link opens in any browser. Teammates with the desktop app can use the app link instead.</span>
          <button type="button" className="btn btn--ghost" onClick={() => void copy('desktop')} disabled={creating}>
            {copied === 'desktop' ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            Copy desktop app link
          </button>
        </div>
      )}
      <div className="row share-invite" style={{ marginTop: 8 }}>
        <button type="button" className="btn btn--ghost" onClick={() => void copy('text')} disabled={creating} title="A short message with the link, for chat or mail">
          {copied === 'text' ? <Check size={14} aria-hidden /> : <MessageSquareText size={14} aria-hidden />}
          {copied === 'text' ? 'Copied' : 'Copy invitation text'}
        </button>
        {canShare && (
          <button type="button" className="btn btn--ghost" onClick={() => void share()} disabled={creating}>
            <Share size={14} aria-hidden />
            Share…
          </button>
        )}
      </div>

      <People doc={ctx.doc} />

      <details className="disclosure">
        <summary>
          <ChevronRight size={14} aria-hidden />
          Advanced
        </summary>
        <div className="disclosure__body">
          <RelayField ctx={ctx} inputId={`${id}-relay`} />
          <LeaveBoard ctx={ctx} title={title} onClose={onClose} />
          <p className="dlg-small" style={{ marginTop: 14 }}>
            To remove someone's access, duplicate the board's contents into a new board and share the new one.
          </p>
        </div>
      </details>
    </>
  )
}

/** The board's member roster (validated), re-read whenever a teammate's entry changes. */
function useMembers(doc: Y.Doc): Member[] {
  const store = useMemo(() => {
    let snap = readMembers(doc)
    return {
      subscribe: (cb: () => void) => {
        const map = getMembers(doc)
        const h = () => {
          snap = readMembers(doc)
          cb()
        }
        map.observe(h)
        return () => map.unobserve(h)
      },
      get: () => snap,
    }
  }, [doc])
  return useSyncExternalStore(store.subscribe, store.get)
}

function People({ doc }: { doc: Y.Doc }) {
  const live = usePeople()
  const me = useIdentity((s) => s.user)
  const roster = useMembers(doc)
  const [showAll, setShowAll] = useState(false)
  const id = useId()
  const rows = useMemo(
    () =>
      mergePeople(
        roster,
        live.map((p) => ({ id: p.id, name: p.name, color: p.color, editing: p.editing })),
        { id: me.id, name: me.name, color: me.color },
      ),
    [roster, live, me.id, me.name, me.color],
  )
  const shown = showAll ? rows : rows.slice(0, PEOPLE_SHOWN)
  const others = rows.length - 1
  const now = Date.now()
  return (
    <section className="dlg-section" style={{ marginTop: 20 }} aria-labelledby={`${id}-people`}>
      <h3 className="dlg-section__title" id={`${id}-people`}>
        People on this board{others > 0 ? ` (${rows.length})` : ''}
      </h3>
      <ul className="people people--board">
        {shown.map((p) => (
          <PersonItem key={p.id} person={p} now={now} />
        ))}
      </ul>
      {rows.length > shown.length && (
        <button type="button" className="text-btn" style={{ marginTop: 4 }} onClick={() => setShowAll(true)}>
          Show all {rows.length} people
        </button>
      )}
      {others === 0 && (
        <p className="dlg-small" style={{ marginTop: 4 }}>
          Nobody else has opened this board yet. People appear here once they open it from your invitation.
        </p>
      )}
    </section>
  )
}

function PersonItem({ person: p, now }: { person: PersonRow; now: number }) {
  // Peer clocks are untrusted: a visit "in the future" reads as just now; this is display only.
  const status = p.online ? (p.editing ? 'editing now' : 'online now') : p.seenAt ? `last here ${relativeTime(Math.min(p.seenAt, now), now)}` : 'offline'
  return (
    <li className={p.online ? 'is-online' : undefined}>
      <span className="people__avatar">
        <Avatar name={p.name || '?'} color={safeColor(p.color)} size={26} />
        {p.online && <span className="people__dot" aria-hidden />}
      </span>
      <span className="people__name">
        {p.name || 'You'}
        {p.isMe && <span className="you"> (you)</span>}
      </span>
      <span className="people__status">{status}</span>
    </li>
  )
}

const RELAY_STATE_TEXT: Record<BoardRelayStatus['state'], string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  offline: 'Not reachable right now',
  error: 'Not working',
}

function RelayField({ ctx, inputId }: { ctx: BoardContextValue; inputId: string }) {
  const meta = useBoardMeta(ctx.doc)
  const entries = useLibrary((s) => s.entries)
  const status = useBoardRelayStatus(ctx.boardId)
  const saved = meta.relay ?? ''
  const [value, setValue] = useState(saved)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const trimmed = value.trim()
  const valid = validRelayUrl(trimmed)
  const inherited = !saved ? effectiveRelay(ctx.boardId, entries) : null

  // Follow changes made by teammates while the field is untouched.
  useEffect(() => setValue(saved), [saved])

  const save = async () => {
    if (ctx.readOnly || !valid || trimmed === saved) return
    const res = await setBoardRelay(ctx.boardId, trimmed || null)
    if (!res.ok) {
      setResult(res)
      return
    }
    setValue(res.url ?? '')
    toast(res.url ? 'Sync server saved for everyone on this board' : 'Sync server removed', 'success')
  }

  const test = async () => {
    if (!trimmed || !valid) return
    setTesting(true)
    setResult(null)
    try {
      setResult(await testRelay(trimmed))
    } catch {
      setResult({ ok: false, message: 'The server could not be reached.' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        Sync server (optional)
      </label>
      <span className="field__hint">
        A sync server keeps this board available when none of your teammates are online, and helps on networks that block direct
        connections. It only stores encrypted data it cannot read. Everyone on this board uses the same server.
      </span>
      <div className="row" style={{ marginTop: 4 }}>
        <input
          id={inputId}
          className="input"
          placeholder="wss://sync.example.com"
          value={value}
          maxLength={MAX_RELAY_URL}
          spellCheck={false}
          autoComplete="off"
          disabled={ctx.readOnly}
          aria-invalid={!valid}
          onChange={(e) => {
            setValue(e.target.value)
            setResult(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void save()
            }
          }}
        />
        <button type="button" className="btn" onClick={() => void test()} disabled={!trimmed || !valid || testing}>
          {testing && <LoaderCircle size={14} className="spin" aria-hidden />}
          Test
        </button>
        <button type="button" className="btn" onClick={() => void save()} disabled={ctx.readOnly || !valid || trimmed === saved}>
          {trimmed || !saved ? 'Save' : 'Remove'}
        </button>
      </div>
      {!valid && <span className="field__error">Enter a relay address such as wss://relay.example.com.</span>}
      {inherited && (
        <span className="field__hint">
          This board already syncs through the server set on a parent board ({parseRelayUrl(inherited)?.display ?? 'sync server'}). Set one here
          only to use a different server.
        </span>
      )}
      {status && !result && (
        <span className="field__hint" role="status">
          Status: {RELAY_STATE_TEXT[status.state]}
          {status.message ? ` — ${status.message.slice(0, 200)}` : ''}
          {status.pending ? ` (${status.pending} change${status.pending === 1 ? '' : 's'} waiting to upload)` : ''}
        </span>
      )}
      {result && (
        <div className={`callout ${result.ok ? 'callout--ok' : 'callout--error'}`} role="status" style={{ marginTop: 6 }}>
          {result.ok ? <CircleCheck size={16} aria-hidden /> : <CircleAlert size={16} aria-hidden />}
          <span>{result.message}</span>
        </div>
      )}
      <span className="field__hint">
        You can run your own sync server with Node or Docker — see <code>docs/RELAY.md</code> in the {APP_NAME} source code.
      </span>
    </div>
  )
}

function LeaveBoard({ ctx, title, onClose }: { ctx: BoardContextValue; title: string; onClose: () => void }) {
  const entry = useLibrary((s) => s.entries[ctx.boardId])
  const meta = useBoardMeta(ctx.doc)
  const me = useIdentity((s) => s.user.id)
  const [onHome, setOnHome] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [leaving, setLeaving] = useState(false)

  // Only boards joined through an invite and sitting on Home can be left.
  const joined = !!entry?.shared && entry.parentId === HOME_BOARD_ID && meta.createdBy !== me

  useEffect(() => {
    if (!joined) return
    let cancelled = false
    void docs.withDoc(HOME_BOARD_ID, (home) => {
      let found = false
      getCards(home).forEach((m) => {
        if (!isTrashed(m) && m.get('type') === 'board' && m.get('boardId') === ctx.boardId) found = true
      })
      if (!cancelled) setOnHome(found)
    })
    return () => {
      cancelled = true
    }
  }, [joined, ctx.boardId])

  if (!joined || !onHome) return null

  const leave = () => {
    setLeaving(true)
    const boardId = ctx.boardId
    onClose()
    // Leave the board's screen first: its local copy is deleted afterwards. Replace (not push) the
    // history entry so Back does not lead to a board that is no longer on this device.
    openBoard(HOME_BOARD_ID, true)
    setTimeout(() => {
      leaveBoard(boardId)
        .then(() => toast(`You left “${title}”. Your teammates still have it.`, 'success'))
        .catch(() => toast('Could not remove the board from this device.', 'error'))
    }, 200)
  }

  return (
    <div className="dlg-section" style={{ marginTop: 18 }}>
      <h3 className="dlg-section__title">Leave board</h3>
      {!confirming ? (
        <>
          <p className="dlg-text">Remove this board from this device. Your teammates keep their copies, and you can rejoin with an invite link.</p>
          <button type="button" className="btn btn--danger" onClick={() => setConfirming(true)}>
            <LogOut size={14} aria-hidden />
            Leave board…
          </button>
        </>
      ) : (
        <div className="callout callout--warn" role="alert">
          <CircleAlert size={16} aria-hidden />
          <div>
            <p style={{ margin: '0 0 8px' }}>
              Leave “{title}”? It will be deleted from this device, including any changes that have not synced to a teammate yet.
            </p>
            <div className="row">
              <button type="button" className="btn" onClick={() => setConfirming(false)} data-autofocus>
                Cancel
              </button>
              <button type="button" className="btn btn--danger" onClick={leave} disabled={leaving}>
                Leave board
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
