/**
 * The mouse pointer (off-screen recording has none), a ring on every click, and the picture
 * being dragged in from the desktop.
 */
import { interpolate } from 'remotion'
import { COLORS } from '../theme'

export interface PointerProps {
  x: number
  y: number
  /** Pointer height in output pixels. */
  size: number
  /** Clip frames since the last click (Infinity when none). */
  sinceClick: number
  carry: boolean
}

export const Pointer: React.FC<PointerProps> = ({ x, y, size, sinceClick, carry }) => {
  const ring = sinceClick >= 0 && sinceClick < 16
  const k = size / 26
  const r = interpolate(sinceClick, [0, 16], [5, 30]) * k
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: 0, height: 0, pointerEvents: 'none' }}>
      {ring && (
        <div
          style={{
            position: 'absolute',
            left: -r,
            top: -r,
            width: 2 * r,
            height: 2 * r,
            borderRadius: '50%',
            border: `${2.6 * k}px solid ${COLORS.yellow}`,
            opacity: interpolate(sinceClick, [0, 16], [0.95, 0]),
          }}
        />
      )}
      {carry && (
        <div
          style={{
            position: 'absolute',
            left: 10 * k,
            top: 16 * k,
            width: 132 * k,
            height: 88 * k,
            borderRadius: 6 * k,
            overflow: 'hidden',
            transform: 'rotate(-5deg)',
            boxShadow: '0 12px 30px rgba(0, 0, 0, 0.5)',
            border: `${2 * k}px solid ${COLORS.paper}`,
          }}
        >
          <Landscape />
        </div>
      )}
      <svg
        width={size * 0.72}
        height={size}
        viewBox="0 0 18.7 26"
        style={{ position: 'absolute', left: -1, top: -1, filter: 'drop-shadow(0 2px 3px rgba(0, 0, 0, 0.45))' }}
      >
        <path d="M1 1 L1 21.5 L6.4 16.6 L10 24.4 L13.4 22.9 L9.9 15.2 L17 15.2 Z" fill="#ffffff" stroke="#111316" strokeWidth={1.4} strokeLinejoin="round" />
      </svg>
    </div>
  )
}

/** The same picture the recording drops onto the board (record/seed.js), drawn small. */
export const Landscape: React.FC = () => (
  <svg viewBox="0 0 1200 800" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#24324a" />
        <stop offset="1" stopColor="#3f7f7a" />
      </linearGradient>
    </defs>
    <rect width="1200" height="800" fill="url(#sky)" />
    <circle cx="820" cy="300" r="130" fill="#f2c23b" />
    <path d="M0 600 Q320 430 640 580 Q900 690 1200 520 L1200 800 L0 800 Z" fill="#a9c5b6" />
    <path d="M0 700 Q420 590 760 690 Q1000 760 1200 680 L1200 800 L0 800 Z" fill="#df7a5e" />
  </svg>
)
