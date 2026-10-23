/** Row of card color swatches plus "No color", shared by the context menu and selection toolbar. */
import { Ban, Check } from 'lucide-react'
import { CARD_COLORS, type CardColor } from '../../model/types'
import './menus.css'

export const COLOR_NAMES: Record<CardColor, string> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  brown: 'Brown',
  grey: 'Grey',
  dark: 'Dark',
}

interface Props {
  /** The shared color of the cards, null for none, undefined when they differ. */
  value: CardColor | null | undefined
  onChange: (color: CardColor | null) => void
  size?: 'sm' | 'md'
  /** Render as menu radio items (inside role="menu") instead of toggle buttons. */
  menu?: boolean
  /** Extra attributes on every swatch (e.g. keyboard-navigation markers). */
  itemProps?: Record<string, string>
}

export function ColorDots({ value, onChange, size = 'md', menu = false, itemProps }: Props) {
  const stateProps = (on: boolean) => (menu ? { role: 'menuitemradio', 'aria-checked': on } : { 'aria-pressed': on })
  const icon = size === 'sm' ? 12 : 14
  return (
    <div className={`color-dots color-dots--${size}`} role="group" aria-label="Card color">
      <button
        type="button"
        className="color-dot color-dot--none"
        aria-label="No color"
        title="No color"
        {...stateProps(value === null)}
        onClick={() => onChange(null)}
        {...itemProps}
      >
        <Ban size={icon} strokeWidth={2} aria-hidden />
      </button>
      {CARD_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className="color-dot"
          data-swatch={c}
          style={{ background: `var(--c-${c})` }}
          aria-label={COLOR_NAMES[c]}
          title={COLOR_NAMES[c]}
          {...stateProps(value === c)}
          onClick={() => onChange(c)}
          {...itemProps}
        >
          {value === c && <Check size={icon - 2} strokeWidth={3} aria-hidden />}
        </button>
      ))}
    </div>
  )
}

/** The common color of a set of cards: the color if all share it, null if none has one, else undefined. */
export function sharedColor(colors: readonly (string | null)[]): CardColor | null | undefined {
  if (!colors.length) return undefined
  const first = colors[0]
  if (!colors.every((c) => c === first)) return undefined
  if (first === null) return null
  return (CARD_COLORS as readonly string[]).includes(first) ? (first as CardColor) : undefined
}
