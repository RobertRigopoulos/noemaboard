import { describe, expect, it } from 'vitest'
import { BOARD_ICONS } from '../../model/boardIcons'
import { filterIcons, ICON_KEYWORDS } from './iconKeywords'

const ids = (q: string) => filterIcons(q).map((i) => i.id)

describe('icon keywords', () => {
  it('has 2 to 5 lower-case keywords for every board icon, and none for unknown ids', () => {
    const known = new Set(BOARD_ICONS.map((i) => i.id))
    for (const icon of BOARD_ICONS) {
      const words = ICON_KEYWORDS[icon.id]
      expect(words, icon.id).toBeDefined()
      expect(words.length, icon.id).toBeGreaterThanOrEqual(2)
      expect(words.length, icon.id).toBeLessThanOrEqual(5)
      for (const w of words) expect(w).toBe(w.toLowerCase())
    }
    for (const id of Object.keys(ICON_KEYWORDS)) expect(known.has(id), id).toBe(true)
  })
})

describe('filterIcons', () => {
  it('returns every icon for an empty query', () => {
    expect(filterIcons('')).toHaveLength(BOARD_ICONS.length)
    expect(filterIcons('   ')).toHaveLength(BOARD_ICONS.length)
  })

  it('matches labels and keywords by word prefix, ignoring case', () => {
    expect(ids('travel')).toContain('plane')
    expect(ids('TRIP')).toContain('plane')
    expect(ids('fli')).toContain('plane')
    expect(ids('kanban')).toContain('kanban')
    expect(ids('Food')).toContain('utensils')
  })

  it('matches the parts of an icon id too', () => {
    expect(ids('cart')).toContain('shopping-cart')
    expect(ids('alarm')).toContain('alarm-clock')
  })

  it('needs every word of the query', () => {
    expect(ids('team people')).toEqual(['users'])
    expect(ids('travel flight')).toEqual(['plane'])
  })

  it('does not match the middle of a word', () => {
    expect(ids('ravel')).not.toContain('plane')
    expect(ids('xyzzy')).toEqual([])
  })

  it('keeps the order of the icon list', () => {
    const all = BOARD_ICONS.map((i) => i.id)
    const found = ids('art')
    expect(found.length).toBeGreaterThan(1)
    expect([...found].sort((a, b) => all.indexOf(a) - all.indexOf(b))).toEqual(found)
  })
})
