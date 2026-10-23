import { describe, expect, it } from 'vitest'
import { imageOrder, type OrderCard } from './lightboxOrder'

const img = (id: string, x: number, y: number, extra: Partial<OrderCard> = {}): OrderCard => ({
  id,
  type: 'image',
  x,
  y,
  parent: null,
  order: 'a0',
  ...extra,
})

describe('imageOrder', () => {
  it('reads free images in rows, left to right', () => {
    const cards: OrderCard[] = [img('c', 400, 30), img('a', 0, 0), img('d', 0, 500), img('b', 200, -20), { ...img('n', 100, 0), type: 'note' }]
    // a, b and c start within 40 units of the row's top (-20): one row, read by x.
    expect(imageOrder(cards)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('starts a new row past the tolerance', () => {
    expect(imageOrder([img('low', 0, 100), img('high', 300, 0)])).toEqual(['high', 'low'])
    expect(imageOrder([img('low', 0, 30), img('high', 300, 0)])).toEqual(['low', 'high'])
  })

  it('places column children at the column, in column order', () => {
    const cards: OrderCard[] = [
      { id: 'col', type: 'column', x: 300, y: 0, parent: null, order: 'a0' },
      img('second', 0, 0, { parent: 'col', order: 'a2' }),
      img('first', 0, 0, { parent: 'col', order: 'a1' }),
      img('left', 0, 10),
      img('right', 600, 0),
    ]
    expect(imageOrder(cards)).toEqual(['left', 'first', 'second', 'right'])
  })

  it('skips unsorted and trashed images, and children of unsorted columns', () => {
    const cards: OrderCard[] = [
      img('a', 0, 0),
      img('u', 100, 0, { unsorted: true }),
      img('t', 200, 0, { trashed: true }),
      { id: 'col', type: 'column', x: 0, y: 300, parent: null, order: 'a0', unsorted: true },
      img('inUnsorted', 0, 0, { parent: 'col' }),
    ]
    expect(imageOrder(cards)).toEqual(['a'])
  })

  it('treats a card whose column is missing as free', () => {
    expect(imageOrder([img('orphan', 0, 0, { parent: 'gone' }), img('next', 100, 0)])).toEqual(['orphan', 'next'])
  })
})
