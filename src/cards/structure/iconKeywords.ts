/**
 * Search words for the board icon picker: 2-5 keywords per icon id of model/boardIcons.ts, so typing
 * 'travel', 'trip' or 'flight' all find the plane.
 */
import { BOARD_ICONS, type BoardIconInfo } from '../../model/boardIcons'

export const ICON_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  folder: ['files', 'archive', 'directory', 'general'],
  kanban: ['board', 'workflow', 'tasks', 'sprint', 'agile'],
  'list-checks': ['todo', 'tasks', 'checklist', 'done'],
  calendar: ['schedule', 'date', 'events', 'planning'],
  'alarm-clock': ['time', 'due', 'reminder', 'urgent'],
  target: ['objective', 'aim', 'focus', 'okr'],
  flag: ['milestone', 'goal', 'finish', 'country'],
  briefcase: ['job', 'business', 'career', 'office'],
  'chart-column': ['stats', 'analytics', 'data', 'metrics', 'bar'],
  'trending-up': ['growth', 'progress', 'sales', 'increase'],
  users: ['people', 'team', 'group', 'members', 'crew'],
  handshake: ['deal', 'agreement', 'partners', 'client'],
  megaphone: ['announcement', 'campaign', 'promotion', 'pr'],
  'message-circle': ['chat', 'talk', 'feedback', 'conversation'],
  mail: ['email', 'letter', 'inbox', 'newsletter'],
  repeat: ['retro', 'loop', 'cycle', 'recurring'],
  lightbulb: ['ideas', 'brainstorm', 'concept', 'innovation'],
  brain: ['mind', 'think', 'knowledge', 'smart'],
  sparkles: ['magic', 'inspiration', 'new', 'shine'],
  'notebook-pen': ['notes', 'journal', 'diary', 'writing'],
  'file-text': ['doc', 'paper', 'text', 'brief'],
  'book-open': ['reading', 'story', 'study', 'novel'],
  library: ['books', 'collection', 'reference', 'resources'],
  feather: ['writing', 'poetry', 'author', 'quill'],
  newspaper: ['articles', 'press', 'blog', 'media'],
  'graduation-cap': ['school', 'education', 'course', 'university', 'study'],
  search: ['research', 'find', 'discover', 'explore'],
  puzzle: ['problem', 'game', 'pieces', 'solve'],
  palette: ['design', 'colors', 'art', 'paint'],
  brush: ['paint', 'art', 'drawing', 'artist'],
  'pen-tool': ['vector', 'illustration', 'graphic', 'design'],
  shapes: ['geometry', 'forms', 'design', 'abstract'],
  layers: ['stack', 'levels', 'design', 'mockup'],
  camera: ['photo', 'photography', 'shoot', 'pictures'],
  image: ['pictures', 'gallery', 'moodboard', 'visual'],
  clapperboard: ['film', 'movie', 'video', 'cinema', 'scene'],
  music: ['song', 'audio', 'band', 'playlist'],
  mic: ['podcast', 'audio', 'voice', 'interview', 'recording'],
  gamepad: ['games', 'play', 'gaming', 'console'],
  code: ['programming', 'developer', 'software', 'dev'],
  laptop: ['computer', 'tech', 'work', 'remote'],
  smartphone: ['phone', 'mobile', 'app', 'device'],
  wrench: ['tools', 'fix', 'settings', 'maintenance'],
  flask: ['science', 'experiment', 'lab', 'test'],
  rocket: ['launch', 'startup', 'release', 'ship', 'space'],
  package: ['product', 'box', 'delivery', 'shipping'],
  house: ['home', 'family', 'personal', 'household'],
  building: ['office', 'company', 'city', 'architecture'],
  store: ['shop', 'retail', 'business', 'market'],
  'shopping-cart': ['shopping', 'buy', 'groceries', 'cart'],
  gift: ['present', 'birthday', 'wishlist', 'party'],
  heart: ['love', 'favourite', 'favorite', 'health', 'like'],
  star: ['favourite', 'favorite', 'important', 'rating'],
  trophy: ['award', 'win', 'achievement', 'prize'],
  plane: ['travel', 'trip', 'flight', 'vacation', 'holiday'],
  map: ['travel', 'route', 'location', 'places'],
  compass: ['explore', 'direction', 'adventure', 'navigation'],
  globe: ['world', 'international', 'earth', 'web'],
  mountain: ['outdoors', 'hiking', 'nature', 'adventure'],
  sprout: ['garden', 'plants', 'growth', 'seedling'],
  leaf: ['nature', 'eco', 'green', 'plants'],
  sun: ['summer', 'weather', 'day', 'sunny'],
  moon: ['night', 'sleep', 'dark', 'evening'],
  coffee: ['cafe', 'break', 'drink', 'morning'],
  utensils: ['food', 'recipes', 'cooking', 'restaurant', 'meals'],
  dumbbell: ['fitness', 'gym', 'workout', 'sport', 'exercise'],
  'paw-print': ['pets', 'dog', 'cat', 'animals'],
  wallet: ['money', 'budget', 'finance', 'expenses'],
  lock: ['private', 'secure', 'secret', 'password'],
  zap: ['energy', 'power', 'fast', 'electric'],
}

/** Words an icon can be found by: its label, its id parts and its keywords (lower case). */
function wordsOf(icon: BoardIconInfo): string[] {
  const text = [icon.label, icon.id.replace(/-/g, ' '), ...(ICON_KEYWORDS[icon.id] ?? [])].join(' ')
  return text.toLocaleLowerCase().split(/[\s/-]+/).filter(Boolean)
}

const WORDS = new Map<string, string[]>(BOARD_ICONS.map((i) => [i.id, wordsOf(i)]))

/**
 * Icons matching a search: every word of the query must start one of the icon's words
 * (case-insensitive). An empty query returns all icons.
 */
export function filterIcons(query: string, icons: readonly BoardIconInfo[] = BOARD_ICONS): BoardIconInfo[] {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return [...icons]
  return icons.filter((icon) => {
    const words = WORDS.get(icon.id) ?? wordsOf(icon)
    return terms.every((t) => words.some((w) => w.startsWith(t)))
  })
}
