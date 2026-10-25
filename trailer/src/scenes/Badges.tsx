/** Three things worth knowing, one after another. */
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { Infinity as InfinityIcon, Lock, MonitorSmartphone } from 'lucide-react'
import { COLORS, DISPLAY, type Layout } from '../theme'

const POINTS = [
  { icon: InfinityIcon, text: 'Free, no limits' },
  { icon: Lock, text: 'End-to-end encrypted' },
  { icon: MonitorSmartphone, text: 'Web, Windows, Mac, Linux' },
]

export const Badges: React.FC<{ layout: Layout }> = ({ layout }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const tall = layout.height > layout.width
  const size = tall ? 62 : layout.width > 1500 ? 72 : 58
  const tile = size * 1.45
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: size * 0.62 }}>
        {POINTS.map((point, i) => {
          // One per beat, from the scene's bar line (6 frames in).
          const p = spring({ frame: frame - 6 - i * 18, fps, config: { damping: 16, stiffness: 120, mass: 0.8 } })
          const Icon = point.icon
          return (
            <div
              key={point.text}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: size * 0.5,
                opacity: p,
                transform: `translateX(${interpolate(p, [0, 1], [-60, 0])}px)`,
              }}
            >
              <div
                style={{
                  width: tile,
                  height: tile,
                  flex: 'none',
                  borderRadius: tile * 0.24,
                  backgroundColor: COLORS.tile,
                  boxShadow: '0 0 0 1.5px rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon size={tile * 0.52} color={COLORS.yellow} strokeWidth={2} />
              </div>
              <div
                style={{
                  fontFamily: DISPLAY,
                  fontVariationSettings: '"opsz" 144',
                  fontWeight: 600,
                  fontSize: size,
                  color: COLORS.paper,
                  whiteSpace: 'nowrap',
                }}
              >
                {point.text}
              </div>
            </div>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}
