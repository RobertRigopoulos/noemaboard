/**
 * Image, file and link actions for the selection toolbar, the context menu and board shortcuts, plus
 * the media board overlays (lightbox and alt-text editor). Imported for its side effects by the media
 * card bodies, so it is loaded whenever a board can show one of them.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import {
  AlignLeft,
  Captions,
  ClipboardCopy,
  Crop,
  Download,
  ExternalLink,
  FlipHorizontal2,
  FlipVertical2,
  Globe,
  Image as ImageIcon,
  ImageDown,
  Link2,
  Maximize2,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  TextCursorInput,
  Undo2,
} from 'lucide-react'
import { registerBoardOverlay, registerCardActions, type CardAction } from '../cardActions'
import type { BoardContextValue } from '../../board/BoardContext'
import type { IndexedCard } from '../../board/cardIndex'
import { usePanels, useSelection, useView } from '../../board/store'
import { getCardMap, readCard, SYSTEM_ORIGIN, updateCard } from '../../model/board'
import type { CardMap } from '../../model/types'
import { isValidBlobHash } from '../../collab/crypto'
import { getUser } from '../../collab/identity'
import { desktop, openExternal } from '../../lib/desktop'
import { isSafeHref } from '../../editor/safeUrl'
import { toast } from '../../ui/toast'
import { CAPTION_LABELS, captionState, readCaptionHidden } from './captionState'
import { copyImageCardToClipboard } from './clipboardImage'
import { fragmentHasText } from './common'
import { downloadBlob, downloadEdited, openPdfInTab } from './download'
import { detectEmbed, sanitizeEmbed } from './embed'
import { asText, cleanFileName, fileExtension, fileKind } from './format'
import { openImage, requestCaptionFocus, useAltEditor } from './lightboxStore'
import { imageOrder } from './lightboxOrder'
import { LINK_DISPLAY_KEYS, readLinkDisplay, toggleLinkField } from './linkDisplay'
import { positive } from './numbers'
import { isPreviewStale } from './previewPolicy'
import { retryPreview } from './preview'
import {
  flipTransform,
  IDENTITY,
  isIdentity,
  readImageTransform,
  rotateTransform,
  transformFields,
  type ImageTransform,
} from './transform'
import { MAX_URL_LENGTH, normalizeUrl } from './url'
import { ImageLightbox } from './Lightbox'
import { AltTextPopover } from './AltTextPopover'

type Fields = Record<string, unknown>

const fieldsOf = (m: CardMap) => readCard(m) as unknown as Fields

function captionHasText(m: CardMap | undefined): boolean {
  const raw = m?.get('caption')
  return raw instanceof Y.XmlFragment && fragmentHasText(raw)
}

/** One undo step of its own, even right after another edit. */
function writeOnce(ctx: BoardContextValue, id: string, patch: Fields) {
  ctx.undo.stopCapturing()
  updateCard(ctx.doc, id, patch, getUser().id)
  ctx.undo.stopCapturing()
}

/** The 'Caption' toolbar toggle and its menu item ('Add caption', 'Hide caption', 'Show caption'). */
function captionActions(ctx: BoardContextValue, id: string, data: Fields): CardAction[] {
  const m = getCardMap(ctx.doc, id)
  const hasText = captionHasText(m)
  const state = captionState(hasText, readCaptionHidden(data))
  const run = () => {
    const live = getCardMap(ctx.doc, id)
    if (!live) return
    const hidden = readCaptionHidden(fieldsOf(live))
    const now = captionState(captionHasText(live), hidden)
    if (now === 'add') {
      // A caption hidden and later emptied would vanish again as soon as editing ends. Showing an
      // empty caption changes nothing anyone sees, so this is not an undo step.
      if (hidden) updateCard(ctx.doc, id, { captionHidden: undefined }, getUser().id, SYSTEM_ORIGIN)
      // Edit mode shows the caption editor, which takes focus (not a link's address) with the caret at the end.
      requestCaptionFocus(id)
      useSelection.getState().setEditing(id)
      return
    }
    writeOnce(ctx, id, { captionHidden: now === 'hide' ? true : undefined })
  }
  return [
    { id: 'media.caption', label: 'Caption', icon: Captions, group: 'edit', inToolbar: true, inMenu: false, pressed: state === 'hide', run },
    { id: 'media.caption.menu', label: CAPTION_LABELS[state], icon: Captions, group: 'edit', run },
  ]
}

function imageActions(ctx: BoardContextValue, c: IndexedCard): CardAction[] {
  const { doc, boardId } = ctx
  const id = c.id
  const data = c.card as unknown as Fields
  const blob = isValidBlobHash(data.blob) ? data.blob : null
  // Bytes not on this device are fetched on demand when an action runs (and it says so if nobody
  // online has them), so only a card without any image disables these.
  const noBytes = !blob
  const name = asText(data.name, 255) || 'Image'
  const mime = asText(data.mime, 100)
  const iw = positive(data.iw)
  const ih = positive(data.ih)
  const t = readImageTransform(data, iw, ih)
  const transformed = !isIdentity(t)

  // Turns and flips start from the card as it is now, not from this (possibly older) snapshot.
  const change = (fn: (t: ImageTransform) => ImageTransform) => () => {
    const m = getCardMap(doc, id)
    if (!m) return
    const f = fieldsOf(m)
    const current = readImageTransform(f, positive(f.iw), positive(f.ih))
    writeOnce(ctx, id, transformFields(fn(current)))
  }

  const out: CardAction[] = [
    { id: 'image.view', label: 'View full size', icon: Maximize2, group: 'view', hint: 'Space', readOnlyOk: true, inToolbar: true, run: () => openImage(id, 'view') },
    ...captionActions(ctx, id, data),
    {
      id: 'image.alt',
      label: 'Alt text…',
      icon: TextCursorInput,
      group: 'edit',
      run: (anchor) => useAltEditor.getState().open(id, anchor),
    },
    { id: 'image.crop', label: 'Crop and rotate', icon: Crop, group: 'media', inToolbar: true, disabled: noBytes, run: () => openImage(id, 'crop') },
    {
      id: 'image.rotateFlip',
      label: 'Rotate and flip',
      icon: RotateCw,
      group: 'media',
      children: [
        { id: 'image.rotateLeft', label: 'Rotate left', icon: RotateCcw, group: 'media', run: change((x) => rotateTransform(x, 'ccw')) },
        { id: 'image.rotateRight', label: 'Rotate right', icon: RotateCw, group: 'media', run: change((x) => rotateTransform(x, 'cw')) },
        { id: 'image.flipH', label: 'Flip horizontal', icon: FlipHorizontal2, group: 'media', run: change((x) => flipTransform(x, 'h')) },
        { id: 'image.flipV', label: 'Flip vertical', icon: FlipVertical2, group: 'media', run: change((x) => flipTransform(x, 'v')) },
      ],
    },
  ]
  if (transformed) {
    out.push({ id: 'image.resetTransform', label: 'Reset crop and rotation', icon: Undo2, group: 'media', run: change(() => IDENTITY) })
  }
  out.push(
    {
      id: 'image.copy',
      label: 'Copy image',
      icon: ClipboardCopy,
      group: 'export',
      readOnlyOk: true,
      disabled: noBytes,
      run: async () => {
        if (await copyImageCardToClipboard(doc, id, boardId, { explain: true })) toast('Image copied', 'success', 2500)
      },
    },
    {
      id: 'image.download',
      label: 'Download original',
      icon: Download,
      group: 'export',
      readOnlyOk: true,
      inToolbar: true,
      disabled: noBytes,
      run: () => (blob ? downloadBlob(blob, name, mime, boardId) : undefined),
    },
  )
  if (transformed) {
    out.push({
      id: 'image.downloadEdited',
      label: 'Download edited',
      icon: ImageDown,
      group: 'export',
      readOnlyOk: true,
      disabled: noBytes,
      run: () => (blob ? downloadEdited(blob, name, t, iw, ih, boardId) : undefined),
    })
  }
  return out
}

function fileActions(ctx: BoardContextValue, c: IndexedCard): CardAction[] {
  const { boardId } = ctx
  const data = c.card as unknown as Fields
  const hash = isValidBlobHash(data.blob) ? data.blob : null
  const name = cleanFileName(asText(data.name, 255), 'Untitled file')
  const mime = asText(data.mime, 100).toLowerCase()
  const noBytes = !hash
  const out: CardAction[] = []
  // A real PDF name, not just a type claimed by whoever added it. The desktop app has no PDF viewer.
  if (!desktop && fileKind(mime, name) === 'pdf' && fileExtension(name) === 'pdf') {
    out.push({
      id: 'file.open',
      label: 'Open',
      icon: ExternalLink,
      group: 'view',
      readOnlyOk: true,
      disabled: noBytes,
      run: () => {
        if (!hash) return
        // Opened inside the click: browsers block tabs opened after an await.
        const tab = window.open('', '_blank')
        if (tab) tab.opener = null
        return openPdfInTab(hash, boardId, tab).then((ok) => {
          if (!ok) tab?.close()
        })
      },
    })
  }
  out.push({
    id: 'file.download',
    label: 'Download',
    icon: Download,
    group: 'export',
    readOnlyOk: true,
    inToolbar: true,
    disabled: noBytes,
    run: () => (hash ? downloadBlob(hash, name, mime, boardId) : undefined),
  })
  return out
}

function linkActions(ctx: BoardContextValue, c: IndexedCard): CardAction[] {
  const { doc } = ctx
  const id = c.id
  const data = c.card as unknown as Fields
  const url = normalizeUrl(asText(data.url, MAX_URL_LENGTH))
  const out: CardAction[] = []
  if (url) {
    const display = readLinkDisplay(data)
    const fresh = (data.previewState === 'done' || data.previewState === 'basic') && !isPreviewStale(data)
    const hasImage = fresh && isValidBlobHash(data.imageBlob)
    const hasDescription = fresh && !!asText(data.description, 600)
    const embeddable = !!(sanitizeEmbed(data.embed) ?? detectEmbed(url))
    const toggle = (key: (typeof LINK_DISPLAY_KEYS)[number]) => () => {
      const m = getCardMap(doc, id)
      if (m) writeOnce(ctx, id, toggleLinkField(readLinkDisplay(fieldsOf(m)), key))
    }
    if (hasImage || embeddable) {
      out.push({ id: 'link.showImage', label: 'Show image', icon: ImageIcon, group: 'media', inToolbar: true, pressed: !display.hideImage, run: toggle('hideImage') })
    }
    if (hasDescription) {
      out.push({ id: 'link.showDescription', label: 'Show description', icon: AlignLeft, group: 'media', inToolbar: true, pressed: !display.hideDescription, run: toggle('hideDescription') })
    }
    out.push({ id: 'link.showUrl', label: 'Show address', icon: Globe, group: 'media', inToolbar: true, pressed: !display.hideUrl, run: toggle('hideUrl') })
    if (embeddable) {
      out.push({ id: 'link.playInline', label: 'Play inline', icon: Play, group: 'media', inToolbar: true, pressed: !display.embedAsLink, run: toggle('embedAsLink') })
    }
    out.push(
      {
        id: 'link.open',
        label: 'Open link',
        icon: ExternalLink,
        group: 'view',
        readOnlyOk: true,
        run: () => {
          if (isSafeHref(url)) openExternal(url)
        },
      },
      {
        id: 'link.copy',
        label: 'Copy link address',
        icon: Link2,
        group: 'export',
        readOnlyOk: true,
        run: async () => {
          try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
            await navigator.clipboard.writeText(url)
            toast('Link copied', 'success', 2500)
          } catch {
            toast('Could not copy the link', 'error')
          }
        },
      },
      {
        // Toolbar only: the context menu already has the board's own 'Edit' (Enter) for any card.
        id: 'link.edit',
        label: 'Edit link',
        icon: Pencil,
        group: 'edit',
        hint: 'Enter',
        inToolbar: true,
        inMenu: false,
        run: () => useSelection.getState().setEditing(id),
      },
    )
    // Only the desktop app can read other sites: a browser would replace a teammate's full preview
    // with the bare host name.
    if (desktop) {
      out.push({
        id: 'link.refresh',
        label: 'Refresh preview',
        icon: RefreshCw,
        group: 'edit',
        disabled: data.previewState === 'loading',
        run: () => retryPreview(doc, id),
      })
    }
  }
  // A link without an address shows only the address field (no caption), like LinkCard.
  if (asText(data.url, MAX_URL_LENGTH)) out.push(...captionActions(ctx, id, data))
  return out
}

registerCardActions((ctx, cards) => {
  if (cards.length !== 1) return []
  const c = cards[0]
  if (c.type === 'image') return imageActions(ctx, c)
  if (c.type === 'file') return fileActions(ctx, c)
  if (c.type === 'link') return linkActions(ctx, c)
  return []
})

// ---------------------------------------------------------------------------
// Overlays

function useIndexSnapshot(ctx: BoardContextValue): readonly IndexedCard[] {
  return useSyncExternalStore(ctx.index.subscribe, ctx.index.getSnapshot)
}

/** The lightbox, shown while usePanels.expanded is an active image card of this board. */
function MediaLightboxOverlay({ ctx }: { ctx: BoardContextValue }) {
  const expanded = usePanels((s) => s.expanded)
  const activeBoard = useView((s) => s.boardId)
  const cards = useIndexSnapshot(ctx)
  const current = expanded ? ctx.index.get(expanded) : undefined
  const missing = !!expanded && !current && activeBoard === ctx.boardId

  // A view left open for a card that went away (deleted, moved to another board) closes.
  useEffect(() => {
    if (missing && usePanels.getState().expanded === expanded) usePanels.getState().setExpanded(null)
  }, [missing, expanded])

  const order = useMemo(
    () => imageOrder(cards.map((c) => ({ id: c.id, type: c.type, x: c.x, y: c.y, parent: c.parent, order: c.order, unsorted: c.unsorted }))),
    [cards],
  )
  if (!expanded || !current || current.type !== 'image') return null
  return <ImageLightbox ctx={ctx} id={expanded} card={current.card} order={order} />
}

/** The alt-text editor for the image card named by useAltEditor. */
function MediaAltTextOverlay({ ctx }: { ctx: BoardContextValue }) {
  const altFor = useAltEditor((s) => s.altFor)
  const anchor = useAltEditor((s) => s.anchor)
  const close = useAltEditor((s) => s.close)
  const activeBoard = useView((s) => s.boardId)
  useIndexSnapshot(ctx)
  const current = altFor ? ctx.index.get(altFor) : undefined
  const editable = current?.type === 'image' && !ctx.readOnly
  // Closed when the card goes away (or the board turns read-only) on the board being shown.
  const gone = !!altFor && !editable && activeBoard === ctx.boardId
  useEffect(() => {
    if (gone) close()
  }, [gone, close])
  if (!altFor || !editable) return null
  return <AltTextPopover key={altFor} ctx={ctx} id={altFor} anchor={anchor} onClose={close} />
}

registerBoardOverlay('media.lightbox', MediaLightboxOverlay)
registerBoardOverlay('media.altText', MediaAltTextOverlay)
