/** Opening: cards drift onto the canvas, then the logo and "Lay out your ideas. Together." */
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { COLORS, DISPLAY, type Layout } from '../theme'

/** Positions are fractions of the frame; w is a fraction of the frame width. */
const CARDS = [
  { x: 0.08, y: 0.16, w: 0.2, lines: 3, color: '#f2c23b', rot: -4 },
  { x: 0.72, y: 0.12, w: 0.18, lines: 2, color: '#0090ff', rot: 3 },
  { x: 0.76, y: 0.66, w: 0.19, lines: 3, color: '#30a46c', rot: -3 },
  { x: 0.05, y: 0.7, w: 0.17, lines: 2, color: '#d6409f', rot: 5 },
  { x: 0.42, y: 0.84, w: 0.16, lines: 2, color: '#6e56cf', rot: -2 },
]

export const Intro: React.FC<{ layout: Layout }> = ({ layout }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const tall = layout.height > layout.width
  const size = tall ? 108 : layout.width > 1500 ? 116 : 100
  // On the music's beats (18 frames apart): logo, then "Lay out your ideas." and "Together."
  const logoIn = spring({ frame: frame - 2, fps, config: { damping: 200 } })
  const line1 = spring({ frame: frame - 18, fps, config: { damping: 18, stiffness: 120 } })
  const line2 = spring({ frame: frame - 36, fps, config: { damping: 14, stiffness: 120 } })

  return (
    <AbsoluteFill>
      {CARDS.map((c, i) => {
        const p = spring({ frame: frame - i * 4, fps, config: { damping: 20, stiffness: 90 } })
        const w = c.w * layout.width * (tall ? 1.5 : 1)
        const bob = Math.sin((frame + i * 20) / 28) * 6
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: c.x * layout.width - (tall ? w * 0.18 : 0),
              top: c.y * layout.height + bob,
              width: w,
              padding: w * 0.08,
              borderRadius: 10,
              backgroundColor: COLORS.card,
              borderTop: `5px solid ${c.color}`,
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.35)',
              opacity: p * 0.5,
              transform: `translateY(${interpolate(p, [0, 1], [60, 0])}px) rotate(${c.rot}deg)`,
            }}
          >
            <div style={{ height: w * 0.07, width: '55%', borderRadius: 4, backgroundColor: 'rgba(236, 238, 241, 0.55)', marginBottom: w * 0.06 }} />
            {Array.from({ length: c.lines }, (_, j) => (
              <div
                key={j}
                style={{ height: w * 0.035, width: `${90 - j * 18}%`, borderRadius: 3, backgroundColor: 'rgba(236, 238, 241, 0.22)', marginTop: w * 0.04 }}
              />
            ))}
          </div>
        )
      })}

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
        <Img
          src={staticFile('brand/logo-light.svg')}
          style={{
            width: tall ? 400 : 360,
            marginBottom: size * 0.55,
            opacity: logoIn,
            transform: `translateY(${interpolate(logoIn, [0, 1], [-14, 0])}px)`,
          }}
        />
        <div style={{ fontFamily: DISPLAY, fontVariationSettings: '"opsz" 144', fontWeight: 600, fontSize: size, lineHeight: 1.04, color: COLORS.paper }}>
          <div style={{ opacity: line1, transform: `translateY(${interpolate(line1, [0, 1], [40, 0])}px)` }}>
            Lay out your{tall ? <br /> : ' '}ideas.
          </div>
          <div
            style={{
              color: COLORS.yellow,
              opacity: line2,
              transform: `translateY(${interpolate(line2, [0, 1], [40, 0])}px) scale(${interpolate(line2, [0, 1], [0.92, 1])})`,
            }}
          >
            Together.
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
