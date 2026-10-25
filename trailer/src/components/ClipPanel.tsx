/**
 * A recorded app window in a rounded frame. Its camera follows the recording's focus marks (zooming
 * in where the action is, never past the clip's edges) and it draws the pointer on top.
 */
import { OffthreadVideo, staticFile, useCurrentFrame } from 'remotion'
import { cameraAt, pointerAt, type Timeline } from '../timeline'
import type { Box } from '../theme'
import { Pointer } from './Pointer'

export interface ClipPanelProps {
  box: Box
  clip: string
  timeline: Timeline
  /** Clip frames skipped at the start, and how fast the clip plays. */
  trim: number
  rate: number
  pointerSize: number
  /** Largest zoom: clip pixels to output pixels (more would look soft). */
  maxZoom: number
}

export const ClipPanel: React.FC<ClipPanelProps> = ({ box, clip, timeline, trim, rate, pointerSize, maxZoom }) => {
  const frame = useCurrentFrame()
  const at = trim + frame * rate
  const { s, cx, cy } = cameraAt(timeline, at, box, maxZoom)

  // Centre on the camera point, but never show past the clip's edges.
  const tx = Math.min(0, Math.max(box.w - timeline.width * s, box.w / 2 - cx * s))
  const ty = Math.min(0, Math.max(box.h - timeline.height * s, box.h / 2 - cy * s))

  const p = pointerAt(timeline, at)
  const lastClick = timeline.clicks.filter((c) => c <= at).pop()

  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        borderRadius: 22,
        overflow: 'hidden',
        backgroundColor: '#17191c',
        boxShadow: '0 40px 100px rgba(0, 0, 0, 0.55), 0 0 0 1.5px rgba(255, 255, 255, 0.1)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: timeline.width,
          height: timeline.height,
          transformOrigin: '0 0',
          transform: `translate(${tx}px, ${ty}px) scale(${s})`,
        }}
      >
        <OffthreadVideo src={staticFile(`clips/${clip}.mp4`)} trimBefore={trim} playbackRate={rate} muted style={{ width: '100%', height: '100%' }} />
      </div>
      <Pointer x={p.x * s + tx} y={p.y * s + ty} size={pointerSize} sinceClick={lastClick === undefined ? Infinity : at - lastClick} carry={p.carry} />
    </div>
  )
}
