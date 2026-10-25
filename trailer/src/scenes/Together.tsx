/** Two people on one board: Ada's and Ben's screens, recorded at the same moment, side by side. */
import { AbsoluteFill } from 'remotion'
import { Caption } from '../components/Caption'
import { ClipPanel } from '../components/ClipPanel'
import { COLORS, TEXT, type Layout } from '../theme'
import type { Timelines } from '../timeline'
import { RiseIn } from './Feature'

const PEOPLE = [
  { clip: 'together-ada', name: "Ada's screen", color: COLORS.ada },
  { clip: 'together-ben', name: "Ben's screen", color: COLORS.ben },
] as const

export const Together: React.FC<{ layout: Layout; timelines: Timelines; trim: number; rate: number }> = ({ layout, timelines, trim, rate }) => {
  const label = Math.round(layout.sub * 0.85)
  return (
    <AbsoluteFill>
      <Caption layout={layout} text="Edit together, *live*" sub="See your team's cursors and changes as they happen." />
      {PEOPLE.map((person, i) => {
        const box = layout.pair[i]
        return (
          <RiseIn key={person.clip} box={box} delay={2 + i * 5}>
            <div
              style={{
                position: 'absolute',
                left: box.x + 14,
                top: box.y + 14,
                zIndex: 2,
                display: 'flex',
                alignItems: 'center',
                gap: label * 0.4,
                padding: `${label * 0.28}px ${label * 0.6}px`,
                borderRadius: 999,
                backgroundColor: 'rgba(23, 25, 28, 0.86)',
                boxShadow: '0 0 0 1.5px rgba(255, 255, 255, 0.12)',
                fontFamily: TEXT,
                fontWeight: 600,
                fontSize: label,
                color: COLORS.paper,
              }}
            >
              <span style={{ width: label * 0.5, height: label * 0.5, borderRadius: '50%', backgroundColor: person.color }} />
              {person.name}
            </div>
            <ClipPanel box={box} clip={person.clip} timeline={timelines[person.clip]} trim={trim} rate={rate} pointerSize={layout.pointer * 0.9} maxZoom={layout.maxZoom} />
          </RiseIn>
        )
      })}
    </AbsoluteFill>
  )
}
