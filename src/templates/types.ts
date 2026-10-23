import type * as Y from 'yjs'
import type { LucideIcon } from 'lucide-react'
import type { CardColor } from '../model/types'

export const TEMPLATE_IDS = [
  'project-plan',
  'weekly-planner',
  'brainstorm',
  'moodboard',
  'meeting-notes',
  'retrospective',
  'storyboard',
] as const

export type TemplateId = (typeof TEMPLATE_IDS)[number]

export const BLANK_TEMPLATE_ID = 'blank'

/** Anything the template gallery offers: a template or the blank board. */
export type TemplateChoice = TemplateId | typeof BLANK_TEMPLATE_ID

export interface BoardTemplate {
  id: TemplateChoice
  /** Shown in the gallery; also the new board's title unless `title` is set. */
  name: string
  /** One line for the gallery tile. */
  description: string
  /** Gallery tile icon. */
  icon: LucideIcon
  /** Gallery tile color and the new board's color. */
  color: CardColor | null
  /** Board icon id (src/model/boardIcons.ts) shown on the new board card, or null for the default glyph. */
  boardIcon: string | null
  /** Title of the created board when it differs from `name`. */
  title?: string
  /**
   * Fills an empty board doc with the template's cards. Writes are not undoable (SYSTEM_ORIGIN),
   * and a doc that already has cards is left alone.
   */
  build(doc: Y.Doc, userId: string): void
}
