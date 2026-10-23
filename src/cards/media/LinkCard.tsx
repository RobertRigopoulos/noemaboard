import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import * as Y from 'yjs'
import { Globe, Link2, Play, TriangleAlert } from 'lucide-react'
import type { CardProps } from '../types'
import type { LinkCard as LinkCardData } from '../../model/types'
import { useBoard } from '../../board/BoardContext'
import { getCards, updateCard } from '../../model/board'
import { useBlobUrl } from '../../collab/blobs'
import { isValidBlobHash } from '../../collab/crypto'
import { getUser } from '../../collab/identity'
import { desktop, openExternal } from '../../lib/desktop'
import { asText } from './format'
import { hostLabel, MAX_URL_LENGTH, normalizeUrl } from './url'
import { detectEmbed, EMBED_LABELS, playerSrc, sanitizeEmbed, type Embed } from './embed'
import { isLoadingStale, isPreviewStale, loadingSince, STALE_LOADING_MS } from './previewPolicy'
import { hasPreviewClaim } from './previewClaims'
import { maybeFetchPreview, requestPreview, retryPreview } from './preview'
import { linkFields } from './create'
import { Caption, fragmentHasText, stopPointer } from './common'
import { linkParts, readLinkDisplay, type LinkDisplay } from './linkDisplay'
import { readCaptionHidden } from './captionState'
import { useCaptionFocus } from './lightboxStore'
import { discardEmptyCard } from '../text/discardEmpty'
import './actions'
import './media.css'

/** Extra fields used by the preview fetch (see previewPolicy). */
type LinkData = LinkCardData & { previewBy?: unknown; previewFor?: unknown; previewStartedAt?: unknown }

/** Link card: preview (image, title, description, site) or a click-to-load embed, plus a caption. */
export function LinkCard({ id, card, map, editing, readOnly, startEditing, stopEditing }: CardProps<LinkData>) {
  const { doc, boardId, undo } = useBoard()
  const rawUrl = asText(card.url, MAX_URL_LENGTH)
  const url = useMemo(() => normalizeUrl(rawUrl), [rawUrl])
  const embedField = card.embed
  const embed = useMemo(() => (url ? (sanitizeEmbed(embedField) ?? detectEmbed(url)) : null), [url, embedField])
  // Editing a link ('Edit link', Enter, double-click) is about its address; 'Add caption' asks for the caption.
  const captionFirst = useCaptionFocus((s) => s.cardId === id)

  // The device that asked for the preview fetches it; everyone else just renders what it writes.
  useEffect(() => {
    if (!readOnly && rawUrl) maybeFetchPreview(doc, id)
  }, [doc, id, readOnly, rawUrl, card.previewState, card.previewBy, card.previewFor])

  // Leaving edit mode on a link that never got a URL removes it (like cancelling).
  const wasEditing = useRef(editing)
  useEffect(() => {
    const was = wasEditing.current
    wasEditing.current = editing
    if (!was || editing || readOnly) return
    const m = getCards(doc).get(id)
    if (!m) return
    const u = m.get('url')
    const caption = m.get('caption')
    const hasCaption = caption instanceof Y.XmlFragment && fragmentHasText(caption)
    // Undone and forgotten when the newest undo step is its creation, so Ctrl+Z does not bring it back.
    if ((typeof u !== 'string' || !u.trim()) && !hasCaption) discardEmptyCard(doc, undo, id, getUser().id)
  }, [editing, readOnly, doc, undo, id])

  const applyUrl = (next: string) => {
    if (readOnly) return
    const current = getCards(doc).get(id)?.get('url')
    if (next === current) return
    const me = getUser().id
    updateCard(doc, id, linkFields(next, me), me)
    requestPreview(doc, id)
  }

  if (!rawUrl) {
    return (
      <div className="link-card link-card--empty">
        {editing && !readOnly ? (
          <UrlField initial="" autoFocus onCommit={applyUrl} onDone={stopEditing} />
        ) : (
          <div className="link-card__placeholder">
            <Link2 size={16} aria-hidden />
            {readOnly ? (
              <span>Empty link</span>
            ) : (
              <button type="button" className="link-card__add" onPointerDown={stopPointer} onClick={startEditing}>
                Add a link
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const display = readLinkDisplay(card)
  // Everything but the title hidden: a compact row, handy for lists of links.
  const compact = display.hideImage && display.hideDescription && display.hideUrl
  return (
    <div className={`link-card${embed ? ' has-embed' : ''}${editing ? ' is-editing' : ''}${compact ? ' is-compact' : ''}`}>
      {editing && !readOnly && (
        <div className="link-card__url">
          <UrlField initial={rawUrl} autoFocus={!captionFirst} onCommit={applyUrl} onDone={stopEditing} />
        </div>
      )}
      <LinkPreview
        id={id}
        card={card}
        url={url}
        rawUrl={rawUrl}
        embed={embed}
        display={display}
        boardId={boardId}
        readOnly={readOnly}
        onRetry={() => retryPreview(doc, id)}
      />
      <Caption
        cardId={id}
        map={map}
        editing={editing}
        readOnly={readOnly}
        hidden={readCaptionHidden(card)}
        autofocus={captionFirst ? 'end' : false}
        onExit={stopEditing}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Display

/** Re-renders once a 'loading' preview has been loading for too long (its fetcher went away). */
function useLoadingTimeout(card: LinkData): boolean {
  const loading = card.previewState === 'loading'
  const since = loadingSince(card)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!loading) return
    const remaining = since + STALE_LOADING_MS - Date.now()
    if (remaining < 0) return
    const t = setTimeout(() => setTick((n) => n + 1), remaining + 100)
    return () => clearTimeout(t)
  }, [loading, since])
  return isLoadingStale(card, Date.now())
}

function LinkPreview({
  id,
  card,
  url,
  rawUrl,
  embed,
  display,
  boardId,
  readOnly,
  onRetry,
}: {
  id: string
  card: LinkData
  url: string | null
  rawUrl: string
  embed: Embed | null
  display: LinkDisplay
  boardId: string
  readOnly: boolean
  onRetry: () => void
}) {
  const host = hostLabel(url) || rawUrl
  // A string: peers (and newer versions) may write states this version does not know.
  const state: string = card.previewState
  // Fields written for a different URL (e.g. after an undo) are not shown.
  const fresh = (state === 'done' || state === 'basic') && !isPreviewStale(card)
  const title = (fresh && asText(card.title, 300)) || host
  const description = fresh ? asText(card.description, 600) : ''
  const siteName = fresh ? asText(card.siteName, 120) : ''
  const imageHash = fresh && isValidBlobHash(card.imageBlob) ? card.imageBlob : null
  const faviconHash = fresh && isValidBlobHash(card.favicon) ? card.favicon : null
  // A fetch abandoned mid-way (the fetching app was closed) is shown as failed, with Retry.
  const abandoned = useLoadingTimeout(card)
  const loading = state === 'loading' && !abandoned
  const failed = state === 'error' || abandoned
  // Added in a browser (host name only) or never fetched here: the desktop app can load the
  // preview when someone asks for it. Not automatic: which pages a device fetches is never up to peers.
  const canLoad =
    !!desktop &&
    !!url &&
    !readOnly &&
    !loading &&
    !failed &&
    (state === 'basic' || state === 'idle' || isPreviewStale(card)) &&
    !hasPreviewClaim(boardId, id, rawUrl)
  const open = useOpenLink(url)
  const parts = linkParts(display, { image: !!imageHash, description: !!description, embed: !!embed })
  const retry = failed && !!url && !readOnly
  // The address line also carries the "Not a web link" warning and the preview buttons.
  const meta = parts.address || !url || retry || canLoad

  return (
    <>
      {parts.media === 'embed' && embed ? (
        <EmbedPlayer key={embed.src} embed={embed} title={title} poster={imageHash} boardId={boardId} />
      ) : parts.media === 'image' && imageHash ? (
        <PreviewImage hash={imageHash} boardId={boardId} />
      ) : null}
      <div className="link-card__body">
        {loading ? (
          <div className="link-card__skeleton" role="status" aria-label="Loading link preview">
            <span />
            <span />
          </div>
        ) : url ? (
          <a
            className={`link-card__title${failed ? ' is-url' : ''}`}
            href={url}
            draggable={false}
            rel="noopener noreferrer"
            title={parts.address ? undefined : url}
            {...open}
          >
            {failed ? url : title}
          </a>
        ) : (
          <div className="link-card__title is-url">{rawUrl}</div>
        )}
        {parts.description && <p className="link-card__desc">{description}</p>}
        {meta && (
          <div className="link-card__meta">
            {!url ? (
              <>
                <TriangleAlert size={13} aria-hidden />
                <span>Not a web link</span>
              </>
            ) : parts.address ? (
              <>
                <Favicon hash={faviconHash} boardId={boardId} />
                {siteName && siteName.toLowerCase() !== host.toLowerCase() && <span className="link-card__site">{siteName}</span>}
                <a className="link-card__host" href={url} draggable={false} rel="noopener noreferrer" title={url} {...open}>
                  {host}
                </a>
              </>
            ) : null}
            {retry && (
              <button type="button" className="link-card__retry" onPointerDown={stopPointer} onClick={onRetry} title="Try loading the preview again">
                Retry preview
              </button>
            )}
            {canLoad && (
              <button type="button" className="link-card__retry" onPointerDown={stopPointer} onClick={onRetry} title="Load the page’s title, description and image">
                Load preview
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}

let lastOpenAt = 0

/** Click handlers that open the link outside the app, ignoring the click that ends a card drag. */
function useOpenLink(url: string | null) {
  const down = useRef<{ x: number; y: number } | null>(null)
  const open = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const d = down.current
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
    // A double-click (to edit the card) must not open the page twice.
    const now = Date.now()
    if (now - lastOpenAt < 600) return
    lastOpenAt = now
    if (url) openExternal(url)
  }
  return {
    onPointerDown: (e: PointerEvent) => {
      down.current = { x: e.clientX, y: e.clientY }
    },
    onClick: open,
    onAuxClick: (e: MouseEvent) => {
      if (e.button === 1) open(e)
    },
  }
}

function Favicon({ hash, boardId }: { hash: string | null; boardId: string }) {
  const { url } = useBlobUrl(hash, boardId)
  const [failed, setFailed] = useState(false)
  if (!url || failed) return <Globe size={13} className="link-card__globe" aria-hidden />
  return <img className="link-card__favicon" src={url} alt="" draggable={false} onError={() => setFailed(true)} />
}

function PreviewImage({ hash, boardId }: { hash: string; boardId: string }) {
  const { url, state } = useBlobUrl(hash, boardId)
  const [failed, setFailed] = useState(false)
  if (state === 'missing' || failed) return null
  return (
    <div className="link-card__image">
      {url ? <img src={url} alt="" draggable={false} decoding="async" onError={() => setFailed(true)} /> : <div className="media-shimmer" />}
    </div>
  )
}

/**
 * Embedded player, loaded only when someone presses play: until then no request reaches the
 * provider (privacy) and boards with many videos stay fast.
 */
function EmbedPlayer({ embed, title, poster, boardId }: { embed: Embed; title: string; poster: string | null; boardId: string }) {
  const [active, setActive] = useState(false)
  const posterUrl = useBlobUrl(poster, boardId).url
  const label = EMBED_LABELS[embed.provider]
  return (
    <div className={`link-card__embed link-card__embed--${embed.provider}`} style={{ aspectRatio: String(embed.aspect) }}>
      {active ? (
        <iframe
          src={playerSrc(embed)}
          title={`${label}: ${title}`}
          sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
          loading="lazy"
          allowFullScreen
        />
      ) : (
        <button
          type="button"
          className="link-card__poster"
          onClick={(e) => {
            e.stopPropagation()
            setActive(true)
          }}
          aria-label={`Load ${label} player: ${title}`}
          title={`Load ${label} player`}
        >
          {posterUrl && <img src={posterUrl} alt="" draggable={false} decoding="async" />}
          <span className="link-card__play" aria-hidden>
            <Play size={20} fill="currentColor" />
          </span>
          <span className="link-card__provider">{label}</span>
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editing

/**
 * URL input. Enter (or pasting a link into the empty field) saves; Escape cancels. Clicking away
 * unmounts the field without a blur event, so a valid draft is also saved on unmount.
 */
function UrlField({
  initial,
  autoFocus = false,
  onCommit,
  onDone,
}: {
  initial: string
  autoFocus?: boolean
  onCommit: (url: string) => void
  onDone: () => void
}) {
  const [value, setValue] = useState(initial)
  const [invalid, setInvalid] = useState(false)
  const draft = useRef({ value: initial, settled: false })
  const commitRef = useRef(onCommit)
  useEffect(() => {
    commitRef.current = onCommit
  })

  useEffect(
    () => () => {
      const d = draft.current
      if (d.settled || d.value.trim() === initial.trim()) return
      const url = normalizeUrl(d.value)
      if (url) commitRef.current(url)
    },
    [initial],
  )

  const update = (v: string) => {
    draft.current.value = v
    setValue(v)
    if (invalid) setInvalid(false)
  }

  const submit = (v: string): boolean => {
    if (!v.trim()) {
      draft.current.settled = true
      onDone()
      return true
    }
    const url = normalizeUrl(v)
    if (!url) {
      setInvalid(true)
      return false
    }
    draft.current.settled = true
    onCommit(url)
    onDone()
    return true
  }

  return (
    <div className="link-url">
      <input
        className={`link-url__input${invalid ? ' is-invalid' : ''}`}
        type="url"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="Paste or type a link…"
        aria-label="Link address"
        aria-invalid={invalid || undefined}
        autoFocus={autoFocus}
        value={value}
        maxLength={MAX_URL_LENGTH}
        onPointerDown={stopPointer}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit(value)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            draft.current.settled = true
            onDone()
          }
        }}
        onPaste={(e) => {
          if (value.trim()) return
          const text = e.clipboardData.getData('text/plain')
          if (normalizeUrl(text)) {
            e.preventDefault()
            update(text.trim())
            submit(text)
          }
        }}
        onBlur={() => {
          // Focus moved within the card (e.g. to the caption): keep a valid change.
          if (draft.current.settled) return
          const url = normalizeUrl(draft.current.value)
          if (url && draft.current.value.trim() !== initial.trim()) commitRef.current(url)
        }}
      />
      {invalid && (
        <p className="link-url__error" role="alert">
          That doesn’t look like a web address
        </p>
      )}
    </div>
  )
}
