/**
 * Board data model.
 *
 * Every board is its own Y.Doc (guid = board id) with three top-level types:
 *   meta  : Y.Map  -> BoardMeta fields
 *   cards : Y.Map<Y.Map>  card id -> card (fields below)
 *   trash : Y.Map<Y.Map>  trash entry id -> { id, deletedAt, deletedBy, cards: Y.Array<Y.Map> }
 *
 * Card fields are stored directly on the card's Y.Map. Primitive fields are plain
 * values (last writer wins). Collaborative text lives in nested Y types
 * (Y.XmlFragment for rich text, Y.Array for comment threads and sketch strokes).
 *
 * A fourth top-level type, members : Y.Map, holds the board's member roster (see model/members.ts).
 *
 * Fields come from peers and are untrusted: readCard() sanitises the core fields and passes every
 * other field through untouched, so each feature reads its own fields through a validator taking
 * `unknown`. Optional fields documented as "validated by the reader" were added later; older app
 * versions ignore them.
 *
 * Blob references (content hashes of images, thumbnails, favicons, covers...) must be TOP-LEVEL
 * string fields of a card holding a lowercase 64-hex SHA-256, never nested inside objects: sync
 * scope checks and backups find them by scanning top-level fields (see model/blobRefs.ts).
 */
import type * as Y from 'yjs'

export const CARD_TYPES = [
  'note',
  'todo',
  'link',
  'image',
  'file',
  'board',
  'column',
  'line',
  'comment',
  'swatch',
  'sketch',
  'document',
] as const

export type CardType = (typeof CARD_TYPES)[number]

/** Card types that may live inside a column. */
export const COLUMN_CHILD_TYPES: ReadonlySet<CardType> = new Set<CardType>([
  'note',
  'todo',
  'link',
  'image',
  'file',
  'board',
  'comment',
  'swatch',
  'sketch',
  'document',
])

/** Named card colors. The actual CSS colors live in styles (light + dark). */
export const CARD_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'brown',
  'grey',
  'dark',
] as const
export type CardColor = (typeof CARD_COLORS)[number]

/** Fields shared by every card. */
export interface CardBase {
  id: string
  type: CardType
  /** Board coordinates of the top-left corner. Ignored while the card is in a column. */
  x: number
  y: number
  /** Width in board units. */
  w: number
  /** Height in board units for explicitly sized cards (image, sketch, swatch...). Auto-height cards omit it. */
  h?: number
  /** Stacking order. Higher is on top. */
  z: number
  /** Column card id when the card is stacked inside a column, else null. */
  parent: string | null
  /** Fractional index (see `fractional-indexing`) ordering cards inside a column. */
  order: string
  color: CardColor | null
  locked?: boolean
  /**
   * True for a top-level card that sits in the board's Unsorted drawer instead of on the canvas
   * (see model/unsorted.ts). It keeps real x/y because older versions draw it there.
   * Validated by the reader; older versions ignore it.
   */
  unsorted?: boolean
  /** Set while the card is in the trash (soft delete) or was moved to another board. */
  trashedAt?: number | null
  createdAt: number
  createdBy: string
  updatedAt: number
  updatedBy: string
}

export interface NoteCard extends CardBase {
  type: 'note'
  /** Y.XmlFragment field name: 'content' */
}

export interface TodoCard extends CardBase {
  type: 'todo'
  title: string
  /** Y.XmlFragment field 'content' holds a task list. */
  /** Hide checked tasks. Validated by the reader; older versions ignore it. */
  hideDone?: boolean
}

export interface DocumentCard extends CardBase {
  type: 'document'
  title: string
  /** Y.XmlFragment field 'content' holds the long-form document. */
}

export interface LinkCard extends CardBase {
  type: 'link'
  url: string
  title: string
  description: string
  siteName: string
  /** Preview image: content hash of a blob, or a remote URL. */
  imageBlob: string | null
  imageUrl: string | null
  favicon: string | null
  /** Set when the link can be embedded (YouTube, Vimeo, ...). aspect = width / height. */
  embed: { provider: string; src: string; aspect: number } | null
  /** 'idle' | 'loading' | 'done' | 'error' for the preview fetch. */
  previewState: 'idle' | 'loading' | 'done' | 'error'
  /** User id of the person whose app fetches the preview (only they fetch, never other peers). */
  previewBy?: string
  /** The URL the stored preview belongs to. */
  previewFor?: string | null
  /** Display toggles of the preview parts. Validated by the reader; older versions ignore them. */
  hideImage?: boolean
  hideDescription?: boolean
  hideUrl?: boolean
  /** Show an embeddable link (video, map...) as a plain link preview instead of the player. Validated by the reader; older versions ignore it. */
  embedAsLink?: boolean
  /** Hide the caption even when it has text. Validated by the reader; older versions ignore it. */
  captionHidden?: boolean
  /** Y.XmlFragment field 'caption' */
}

export interface ImageCard extends CardBase {
  type: 'image'
  blob: string
  mime: string
  name: string
  /** Intrinsic pixel size of the original image. */
  iw: number
  ih: number
  /** Blob hash of a smaller display copy (≤ 800px), if one was made on import. */
  thumb?: string | null
  /**
   * Visible part as fractions (0..1) of the rotated image; null or absent = the whole image.
   * Validated by the reader; older versions ignore it.
   */
  crop?: { x: number; y: number; w: number; h: number } | null
  /** Clockwise rotation in degrees. Validated by the reader; older versions ignore it. */
  rotation?: 0 | 90 | 180 | 270
  /** Mirror horizontally / vertically. Validated by the reader; older versions ignore them. */
  flipH?: boolean
  flipV?: boolean
  /** Alternative text for screen readers and exports. Validated by the reader; older versions ignore it. */
  alt?: string
  /** Hide the caption even when it has text. Validated by the reader; older versions ignore it. */
  captionHidden?: boolean
  /** Y.XmlFragment field 'caption' */
}

export interface FileCard extends CardBase {
  type: 'file'
  blob: string
  name: string
  size: number
  mime: string
}

export interface BoardCard extends CardBase {
  type: 'board'
  boardId: string
  /** Capability secret of the child board. Anyone who can read this card can open the child board. */
  secret: string
  /** Cached title/icon/color of the child board for display when the child doc is not loaded. */
  title: string
  icon: string | null
  /**
   * Cached number of active cards on the child board, written by whoever has it open (derived, not
   * content). Validated by the reader; older versions ignore it.
   */
  childCount?: number
  /** Cached blob hash of the child board's cover image. Validated by the reader; older versions ignore it. */
  cover?: string | null
}

export interface ColumnCard extends CardBase {
  type: 'column'
  title: string
  collapsed: boolean
}

export interface LineEnd {
  /** Attached card id, or null for a free point. */
  card: string | null
  /** Free point (board coords) used when card is null; last known position otherwise. */
  x: number
  y: number
}

export interface LineCard extends CardBase {
  type: 'line'
  from: LineEnd
  to: LineEnd
  /** Perpendicular offset of the curve's control point from the straight line's midpoint. 0 = straight. */
  bend: number
  label: string
  dashed: boolean
  arrowStart: boolean
  arrowEnd: boolean
  thickness: number
}

export interface CommentMessage {
  id: string
  authorId: string
  authorName: string
  authorColor: string
  text: string
  createdAt: number
  editedAt: number | null
  /** User ids mentioned in `text`. Validated by the reader; older versions ignore it. */
  mentions?: string[]
}

export interface CommentCard extends CardBase {
  type: 'comment'
  resolved: boolean
  /**
   * Id of the card this comment is pinned to: it is deleted, moved and copied together with that
   * card. null or absent = a free comment. Validated by the reader; older versions ignore it.
   */
  attachedTo?: string | null
  /** Shown as a small pin instead of the full thread. Validated by the reader; older versions ignore it. */
  collapsed?: boolean
  /** Y.Array<Y.Map> field 'thread' of CommentMessage. */
}

export interface SwatchCard extends CardBase {
  type: 'swatch'
  hex: string
  name: string
}

export interface SketchStroke {
  id: string
  /** Flattened [x, y, pressure, x, y, pressure, ...] in the card's vw/vh drawing units. */
  points: number[]
  color: string
  size: number
}

export interface SketchCard extends CardBase {
  type: 'sketch'
  /** Y.Array<SketchStroke> field 'strokes'. h is required. */
  /** Drawing coordinate space (stroke units). The drawing scales when the card is resized. */
  vw: number
  vh: number
}

export type Card =
  | NoteCard
  | TodoCard
  | DocumentCard
  | LinkCard
  | ImageCard
  | FileCard
  | BoardCard
  | ColumnCard
  | LineCard
  | CommentCard
  | SwatchCard
  | SketchCard

export type CardOf<T extends CardType> = Extract<Card, { type: T }>

/** Names of nested Y types per card type, created together with the card. */
export const CARD_YTYPES: Record<CardType, Record<string, 'xml' | 'array'>> = {
  note: { content: 'xml' },
  todo: { content: 'xml' },
  document: { content: 'xml' },
  link: { caption: 'xml' },
  image: { caption: 'xml' },
  file: {},
  board: {},
  column: {},
  line: {},
  comment: { thread: 'array' },
  swatch: {},
  sketch: { strokes: 'array' },
}

/** Default widths/heights in board units. */
export const GRID = 10
export const DEFAULT_SIZE: Record<CardType, { w: number; h?: number }> = {
  note: { w: 300 },
  todo: { w: 300 },
  document: { w: 200 },
  link: { w: 300 },
  image: { w: 300 },
  file: { w: 300 },
  board: { w: 130 },
  column: { w: 320 },
  line: { w: 0 },
  comment: { w: 300 },
  swatch: { w: 140, h: 160 },
  sketch: { w: 400, h: 300 },
}

export const MIN_WIDTH: Record<CardType, number> = {
  note: 120,
  todo: 160,
  document: 140,
  link: 160,
  image: 60,
  file: 160,
  board: 100,
  column: 200,
  line: 0,
  comment: 200,
  swatch: 80,
  sketch: 80,
}

export interface BoardMeta {
  id: string
  title: string
  /** Emoji or short text shown on the board card. */
  icon: string | null
  color: CardColor | null
  /** Board this board was created in (for breadcrumbs). null for top-level boards. */
  parentId: string | null
  createdAt: number
  createdBy: string
  /** True once an invite link has been created; peers then keep this board's room open. */
  shared: boolean
  /** Optional relay server URL used by everyone on this board. */
  relay: string | null
  /** Blob hash of the board's cover image. Validated by the reader; older versions ignore it. */
  cover?: string | null
  /** Schema version for future migrations. */
  version: number
}

export const SCHEMA_VERSION = 1

/** Local-only identity of the person using this app instance. */
export interface UserProfile {
  id: string
  name: string
  color: string
}

/** Awareness state published per board. */
export interface PresenceState {
  user: UserProfile
  /** Pointer position in board coordinates, or null when outside the canvas. */
  pointer: { x: number; y: number } | null
  /** Selected card ids. */
  selection: string[]
  /** Card currently being text-edited. */
  editing: string | null
  /** y-prosemirror caret, managed by the editor (field name 'cursor'). */
  cursor?: unknown
}

export type CardMap = Y.Map<unknown>
