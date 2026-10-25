/** The board's dark canvas with its dot grid, drifting slowly, and a soft light behind the action. */
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { COLORS } from '../theme'

export const Background: React.FC = () => {
  const frame = useCurrentFrame()
  const drift = frame * 0.35
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.canvas }}>
      <AbsoluteFill
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(255, 255, 255, 0.075) 1.6px, transparent 2.2px)',
          backgroundSize: '34px 34px',
          backgroundPosition: `${drift}px ${drift * 0.6}px`,
        }}
      />
      <AbsoluteFill
        style={{
          background: 'radial-gradient(ellipse 70% 55% at 50% 58%, rgba(242, 194, 59, 0.07), transparent 70%)',
        }}
      />
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 85% 85% at 50% 50%, transparent 55%, rgba(0, 0, 0, 0.45))' }} />
    </AbsoluteFill>
  )
}
