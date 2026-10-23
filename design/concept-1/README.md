# NoemaBoard mark: source files

Final round of concept 1, "the thought card". Brand notes (meaning, clear space, minimum sizes, do and don't) are in `../brand.md`.

## Colour rules

1. **Never put the N on a yellow tile.** The tile is always the charcoal gradient. A charcoal-and-yellow N on a yellow square comes too close to Miro.
2. **Use the transparent colour mark (yellow card) only at 48 px and up on light backgrounds.** On white or #eceef1 the yellow card has a contrast of about 1.6:1. Below 48 px on light surfaces, use the tile icon (`icon.svg`) or the one-colour mark (`mark-mono.svg`).
3. **On dark backgrounds the stems are #eceef1, not pure white.** This applies to `mark-dark.svg` and `lockup-dark.svg`, so the mark matches the dark-theme wordmark and does not glow next to it. Pure white stems appear only on the tile.
4. **The card is always flat #f2c23b.** It never gets a shadow, a gradient or an outline. The 3.2/100 knockout gap is the only depth cue.

## Files

| File | Use |
|---|---|
| `icon.svg` | App icon, 1024 tile (rx 225). It holds several optical sizes that its own media queries select. Up to 20 px it shows the pixel-fitted 16 drawing, 21 to 25 px the 24 drawing, and 28 to 36 px the 32 drawing. Other sizes up to 64 px show the vector N at 62.5% of the tile. From 65 px it shows the N at 58.6% with a white rim at 8%, and the dotted canvas appears from 180 px. Renderers without CSS show the large drawing. |
| `icon-square.svg` | Full-bleed square for the apple-touch-icon and social avatars, where the platform applies its own mask. |
| `icon-macos.svg` | macOS icon: an 824 tile (rx 185) on a transparent 1024 canvas, with a shadow at y 10, blur 20 and 30% black. |
| `favicon.svg` | Browser tab icon. It uses the pixel drawings 16, 24 and 32 by size, and the vector from 40 px. |
| `favicon-16.svg`, `favicon-24.svg`, `favicon-32.svg` | The pixel-fitted drawings on their own. Every edge sits on the pixel grid and nothing is anti-aliased. The single 1 px charcoal gap appears only where the card lies over the left column. |
| `tray-template.svg` | macOS menu-bar template glyph (black and alpha only). |
| `mark.svg`, `mark-dark.svg`, `mark-mono.svg`, `mark-mono-white.svg` | The transparent symbol. |
| `lockup.svg`, `lockup-dark.svg` | The mark and the "NoemaBoard" wordmark, all as paths. |
| `social/` | `avatar-400.png`, `banner-x-1500x500.png`, `banner-linkedin-1584x396.png` and their SVG sources. |
| `icon.ico`, `favicon.ico`, `*.png` | Raster exports. `publish.mjs` copies the finals into `public/` and `build/`. |
| `preview.png`, `pixels.png`, `social.png` | Check sheets. |

Geometry is in `lib.mjs` and the files are built by `gen.mjs`. All knockouts are flat boolean paths, with no masks, clip paths or filters in the mark. Any ids are unique per file.

## Regenerate

```sh
node design/concept-1/gen.mjs                                         # SVGs
node design/concept-1/sheets.mjs                                      # check sheets + raster job list
npx electron design/concept-1/raster.cjs design/concept-1/raster-jobs.json   # PNG / ICO exports
node design/concept-1/publish.mjs                                     # copy finals to public/ and build/
npx electron design/concept-1/render.cjs design/concept-1/preview.html design/concept-1/preview.png
npx electron design/concept-1/render.cjs design/concept-1/pixels.html design/concept-1/pixels.png
npx electron design/concept-1/render.cjs design/concept-1/social.html design/concept-1/social.png
npm run icons                                                         # tray icons in electron/icons.ts, build/ icons
```

The wordmark pen positions come from Chromium. Re-measure them with `tools/measure.cjs` if the font settings in `wordmark-metrics.json` change.
