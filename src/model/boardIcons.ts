/**
 * Board icons are chosen from a fixed set of line icons and stored by id (never emoji or free
 * text). Kept free of React/icon imports so the data layer can validate ids from peers.
 */

export interface BoardIconInfo {
  id: string
  label: string
}

export const BOARD_ICONS: readonly BoardIconInfo[] = [
  // work & planning
  { id: 'folder', label: 'Folder' },
  { id: 'kanban', label: 'Kanban' },
  { id: 'list-checks', label: 'Checklist' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'alarm-clock', label: 'Deadline' },
  { id: 'target', label: 'Goal' },
  { id: 'flag', label: 'Milestone' },
  { id: 'briefcase', label: 'Work' },
  { id: 'chart-column', label: 'Report' },
  { id: 'trending-up', label: 'Growth' },
  { id: 'users', label: 'Team' },
  { id: 'handshake', label: 'Partners' },
  { id: 'megaphone', label: 'Marketing' },
  { id: 'message-circle', label: 'Discussion' },
  { id: 'mail', label: 'Mail' },
  { id: 'repeat', label: 'Retrospective' },
  // ideas & writing
  { id: 'lightbulb', label: 'Idea' },
  { id: 'brain', label: 'Thinking' },
  { id: 'sparkles', label: 'Inspiration' },
  { id: 'notebook-pen', label: 'Notes' },
  { id: 'file-text', label: 'Document' },
  { id: 'book-open', label: 'Book' },
  { id: 'library', label: 'Library' },
  { id: 'feather', label: 'Writing' },
  { id: 'newspaper', label: 'News' },
  { id: 'graduation-cap', label: 'Learning' },
  { id: 'search', label: 'Research' },
  { id: 'puzzle', label: 'Puzzle' },
  // making
  { id: 'palette', label: 'Design' },
  { id: 'brush', label: 'Art' },
  { id: 'pen-tool', label: 'Illustration' },
  { id: 'shapes', label: 'Shapes' },
  { id: 'layers', label: 'Layers' },
  { id: 'camera', label: 'Photography' },
  { id: 'image', label: 'Images' },
  { id: 'clapperboard', label: 'Film' },
  { id: 'music', label: 'Music' },
  { id: 'mic', label: 'Podcast' },
  { id: 'gamepad', label: 'Games' },
  { id: 'code', label: 'Code' },
  { id: 'laptop', label: 'Computer' },
  { id: 'smartphone', label: 'Mobile' },
  { id: 'wrench', label: 'Tools' },
  { id: 'flask', label: 'Experiment' },
  { id: 'rocket', label: 'Launch' },
  { id: 'package', label: 'Product' },
  // life & places
  { id: 'house', label: 'Home' },
  { id: 'building', label: 'Office' },
  { id: 'store', label: 'Shop' },
  { id: 'shopping-cart', label: 'Shopping' },
  { id: 'gift', label: 'Gift' },
  { id: 'heart', label: 'Favourite' },
  { id: 'star', label: 'Star' },
  { id: 'trophy', label: 'Achievement' },
  { id: 'plane', label: 'Travel' },
  { id: 'map', label: 'Map' },
  { id: 'compass', label: 'Explore' },
  { id: 'globe', label: 'World' },
  { id: 'mountain', label: 'Outdoors' },
  { id: 'sprout', label: 'Garden' },
  { id: 'leaf', label: 'Nature' },
  { id: 'sun', label: 'Summer' },
  { id: 'moon', label: 'Night' },
  { id: 'coffee', label: 'Coffee' },
  { id: 'utensils', label: 'Food' },
  { id: 'dumbbell', label: 'Fitness' },
  { id: 'paw-print', label: 'Pets' },
  { id: 'wallet', label: 'Money' },
  { id: 'lock', label: 'Private' },
  { id: 'zap', label: 'Energy' },
]

const IDS = new Set(BOARD_ICONS.map((i) => i.id))

export function isBoardIconId(v: unknown): v is string {
  return typeof v === 'string' && IDS.has(v)
}

export function boardIconLabel(id: string): string {
  return BOARD_ICONS.find((i) => i.id === id)?.label ?? 'Board'
}
