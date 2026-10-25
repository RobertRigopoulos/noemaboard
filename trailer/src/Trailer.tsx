/** The whole trailer, in any of the three formats. */
import { AbsoluteFill, Audio, staticFile } from 'remotion'
import { linearTiming, TransitionSeries } from '@remotion/transitions'
import { fade } from '@remotion/transitions/fade'
import { Background } from './components/Background'
import { Badges } from './scenes/Badges'
import { End } from './scenes/End'
import { Feature } from './scenes/Feature'
import { Intro } from './scenes/Intro'
import { Together } from './scenes/Together'
import { LAYOUTS, type Format } from './theme'
import type { Timelines } from './timeline'

/**
 * Timing follows the music (music/compose.mjs): 100 BPM, so one bar is 72 frames at 30 fps, and
 * every cut (the middle of a FADE-frame cross-fade) lands on a bar line.
 */
export const BAR = 72
export const FADE = 12
const BARS = { intro: 1, add: 3, organise: 3, together: 3, share: 2, badges: 2, end: 2 }
type Scene = keyof typeof BARS
const ORDER = Object.keys(BARS) as Scene[]
/** Sequence lengths in frames: each scene also runs half a fade into each neighbour. */
export const SCENES = Object.fromEntries(
  ORDER.map((name, i) => [name, BARS[name] * BAR + (i === 0 || i === ORDER.length - 1 ? FADE / 2 : FADE)]),
) as Record<Scene, number>
export const TOTAL_FRAMES = ORDER.reduce((sum, name) => sum + BARS[name] * BAR, 0)

/**
 * Which part of each recording plays, and how fast: `trim` clip frames are skipped, then the clip
 * plays at `rate` (1.5 = half as fast again) for the scene's length.
 */
const PLAY = {
  add: { trim: 8, rate: 1.55 },
  organise: { trim: 10, rate: 1.2 },
  together: { trim: 12, rate: 1.13 },
  share: { trim: 6, rate: 1.08 },
}

export type TrailerProps = { format: Format; timelines: Timelines | null; music: boolean }

export const Trailer: React.FC<TrailerProps> = ({ format, timelines, music }) => {
  const layout = LAYOUTS[format]
  if (!timelines) return <Background />
  const fadeIn = <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />
  return (
    <AbsoluteFill>
      {music && <Audio src={staticFile('music/noemaboard-theme.wav')} />}
      <Background />
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={SCENES.intro}>
          <Intro layout={layout} />
        </TransitionSeries.Sequence>
        {fadeIn}
        <TransitionSeries.Sequence durationInFrames={SCENES.add}>
          <Feature
            layout={layout}
            caption="Notes, images, links, to-dos"
            sub="Drop anything onto one endless canvas."
            clip="add"
            timeline={timelines.add}
            {...PLAY.add}
          />
        </TransitionSeries.Sequence>
        {fadeIn}
        <TransitionSeries.Sequence durationInFrames={SCENES.organise}>
          <Feature
            layout={layout}
            caption="Organise it *your way*"
            sub="Columns, and boards inside boards."
            clip="organise"
            timeline={timelines.organise}
            {...PLAY.organise}
          />
        </TransitionSeries.Sequence>
        {fadeIn}
        <TransitionSeries.Sequence durationInFrames={SCENES.together}>
          <Together layout={layout} timelines={timelines} {...PLAY.together} />
        </TransitionSeries.Sequence>
        {fadeIn}
        <TransitionSeries.Sequence durationInFrames={SCENES.share}>
          <Feature
            layout={layout}
            caption="Share with a link. | *No accounts.*"
            sub="Teammates join from any browser."
            clip="share"
            timeline={timelines.share}
            {...PLAY.share}
          />
        </TransitionSeries.Sequence>
        {fadeIn}
        <TransitionSeries.Sequence durationInFrames={SCENES.badges}>
          <Badges layout={layout} />
        </TransitionSeries.Sequence>
        {fadeIn}
        <TransitionSeries.Sequence durationInFrames={SCENES.end}>
          <End layout={layout} />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  )
}
