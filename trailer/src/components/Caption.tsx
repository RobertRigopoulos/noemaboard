/** A scene's headline (words rise in one after another) and an optional line under it. */
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { COLORS, DISPLAY, TEXT, type Layout } from '../theme'

export interface CaptionProps {
  layout: Layout
  /** Headline; words wrapped in *stars* are set in yellow, and | breaks the line in narrow formats. */
  text: string
  sub?: string
  /** Frame (within the scene) where the words start to appear. */
  delay?: number
}

export const Caption: React.FC<CaptionProps> = ({ layout, text, sub, delay = 4 }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const narrow = layout.captionWidth < 1200
  const words = text.replace(/\s*\|\s*/g, narrow ? ' | ' : ' ').split(' ')
  const subIn = spring({ frame: frame - delay - words.length * 3 - 4, fps, config: { damping: 200 } })
  let inAccent = false
  return (
    <div
      style={{
        position: 'absolute',
        top: layout.captionTop,
        left: (layout.width - layout.captionWidth) / 2,
        width: layout.captionWidth,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontFamily: DISPLAY,
          fontVariationSettings: '"opsz" 144',
          fontWeight: 600,
          fontSize: layout.headline,
          lineHeight: 1.08,
          letterSpacing: '-0.01em',
          color: COLORS.paper,
        }}
      >
        {words.map((word, i) => {
          if (word === '|') return <br key={i} />
          const p = spring({ frame: frame - delay - i * 3, fps, config: { damping: 18, stiffness: 140, mass: 0.7 } })
          // *Yellow* runs may span several words: from a word starting with * to one ending with it.
          if (word.startsWith('*')) inAccent = true
          const accent = inAccent
          if (/\*[.,!?]?$/.test(word)) inAccent = false
          return (
            <span
              key={i}
              style={{
                display: 'inline-block',
                marginRight: '0.24em',
                opacity: p,
                transform: `translateY(${interpolate(p, [0, 1], [0.45, 0])}em)`,
                color: accent ? COLORS.yellow : undefined,
              }}
            >
              {word.replace(/\*/g, '')}
            </span>
          )
        })}
      </div>
      {sub && (
        <div
          style={{
            marginTop: layout.sub * 0.55,
            fontFamily: TEXT,
            fontWeight: 500,
            fontSize: layout.sub,
            lineHeight: 1.35,
            color: COLORS.muted,
            opacity: subIn,
            transform: `translateY(${interpolate(subIn, [0, 1], [12, 0])}px)`,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  )
}
