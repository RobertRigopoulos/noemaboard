/** One feature: a caption over a recorded app window. */
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { Caption } from '../components/Caption'
import { ClipPanel } from '../components/ClipPanel'
import type { Box, Layout } from '../theme'
import type { Timeline } from '../timeline'

/** Rises gently into place: wraps panels that are positioned absolutely within `box`. */
export const RiseIn: React.FC<{ box: Box; delay?: number; children: React.ReactNode }> = ({ box, delay = 0, children }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const p = spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 22 })
  return (
    <AbsoluteFill
      style={{
        opacity: p,
        transformOrigin: `${box.x + box.w / 2}px ${box.y + box.h / 2}px`,
        transform: `translateY(${interpolate(p, [0, 1], [36, 0])}px) scale(${interpolate(p, [0, 1], [0.965, 1])})`,
      }}
    >
      {children}
    </AbsoluteFill>
  )
}

export interface FeatureProps {
  layout: Layout
  caption: string
  sub?: string
  clip: string
  timeline: Timeline
  trim: number
  rate: number
}

export const Feature: React.FC<FeatureProps> = ({ layout, caption, sub, clip, timeline, trim, rate }) => (
  <AbsoluteFill>
    <Caption layout={layout} text={caption} sub={sub} />
    <RiseIn box={layout.panel} delay={2}>
      <ClipPanel box={layout.panel} clip={clip} timeline={timeline} trim={trim} rate={rate} pointerSize={layout.pointer} maxZoom={layout.maxZoom} />
    </RiseIn>
  </AbsoluteFill>
)
