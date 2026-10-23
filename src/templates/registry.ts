/** Every choice offered by the template gallery, looked up by id. */
import { Plus } from 'lucide-react'
import { BUILT_IN_TEMPLATES } from './definitions'
import { BLANK_TEMPLATE_ID, type BoardTemplate, type TemplateChoice } from './types'

export * from './types'

export const BLANK_BOARD: BoardTemplate = {
  id: BLANK_TEMPLATE_ID,
  name: 'Blank board',
  title: 'New board',
  description: 'Start from an empty canvas.',
  icon: Plus,
  color: null,
  boardIcon: null,
  build: () => {},
}

export const TEMPLATES: readonly BoardTemplate[] = BUILT_IN_TEMPLATES

/** Gallery order: the blank board first, then the templates. */
export const TEMPLATE_CHOICES: readonly BoardTemplate[] = [BLANK_BOARD, ...TEMPLATES]

export function getTemplate(id: TemplateChoice | string): BoardTemplate | undefined {
  return TEMPLATE_CHOICES.find((t) => t.id === id)
}

/** Title of the board a template creates. */
export const templateBoardTitle = (t: BoardTemplate) => t.title ?? t.name
