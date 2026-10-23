import { useCallback, useEffect, useRef, useState } from 'react'
import {
  autoUpdate,
  flip,
  FloatingPortal,
  hide,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { Check, Copy, Pipette } from 'lucide-react'
import { useBoard } from '../../board/BoardContext'
import { updateCard } from '../../model/board'
import { getUser } from '../../collab/identity'
import { formatHsl, formatRgb, hexToRgb, isVeryLight, parseColor } from './color'
import { copyText } from './copyText'

export const MAX_SWATCH_NAME = 120

/** Quick picks: the app's card palette plus ink and paper. */
const PRESETS: readonly { hex: string; label: string }[] = [
  { hex: '#1f2328', label: 'Ink' },
  { hex: '#ffffff', label: 'White' },
  { hex: '#e5484d', label: 'Red' },
  { hex: '#f76b15', label: 'Orange' },
  { hex: '#f2c23b', label: 'Yellow' },
  { hex: '#30a46c', label: 'Green' },
  { hex: '#12a594', label: 'Teal' },
  { hex: '#0090ff', label: 'Blue' },
  { hex: '#6e56cf', label: 'Purple' },
  { hex: '#d6409f', label: 'Pink' },
]

interface EyeDropperResult {
  sRGBHex: string
}
type EyeDropperCtor = new () => { open: () => Promise<EyeDropperResult> }

const getEyeDropper = (): EyeDropperCtor | null =>
  typeof window !== 'undefined' && 'EyeDropper' in window ? ((window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper ?? null) : null

interface Props {
  id: string
  anchor: HTMLElement
  hex: string
  name: string
  onClose: () => void
}

/**
 * Popover for editing a swatch. Changes are applied live (debounced) so collaborators see the
 * color as it is picked; consecutive edits merge into one undo step via the UndoManager.
 */
export function SwatchEditor({ id, anchor, hex, name, onClose }: Props) {
  const { doc } = useBoard()
  const [hexText, setHexText] = useState(hex)
  const [nameText, setNameText] = useState(name)
  const [invalid, setInvalid] = useState(false)
  const hexInput = useRef<HTMLInputElement>(null)
  const nameFocused = useRef(false)
  const pending = useRef<Record<string, unknown>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const EyeDropper = getEyeDropper()

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length) updateCard(doc, id, patch, getUser().id)
  }, [doc, id])

  /**
   * Debounced by default (typing must not commit half-typed codes like '#7c6'); `throttle` keeps
   * committing while the native picker is dragged so the card and peers follow along.
   */
  const queue = (patch: Record<string, unknown>, delay: number, throttle = false) => {
    Object.assign(pending.current, patch)
    if (delay <= 0) return flush()
    if (throttle && timer.current) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, delay)
  }

  // Commit whatever is pending when the popover closes (Escape, click outside, Done).
  useEffect(() => () => flush(), [flush])

  // Follow remote changes unless the local draft already matches or is about to be saved.
  useEffect(() => {
    if ('hex' in pending.current) return
    setHexText((t) => (parseColor(t) === hex ? t : hex))
    setInvalid(false)
  }, [hex])
  useEffect(() => {
    if ('name' in pending.current || nameFocused.current) return
    setNameText(name)
  }, [name])

  useEffect(() => {
    const el = hexInput.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.select()
  }, [])

  const { refs, floatingStyles, context, middlewareData } = useFloating({
    open: true,
    onOpenChange: (o) => {
      if (!o) {
        flush()
        onClose()
      }
    },
    elements: { reference: anchor },
    placement: 'right-start',
    strategy: 'fixed',
    middleware: [offset(12), flip({ padding: 8 }), shift({ padding: 8 }), hide()],
    // The canvas pans with CSS transforms, which fire no scroll events: track every frame.
    whileElementsMounted: (r, f, u) => autoUpdate(r, f, u, { animationFrame: true }),
  })
  // Escape is handled by the board shortcuts (leaves edit mode but keeps the card selected).
  const dismiss = useDismiss(context, { escapeKey: false })
  const role = useRole(context, { role: 'dialog' })
  const { getFloatingProps } = useInteractions([dismiss, role])

  const current = parseColor(hexText) ?? hex
  const rgb = hexToRgb(current) ?? { r: 0, g: 0, b: 0 }

  const setColor = (value: string, delay: number) => {
    const p = parseColor(value)
    if (!p) return
    setHexText(p)
    setInvalid(false)
    queue({ hex: p }, delay, true)
  }

  const onHexText = (value: string) => {
    setHexText(value)
    const p = parseColor(value)
    setInvalid(!p && value.trim() !== '')
    if (p) queue({ hex: p }, 250)
  }

  const onHexBlur = () => {
    const p = parseColor(hexText)
    setHexText(p ?? hex)
    setInvalid(false)
    flush()
  }

  const onName = (value: string) => {
    const v = value.slice(0, MAX_SWATCH_NAME)
    setNameText(v)
    queue({ name: v }, 300)
  }

  const onNameBlur = () => {
    nameFocused.current = false
    const trimmed = nameText.trim()
    if (trimmed !== nameText) {
      setNameText(trimmed)
      queue({ name: trimmed }, 0)
    } else flush()
  }

  const pickFromScreen = async () => {
    if (!EyeDropper) return
    try {
      const res = await new EyeDropper().open()
      setColor(res.sRGBHex, 0)
    } catch {
      // Cancelled with Escape or blocked: nothing to do.
    }
  }

  const done = () => {
    const trimmed = nameText.trim()
    if (trimmed !== nameText) queue({ name: trimmed }, 0)
    flush()
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLInputElement
    const inText = t.tagName === 'INPUT' && t.type !== 'color'
    // With a button focused, board shortcuts would delete or nudge the card behind the popover.
    if (!inText && (e.key === 'Delete' || e.key === 'Backspace' || e.key.startsWith('Arrow'))) {
      e.preventDefault()
      return
    }
    // Only text fields: Enter on a button must still activate that button.
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && inText) {
      e.preventDefault()
      if (t === hexInput.current) {
        const p = parseColor(hexText)
        if (!p) {
          setInvalid(true)
          return
        }
        setColor(p, 0)
      }
      done()
    }
  }

  const rgbText = formatRgb(rgb)
  const hslText = formatHsl(rgb)
  const hidden = !!middlewareData.hide?.referenceHidden

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        className="swatch-editor"
        style={{ ...floatingStyles, visibility: hidden ? 'hidden' : undefined }}
        aria-label="Edit color"
        {...getFloatingProps({
          // React events bubble through portals to the card shell; keep them here.
          onPointerDown: (e) => e.stopPropagation(),
          onDoubleClick: (e) => e.stopPropagation(),
          onContextMenu: (e) => e.stopPropagation(),
          onKeyDown,
        })}
      >
        <div className="swatch-editor__row">
          <label className={`swatch-editor__well${isVeryLight(current) ? ' is-light' : ''}`} style={{ background: current }} title="Open color picker">
            <input
              type="color"
              value={current}
              aria-label="Color picker"
              onChange={(e) => setColor(e.target.value, 120)}
            />
          </label>
          <div className={`swatch-editor__hex${invalid ? ' is-invalid' : ''}`}>
            <input
              ref={hexInput}
              className="input"
              value={hexText}
              spellCheck={false}
              autoComplete="off"
              maxLength={64}
              aria-label="Color code (hex or rgb)"
              aria-invalid={invalid || undefined}
              placeholder="#7c6cf0"
              onChange={(e) => onHexText(e.target.value)}
              onBlur={onHexBlur}
            />
          </div>
          {EyeDropper && (
            <button type="button" className="icon-btn" onClick={() => void pickFromScreen()} title="Pick a color from the screen" aria-label="Pick a color from the screen">
              <Pipette size={16} />
            </button>
          )}
        </div>
        {invalid && <div className="swatch-editor__error">Use #rgb, #rrggbb or rgb(r, g, b)</div>}

        <input
          className="input swatch-editor__name"
          value={nameText}
          placeholder="Color name"
          aria-label="Color name"
          maxLength={MAX_SWATCH_NAME}
          onFocus={() => {
            nameFocused.current = true
          }}
          onChange={(e) => onName(e.target.value)}
          onBlur={onNameBlur}
        />

        <div className="swatch-editor__presets" role="group" aria-label="Preset colors">
          {PRESETS.map((p) => (
            <button
              key={p.hex}
              type="button"
              className={`swatch-editor__preset${p.hex === current ? ' is-active' : ''}${isVeryLight(p.hex) ? ' is-light' : ''}`}
              style={{ background: p.hex }}
              title={`${p.label} ${p.hex}`}
              aria-label={`${p.label} ${p.hex}`}
              aria-pressed={p.hex === current}
              onClick={() => setColor(p.hex, 0)}
            />
          ))}
        </div>

        <dl className="swatch-editor__codes">
          <CodeRow label="HEX" value={current} />
          <CodeRow label="RGB" value={rgbText} />
          <CodeRow label="HSL" value={hslText} />
        </dl>

        <div className="swatch-editor__footer">
          <button type="button" className="btn btn--primary" onClick={done}>
            <Check size={14} aria-hidden="true" />
            Done
          </button>
        </div>
      </div>
    </FloatingPortal>
  )
}

function CodeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="swatch-editor__code">
      <dt>{label}</dt>
      <dd>
        <button type="button" onClick={() => void copyText(value)} title={`Copy ${value}`} aria-label={`Copy ${label} ${value}`}>
          <span>{value}</span>
          <Copy size={12} aria-hidden="true" />
        </button>
      </dd>
    </div>
  )
}
