# NoemaBoard trailer

A 38-second social media trailer made from **real app footage**, with its own music, in three
sizes:

| File (in `out/`) | Size | For |
|---|---|---|
| `noemaboard-trailer-4x5.mp4` | 1080 x 1350 | LinkedIn and Instagram feeds |
| `noemaboard-trailer-9x16.mp4` | 1080 x 1920 | Reels, TikTok, YouTube Shorts |
| `noemaboard-trailer-16x9.mp4` | 1920 x 1080 | X, YouTube, websites |

Captions carry the story, so it works muted (most people watch social videos that way), and the
music was written for it: every cut lands on a bar line.

## How it is made

1. **Record** (`npm run record`): `record/record.cjs` starts the app's dev server and a local sync
   relay, opens off-screen app windows for two people ("Ada" and "Ben"), builds the demo boards
   with the app's own code (`record/seed.js`) and drives the mouse and keyboard. Each shot is saved
   to `public/clips/<shot>.mp4` at 1920 x 1080, plus `<shot>.json`: where the pointer was in every
   frame, the clicks, and "focus marks" saying where the action is.
2. **Compose** (`npm run music`): `music/compose.mjs` writes the music note by note and synthesises
   every instrument in code, with no samples, so the track is free to use anywhere. It is mastered
   to -14 LUFS, the common loudness for online video, into `public/music/noemaboard-theme.wav`.
3. **Edit** (`npm run studio` to preview, `npm run render` to export): [Remotion](https://www.remotion.dev)
   turns `src/` into the videos. Captions, the pointer and the click rings are drawn on top of the
   footage, and the camera follows the focus marks, zooming in where a format needs it.

Nothing is saved outside `public/` and `out/`: recording windows use throwaway storage and no
public service is contacted.

## Commands

From this folder, after `npm install` (and with `npm install` done in the project root):

```bash
npm run record              # all shots: add, organise, together, share
npm run record -- share     # one shot again
npm run music               # the music only (studio and render make it first anyway)
npm run studio              # preview and tweak in the browser
npm run render              # all three sizes into out/
npm run render -- 9x16      # one size
npm run render -- silent    # versions without sound (noemaboard-trailer-<size>-silent.mp4)
```

Recording needs [ffmpeg](https://ffmpeg.org) on the PATH. The first render downloads the browser
Remotion renders with (about 100 MB).

## Changing it

- **Captions and timing:** `src/Trailer.tsx` (scene lengths in bars of the music, which part of
  each clip plays and how fast, caption text; `*stars*` make words yellow, `|` breaks the line on
  narrow formats).
- **Music:** `music/compose.mjs` (chords, melody, and which bars get which instruments). It runs at
  100 BPM, so a bar is 2.4 seconds or 72 frames; if a scene gains or loses bars, change the music
  to match so the cuts stay on the beat.
- **Layouts per format:** `src/theme.ts`.
- **What happens on screen:** the shots in `record/record.cjs` and the demo boards in
  `record/seed.js`. Keep demo boards about 600 CSS pixels wide, so the phone-shaped version can show
  a whole board.

## License note

Remotion is free for individuals and companies of up to three people; larger companies need a
[Remotion license](https://www.remotion.dev/license) to use this folder. The app itself does not use
Remotion.
