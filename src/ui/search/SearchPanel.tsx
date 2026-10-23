/**
 * Search across every board on this device: board titles (library) and card text, live for loaded
 * boards and from the local search index (searchIndex.ts) for the rest. Type filters, a scope
 * (all boards / this board), relevance or recently-viewed order, and query operators
 * (type:, in:"Board", "exact phrase").
 * Opened from the header, Mod+F (all boards), Mod+Shift+F (this board), useDialogs('search') or
 * usePanels('search').
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type * as Y from 'yjs'
import { CornerDownLeft, LayoutGrid, LoaderCircle, Search as SearchIcon } from 'lucide-react'
import { HOME_BOARD_ID } from '../../config'
import { docs } from '../../collab/docs'
import { useLibrary } from '../../collab/library'
import { canOpenBoard } from '../../app/boardAccess'
import { breadcrumbs } from '../../collab/boards'
import { openBoard } from '../../app/router'
import { usePanels } from '../../board/store'
import { CARD_DEFINITIONS } from '../../cards/registry'
import { useDialogs } from '../uiStore'
import { Dialog } from '../dialogs/Dialog'
import {
  boardTitleItem,
  collectDocItems,
  docTitle,
  filterTypes,
  runSearch,
  SEARCH_FILTERS,
  type SearchFilterId,
  type SearchGroup,
  type SearchHit,
  type SearchItem,
} from './collect'
import type { SnippetPart } from './match'
import { openCard } from './focusTarget'
import { cachedItems, cachedTitle, ensureIndexLoaded, setIndexerFast, useSearchIndex } from './searchIndex'
import { useSearchScope, type SearchScope } from './searchState'
import './search.css'

type SortOrder = 'relevance' | 'recent'

const MAX_HITS = 200

/** Searchable items per loaded doc, rebuilt only after the doc changes. */
const itemCache = new WeakMap<Y.Doc, { items: SearchItem[] | null }>()

function liveItems(boardId: string, doc: Y.Doc): SearchItem[] {
  let entry = itemCache.get(doc)
  if (!entry) {
    const e: { items: SearchItem[] | null } = { items: null }
    doc.on('update', () => {
      e.items = null
    })
    itemCache.set(doc, e)
    entry = e
  }
  entry.items ??= collectDocItems(boardId, doc)
  return entry.items
}

export function useSearchOpen(): [boolean, () => void] {
  const dialogOpen = useDialogs((s) => s.dialog === 'search')
  const panelOpen = usePanels((s) => s.panel === 'search')
  const close = () => {
    if (useDialogs.getState().dialog === 'search') useDialogs.getState().close()
    if (usePanels.getState().panel === 'search') usePanels.getState().setPanel(null)
  }
  return [dialogOpen || panelOpen, close]
}

export function SearchPanel({ currentBoardId }: { currentBoardId: string }) {
  const [open, close] = useSearchOpen()
  return (
    <Dialog open={open} onClose={close} title="Search" hideHeader size="lg" className="search-dlg">
      <SearchBody currentBoardId={currentBoardId} onClose={close} />
    </Dialog>
  )
}

function Highlighted({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="search-hit">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

function TypeIcon({ type }: { type: SearchHit['type'] }) {
  const Icon = type === 'board-title' ? LayoutGrid : (CARD_DEFINITIONS[type]?.icon ?? LayoutGrid)
  return <Icon size={16} aria-hidden />
}

function boardPath(boardId: string): string {
  return breadcrumbs(boardId)
    .slice(0, -1)
    .map((c) => c.title)
    .join(' › ')
}

/** The indexer runs eagerly while the dialog is open. */
function useEagerIndexing() {
  useEffect(() => {
    void ensureIndexLoaded()
    setIndexerFast(true)
    return () => setIndexerFast(false)
  }, [])
}

function SearchBody({ currentBoardId, onClose }: { currentBoardId: string; onClose: () => void }) {
  const allEntries = useLibrary((s) => s.entries)
  // Boards without a key on this device cannot be opened: never offer them.
  const entries = useMemo(() => {
    const out: typeof allEntries = {}
    for (const [id, e] of Object.entries(allEntries)) if (canOpenBoard(id, allEntries)) out[id] = e
    return out
  }, [allEntries])
  const indexVersion = useSearchIndex((s) => s.version)
  const indexing = useSearchIndex((s) => s.indexing)
  const indexedDone = useSearchIndex((s) => s.done)
  const indexedTotal = useSearchIndex((s) => s.total)
  const scope = useSearchScope((s) => s.scope)
  const setScope = useSearchScope((s) => s.setScope)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filter, setFilter] = useState<SearchFilterId>('all')
  const [sort, setSort] = useState<SortOrder>('relevance')
  const [active, setActive] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  useEagerIndexing()

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 90)
    return () => clearTimeout(t)
  }, [query])

  const boardIds = useMemo(() => [HOME_BOARD_ID, ...Object.keys(entries).filter((id) => id !== HOME_BOARD_ID)], [entries])

  const titleOf = (id: string) =>
    id === HOME_BOARD_ID ? 'Home' : docTitle(docs.peek(id), cachedTitle(id) ?? entries[id]?.title ?? 'Board')

  const { items, searchable } = useMemo(() => {
    const out: SearchItem[] = []
    let count = 0
    for (const id of boardIds) {
      const doc = docs.isLoaded(id) ? docs.peek(id) : undefined
      const list = doc ? liveItems(id, doc) : cachedItems(id)
      if (list) {
        count++
        out.push(...list)
      }
      if (id !== HOME_BOARD_ID) out.push(boardTitleItem(id, titleOf(id)))
    }
    return { items: out, searchable: count }
    // indexVersion: records changed (a board was indexed or edited); titleOf reads the same inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardIds, entries, indexVersion])

  const types = useMemo(() => filterTypes(filter), [filter])
  const recency = useMemo(() => (sort === 'recent' ? (id: string) => entries[id]?.lastOpened ?? 0 : null), [sort, entries])
  const hasQuery = !!debounced.trim()
  const browsing = hasQuery || filter !== 'all'

  const groups: SearchGroup[] = useMemo(() => {
    if (browsing) {
      return runSearch(items, debounced, titleOf, {
        currentBoardId,
        maxHits: MAX_HITS,
        types,
        boardIds: scope === 'board' ? new Set([currentBoardId]) : null,
        recency,
      })
    }
    // No query yet: recently opened boards for quick switching.
    const recent = Object.values(entries)
      .filter((e) => e.id !== currentBoardId && e.id !== HOME_BOARD_ID && e.lastOpened > 0)
      .sort((a, b) => b.lastOpened - a.lastOpened)
      .slice(0, 8)
    const hits: SearchHit[] = recent.map((e) => ({
      boardId: e.id,
      cardId: null,
      type: 'board-title',
      title: [{ text: titleOf(e.id), hit: false }],
      snippet: [],
      score: 0,
    }))
    if (currentBoardId !== HOME_BOARD_ID)
      hits.push({ boardId: HOME_BOARD_ID, cardId: null, type: 'board-title', title: [{ text: 'Home', hit: false }], snippet: [], score: 0 })
    return hits.length ? [{ boardId: '', boardTitle: 'Recent boards', hits }] : []
    // titleOf reads the same inputs as `items`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, debounced, browsing, currentBoardId, entries, types, scope, recency])

  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups])

  useEffect(() => setActive(0), [groups])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (hit: SearchHit | undefined) => {
    if (!hit) return
    onClose()
    if (hit.cardId) openCard(hit.boardId, hit.cardId, currentBoardId)
    else if (hit.boardId !== currentBoardId) openBoard(hit.boardId)
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault()
      if (flat.length) setActive((a) => (a + 1) % flat.length)
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault()
      if (flat.length) setActive((a) => (a - 1 + flat.length) % flat.length)
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      setActive((a) => Math.min(flat.length - 1, a + 8))
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 8))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(flat[active])
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`
  const total = flat.length
  const scopeTitle = scope === 'board' ? titleOf(currentBoardId) : null
  let index = 0

  let body: ReactNode
  if (!groups.length) {
    body = browsing ? (
      <div className="search-empty">
        <p>{hasQuery ? <>No matches for <strong>“{debounced.trim()}”</strong></> : 'Nothing of this kind yet'}</p>
        <p className="muted">
          {scope === 'board'
            ? 'Only this board was searched. Try “All boards”.'
            : indexing
              ? 'Some boards are still being indexed; results appear as they are ready.'
              : 'Check the spelling or try fewer words. Only boards stored on this device can be searched.'}
        </p>
      </div>
    ) : (
      <div className="search-empty">
        <p className="muted">Type to search card text, links, comments and board names.</p>
        <p className="muted search-empty__tip">
          Try <code>type:image</code>, <code>in:"Board name"</code> or <code>"an exact phrase"</code>.
        </p>
      </div>
    )
  } else {
    body = groups.map((g) => (
      <div key={g.boardId || 'boards'} role="group" aria-labelledby={`${listId}-g-${g.boardId || 'boards'}`} className="search-group">
        <div id={`${listId}-g-${g.boardId || 'boards'}`} className="search-group__title">
          <span className="search-group__name">{g.boardTitle}</span>
          {g.boardId && g.boardId !== HOME_BOARD_ID && boardPath(g.boardId) && <span className="search-group__path">{boardPath(g.boardId)}</span>}
          {g.boardId === currentBoardId && <span className="search-group__badge">This board</span>}
        </div>
        {g.hits.map((h) => {
          const i = index++
          const path = h.type === 'board-title' && h.boardId !== HOME_BOARD_ID ? boardPath(h.boardId) : ''
          return (
            <div
              key={`${h.boardId}:${h.cardId ?? ''}`}
              id={optionId(i)}
              data-index={i}
              role="option"
              aria-selected={i === active}
              className="search-item"
              onMouseMove={() => i !== active && setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(h)}
            >
              <span className="search-item__icon">
                <TypeIcon type={h.type} />
              </span>
              <span className="search-item__text">
                <span className="search-item__title">
                  <Highlighted parts={h.title} />
                </span>
                {h.snippet.length > 0 && (
                  <span className="search-item__snippet">
                    <Highlighted parts={h.snippet} />
                  </span>
                )}
                {path && <span className="search-item__snippet">{path}</span>}
              </span>
              {i === active && <CornerDownLeft className="search-item__enter" size={14} aria-hidden />}
            </div>
          )
        })}
      </div>
    ))
  }

  return (
    <div className="search">
      <div className="search__bar">
        <SearchIcon size={18} aria-hidden className="search__icon" />
        <input
          data-autofocus
          className="search__input"
          type="text"
          role="combobox"
          aria-expanded={total > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={total ? optionId(active) : undefined}
          aria-label={scopeTitle ? `Search “${scopeTitle}”` : 'Search boards and cards'}
          placeholder={scopeTitle ? `Search “${scopeTitle}”…` : 'Search boards and cards…'}
          value={query}
          maxLength={200}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <kbd className="kbd">Esc</kbd>
      </div>
      <div className="search__filters">
        <div className="search-chips" role="group" aria-label="Show only">
          {SEARCH_FILTERS.map((f) => (
            <button key={f.id} type="button" className="search-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="search__options">
          <div className="seg search-seg" role="radiogroup" aria-label="Where to search">
            {(
              [
                { value: 'all', label: 'All boards' },
                { value: 'board', label: 'This board' },
              ] as { value: SearchScope; label: string }[]
            ).map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={scope === o.value}
                tabIndex={scope === o.value ? 0 : -1}
                className="seg__opt"
                onClick={() => setScope(o.value)}
                onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
                  e.preventDefault()
                  const next: SearchScope = scope === 'all' ? 'board' : 'all'
                  setScope(next)
                  ;(e.currentTarget.parentElement?.querySelector('[aria-checked="false"]') as HTMLElement | null)?.focus()
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          <label className="search-sort">
            <span>Sort</span>
            <select className="search-sort__select" value={sort} onChange={(e) => setSort(e.target.value as SortOrder)}>
              <option value="relevance">Relevance</option>
              <option value="recent">Recently viewed</option>
            </select>
          </label>
        </div>
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="search__results">
        {body}
      </div>
      <div className="search__footer">
        <span aria-live="polite">
          {browsing ? `${total} result${total === 1 ? '' : 's'}` : ''}
          {browsing && total >= MAX_HITS ? ' (showing the best 200)' : ''}
        </span>
        <span className="search__scope">
          {indexing ? (
            <>
              <LoaderCircle size={12} className="spin" aria-hidden /> Indexed {indexedDone} of {indexedTotal} boards
            </>
          ) : scope === 'board' ? (
            `Searching “${scopeTitle}”`
          ) : (
            `Searching ${searchable} board${searchable === 1 ? '' : 's'} on this device`
          )}
        </span>
        <span className="search__keys">
          <kbd className="kbd">↑</kbd>
          <kbd className="kbd">↓</kbd> to move <kbd className="kbd">Enter</kbd> to open
        </span>
      </div>
    </div>
  )
}
