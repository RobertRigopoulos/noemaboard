/**
 * Cover, icon and colour picker shown under a board card while it is being renamed. Portaled out of
 * the zoomed canvas so it stays readable at any zoom level.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import { autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, size, useFloating } from '@floating-ui/react'
import { ArrowRight, ImageUp, LoaderCircle, Search } from 'lucide-react'
import { CARD_COLORS, type CardColor } from '../../model/types'
import { BoardIcon } from '../../ui/icons/BoardIcon'
import { docs } from '../../collab/docs'
import { useBlobUrl } from '../../collab/blobs'
import { childImageChoices, type CoverChoice } from './boardAppearance'
import { filterIcons } from './iconKeywords'
import { isBoardDocReady } from './helpers'

/** Icons per row of the grid (keep in step with .bcard-pop__icons in board-card.css). */
const ICON_COLUMNS = 8

interface Props {
  anchor: HTMLElement | null
  icon: string | null
  color: CardColor | null
  /** Blob hash of the current cover, or null. */
  cover: string | null
  /** An uploaded cover is being processed. */
  coverBusy: boolean
  /** The board the card is on (the cover blob is one of its card fields). */
  blobBoardId: string | null
  /** The board the card opens, whose images can be picked as the cover when it is loaded. */
  childBoardId: string | null
  onIcon: (icon: string | null) => void
  onColor: (color: CardColor | null) => void
  onCover: (hash: string | null) => void
  /** Opens the file picker for a new cover image. */
  onUploadCover: () => void
  onOpenBoard: () => void
  /** Focus left both the card and the popover. */
  onFocusOut: (e: FocusEvent<HTMLDivElement>) => void
  /** Receives the floating element so the card can tell its own focus moves from real blurs. */
  floatingRef: (el: HTMLElement | null) => void
  /** Escape was pressed inside the popover (it goes on to the board, which may end edit mode). */
  onEscape?: () => void
}

const label = (c: string) => c.charAt(0).toUpperCase() + c.slice(1)

/** Images of the child board while its doc is loaded on this device, else null. */
function useChildImages(boardId: string | null): CoverChoice[] | null {
  const read = useCallback(() => {
    const d = boardId ? docs.peek(boardId) : undefined
    return d && isBoardDocReady(d) ? childImageChoices(d) : null
  }, [boardId])
  const [list, setList] = useState<CoverChoice[] | null>(read)
  useEffect(() => {
    setList(read())
    if (!boardId) return
    return docs.onLoad((id) => {
      if (id === boardId) setList(read())
    })
  }, [boardId, read])
  return list
}

export function BoardAppearancePopover(props: Props) {
  const { anchor, icon, color, onColor, onOpenBoard, onFocusOut, floatingRef } = props
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    elements: { reference: anchor },
    placement: 'bottom',
    middleware: [
      offset(10),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(220, availableHeight)}px`
        },
      }),
    ],
    // The canvas pans with CSS transforms, which only an animation-frame loop notices.
    whileElementsMounted: (reference, floating, update) => autoUpdate(reference, floating, update, { animationFrame: true }),
  })

  const setFloating = useCallback(
    (el: HTMLElement | null) => {
      refs.setFloating(el)
      floatingRef(el)
    },
    [refs, floatingRef],
  )

  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} modal={false} initialFocus={-1} returnFocus={false} closeOnFocusOut={false}>
        <div
          ref={setFloating}
          style={floatingStyles}
          className="bcard-pop scrollable"
          role="dialog"
          aria-label="Board cover, icon and color"
          // Keep focus in the title field when clicking with the mouse (fields take focus as usual).
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest('input')) e.preventDefault()
          }}
          // React events bubble through portals: keep them away from the card and canvas.
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onKeyDown={(e) => {
            // Escape still reaches the board shortcuts (it ends edit mode); nothing else should.
            if (e.key !== 'Escape') e.stopPropagation()
            else if (!e.defaultPrevented) props.onEscape?.()
          }}
          onBlur={onFocusOut}
        >
          <CoverSection {...props} />
          <IconSection icon={icon} onIcon={props.onIcon} />
          <Section title="Color">
            <div className="bcard-pop__colors">
              <button
                type="button"
                className="bcard-pop__swatch bcard-pop__swatch--none"
                aria-label="No color"
                title="No color"
                aria-pressed={!color}
                onClick={() => onColor(null)}
              />
              {CARD_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="bcard-pop__swatch"
                  data-color={c}
                  aria-label={label(c)}
                  title={label(c)}
                  aria-pressed={color === c}
                  onClick={() => onColor(c)}
                />
              ))}
            </div>
          </Section>
          <div className="bcard-pop__footer">
            <button type="button" className="btn btn--ghost bcard-pop__open" onClick={onOpenBoard}>
              Open board
              <ArrowRight size={14} aria-hidden />
            </button>
          </div>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  )
}

function CoverSection({ cover, coverBusy, blobBoardId, childBoardId, onCover, onUploadCover }: Props) {
  const images = useChildImages(childBoardId)
  const pickId = useId()
  const current = useBlobUrl(cover, blobBoardId)
  return (
    <Section
      title="Cover"
      action={
        cover ? (
          <button type="button" className="bcard-pop__text-btn" onClick={() => onCover(null)}>
            Remove
          </button>
        ) : undefined
      }
    >
      <div className="bcard-pop__cover-row">
        {cover && (
          <span className="bcard-pop__cover-current" aria-hidden>
            {current.url ? <img src={current.url} alt="" draggable={false} /> : null}
          </span>
        )}
        <button type="button" className="bcard-pop__cover-btn" onClick={onUploadCover} disabled={coverBusy} aria-busy={coverBusy}>
          {coverBusy ? <LoaderCircle size={15} className="bcard-pop__spin" aria-hidden /> : <ImageUp size={15} aria-hidden />}
          {coverBusy ? 'Adding image' : cover ? 'Upload another image' : 'Upload image'}
        </button>
      </div>
      <div className="bcard-pop__sublabel" id={pickId}>
        Pick from this board
      </div>
      {images === null ? (
        <p className="bcard-pop__note">Open the board once to pick one of its images.</p>
      ) : images.length === 0 ? (
        <p className="bcard-pop__note">This board has no images yet.</p>
      ) : (
        <div className="bcard-pop__covers" role="group" aria-labelledby={pickId}>
          {images.map((img) => (
            <CoverChoiceButton key={img.hash} choice={img} boardId={childBoardId} selected={cover === img.hash} onPick={() => onCover(img.hash)} />
          ))}
        </div>
      )}
    </Section>
  )
}

function CoverChoiceButton({ choice, boardId, selected, onPick }: { choice: CoverChoice; boardId: string | null; selected: boolean; onPick: () => void }) {
  const { url } = useBlobUrl(choice.hash, boardId)
  return (
    <button type="button" className="bcard-pop__cover-choice" aria-label={`Use ${choice.name} as the cover`} title={choice.name} aria-pressed={selected} onClick={onPick}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="bcard-pop__cover-loading" aria-hidden />}
    </button>
  )
}

function IconSection({ icon, onIcon }: { icon: string | null; onIcon: (icon: string | null) => void }) {
  const [query, setQuery] = useState('')
  const icons = useMemo(() => filterIcons(query), [query])
  const [active, setActive] = useState(() => Math.max(0, icons.findIndex((i) => i.id === icon)))
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const searchRef = useRef<HTMLInputElement>(null)
  const gridId = useId()

  // New results: the roving stop goes to the current icon when it is listed, else the first one.
  useEffect(() => {
    const i = icons.findIndex((x) => x.id === icon)
    setActive(i >= 0 ? i : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icons])

  const activeIndex = Math.min(active, Math.max(0, icons.length - 1))

  const focusAt = (i: number) => {
    setActive(i)
    buttons.current[i]?.focus()
  }

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = icons.length
    if (!n || e.altKey || e.metaKey) return
    const row = Math.floor(activeIndex / ICON_COLUMNS)
    const lastRow = Math.floor((n - 1) / ICON_COLUMNS)
    let next = activeIndex
    switch (e.key) {
      case 'ArrowRight':
        next = Math.min(n - 1, activeIndex + 1)
        break
      case 'ArrowLeft':
        next = Math.max(0, activeIndex - 1)
        break
      case 'ArrowDown':
        // The last row may be shorter: land on its last icon rather than nowhere.
        if (row < lastRow) next = Math.min(n - 1, activeIndex + ICON_COLUMNS)
        break
      case 'ArrowUp':
        if (row === 0) {
          e.preventDefault()
          searchRef.current?.focus()
          return
        }
        next = activeIndex - ICON_COLUMNS
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = n - 1
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        onIcon(icons[activeIndex].id)
        return
      default:
        return
    }
    e.preventDefault()
    focusAt(next)
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' && icons.length) {
      e.preventDefault()
      focusAt(activeIndex)
    } else if (e.key === 'Enter' && icons.length) {
      e.preventDefault()
      onIcon(icons[activeIndex].id)
    } else if (e.key === 'Escape' && query) {
      // Clears the search first; a second Escape ends editing.
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
    }
  }

  return (
    <Section
      title="Icon"
      action={
        <button type="button" className="bcard-pop__text-btn" aria-pressed={!icon} onClick={() => onIcon(null)}>
          None
        </button>
      }
    >
      <div className="bcard-pop__search">
        <Search size={14} className="bcard-pop__search-icon" aria-hidden />
        <input
          ref={searchRef}
          type="search"
          className="bcard-pop__search-input"
          placeholder="Search icons"
          aria-label="Search icons"
          aria-controls={gridId}
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value.slice(0, 60))}
          onKeyDown={onSearchKey}
        />
      </div>
      {icons.length ? (
        <div id={gridId} className="bcard-pop__icons scrollable" role="group" aria-label="Icons" onKeyDown={onGridKey}>
          {icons.map((i, k) => (
            <button
              key={i.id}
              ref={(el) => {
                buttons.current[k] = el
              }}
              type="button"
              className="bcard-pop__icon-btn"
              aria-label={i.label}
              aria-pressed={icon === i.id}
              title={i.label}
              tabIndex={k === activeIndex ? 0 : -1}
              onFocus={() => setActive(k)}
              onClick={() => onIcon(i.id)}
            >
              <BoardIcon icon={i.id} size={18} />
            </button>
          ))}
        </div>
      ) : (
        <p id={gridId} className="bcard-pop__note bcard-pop__empty" role="status">
          No icons match
        </p>
      )}
    </Section>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="bcard-pop__section">
      <div className="bcard-pop__head">
        <span className="bcard-pop__label">{title}</span>
        {action}
      </div>
      {children}
    </div>
  )
}
