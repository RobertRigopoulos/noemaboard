# NoemaBoard brand notes

## The mark

The mark is an N built from three cards from the board:

- **Two slim white column cards** are the stems. They stand for the board's columns.
- **One wide yellow "thought" card** forms the diagonal. It lies over the left column and slides under the right one.

So the letter reads as a note being moved from one column to the next. That is the app's core action, and it is also what *noema* means: a thought, the thing being thought about.

The construction follows two rules:

- **Real card corners are rounded and overlap cuts are sharp.** The cards use the same small radius as the app's own cards (card 3.5/100, columns 3/100). Edges made by an overlap are sharp, because the card carries on underneath.
- **Depth comes from the gap.** A 3.2/100 knockout gap separates overlapping cards. It is the only depth cue: no shadow, no gradient on the card.

The proportions copy the app's display face, Fraunces: thin stems and a heavy diagonal. The card's lower tip lands exactly on the baseline beside the right column.

## Colours

| Role | Hex |
|---|---|
| Ink (charcoal stems on light, wordmark) | `#1f2328` |
| Thought card yellow | `#f2c23b` |
| Paper (light canvas; stems and wordmark on dark) | `#eceef1` |
| White (stems on the tile only) | `#ffffff` |
| Tile gradient, top to bottom | `#2d323a` to `#1b1e23` |
| Tile, flat (pixel-fitted 16 to 32 px icons) | `#24282e` |
| Dark canvas | `#17191c` |
| Tile texture | dots in white at 6.5%, 64-unit grid, r 5 (from 180 px) |
| Tile rim | white at 8%, 5/1024 |

The app's other accents (red `#e5484d`, orange `#f76b15`, green `#30a46c`, teal `#12a594`, blue `#0090ff`, purple `#6e56cf`) belong to the product, not the logo.

## Type

- **Wordmark:** Fraunces (SIL OFL) at opsz 56, wght 560, SOFT 80, WONK 0. It is converted to outlines and uses Fraunces' own kerning, plus No -10/1000 em and aB +30/1000 em so the name splits gently into Noema and Board. Always use the supplied file and never retype it.
- **UI and supporting text:** Inter.

## Lockup

The mark stands on the text baseline. Its top meets the ascender of the d. The gap between mark and wordmark is 0.55 times the cap height.

Files:
- `public/logo.svg`: dark text, for light backgrounds.
- `public/logo-light.svg`: `#eceef1` text and stems, for dark backgrounds.

## Clear space

Let **X** be the width of one column of the mark, which is one fifth of the mark's height.

- Keep at least **2X** free on every side of the mark or lockup.
- Around the app icon, keep at least one eighth of the tile's width.

## Minimum sizes

| Asset | Minimum |
|---|---|
| App icon (`icon.svg`, `favicon.svg`) | 16 px. Hand-fitted drawings for 16, 24 and 32 px are built in. |
| One-colour mark | 16 px tall |
| Colour mark, transparent, on light backgrounds | 48 px. Below that, use the app icon or the one-colour mark. |
| Colour mark, transparent, on dark backgrounds | 24 px |
| Lockup | Mark 16 px tall (lockup about 150 px wide). Below that, use the app icon alone. |

## Do

- Use the supplied files: `public/icon.svg`, `public/favicon.svg`, `public/logo*.svg`, and the PNG/ICO exports.
- Use the app icon or the one-colour mark for small sizes on light surfaces.
- Keep the layering: card over the left column, under the right.
- Put the transparent mark on calm, plain backgrounds: the canvas colours, white, or the dark canvas.

## Don't

- Don't put the N on a yellow tile or a yellow background, so it stays well clear of Miro.
- Don't recolour the card or the columns, or swap their colours.
- Don't add shadows, gradients, outlines or bevels to the mark. The only depth cue is the knockout gap.
- Don't reverse the weave, rotate, skew, stretch or re-space the mark or the wordmark.
- Don't round the cut edges or sharpen the card corners.
- Don't use pure white stems next to the light wordmark on dark backgrounds. Use `#eceef1`.
- Don't set "NoemaBoard" in live text as a logo, or in any other typeface.
- Don't place the logo on busy photos or mid-tone backgrounds where the yellow card disappears.

## Files and sources

- **Sources:** `design/concept-1/` holds the generators (`gen.mjs`, `lib.mjs`), the check sheets and the social assets. `design/concept-1/README.md` covers colour rules and regeneration.
- **App:** `public/` holds `icon.svg`, `favicon.svg`, `favicon.ico`, `logo-mark.svg`, `logo.svg`, `logo-light.svg`, `apple-touch-icon.png` and `icon-512.png`.
- **Packaging:** `build/` holds `icon.png`, `icon.ico`, `icon-mac.svg`, `icon-mac.png` and `tray-template.svg`. Run `npm run icons` to regenerate these and `electron/icons.ts`.
- **Launch:** `design/concept-1/social/` holds `avatar-400.png`, `banner-x-1500x500.png` and `banner-linkedin-1584x396.png`.
