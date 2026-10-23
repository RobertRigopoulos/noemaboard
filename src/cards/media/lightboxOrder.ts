/** Order in which the lightbox steps through a board's images. Pure. */

export interface OrderCard {
  id: string
  type: string
  x: number
  y: number
  parent: string | null
  order: string
  /** Cards in the trash or in Unsorted are skipped. */
  trashed?: boolean
  unsorted?: boolean
}

/** Items whose tops are this close (board units) read as one row. */
export const ROW_TOLERANCE = 40

interface Slot {
  x: number
  y: number
  ids: string[]
}

/**
 * Image ids in reading order: free images in rows (tops within 40 units) left to right, then the
 * next row; images inside a column count at the column's position, in column order.
 */
export function imageOrder(cards: readonly OrderCard[]): string[] {
  const byId = new Map<string, OrderCard>()
  for (const c of cards) byId.set(c.id, c)
  const live = (c: OrderCard | undefined): c is OrderCard => !!c && !c.trashed && !c.unsorted

  const slots: Slot[] = []
  const columns = new Map<string, Slot & { children: OrderCard[] }>()
  for (const c of cards) {
    if (c.type !== 'image' || !live(c)) continue
    const parent = c.parent ? byId.get(c.parent) : undefined
    if (parent && parent.type === 'column') {
      // A card in a column that is gone, in the trash or in Unsorted is not on the board either.
      if (!live(parent)) continue
      let slot = columns.get(parent.id)
      if (!slot) {
        slot = { x: parent.x, y: parent.y, ids: [], children: [] }
        columns.set(parent.id, slot)
        slots.push(slot)
      }
      slot.children.push(c)
      continue
    }
    slots.push({ x: c.x, y: c.y, ids: [c.id] })
  }
  for (const slot of columns.values()) {
    slot.children.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1))
    slot.ids = slot.children.map((c) => c.id)
  }

  const finite = (v: number) => (Number.isFinite(v) ? v : 0)
  slots.sort((a, b) => finite(a.y) - finite(b.y) || finite(a.x) - finite(b.x))
  const out: string[] = []
  let row: Slot[] = []
  let rowTop = 0
  const flush = () => {
    row.sort((a, b) => finite(a.x) - finite(b.x) || finite(a.y) - finite(b.y))
    for (const s of row) out.push(...s.ids)
    row = []
  }
  for (const s of slots) {
    if (row.length && finite(s.y) - rowTop > ROW_TOLERANCE) flush()
    if (!row.length) rowTop = finite(s.y)
    row.push(s)
  }
  flush()
  return out
}
