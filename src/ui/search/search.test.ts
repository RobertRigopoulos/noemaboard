import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, deleteCards, getCards, initBoardDoc, setFragmentText } from '../../model/board'
import { boardTitleItem, collectDocItems, filterTypes, runSearch } from './collect'
import { findRanges, fold, hasCriteria, highlight, makeSnippet, matchesAll, mergeRanges, parseQuery, parseSearchQuery } from './match'
import {
  boardsToIndex,
  buildRecord,
  fnv1aHex,
  INDEX_LIMITS,
  INDEX_VERSION,
  isFreshRecord,
  recordItems,
  recordsToDrop,
  sanitizeRecord,
  stateVectorHash,
} from './searchIndex'

const U = 'u1'
const joined = (parts: { text: string; hit: boolean }[]) => parts.map((p) => (p.hit ? `[${p.text}]` : p.text)).join('')

describe('match', () => {
  it('folds case and accents while mapping back to the original text', () => {
    const f = fold('Crème Brûlée')
    expect(f.text).toBe('creme brulee')
    const r = findRanges(f, ['brulee'])
    expect(r).toEqual([{ start: 6, end: 12 }])
    expect('Crème Brûlée'.slice(r[0].start, r[0].end)).toBe('Brûlée')
  })

  it('maps ranges correctly when the original uses decomposed accents', () => {
    const s = 'café au lait'
    const r = findRanges(fold(s), ['cafe'])
    // The combining accent belongs to the highlighted word.
    expect(s.slice(r[0].start, r[0].end)).toBe('café')
    const r2 = findRanges(fold(s), ['au'])
    expect(s.slice(r2[0].start, r2[0].end)).toBe('au')
  })

  it('parses queries into unique folded terms, longest first', () => {
    expect(parseQuery('  Road  MAP road  é ')).toEqual(['road', 'map', 'e'])
    expect(parseQuery('   ')).toEqual([])
  })

  it('requires every term somewhere in the fields', () => {
    expect(matchesAll([fold('Launch plan'), fold('Q3 goals')], ['plan', 'q3'])).toBe(true)
    expect(matchesAll([fold('Launch plan')], ['plan', 'q3'])).toBe(false)
  })

  it('merges overlapping ranges and highlights them', () => {
    expect(mergeRanges([{ start: 5, end: 8 }, { start: 0, end: 3 }, { start: 2, end: 6 }])).toEqual([{ start: 0, end: 8 }])
    expect(joined(highlight('hello world', [{ start: 0, end: 5 }]))).toBe('[hello] world')
  })

  it('makes snippets around the first hit with ellipses', () => {
    const long = `${'lorem ipsum '.repeat(20)}the needle is here ${'dolor sit '.repeat(20)}`
    const s = joined(makeSnippet(long, ['needle'], 60))
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
    expect(s).toContain('[needle]')
    expect(s.length).toBeLessThan(80)
    expect(joined(makeSnippet('Short text', ['text']))).toBe('Short [text]')
    expect(joined(makeSnippet('a\n\n  b', ['b']))).toBe('a [b]')
  })
})

describe('collect + runSearch', () => {
  function board(id: string, title: string) {
    const doc = new Y.Doc({ guid: id })
    initBoardDoc(doc, { id, title }, U)
    return doc
  }
  function note(doc: Y.Doc, text: string, x = 0) {
    const id = createCard(doc, 'note', { x }, U)
    doc.transact(() => setFragmentText(getCards(doc).get(id)!.get('content') as Y.XmlFragment, text))
    return id
  }

  it('finds cards by text, titles, urls and comments, grouped by board', () => {
    const a = board('boardA00001', 'Marketing')
    const b = board('boardB00001', 'Engineering')
    const n1 = note(a, 'Launch checklist\nBook the venue for the launch party')
    const link = createCard(a, 'link', { url: 'https://example.com/launch', title: 'Press kit' }, U)
    const n2 = note(b, 'Release train: launch on Monday')
    const trashed = note(b, 'launch secret plan')
    deleteCards(b, [trashed], U)
    const comment = createCard(b, 'comment', {}, U)
    const msg = new Y.Map<unknown>()
    msg.set('authorName', 'Ana')
    msg.set('text', 'Did we confirm the venue?')
    ;(getCards(b).get(comment)!.get('thread') as Y.Array<Y.Map<unknown>>).push([msg])

    const items = [...collectDocItems('boardA00001', a), ...collectDocItems('boardB00001', b), boardTitleItem('boardA00001', 'Marketing launch')]
    const titles = (id: string) => ({ boardA00001: 'Marketing', boardB00001: 'Engineering' })[id] ?? '?'

    const groups = runSearch(items, 'launch', titles, { currentBoardId: 'boardB00001' })
    expect(groups[0].boardId).toBe('')
    expect(groups[0].hits[0]).toMatchObject({ boardId: 'boardA00001', cardId: null })
    const ids = groups.flatMap((g) => g.hits.map((h) => h.cardId))
    expect(ids).toEqual(expect.arrayContaining([n1, link, n2]))
    expect(ids).not.toContain(trashed)
    // The current board ranks before other boards.
    expect(groups[1].boardId).toBe('boardB00001')

    const venue = runSearch(items, 'VENUE', titles)
    const venueIds = venue.flatMap((g) => g.hits.map((h) => h.cardId))
    expect(venueIds).toEqual(expect.arrayContaining([n1, comment]))
    const noteHit = venue.flatMap((g) => g.hits).find((h) => h.cardId === n1)!
    expect(joined(noteHit.title)).toBe('Launch checklist')
    expect(joined(noteHit.snippet)).toContain('[venue]')

    // Every word must match (AND semantics).
    expect(runSearch(items, 'launch monday', titles).flatMap((g) => g.hits.map((h) => h.cardId))).toEqual([n2])
    expect(runSearch(items, 'nothing-like-this', titles)).toEqual([])
    expect(runSearch(items, '   ', titles)).toEqual([])
  })

  it('ranks title matches above body matches and caps results', () => {
    const doc = board('boardC00001', 'C')
    const body = note(doc, 'Intro\nsomething about roadmap')
    const titled = createCard(doc, 'todo', { title: 'Roadmap' }, U)
    const groups = runSearch(collectDocItems('boardC00001', doc), 'roadmap', () => 'C')
    expect(groups[0].hits.map((h) => h.cardId)).toEqual([titled, body])
    for (let i = 0; i < 40; i++) note(doc, `match ${i}`, i * 10)
    const capped = runSearch(collectDocItems('boardC00001', doc), 'match', () => 'C', { maxPerBoard: 10 })
    expect(capped[0].hits).toHaveLength(10)
  })

  it('ignores malformed card data from peers', () => {
    const doc = board('boardD00001', 'D')
    const id = createCard(doc, 'todo', {}, U)
    getCards(doc).get(id)!.set('title', { evil: true } as unknown as string)
    getCards(doc).get(id)!.set('content', 'not a fragment' as unknown as Y.XmlFragment)
    const weird = new Y.Map<unknown>()
    weird.set('type', 'unknown-type')
    getCards(doc).set('weird000001', weird)
    expect(() => collectDocItems('boardD00001', doc)).not.toThrow()
    expect(collectDocItems('boardD00001', doc)).toEqual([])
  })
})

describe('parseSearchQuery', () => {
  it('reads type:, in:"Board" and "exact phrases", leaving plain words', () => {
    const p = parseSearchQuery('launch type:image in:"Q3 Plan" "press kit" venue')
    expect(p.types).toEqual(['image'])
    expect(p.boards).toEqual(['q3 plan'])
    expect(p.phrases).toEqual(['press kit'])
    expect(p.terms.sort()).toEqual(['launch', 'venue'])
  })

  it('accepts plural and alias type names and in:word', () => {
    expect(parseSearchQuery('type:Todos').types).toEqual(['todo'])
    expect(parseSearchQuery('type:boards').types.sort()).toEqual(['board', 'board-title'])
    expect(parseSearchQuery('in:Marketing x').boards).toEqual(['marketing'])
  })

  it('treats unknown operators and types as plain text', () => {
    const p = parseSearchQuery('type:spaceship at 10:30 foo:bar')
    expect(p.types).toEqual([])
    expect(p.terms).toEqual(expect.arrayContaining(['type:spaceship', '10:30', 'foo:bar']))
  })

  it('turns a quoted single word into a word and ignores empty quotes', () => {
    const p = parseSearchQuery('"roadmap" ""')
    expect(p.phrases).toEqual([])
    expect(p.terms).toEqual(['roadmap'])
    expect(hasCriteria(parseSearchQuery('""'))).toBe(false)
    expect(hasCriteria(parseSearchQuery('type:note'))).toBe(true)
  })
})

describe('runSearch filters, scope, operators and order', () => {
  function board(id: string, title: string) {
    const doc = new Y.Doc({ guid: id })
    initBoardDoc(doc, { id, title }, U)
    return doc
  }
  function note(doc: Y.Doc, text: string) {
    const id = createCard(doc, 'note', {}, U)
    doc.transact(() => setFragmentText(getCards(doc).get(id)!.get('content') as Y.XmlFragment, text))
    return id
  }
  const a = board('boardA00002', 'Q3 Plan')
  const b = board('boardB00002', 'Recipes')
  const aNote = note(a, 'Plan the press kit launch')
  const aImage = createCard(a, 'image', { name: 'poster.png', alt: 'Launch poster with a rocket' }, U)
  const bNote = note(b, 'Pancake launch party, press the dough')
  const bTodo = createCard(b, 'todo', { title: 'Launch shopping' }, U)
  const items = [
    ...collectDocItems('boardA00002', a),
    ...collectDocItems('boardB00002', b),
    boardTitleItem('boardA00002', 'Q3 Plan'),
    boardTitleItem('boardB00002', 'Recipes'),
  ]
  const titles = (id: string) => ({ boardA00002: 'Q3 Plan', boardB00002: 'Recipes' })[id] ?? '?'
  const ids = (groups: ReturnType<typeof runSearch>) => groups.flatMap((g) => g.hits.map((h) => h.cardId))

  it('filters by type chips and finds images by alt text', () => {
    expect(ids(runSearch(items, 'launch', titles, { types: filterTypes('media') }))).toEqual([aImage])
    expect(ids(runSearch(items, 'rocket', titles))).toEqual([aImage])
    expect(ids(runSearch(items, 'launch', titles, { types: filterTypes('todos') }))).toEqual([bTodo])
    expect(filterTypes('all')).toBeNull()
  })

  it('lists everything of a type when only a chip is chosen', () => {
    expect(ids(runSearch(items, '', titles, { types: filterTypes('notes') })).sort()).toEqual([aNote, bNote].sort())
    expect(runSearch(items, '', titles)).toEqual([])
  })

  it('limits the scope to one board', () => {
    expect(ids(runSearch(items, 'launch', titles, { boardIds: new Set(['boardB00002']) })).sort()).toEqual([bNote, bTodo].sort())
  })

  it('applies type:, in: and exact phrases', () => {
    expect(ids(runSearch(items, 'launch type:todo', titles))).toEqual([bTodo])
    expect(ids(runSearch(items, 'launch in:"q3 plan"', titles)).filter(Boolean).sort()).toEqual([aImage, aNote].sort())
    expect(ids(runSearch(items, '"press kit"', titles))).toEqual([aNote])
    // "press" alone finds both notes; the phrase only one.
    expect(ids(runSearch(items, 'press', titles)).sort()).toEqual([aNote, bNote].sort())
  })

  it('orders boards by when they were last viewed when asked', () => {
    const recent = runSearch(items, 'launch', titles, { recency: (id) => (id === 'boardB00002' ? 2 : 1) })
    expect(recent.filter((g) => g.boardId).map((g) => g.boardId)).toEqual(['boardB00002', 'boardA00002'])
    const older = runSearch(items, 'launch', titles, { recency: (id) => (id === 'boardA00002' ? 2 : 1) })
    expect(older.filter((g) => g.boardId).map((g) => g.boardId)).toEqual(['boardA00002', 'boardB00002'])
  })
})

describe('search index records', () => {
  function board(id: string, title: string) {
    const doc = new Y.Doc({ guid: id })
    initBoardDoc(doc, { id, title }, U)
    return doc
  }

  it('builds capped records and folds them back into search items', () => {
    const doc = board('indexBoard1', 'Index me')
    const id = createCard(doc, 'note', {}, U)
    doc.transact(() => setFragmentText(getCards(doc).get(id)!.get('content') as Y.XmlFragment, `Title line\n${'x'.repeat(5000)}`))
    const rec = buildRecord('indexBoard1', doc, 'Fallback', 123)
    expect(rec).toMatchObject({ v: INDEX_VERSION, boardId: 'indexBoard1', title: 'Index me', indexedAt: 123 })
    expect(rec.items).toHaveLength(1)
    expect(rec.items[0].body.length).toBe(INDEX_LIMITS.body)
    expect(rec.sv).toMatch(/^[0-9a-f]{8}$/)
    const found = runSearch(recordItems(rec), 'title', () => 'Index me')
    expect(found[0].hits[0].cardId).toBe(id)
  })

  it('caps the number of items per board', () => {
    const doc = board('indexBoard2', 'Many')
    doc.transact(() => {
      for (let i = 0; i < INDEX_LIMITS.items + 25; i++) createCard(doc, 'column', { title: `Column ${i}` }, U)
    })
    expect(buildRecord('indexBoard2', doc, 'Many').items).toHaveLength(INDEX_LIMITS.items)
  })

  it('sanitises stored records and rejects unusable ones', () => {
    const good = {
      v: INDEX_VERSION,
      boardId: 'indexBoard3',
      title: `T\u0000itle${'y'.repeat(400)}`,
      sv: '0a1b2c3d',
      indexedAt: 5,
      items: [
        { cardId: 'card000001', type: 'note', title: 'ok', body: 'b'.repeat(3000) },
        { cardId: '../evil', type: 'note', title: 'bad id', body: '' },
        { cardId: 'card000002', type: 'spaceship', title: 'bad type', body: '' },
        { cardId: 'card000003', type: 'board-title', title: 'not a card', body: '' },
        { cardId: 'card000004', type: 'note', title: '', body: '' },
        null,
      ],
    }
    const r = sanitizeRecord(good)!
    expect(r.title.startsWith('Title')).toBe(true)
    expect(r.title.length).toBe(INDEX_LIMITS.title)
    expect(r.items.map((i) => i.cardId)).toEqual(['card000001'])
    expect(r.items[0].body.length).toBe(INDEX_LIMITS.body)
    expect(sanitizeRecord({ ...good, v: 0 })).toBeNull()
    expect(sanitizeRecord({ ...good, boardId: 'x' })).toBeNull()
    expect(sanitizeRecord({ ...good, boardId: 'home' })).not.toBeNull()
    expect(sanitizeRecord({ ...good, sv: 'nothex!!' })).toBeNull()
    expect(sanitizeRecord([])).toBeNull()
    expect(sanitizeRecord({ ...good, indexedAt: -4, items: 'nope' })).toMatchObject({ indexedAt: 0, items: [] })
  })

  it('tells stale records from fresh ones by the doc state vector', () => {
    const doc = board('indexBoard4', 'Stale')
    const rec = buildRecord('indexBoard4', doc, 'Stale')
    expect(isFreshRecord(rec, stateVectorHash(doc))).toBe(true)
    createCard(doc, 'note', {}, U)
    expect(isFreshRecord(rec, stateVectorHash(doc))).toBe(false)
    expect(isFreshRecord(undefined, stateVectorHash(doc))).toBe(false)
    expect(isFreshRecord({ ...rec, v: INDEX_VERSION + 1 }, rec.sv)).toBe(false)
  })

  it('hashes bytes with FNV-1a', () => {
    expect(fnv1aHex(new Uint8Array())).toBe('811c9dc5')
    expect(fnv1aHex(new TextEncoder().encode('a'))).toBe('e40c292c')
  })

  it('finds boards to index and records to drop', () => {
    const entry = (id: string, secret: string) => ({ id, secret, title: id, icon: null, color: null, parentId: 'home', shared: false, relay: null, lastOpened: 0 })
    const entries = { boardK00001: entry('boardK00001', 's'.repeat(43)), boardN00001: entry('boardN00001', '') }
    const records = new Map([
      ['boardK00001', {} as never],
      ['goneBoard01', {} as never],
    ])
    expect(boardsToIndex(entries, records)).toEqual(['home'])
    expect(boardsToIndex(entries, new Map(), new Set(['home']))).toEqual(['boardK00001'])
    expect(recordsToDrop(entries, records)).toEqual(['goneBoard01'])
  })
})
