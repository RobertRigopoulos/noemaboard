/** Initials avatar in the person's colour. Names and colours may come from peers: sanitised here. */
import type { CSSProperties } from 'react'
import { initials } from '../../collab/identity'

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function safeColor(c: unknown): string {
  return typeof c === 'string' && COLOR_RE.test(c) ? c : '#8b8d98'
}

export function safeName(n: unknown, fallback = 'Someone'): string {
  if (typeof n !== 'string') return fallback
  // Peer-provided: strip control characters.
  // eslint-disable-next-line no-control-regex
  const t = n.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40)
  return t || fallback
}

interface Props {
  name: string
  color: string
  size?: number
  title?: string
  className?: string
}

export function Avatar({ name, color, size = 28, title, className }: Props) {
  const style = {
    '--avatar-color': safeColor(color),
    width: size,
    height: size,
    fontSize: Math.round(size * 0.4),
  } as CSSProperties
  return (
    <span className={['avatar', className].filter(Boolean).join(' ')} style={style} title={title} aria-hidden={title ? undefined : true}>
      {initials(safeName(name, '?'))}
    </span>
  )
}
