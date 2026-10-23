/**
 * Multi-selection in the Unsorted drawer list (pure): click, Shift/Ctrl+click, Shift+Arrow ranges,
 * and which cards a drag or a keyboard action takes. `ids` is always the list in drawer order.
 */

export interface ListSelection {
  selected: ReadonlySet<string>
  /** Where Shift ranges start. */
  anchor: string | null
  /** The row with keyboard focus. */
  focus: string | null
}

export const EMPTY_SELECTION: ListSelection = { selected: new Set(), anchor: null, focus: null }

/** Ids from `a` to `b` inclusive, in list order (empty when either is missing). */
export function rangeBetween(ids: readonly string[], a: string, b: string): string[] {
  const i = ids.indexOf(a)
  const j = ids.indexOf(b)
  if (i < 0 || j < 0) return []
  return ids.slice(Math.min(i, j), Math.max(i, j) + 1)
}

export interface ClickMods {
  /** Shift: select the range from the anchor. */
  range: boolean
  /** Ctrl / Cmd: add or remove one row. */
  toggle: boolean
}

export function clickSelect(sel: ListSelection, ids: readonly string[], id: string, mods: ClickMods): ListSelection {
  if (!ids.includes(id)) return sel
  if (mods.range && sel.anchor && ids.includes(sel.anchor)) {
    const range = rangeBetween(ids, sel.anchor, id)
    const selected = new Set(mods.toggle ? [...sel.selected, ...range] : range)
    return { selected, anchor: sel.anchor, focus: id }
  }
  if (mods.toggle) {
    const selected = new Set(sel.selected)
    if (selected.has(id)) selected.delete(id)
    else selected.add(id)
    return { selected, anchor: id, focus: id }
  }
  return { selected: new Set([id]), anchor: id, focus: id }
}

/** Arrow keys: move focus (and select that row), or with `extend` grow the range from the anchor. */
export function moveFocus(sel: ListSelection, ids: readonly string[], dir: 1 | -1 | 'first' | 'last', extend: boolean): ListSelection {
  if (!ids.length) return EMPTY_SELECTION
  const cur = sel.focus ? ids.indexOf(sel.focus) : -1
  let next: number
  if (dir === 'first') next = 0
  else if (dir === 'last') next = ids.length - 1
  else if (cur < 0) next = dir === 1 ? 0 : ids.length - 1
  else next = Math.min(ids.length - 1, Math.max(0, cur + dir))
  const focus = ids[next]
  if (extend) {
    const anchor = sel.anchor && ids.includes(sel.anchor) ? sel.anchor : (sel.focus ?? focus)
    return { selected: new Set(rangeBetween(ids, anchor, focus)), anchor, focus }
  }
  return { selected: new Set([focus]), anchor: focus, focus }
}

/** Drops rows that left the drawer (placed or deleted, by anyone); keeps focus on a nearby row. */
export function pruneSelection(sel: ListSelection, ids: readonly string[], prevIds: readonly string[] = ids): ListSelection {
  const live = new Set(ids)
  const selected = new Set([...sel.selected].filter((id) => live.has(id)))
  let focus = sel.focus && live.has(sel.focus) ? sel.focus : null
  if (!focus && sel.focus && ids.length) {
    // The focused row went away: focus whatever now sits at (or just before) its old position.
    const old = prevIds.indexOf(sel.focus)
    const after = old < 0 ? [] : prevIds.slice(old + 1).filter((id) => live.has(id))
    focus = after[0] ?? ids[ids.length - 1]
  }
  const anchor = sel.anchor && live.has(sel.anchor) ? sel.anchor : focus
  if (selected.size === sel.selected.size && focus === sel.focus && anchor === sel.anchor) return sel
  return { selected, anchor, focus }
}

/**
 * The cards an action on `id` applies to, in drawer order: the whole selection when `id` is part of
 * it, else just `id` (dragging an unselected row takes only that row).
 */
export function actionIds(sel: ListSelection, ids: readonly string[], id: string | null): string[] {
  if (id && !sel.selected.has(id)) return ids.includes(id) ? [id] : []
  return ids.filter((x) => sel.selected.has(x))
}
