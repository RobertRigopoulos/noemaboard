import {
  CheckSquare,
  Columns3,
  FileText,
  Image,
  LayoutGrid,
  Link2,
  MessageSquare,
  MoveUpRight,
  Paperclip,
  Palette,
  PenLine,
  StickyNote,
} from 'lucide-react'
import type { CardType } from '../model/types'
import type { CardDefinition } from './types'
import { NoteCard } from './text/NoteCard'
import { TodoCard } from './text/TodoCard'
import { DocumentCard } from './text/DocumentCard'
import { ImageCard } from './media/ImageCard'
import { FileCard } from './media/FileCard'
import { LinkCard } from './media/LinkCard'
import { ColumnCard } from './structure/ColumnCard'
import { BoardCard } from './structure/BoardCard'
import { CommentCard } from './structure/CommentCard'
import { SwatchCard } from './creative/SwatchCard'
import { SketchCard } from './creative/SketchCard'

const NoBody = () => null

export const CARD_DEFINITIONS: Record<CardType, CardDefinition> = {
  note: { type: 'note', label: 'Note', icon: StickyNote, Component: NoteCard, resize: 'width', editable: true, frame: 'paper', colorable: true },
  todo: { type: 'todo', label: 'To-do', icon: CheckSquare, Component: TodoCard, resize: 'width', editable: true, frame: 'paper', colorable: true },
  link: { type: 'link', label: 'Link', icon: Link2, Component: LinkCard, resize: 'width', editable: true, frame: 'paper', colorable: true },
  image: { type: 'image', label: 'Image', icon: Image, Component: ImageCard, resize: 'width', keepAspect: true, editable: true, frame: 'paper', colorable: true },
  file: { type: 'file', label: 'File', icon: Paperclip, Component: FileCard, resize: 'width', editable: false, frame: 'paper', colorable: true },
  board: { type: 'board', label: 'Board', icon: LayoutGrid, Component: BoardCard, resize: 'none', editable: true, frame: 'bare', colorable: true },
  column: { type: 'column', label: 'Column', icon: Columns3, Component: ColumnCard, resize: 'width', editable: true, frame: 'bare', colorable: true },
  line: { type: 'line', label: 'Line', icon: MoveUpRight, Component: NoBody, resize: 'none', editable: true, frame: 'bare', colorable: true },
  comment: { type: 'comment', label: 'Comment', icon: MessageSquare, Component: CommentCard, resize: 'width', editable: true, frame: 'paper', colorable: false },
  swatch: { type: 'swatch', label: 'Color', icon: Palette, Component: SwatchCard, resize: 'both', editable: true, frame: 'bare', colorable: false },
  sketch: { type: 'sketch', label: 'Sketch', icon: PenLine, Component: SketchCard, resize: 'both', editable: true, frame: 'bare', colorable: false },
  document: { type: 'document', label: 'Document', icon: FileText, Component: DocumentCard, resize: 'none', editable: true, frame: 'bare', colorable: true },
}

export function getDefinition(type: CardType): CardDefinition | undefined {
  return CARD_DEFINITIONS[type]
}
