/**
 * The canvas's own card actions (registered at module load; Canvas imports this file): align,
 * distribute and tidy, lock position, and stacking order. Chrome renders them in the context menu
 * and the selection toolbar; shortcuts.ts runs the ones with `keys`.
 */
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  Grid2x2,
  Lock,
  type LucideIcon,
} from 'lucide-react'
import { keysHint, registerCardActions, type CardAction } from '../cards/cardActions'
import { isMac } from '../ui/menus/keys'
import type { BoardContextValue } from './BoardContext'
import type { IndexedCard } from './cardIndex'
import type { ArrangeMode } from './arrange'
import { arrange, arrangeSelection, stepZOrder } from './actions'
import { useSelection } from './store'
import { LOCAL_ORIGIN, updateCards } from '../model/board'
import { getUser } from '../collab/identity'
import { isPinnedComment } from '../cards/structure/attach'

/** Free, unlocked, on-canvas, non-line cards that are not pinned comments: the ones Align, Distribute and Tidy move. */
export function isArrangeable(c: IndexedCard, lookup: (id: string) => IndexedCard | undefined): boolean {
  return !c.parent && !c.unsorted && c.type !== 'line' && c.card.locked !== true && !isPinnedComment(c, lookup)
}

/** Makes sure an action runs on the cards it was offered for (a menu may outlive a selection change). */
function syncSelection(cards: readonly IndexedCard[]) {
  const sel = useSelection.getState()
  const ids = cards.map((c) => c.id)
  if (ids.length !== sel.selected.size || ids.some((id) => !sel.selected.has(id))) sel.select(ids)
}

const ALIGN: { mode: ArrangeMode; label: string; icon: LucideIcon; keys?: string; min: number }[] = [
  { mode: 'left', label: 'Align left', icon: AlignStartVertical, keys: 'Alt+A', min: 2 },
  { mode: 'hcenter', label: 'Align centres horizontally', icon: AlignCenterVertical, keys: 'Alt+H', min: 2 },
  { mode: 'right', label: 'Align right', icon: AlignEndVertical, keys: 'Alt+D', min: 2 },
  { mode: 'top', label: 'Align top', icon: AlignStartHorizontal, keys: 'Alt+W', min: 2 },
  { mode: 'vmiddle', label: 'Align middles', icon: AlignCenterHorizontal, keys: 'Alt+V', min: 2 },
  { mode: 'bottom', label: 'Align bottom', icon: AlignEndHorizontal, keys: 'Alt+S', min: 2 },
  { mode: 'distribute-h', label: 'Distribute horizontally', icon: AlignHorizontalDistributeCenter, keys: 'Alt+Shift+H', min: 3 },
  { mode: 'distribute-v', label: 'Distribute vertically', icon: AlignVerticalDistributeCenter, keys: 'Alt+Shift+V', min: 3 },
  { mode: 'tidy', label: 'Tidy up', icon: Grid2x2, min: 2 },
]

function alignAction(ctx: BoardContextValue, cards: readonly IndexedCard[]): CardAction | null {
  const lookup = (id: string) => ctx.index.get(id)
  const count = cards.filter((c) => isArrangeable(c, lookup)).length
  if (count < 2) return null
  return {
    id: 'arrange.align',
    label: 'Align and distribute',
    icon: AlignStartVertical,
    group: 'arrange',
    inToolbar: true,
    children: ALIGN.map((a) => ({
      id: `arrange.${a.mode}`,
      label: a.label,
      icon: a.icon,
      group: 'arrange',
      keys: a.keys,
      disabled: count < a.min,
      run: () => {
        syncSelection(cards)
        ctx.undo.stopCapturing()
        arrangeSelection(ctx.doc, a.mode)
      },
    })),
  }
}

function lockAction(ctx: BoardContextValue, cards: readonly IndexedCard[]): CardAction | null {
  const target = cards.filter((c) => !c.unsorted)
  if (!target.length) return null
  const allLocked = target.every((c) => c.card.locked === true)
  // A toggle keeps one label; `pressed` carries the state ("Lock position, pressed" = locked).
  return {
    id: 'card.lock',
    label: 'Lock position',
    icon: Lock,
    group: 'arrange',
    inToolbar: true,
    pressed: allLocked,
    keys: 'Mod+Shift+L',
    run: () => {
      ctx.undo.stopCapturing()
      const patches: Record<string, Record<string, unknown>> = {}
      for (const c of target) patches[c.id] = { locked: !allLocked }
      updateCards(ctx.doc, patches, getUser().id, LOCAL_ORIGIN)
    },
  }
}

function zOrderActions(ctx: BoardContextValue, cards: readonly IndexedCard[]): CardAction[] {
  if (!cards.some((c) => !c.unsorted)) return []
  const run = (fn: () => void) => () => {
    syncSelection(cards)
    ctx.undo.stopCapturing()
    fn()
  }
  // shortcuts.ts handles these keys itself (they act without a selection too), so they are display
  // hints, formatted like the `keys` of other actions.
  const hint = (keys: string) => keysHint(keys, isMac)
  return [
    { id: 'arrange.front', label: 'Bring to front', icon: ArrowUpToLine, group: 'arrange', hint: hint('Mod+]'), run: run(() => arrange(ctx.doc, 'front')) },
    { id: 'arrange.forward', label: 'Bring forward', icon: ChevronUp, group: 'arrange', hint: hint('Mod+Shift+ArrowUp'), run: run(() => stepZOrder(ctx.doc, 'forward')) },
    { id: 'arrange.backward', label: 'Send backward', icon: ChevronDown, group: 'arrange', hint: hint('Mod+Shift+ArrowDown'), run: run(() => stepZOrder(ctx.doc, 'backward')) },
    { id: 'arrange.back', label: 'Send to back', icon: ArrowDownToLine, group: 'arrange', hint: hint('Mod+['), run: run(() => arrange(ctx.doc, 'back')) },
  ]
}

export function arrangeProvider(ctx: BoardContextValue, cards: readonly IndexedCard[]): CardAction[] {
  const out: CardAction[] = []
  const align = alignAction(ctx, cards)
  if (align) out.push(align)
  const lock = lockAction(ctx, cards)
  if (lock) out.push(lock)
  out.push(...zOrderActions(ctx, cards))
  return out
}

registerCardActions(arrangeProvider)
