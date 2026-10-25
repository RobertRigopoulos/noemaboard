/** Closing card: the logo, the address, free and open source. */
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { COLORS, TEXT, type Layout } from '../theme'

export const End: React.FC<{ layout: Layout }> = ({ layout }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const tall = layout.height > layout.width
  const logo = tall ? 780 : layout.width > 1500 ? 820 : 740
  const url = tall ? 64 : 58
  // The logo lands on the final chord (the bar line, 6 frames in), the address one beat later.
  const logoIn = spring({ frame: frame - 6, fps, config: { damping: 200 } })
  const urlIn = spring({ frame: frame - 24, fps, config: { damping: 16, stiffness: 120 } })
  const fineIn = spring({ frame: frame - 42, fps, config: { damping: 200 } })
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <Img
        src={staticFile('brand/logo-light.svg')}
        style={{ width: logo, opacity: logoIn, transform: `scale(${interpolate(logoIn, [0, 1], [0.94, 1])})` }}
      />
      <div
        style={{
          marginTop: url * 1.1,
          fontFamily: TEXT,
          fontWeight: 650,
          fontSize: url,
          letterSpacing: '-0.01em',
          color: COLORS.paper,
          opacity: urlIn,
          transform: `translateY(${interpolate(urlIn, [0, 1], [24, 0])}px)`,
        }}
      >
        noemaboard<span style={{ color: COLORS.yellow }}>.app</span>
      </div>
      <div style={{ marginTop: url * 0.45, fontFamily: TEXT, fontWeight: 500, fontSize: url * 0.52, color: COLORS.muted, opacity: fineIn }}>
        Free and open source
      </div>
    </AbsoluteFill>
  )
}
