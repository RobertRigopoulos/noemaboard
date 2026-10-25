import { Composition, type CalculateMetadataFunction } from 'remotion'
import { FORMATS, LAYOUTS } from './theme'
import { loadTimelines } from './timeline'
import { TOTAL_FRAMES, Trailer, type TrailerProps } from './Trailer'

/** Reads the pointer and focus data the recorder saved next to the clips. */
const withTimelines: CalculateMetadataFunction<TrailerProps> = async ({ props }) => ({
  props: { ...props, timelines: await loadTimelines() },
})

export const RemotionRoot: React.FC = () => (
  <>
    {FORMATS.map((format) => (
      <Composition
        key={format}
        id={`Trailer-${format}`}
        component={Trailer}
        fps={30}
        width={LAYOUTS[format].width}
        height={LAYOUTS[format].height}
        durationInFrames={TOTAL_FRAMES}
        defaultProps={{ format, timelines: null, music: true }}
        calculateMetadata={withTimelines}
      />
    ))}
  </>
)
