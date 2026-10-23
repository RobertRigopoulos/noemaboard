/**
 * Extension points between feature folders and the board chrome.
 * Card actions: feature folders register providers at module load; the context menu and the selection
 * toolbar (src/ui/menus) render what providers return for the current selection, and the board shortcut
 * handler (src/board/shortcuts.ts) runs actions whose `keys` match a keydown.
 * Board overlays: components BoardChrome renders once per open board (lightbox, popovers, notifiers), so
 * feature folders can mount UI without editing chrome files.
 */
import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { BoardContextValue } from '../board/BoardContext'
import type { IndexedCard } from '../board/cardIndex'

/** Menu sections, rendered in this order with separators between them. */
export const CARD_ACTION_GROUPS = ['view', 'edit', 'media', 'convert', 'collab', 'arrange', 'export'] as const
export type CardActionGroup = (typeof CARD_ACTION_GROUPS)[number]

export interface CardAction {
  /** Unique and stable, e.g. 'image.crop'. */
  id: string
  label: string
  icon: LucideIcon
  group: CardActionGroup
  /** Shortcut run by the board while this action is offered and nothing is typed: '+'-joined optional Mod, Alt, Shift, then one key. Letters match the letter typed (KeyboardEvent.key; KeyboardEvent.code when the key types no ASCII letter), digits KeyboardEvent.code, anything else KeyboardEvent.key. Example: 'Mod+Alt+M'. */
  keys?: string
  /** Display-only shortcut text for keys handled elsewhere (e.g. 'Space'). Ignored when `keys` is set. */
  hint?: string
  /** Shown in the context menu. Default true. */
  inMenu?: boolean
  /** Shown as an icon button in the selection toolbar. Default false. */
  inToolbar?: boolean
  /** Toggle state: aria-pressed in the toolbar, menuitemcheckbox + aria-checked in the menu. */
  pressed?: boolean
  disabled?: boolean
  danger?: boolean
  /** Offered on read-only boards too (view, copy, download). Default false. */
  readOnlyOk?: boolean
  /** Sub-actions: a submenu in the context menu, a dropdown in the toolbar. The parent's run is ignored. */
  children?: CardAction[]
  /** anchor = screen rect of the toolbar button or menu item used; null when run from a shortcut. */
  run?: (anchor: DOMRect | null) => void | Promise<unknown>
}

/** Must be cheap and side-effect free: it runs on every selection-toolbar render. */
export type CardActionProvider = (ctx: BoardContextValue, cards: readonly IndexedCard[]) => CardAction[]

const providers: CardActionProvider[] = []

export function registerCardActions(provider: CardActionProvider): void {
  if (!providers.includes(provider)) providers.push(provider)
}

function allowed(a: CardAction, readOnly: boolean): CardAction | null {
  if (readOnly && !a.readOnlyOk) return null
  if (!a.children) return a
  const children = a.children.map((c) => allowed(c, readOnly)).filter((c): c is CardAction => !!c)
  return children.length ? { ...a, children } : null
}

/** Actions for the selection in registration order; a provider that throws is skipped. */
export function collectCardActions(ctx: BoardContextValue, cards: readonly IndexedCard[]): CardAction[] {
  const out: CardAction[] = []
  if (!cards.length) return out
  for (const provider of providers) {
    let list: CardAction[]
    try {
      list = provider(ctx, cards)
    } catch (err) {
      console.warn('Card action provider failed', err)
      continue
    }
    for (const a of list) {
      const ok = allowed(a, ctx.readOnly)
      if (ok) out.push(ok)
    }
  }
  return out
}

/** Leaf actions (children flattened), for shortcut dispatch. */
export function flattenActions(list: readonly CardAction[]): CardAction[] {
  return list.flatMap((a) => (a.children ? flattenActions(a.children) : [a]))
}

export type BoardOverlay = ComponentType<{ ctx: BoardContextValue }>
const overlays: { key: string; overlay: BoardOverlay }[] = []

/** `key` must be unique (React key). Overlays render for every open board, presenting or not. */
export function registerBoardOverlay(key: string, overlay: BoardOverlay): void {
  if (!overlays.some((o) => o.key === key)) overlays.push({ key, overlay })
}

export function boardOverlays(): readonly { key: string; overlay: BoardOverlay }[] {
  return overlays
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

const MODIFIERS = new Set(['Mod', 'Alt', 'Shift'])

function parseKeys(keys: string): { mods: Set<string>; key: string } | null {
  // A trailing '+' token means the plus key itself ('Mod++').
  const parts = keys.endsWith('++') ? [...keys.slice(0, -2).split('+'), '+'] : keys.split('+')
  const key = parts.pop()
  if (!key) return null
  const mods = new Set<string>()
  for (const p of parts) {
    if (!MODIFIERS.has(p)) return null
    mods.add(p)
  }
  return { mods, key }
}

/** True when the keydown matches an action's `keys` (modifiers are exact: unlisted ones must be up). */
export function matchesKeys(keys: string, e: KeyLike): boolean {
  const parsed = parseKeys(keys)
  if (!parsed) return false
  const { mods, key } = parsed
  if (mods.has('Mod') !== (e.ctrlKey || e.metaKey)) return false
  if (mods.has('Alt') !== e.altKey) return false
  if (mods.has('Shift') !== e.shiftKey) return false
  if (/^[A-Za-z]$/.test(key)) {
    // The letter the layout types, so the shortcut follows the key label on AZERTY or Dvorak.
    if (/^[A-Za-z]$/.test(e.key)) return e.key.toLowerCase() === key.toLowerCase()
    // No ASCII letter (macOS Option symbols, dead keys, non-Latin layouts): the physical key.
    return e.code === 'Key' + key.toUpperCase()
  }
  // Digits match the physical key: Shift changes e.key, and AZERTY types digits only with Shift.
  if (/^[0-9]$/.test(key)) return e.code === 'Digit' + key
  if (key === 'Space') return e.code === 'Space'
  if (key.length === 1) return e.key.toLowerCase() === key.toLowerCase()
  return e.key === key
}

const MAC_MODS: Record<string, string> = { Mod: '⌘', Alt: '⌥', Shift: '⇧' }
const PC_MODS: Record<string, string> = { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }
const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
}

/** Display text for `keys`: '⌘⌥M' on macOS, 'Ctrl+Alt+M' elsewhere. */
export function keysHint(keys: string, mac: boolean): string {
  const parsed = parseKeys(keys)
  if (!parsed) return keys
  // Fixed modifier order, whatever order the action author used.
  const mods = ['Mod', 'Alt', 'Shift'].filter((m) => parsed.mods.has(m))
  const key = KEY_NAMES[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key)
  if (mac) return mods.map((m) => MAC_MODS[m]).join('') + key
  return [...mods.map((m) => PC_MODS[m]), key].join('+')
}
