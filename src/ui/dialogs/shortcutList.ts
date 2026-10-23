/**
 * Every keyboard/mouse shortcut, kept in sync with src/board/shortcuts.ts, src/board/Canvas.tsx,
 * card actions' `keys` (src/cards/cardActions.ts), the chrome keys (src/ui/BoardChrome.tsx), the
 * image viewer and the rich-text editor (TipTap default keymaps). 'Mod' is Ctrl (Windows/Linux)
 * or ⌘ (macOS).
 */
export interface Shortcut {
  /** Alternative key combos; each combo is keys joined with '+'. */
  keys: string[]
  label: string
}

export interface ShortcutGroup {
  title: string
  items: Shortcut[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Add to the board',
    items: [
      { keys: ['N'], label: 'Note' },
      { keys: ['T'], label: 'To-do list' },
      { keys: ['C'], label: 'Column' },
      { keys: ['B'], label: 'Board' },
      { keys: ['L'], label: 'Link' },
      { keys: ['M'], label: 'Comment' },
      { keys: ['Double-click'], label: 'Note at the pointer' },
      { keys: ['Mod+V'], label: 'Paste text, links, images or cards' },
    ],
  },
  {
    title: 'Select & edit',
    items: [
      { keys: ['Enter'], label: 'Edit the selected card' },
      { keys: ['Esc'], label: 'Stop editing / clear selection' },
      { keys: ['Shift+Click', 'Mod+Click'], label: 'Add to / remove from selection' },
      { keys: ['Drag'], label: 'Select with a box (on empty canvas)' },
      { keys: ['Mod+A'], label: 'Select all' },
      { keys: ['Tab', 'Shift+Tab'], label: 'Next / previous card' },
      { keys: ['Alt+Arrows'], label: 'Nearest card in that direction' },
      { keys: ['Alt+Shift+Up', 'Alt+Shift+Down'], label: 'Move a card up / down in its column' },
      { keys: ['Space'], label: 'Open the selected board, image or document' },
      { keys: ['Mod+Enter'], label: 'New card below the selected one' },
      { keys: ['Delete', 'Backspace'], label: 'Move to trash' },
      { keys: ['Mod+D'], label: 'Duplicate' },
      { keys: ['Mod+C', 'Mod+X'], label: 'Copy / cut' },
      { keys: ['Arrows'], label: 'Nudge selection' },
      { keys: ['Shift+Arrows'], label: 'Nudge further' },
      { keys: ['Mod+Shift+L'], label: 'Lock / unlock position' },
      { keys: ['Mod+Alt+M'], label: 'Comment on the card' },
      { keys: ['Shift+F10', 'Menu key'], label: 'All actions for the selected cards' },
      { keys: ['Alt+F10'], label: 'Go to the selection toolbar' },
    ],
  },
  {
    title: 'Arrange',
    items: [
      { keys: ['Alt+A', 'Alt+H', 'Alt+D'], label: 'Align left / centres / right' },
      { keys: ['Alt+W', 'Alt+V', 'Alt+S'], label: 'Align top / middles / bottom' },
      { keys: ['Alt+Shift+H', 'Alt+Shift+V'], label: 'Distribute horizontally / vertically' },
      { keys: ['Mod+]', 'Mod+['], label: 'Bring to front / send to back' },
      { keys: ['Mod+Shift+Up', 'Mod+Shift+Down'], label: 'Bring forward / send backward' },
      { keys: ['Alt+Drag'], label: 'Duplicate while dragging' },
      { keys: ['Shift+Drag'], label: 'Draw a straight line' },
      { keys: ['Mod+Drag'], label: 'Move without snapping to the grid' },
      { keys: ['Shift+Resize'], label: 'Resize keeping proportions' },
    ],
  },
  {
    title: 'History',
    items: [
      { keys: ['Mod+Z'], label: 'Undo' },
      { keys: ['Mod+Shift+Z', 'Mod+Y'], label: 'Redo' },
    ],
  },
  {
    title: 'View',
    items: [
      { keys: ['Space+Drag', 'Middle-drag'], label: 'Pan' },
      { keys: ['Scroll'], label: 'Pan (Shift for sideways)' },
      { keys: ['Mod+Scroll', 'Pinch'], label: 'Zoom' },
      { keys: ['Mod+=', 'Mod+−'], label: 'Zoom in / out' },
      { keys: ['Mod+0'], label: 'Zoom to 100%' },
      { keys: ['Shift+1'], label: 'Fit everything on screen' },
      { keys: ['Shift+2'], label: 'Zoom to the selection' },
    ],
  },
  {
    title: 'Navigation',
    items: [
      { keys: ['Mod+[', 'Mod+]'], label: 'Back / forward (nothing selected)' },
      { keys: ['Mod+U'], label: 'Open the parent board' },
      { keys: ['Mod+F'], label: 'Search all boards' },
      { keys: ['Mod+Shift+F'], label: 'Search this board' },
      { keys: ['Mod+Alt+N'], label: 'Quick note' },
    ],
  },
  {
    title: 'App',
    items: [
      { keys: ['?'], label: 'Show keyboard shortcuts' },
      { keys: ['Mod+P'], label: 'Print the board' },
    ],
  },
  {
    title: 'Image viewer',
    items: [
      { keys: ['←', '→'], label: 'Previous / next image' },
      { keys: ['+', '-'], label: 'Zoom in / out' },
      { keys: ['0'], label: 'Fit to the window' },
      { keys: ['1'], label: 'Actual size (100%)' },
    ],
  },
  {
    title: 'Text',
    items: [
      { keys: ['Alt+F10'], label: 'Go to the text toolbar' },
      { keys: ['Mod+Shift+D'], label: 'Set a due date on a task' },
      { keys: ['Mod+Shift+A'], label: 'Assign a task' },
      { keys: ['Alt+Shift+Up', 'Alt+Shift+Down'], label: 'Move a list item up / down' },
      { keys: ['@'], label: 'Mention someone' },
    ],
  },
  {
    title: 'Text formatting',
    items: [
      { keys: ['Mod+B'], label: 'Bold' },
      { keys: ['Mod+I'], label: 'Italic' },
      { keys: ['Mod+U'], label: 'Underline' },
      { keys: ['Mod+Shift+S'], label: 'Strikethrough' },
      { keys: ['Mod+E'], label: 'Inline code' },
      { keys: ['Mod+Shift+H'], label: 'Highlight' },
      { keys: ['Mod+Alt+1', 'Mod+Alt+2', 'Mod+Alt+3'], label: 'Heading 1–3' },
      { keys: ['Mod+Shift+8'], label: 'Bullet list' },
      { keys: ['Mod+Shift+7'], label: 'Numbered list' },
      { keys: ['Mod+Shift+9'], label: 'Checklist' },
      { keys: ['Mod+Shift+B'], label: 'Quote' },
      { keys: ['Tab', 'Shift+Tab'], label: 'Indent / outdent list item' },
      { keys: ['Shift+Enter'], label: 'Line break' },
    ],
  },
  {
    title: 'Markdown while typing',
    items: [
      { keys: ['#', '##', '###'], label: 'Heading' },
      { keys: ['-', '*'], label: 'Bullet list (then Space)' },
      { keys: ['1.'], label: 'Numbered list (then Space)' },
      { keys: ['[ ]'], label: 'Checklist (then Space)' },
      { keys: ['>'], label: 'Quote (then Space)' },
      { keys: ['**text**'], label: 'Bold' },
    ],
  },
]

/** Splits "Mod+Shift+Z" into display keys, mapping Mod/Alt/Shift to the platform's names. */
export function displayKeys(combo: string, mac: boolean): string[] {
  // A lone "+" or keys like "Mod+=" must survive the split.
  const parts = combo === '+' ? ['+'] : combo.split(/\+(?!$)/)
  return parts.map((k) => {
    if (k === 'Mod') return mac ? '⌘' : 'Ctrl'
    if (k === 'Alt') return mac ? '⌥' : 'Alt'
    if (k === 'Shift') return mac ? '⇧' : 'Shift'
    if (k === 'Enter') return mac ? '↩' : 'Enter'
    if (k === 'Backspace') return mac ? '⌫' : 'Backspace'
    return k
  })
}
