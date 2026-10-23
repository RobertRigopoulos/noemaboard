import { useRef, useState, type CSSProperties } from 'react'
import { Copy } from 'lucide-react'
import type { CardProps } from '../types'
import type { SwatchCard as SwatchCardData } from '../../model/types'
import { DEFAULT_SWATCH_HEX, formatRgb, hexToRgb, isVeryLight, parseColor, readableTextColor } from './color'
import { copyText } from './copyText'
import { SwatchEditor, MAX_SWATCH_NAME } from './SwatchEditor'
import './swatch.css'

/**
 * Color swatch: a small tile showing a color, its name and codes. Click a code to copy it;
 * double-click / Enter opens the editor popover.
 */
export function SwatchCard({ id, card, editing, readOnly, stopEditing }: CardProps<SwatchCardData>) {
  // Fields come from peers: never trust them to be well-formed.
  const hex = parseColor(card.hex) ?? DEFAULT_SWATCH_HEX
  const name = typeof card.name === 'string' ? card.name.slice(0, MAX_SWATCH_NAME) : ''
  const rgb = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 }
  const rgbText = formatRgb(rgb)
  const [tile, setTile] = useState<HTMLDivElement | null>(null)
  const open = editing && !readOnly

  const style = {
    '--swatch': hex,
    '--swatch-ink': readableTextColor(hex),
    height: card.h === undefined ? 160 : undefined,
  } as CSSProperties

  return (
    <div
      ref={setTile}
      className={`swatch-card${isVeryLight(hex) ? ' is-light' : ''}${open ? ' is-open' : ''}`}
      style={style}
      role="group"
      aria-label={`Color ${name ? `${name}, ` : ''}${hex}`}
    >
      <div className="swatch-card__color">
        <CopyCode className="swatch-card__rgb" text={rgbText} />
      </div>
      <div className="swatch-card__meta">
        <div className={`swatch-card__name${name ? '' : ' is-empty'}`} title={name || undefined}>
          {name || 'Color name'}
        </div>
        <CopyCode className="swatch-card__code" text={hex} icon />
      </div>
      {open && tile && <SwatchEditor id={id} anchor={tile} hex={hex} name={name} onClose={stopEditing} />}
    </div>
  )
}

/** A code label that copies itself on click (ignored if the click was the end of a drag). */
function CopyCode({ text, className, icon = false }: { text: string; className: string; icon?: boolean }) {
  const down = useRef<{ x: number; y: number } | null>(null)
  return (
    <button
      type="button"
      className={`${className} no-drag`}
      title={`Copy ${text}`}
      aria-label={`Copy ${text}`}
      onPointerDown={(e) => {
        down.current = { x: e.clientX, y: e.clientY }
      }}
      onClick={(e) => {
        const d = down.current
        down.current = null
        // Keyboard activation has no pointerdown; a moved pointer means the card was dragged.
        if (d && e.detail > 0 && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
        e.stopPropagation()
        void copyText(text)
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <span>{text}</span>
      {icon && <Copy size={11} aria-hidden="true" />}
    </button>
  )
}
