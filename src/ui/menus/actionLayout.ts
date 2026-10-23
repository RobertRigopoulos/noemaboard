/**
 * Pure layout rules for card actions: how the context menu groups them into sections and how the
 * selection toolbar decides which provider buttons fit.
 */
import { CARD_ACTION_GROUPS, type CardActionGroup } from '../../cards/cardActions'

export interface Groupable {
  group: CardActionGroup
  inMenu?: boolean
  readOnlyOk?: boolean
  children?: readonly Groupable[]
}

/** Drops what a read-only board may not offer; a parent whose children all go is dropped too. */
export function readOnlyFilter<T extends Groupable>(item: T): T | null {
  if (!item.readOnlyOk) return null
  if (!item.children) return item
  const children = item.children.map((c) => readOnlyFilter(c)).filter((c): c is Groupable => !!c)
  return children.length ? ({ ...item, children } as T) : null
}

const GROUP_INDEX = new Map<string, number>(CARD_ACTION_GROUPS.map((g, i) => [g, i]))

/**
 * Menu sections in CARD_ACTION_GROUPS order, keeping the input order inside each section. Items
 * with inMenu === false are left out; on read-only boards only readOnlyOk items stay. Items with an
 * unknown group (a provider built against a newer list) go into the last section rather than vanish.
 */
export function groupActions<T extends Groupable>(items: readonly T[], readOnly: boolean): T[][] {
  const sections: T[][] = CARD_ACTION_GROUPS.map(() => [])
  for (const raw of items) {
    if (raw.inMenu === false) continue
    const item = readOnly ? readOnlyFilter(raw) : raw
    if (!item) continue
    const i = GROUP_INDEX.get(item.group) ?? sections.length - 1
    sections[i].push(item)
  }
  return sections.filter((s) => s.length > 0)
}

export type MenuRow<T> = { kind: 'item'; item: T } | { kind: 'sep'; key: string }

/** Flattens sections into rows with one separator between neighbouring sections (never at the ends). */
export function withSeparators<T>(sections: readonly (readonly T[])[]): MenuRow<T>[] {
  const rows: MenuRow<T>[] = []
  sections.forEach((section, i) => {
    if (!section.length) return
    if (rows.length) rows.push({ kind: 'sep', key: `sep-${i}` })
    for (const item of section) rows.push({ kind: 'item', item })
  })
  return rows
}

/** Provider buttons always shown in the selection toolbar, even when the rest overflow into More. */
export const TOOLBAR_KEEP = 3
/** Below this window width the toolbar always keeps only TOOLBAR_KEEP provider buttons. */
export const NARROW_WINDOW = 520

export interface ToolbarFit {
  /** Width the bar may use (the canvas width minus 32px). */
  available: number
  /** Width of everything that is always there (colour dots, Duplicate, Delete, More, padding). */
  fixed: number
  /** Width of one provider button, separators included. */
  button: number
  windowWidth: number
}

/** Which provider buttons the selection toolbar shows; the others are reached through More. */
export function splitToolbarActions<T>(actions: readonly T[], fit: ToolbarFit, keep = TOOLBAR_KEEP): { shown: T[]; overflow: T[] } {
  const tooWide = fit.fixed + actions.length * fit.button > fit.available
  if (actions.length <= keep || (!tooWide && fit.windowWidth >= NARROW_WINDOW)) return { shown: [...actions], overflow: [] }
  return { shown: actions.slice(0, keep), overflow: actions.slice(keep) }
}
