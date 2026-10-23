import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Card, CardMap, CardType } from '../model/types'

/** Props every card body component receives from <CardShell>. */
export interface CardProps<C extends Card = Card> {
  id: string
  /** Snapshot of primitive fields (re-rendered when they change). */
  card: C
  /** Live Y.Map of the card for nested types (rich text, threads, strokes). */
  map: CardMap
  selected: boolean
  /** True while this card is in text-edit mode (double-click / Enter / just created). */
  editing: boolean
  /** Rendered inside a column (width is the column's width). */
  inColumn: boolean
  readOnly: boolean
  /** Ask the shell to enter edit mode for this card. */
  startEditing: () => void
  /** Leave edit mode (e.g. Escape). */
  stopEditing: () => void
}

export interface CardDefinition {
  type: CardType
  label: string
  icon: LucideIcon
  Component: ComponentType<CardProps<any>>
  /** Which resize handle the shell shows. */
  resize: 'none' | 'width' | 'both'
  /** Keep aspect ratio while resizing (images). */
  keepAspect?: boolean
  /** Double-click / Enter puts the card in edit mode. */
  editable: boolean
  /** 'paper' = white card with shadow drawn by the shell; 'bare' = component draws everything. */
  frame: 'paper' | 'bare'
  /** Can the user pick a color for this card. */
  colorable: boolean
}
