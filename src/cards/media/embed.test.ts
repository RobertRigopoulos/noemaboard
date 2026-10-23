import { describe, expect, it } from 'vitest'
import { detectEmbed, parseTimestamp, playerSrc, sanitizeEmbed } from './embed'

const src = (url: string) => detectEmbed(url)?.src ?? null

describe('detectEmbed: YouTube', () => {
  const id = 'dQw4w9WgXcQ'
  const embed = `https://www.youtube-nocookie.com/embed/${id}`

  it('handles watch, short, mobile, music and embed URLs', () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&feature=share`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://music.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`,
      `https://youtu.be/${id}?si=abc`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube-nocookie.com/embed/${id}`,
      `https://www.youtube.com/live/${id}`,
      `https://www.youtube.com/v/${id}`,
      `http://www.youtube.com/watch?v=${id}`,
    ]) {
      expect(src(url), url).toBe(embed)
    }
    expect(detectEmbed(`https://www.youtube.com/watch?v=${id}`)).toEqual({ provider: 'youtube', src: embed, aspect: 16 / 9 })
  })

  it('makes shorts vertical', () => {
    const e = detectEmbed(`https://www.youtube.com/shorts/${id}`)
    expect(e?.src).toBe(embed)
    expect(e?.aspect).toBeCloseTo(9 / 16)
  })

  it('keeps start times and playlists', () => {
    expect(src(`https://youtu.be/${id}?t=90`)).toBe(`${embed}?start=90`)
    expect(src(`https://www.youtube.com/watch?v=${id}&t=1m30s`)).toBe(`${embed}?start=90`)
    expect(src(`https://www.youtube.com/watch?v=${id}&t=1h2m3s`)).toBe(`${embed}?start=3723`)
    expect(src(`https://www.youtube.com/watch?v=${id}&list=PLabc123`)).toBe(`${embed}?list=PLabc123`)
    expect(src('https://www.youtube.com/playlist?list=PLabc123')).toBe('https://www.youtube-nocookie.com/embed/videoseries?list=PLabc123')
  })

  it('rejects channel pages and malformed ids', () => {
    expect(detectEmbed('https://www.youtube.com/@somechannel')).toBeNull()
    expect(detectEmbed('https://www.youtube.com/channel/UC123')).toBeNull()
    expect(detectEmbed('https://www.youtube.com/watch?v=short')).toBeNull()
    expect(detectEmbed('https://www.youtube.com/watch?v=<script>xx')).toBeNull()
    expect(detectEmbed('https://youtu.be/')).toBeNull()
    expect(detectEmbed('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(detectEmbed('https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ')).toBeNull()
  })
})

describe('detectEmbed: Vimeo', () => {
  it('handles public, unlisted, channel, group and player URLs', () => {
    expect(src('https://vimeo.com/76979871')).toBe('https://player.vimeo.com/video/76979871')
    expect(src('https://www.vimeo.com/76979871')).toBe('https://player.vimeo.com/video/76979871')
    expect(src('https://vimeo.com/76979871/abcdef1234')).toBe('https://player.vimeo.com/video/76979871?h=abcdef1234')
    expect(src('https://vimeo.com/channels/staffpicks/76979871')).toBe('https://player.vimeo.com/video/76979871')
    expect(src('https://vimeo.com/groups/name/videos/76979871')).toBe('https://player.vimeo.com/video/76979871')
    expect(src('https://player.vimeo.com/video/76979871')).toBe('https://player.vimeo.com/video/76979871')
    expect(src('https://player.vimeo.com/video/76979871?h=abcdef1234')).toBe('https://player.vimeo.com/video/76979871?h=abcdef1234')
  })

  it('rejects non-video pages', () => {
    expect(detectEmbed('https://vimeo.com/someuser')).toBeNull()
    expect(detectEmbed('https://vimeo.com/')).toBeNull()
  })
})

describe('detectEmbed: Spotify', () => {
  it('maps open.spotify.com items to the embed player', () => {
    const id = '4uLU6hMCjMI75M1A2tKUQC'
    const track = detectEmbed(`https://open.spotify.com/track/${id}?si=xyz`)
    expect(track?.src).toBe(`https://open.spotify.com/embed/track/${id}`)
    expect(track!.aspect).toBeGreaterThan(1.5)
    expect(src(`https://open.spotify.com/intl-de/album/${id}`)).toBe(`https://open.spotify.com/embed/album/${id}`)
    expect(src(`https://open.spotify.com/embed/playlist/${id}`)).toBe(`https://open.spotify.com/embed/playlist/${id}`)
    expect(detectEmbed(`https://open.spotify.com/playlist/${id}`)!.aspect).toBeLessThan(1)
    expect(src(`https://open.spotify.com/episode/${id}`)).toBe(`https://open.spotify.com/embed/episode/${id}`)
  })

  it('rejects other Spotify pages', () => {
    expect(detectEmbed('https://open.spotify.com/user/someone')).toBeNull()
    expect(detectEmbed('https://open.spotify.com/track/')).toBeNull()
    expect(detectEmbed('https://spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')).toBeNull()
  })
})

describe('detectEmbed: SoundCloud', () => {
  it('embeds tracks and sets through the widget', () => {
    expect(src('https://soundcloud.com/artist-name/track-name')).toBe(
      'https://w.soundcloud.com/player/?url=' + encodeURIComponent('https://soundcloud.com/artist-name/track-name'),
    )
    expect(src('https://m.soundcloud.com/artist/track?si=1')).toBe(
      'https://w.soundcloud.com/player/?url=' + encodeURIComponent('https://soundcloud.com/artist/track'),
    )
    const set = detectEmbed('https://soundcloud.com/artist/sets/my-album')
    expect(set?.src).toContain(encodeURIComponent('https://soundcloud.com/artist/sets/my-album'))
    expect(set!.aspect).toBeLessThan(1)
  })

  it('rejects profiles and app pages', () => {
    expect(detectEmbed('https://soundcloud.com/artist')).toBeNull()
    expect(detectEmbed('https://soundcloud.com/artist/likes')).toBeNull()
    expect(detectEmbed('https://soundcloud.com/discover/sets')).toBeNull()
    expect(detectEmbed('https://soundcloud.com/search/sounds')).toBeNull()
  })
})

describe('detectEmbed: Loom, Figma, Google Maps', () => {
  it('handles Loom share and embed links', () => {
    const id = '0281766fa2d04bb788eaf19e65135184'
    expect(src(`https://www.loom.com/share/${id}`)).toBe(`https://www.loom.com/embed/${id}`)
    expect(src(`https://loom.com/share/${id}?sid=123`)).toBe(`https://www.loom.com/embed/${id}`)
    expect(src(`https://www.loom.com/share/Weekly-update-${id}`)).toBe(`https://www.loom.com/embed/${id}`)
    expect(src(`https://www.loom.com/embed/${id}`)).toBe(`https://www.loom.com/embed/${id}`)
    expect(detectEmbed('https://www.loom.com/looms/videos')).toBeNull()
  })

  it('wraps Figma files in the share embed', () => {
    const file = 'https://www.figma.com/design/AbCdEf1234567890/My-Design?node-id=1-2'
    expect(src(file)).toBe(`https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(file)}`)
    expect(src('https://figma.com/file/AbCdEf1234567890/Name')).toBe(
      `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent('https://www.figma.com/file/AbCdEf1234567890/Name')}`,
    )
    expect(src('https://www.figma.com/board/AbCdEf1234567890/Jam')).toContain('embed_host=share')
    expect(src('https://www.figma.com/proto/AbCdEf1234567890/Proto')).toContain('embed_host=share')
    expect(detectEmbed('https://www.figma.com/community')).toBeNull()
    expect(detectEmbed('https://www.figma.com/files/recent')).toBeNull()
  })

  it('only embeds Google Maps links that are already embed links', () => {
    expect(src('https://www.google.com/maps/embed?pb=!1m18!1m12')).toBe('https://www.google.com/maps/embed?pb=!1m18!1m12')
    expect(src('https://maps.google.com/maps/embed?pb=abc')).toBe('https://www.google.com/maps/embed?pb=abc')
    expect(src('https://www.google.de/maps/embed?pb=abc')).toBe('https://www.google.com/maps/embed?pb=abc')
    expect(detectEmbed('https://www.google.com/maps/place/Somewhere')).toBeNull()
    expect(detectEmbed('https://www.google.com/maps/embed')).toBeNull()
  })
})

describe('detectEmbed: other input', () => {
  it('returns null for ordinary pages and junk', () => {
    expect(detectEmbed('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(detectEmbed('not a url')).toBeNull()
    expect(detectEmbed('')).toBeNull()
    expect(detectEmbed(null)).toBeNull()
    expect(detectEmbed('javascript:alert(1)')).toBeNull()
  })
})

describe('parseTimestamp', () => {
  it('parses YouTube time formats', () => {
    expect(parseTimestamp('42')).toBe(42)
    expect(parseTimestamp('42s')).toBe(42)
    expect(parseTimestamp('2m')).toBe(120)
    expect(parseTimestamp('1h')).toBe(3600)
    expect(parseTimestamp('abc')).toBeNull()
    expect(parseTimestamp('')).toBeNull()
    expect(parseTimestamp(null)).toBeNull()
  })
})

describe('sanitizeEmbed', () => {
  it('accepts what detectEmbed produces', () => {
    for (const url of [
      'https://youtu.be/dQw4w9WgXcQ?t=5',
      'https://vimeo.com/76979871/abcdef1234',
      'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      'https://soundcloud.com/artist/track',
      'https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184',
      'https://www.figma.com/file/AbCdEf1234567890/Name',
      'https://www.google.com/maps/embed?pb=abc',
    ]) {
      const e = detectEmbed(url)
      expect(e, url).not.toBeNull()
      expect(sanitizeEmbed(e), url).toEqual(e)
    }
  })

  it('rejects iframe sources a peer could inject', () => {
    expect(sanitizeEmbed({ provider: 'youtube', src: 'https://evil.com/embed/dQw4w9WgXcQ', aspect: 1.7 })).toBeNull()
    expect(sanitizeEmbed({ provider: 'youtube', src: 'javascript:alert(1)', aspect: 1.7 })).toBeNull()
    expect(sanitizeEmbed({ provider: 'youtube', src: 'http://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', aspect: 1 })).toBeNull()
    expect(sanitizeEmbed({ provider: 'vimeo', src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', aspect: 1 })).toBeNull()
    expect(sanitizeEmbed({ provider: 'figma', src: 'https://www.figma.com/embed?url=https://evil.com', aspect: 1 })).toBeNull()
    expect(sanitizeEmbed({ provider: 'soundcloud', src: 'https://w.soundcloud.com/player/?url=https://evil.com', aspect: 1 })).toBeNull()
    expect(sanitizeEmbed({ provider: 'unknown', src: 'https://example.com', aspect: 1 })).toBeNull()
    expect(sanitizeEmbed({ provider: 'toString', src: 'https://example.com', aspect: 1 })).toBeNull()
    expect(sanitizeEmbed({ provider: 'youtube', src: 'https://u:p@www.youtube-nocookie.com/embed/dQw4w9WgXcQ' })).toBeNull()
    expect(sanitizeEmbed('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBeNull()
    expect(sanitizeEmbed(null)).toBeNull()
  })

  it('clamps the aspect ratio', () => {
    const base = { provider: 'youtube', src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' }
    expect(sanitizeEmbed({ ...base, aspect: 1000 })!.aspect).toBe(4)
    expect(sanitizeEmbed({ ...base, aspect: 0 })!.aspect).toBe(0.25)
    expect(sanitizeEmbed({ ...base, aspect: 'wide' })!.aspect).toBeCloseTo(16 / 9)
  })
})

describe('playerSrc', () => {
  it('adds autoplay for video providers only', () => {
    expect(playerSrc(detectEmbed('https://youtu.be/dQw4w9WgXcQ?t=5')!)).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=5&autoplay=1')
    expect(playerSrc(detectEmbed('https://vimeo.com/76979871')!)).toBe('https://player.vimeo.com/video/76979871?autoplay=1')
    const spotify = detectEmbed('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')!
    expect(playerSrc(spotify)).toBe(spotify.src)
  })
})
