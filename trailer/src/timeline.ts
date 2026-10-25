/** What the recorder saved next to each clip (record/record.cjs), and how to read it at any time. */
import { Easing, interpolate, staticFile } from 'remotion'
import type { Box } from './theme'

export interface Focus {
  /** From this clip frame on, the action is in `a`, and `c` is the area around it worth showing. */
  f: number
  a: Box
  c: Box
}

export interface Timeline {
  fps: number
  width: number
  height: number
  /** [x, y, button down, carrying a file] per clip frame, in clip pixels. */
  frames: [number, number, number, number][]
  /** Clip frames where the pointer clicked. */
  clicks: number[]
  focus: Focus[]
}

export const CLIPS = ['add', 'organise', 'together-ada', 'together-ben', 'share'] as const
export type ClipName = (typeof CLIPS)[number]
export type Timelines = Record<ClipName, Timeline>

export async function loadTimelines(): Promise<Timelines> {
  const entries = await Promise.all(
    CLIPS.map(async (name) => {
      const res = await fetch(staticFile(`clips/${name}.json`))
      if (!res.ok) throw new Error(`clips/${name}.json is missing: run npm run record first`)
      return [name, (await res.json()) as Timeline] as const
    }),
  )
  return Object.fromEntries(entries) as Timelines
}

/** The pointer at a (fractional) clip frame. */
export function pointerAt(t: Timeline, frame: number): { x: number; y: number; down: boolean; carry: boolean } {
  const last = t.frames.length - 1
  const f = Math.max(0, Math.min(last, frame))
  const i = Math.floor(f)
  const a = t.frames[i]
  const b = t.frames[Math.min(last, i + 1)]
  const k = f - i
  return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, down: a[2] === 1, carry: a[3] === 1 }
}

const ease = Easing.bezier(0.45, 0, 0.2, 1)

/** A camera position: zoom (clip to output pixels) and the clip point at the frame's centre. */
export interface Shot {
  s: number
  cx: number
  cy: number
}

/** Below this zoom (clip to output pixels) the app's text gets hard to read. */
const READABLE = 0.75

/**
 * How a frame of `view` size shows a focus mark: the surroundings when they fit at a zoom that fills
 * the frame and keeps text readable, otherwise the action itself; never zoomed in past `maxZoom`.
 */
export function shotFor(mark: Focus, view: { w: number; h: number }, clip: { width: number; height: number }, maxZoom: number): Shot {
  const cover = Math.max(view.w / clip.width, view.h / clip.height)
  const fit = (r: Box) => Math.min(view.w / r.w, view.h / r.h)
  const target = fit(mark.c) >= Math.max(cover, READABLE) ? mark.c : mark.a
  const s = Math.max(cover, Math.min(fit(target), maxZoom))
  return { s, cx: target.x + target.w / 2, cy: target.y + target.h / 2 }
}

/** The camera at a clip frame: glides from one focus mark's shot to the next over `move` frames. */
export function cameraAt(t: Timeline, frame: number, view: { w: number; h: number }, maxZoom: number, move = 30): Shot {
  const whole: Focus = { f: 0, a: { x: 0, y: 0, w: t.width, h: t.height }, c: { x: 0, y: 0, w: t.width, h: t.height } }
  const marks = t.focus.length ? t.focus : [whole]
  let shot = shotFor(marks[0], view, t, maxZoom)
  for (let i = 1; i < marks.length; i++) {
    const m = marks[i]
    if (frame <= m.f) break
    const next = shotFor(m, view, t, maxZoom)
    const p = interpolate(frame, [m.f, m.f + move], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease })
    shot = { s: shot.s + (next.s - shot.s) * p, cx: shot.cx + (next.cx - shot.cx) * p, cy: shot.cy + (next.cy - shot.cy) * p }
  }
  return shot
}
