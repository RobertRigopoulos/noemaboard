// NoemaBoard mark, concept 1 ("the thought card"): geometry, flat boolean paths, pixel-fitted small sizes.
//
// Everything is plain path data. No masks, no clip paths, no filters in the mark itself, so ICO/ICNS converters,
// design-tool imports and the Windows shell all see the same shapes as a browser.

export const f = (n, d = 3) => +(+n).toFixed(d)

export const PAL = {
  ink: '#1f2328', // app text / charcoal
  inkSoft: '#eceef1', // dark-theme text, also the light canvas
  white: '#ffffff',
  yellow: '#f2c23b', // the thought card
  light: '#eceef1', // light canvas
  dark: '#17191c', // dark canvas
  darkCard: '#24272c',
  tileTop: '#2d323a', // icon tile gradient
  tileBottom: '#1b1e23',
  tileMid: '#24282e', // flat tile colour for the pixel-fitted small icons (midpoint of the gradient)
  red: '#e5484d',
  orange: '#f76b15',
  green: '#30a46c',
  teal: '#12a594',
  blue: '#0090ff',
  purple: '#6e56cf',
}

// ------------------------------------------------------------------ 2D helpers
const V = (x, y, r = 0) => ({ x, y, r })
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (a, k) => ({ x: a.x * k, y: a.y * k })
const dot = (a, b) => a.x * b.x + a.y * b.y
const len = (a) => Math.hypot(a.x, a.y)
const unit = (a) => mul(a, 1 / len(a))

/** Sutherland-Hodgman clip of a convex polygon to the half-plane a*x + b*y <= c. New vertices get radius r. */
export function clip(poly, a, b, c, r = 0) {
  const inside = (p) => a * p.x + b * p.y <= c + 1e-9
  const out = []
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    const pi = inside(p)
    const qi = inside(q)
    if (pi) out.push(p)
    if (pi !== qi) {
      const t = (c - a * p.x - b * p.y) / (a * (q.x - p.x) + b * (q.y - p.y))
      out.push(V(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, r))
    }
  }
  return out
}

/**
 * Path data for a convex polygon (clockwise on screen) whose vertices carry their own fillet radius.
 * Transform: x' = ox + x*s, y' = oy + y*s. Throws if two fillets on one edge would overlap.
 */
export function polyPath(poly, { ox = 0, oy = 0, s = 1, d = 3 } = {}) {
  const P = (p) => `${f(ox + p.x * s, d)} ${f(oy + p.y * s, d)}`
  const n = poly.length
  const parts = poly.map((v, i) => {
    const prev = poly[(i + n - 1) % n]
    const next = poly[(i + 1) % n]
    if (!v.r) return { a: v, b: v, r: 0 }
    const u1 = unit(sub(prev, v))
    const u2 = unit(sub(next, v))
    const phi = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))))
    const tl = v.r / Math.tan(phi / 2)
    if (tl > len(sub(prev, v)) / 2 + 1e-6 && prev.r) throw new Error('fillets overlap')
    if (tl > len(sub(next, v)) + 1e-6) throw new Error('fillet longer than edge')
    return { a: add(v, mul(u1, tl)), b: add(v, mul(u2, tl)), r: v.r }
  })
  let out = `M${P(parts[0].b)}`
  for (let k = 1; k <= n; k++) {
    const p = parts[k % n]
    out += `L${P(p.a)}`
    if (p.r) out += `A${f(p.r * s, d)} ${f(p.r * s, d)} 0 0 1 ${P(p.b)}`
  }
  return out + 'Z'
}

/** Rounded rectangle as a clockwise polygon. */
export const rectPoly = (x, y, w, h, r = 0) => [V(x, y, r), V(x + w, y, r), V(x + w, y + h, r), V(x, y + h, r)]

// ------------------------------------------------------------------ the N (100-unit box)
/**
 * Two thin column cards and one wide "thought" card. Layering (bottom -> top): left column, thought card, right column.
 * The thought card's angle and length are solved so its rounded top apex sits on the cap line (y = t) and its
 * rounded left extreme is flush with the left column's outer edge (x = a).
 *
 * The boolean knockouts are computed here, so the result is three flat paths:
 *   left column  = column minus (card grown by gap)       -> a clean 45 degree cut, sharp corners
 *   thought card = card minus (right column grown by gap, square) -> a vertical cut, sharp corners
 *   right column = untouched
 * Rule: real card corners are rounded, edges made by an overlap are sharp (the card goes on underneath).
 *
 * bottom: how the visible lower end of the thought card meets the baseline beside the right column.
 *   'point' - card width is re-solved so its lower edge meets the cut exactly on the baseline (sharp 45 degree point)
 *   'foot'  - the card is cut by the baseline as well (small flat foot, sharp corners)
 *   'round' - card width re-solved so a fillet of radius rs at the cut sits exactly on the baseline
 */
export function weaveN({ a = 12, s = 15.2, t = 12, w = 31, rd = 3.5, rs = 3, gap = 3.2, bottom = 'point' } = {}) {
  const base = 100 - t
  const cutX = 100 - a - s - gap // the card is cut here by the right column (grown by the gap, square)
  const solve = (w) => {
    let best = null
    for (let th = 30; th <= 60; th += 0.0005) {
      const T = (th * Math.PI) / 180
      const si = Math.sin(T)
      const co = Math.cos(T)
      const h = (50 - (w / 2) * co + rd * (co + si - 1) - a) / si
      const apexY = 50 - h * co - (w / 2) * si + rd * (si + co - 1)
      const err = Math.abs(apexY - t)
      if (!best || err < best.err) best = { th, h, err, si, co, w }
    }
    return best
  }
  // corners of the (sharp) card, local (u across, v along) -> screen
  const corner = (S, u, v) => V(50 + u * S.co + v * S.si, 50 - u * S.si + v * S.co)
  // where the card's lower-left long edge (u = -w/2) crosses x = cutX
  const lowerEdgeYAtCut = (S) => {
    const p = corner(S, -S.w / 2, 0)
    const dir = { x: S.si, y: S.co }
    return p.y + ((cutX - p.x) / dir.x) * dir.y
  }
  let S = solve(w)
  if (bottom === 'point' || bottom === 'round') {
    // y where the lower edge must meet the cut line. 'round': the wedge between the vertical cut and the lower edge
    // has angle theta; a fillet of radius rs there has its lowest point rs/tan(theta/2) - rs above the vertex.
    const target = (S) => (bottom === 'point' ? base : base + rs / Math.tan((S.th * Math.PI) / 360) - rs)
    let lo = 20
    let hi = 45
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      const Sm = solve(mid)
      // wider card -> lower edge moves down-left -> crosses the cut lower (larger y)
      if (lowerEdgeYAtCut(Sm) > target(Sm)) hi = mid
      else lo = mid
    }
    S = solve((lo + hi) / 2)
  }
  const { th, h, si, co } = S
  const W = S.w
  const ext = 40 // the hidden lower end runs on under the right column
  const TR = corner(S, W / 2, -h) // top apex
  const BR = corner(S, W / 2, h + ext)
  const BL = corner(S, -W / 2, h + ext)
  const TL = corner(S, -W / 2, -h) // left extreme
  let cardPoly = [{ ...TR, r: rd }, { ...BR, r: 0 }, { ...BL, r: 0 }, { ...TL, r: rd }]
  const cutR = bottom === 'round' ? rs : 0
  cardPoly = clip(cardPoly, 1, 0, cutX, cutR)
  if (bottom === 'foot') cardPoly = clip(cardPoly, 0, 1, base, 0)
  // left column minus the card's lower-left long edge pushed out by the gap
  const leftCol = clip(rectPoly(a, t, s, base - t, rs), co, -si, 50 * co - 50 * si - W / 2 - gap, 0)
  const rightCol = rectPoly(100 - a - s, t, s, base - t, rs)
  return {
    angle: th,
    cardW: W,
    pieces: [
      { role: 'col', poly: leftCol },
      { role: 'thought', poly: cardPoly },
      { role: 'col', poly: rightCol },
    ],
    bounds: { x: a, y: t, w: 100 - 2 * a, h: 100 - 2 * t },
    debug: { TL, TR, lowerAtCut: lowerEdgeYAtCut(S), cutX },
  }
}

/** The N as SVG elements (one path per piece). fills = { col, thought }. tr = { ox, oy, s } maps the 100-box. */
export function nPaths(geo, fills, tr = {}, d = 3) {
  return geo.pieces.map((p) => `<path fill="${fills[p.role]}" d="${polyPath(p.poly, { ...tr, d })}"/>`).join('')
}

// ------------------------------------------------------------------ pixel-fitted small icons
/** Fillet centre and tangent points of every rounded vertex of a convex clockwise polygon. */
function fillets(poly) {
  const n = poly.length
  return poly.map((v, i) => {
    if (!v.r) return null
    const prev = poly[(i + n - 1) % n]
    const next = poly[(i + 1) % n]
    const u1 = unit(sub(prev, v))
    const u2 = unit(sub(next, v))
    const phi = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))))
    const tl = v.r / Math.tan(phi / 2)
    const bis = unit(add(u1, u2))
    return { v, t1: add(v, mul(u1, tl)), t2: add(v, mul(u2, tl)), c: add(v, mul(bis, v.r / Math.sin(phi / 2))), r: v.r }
  })
}
const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
const inConvex = (poly, p) => poly.every((v, i) => cross(v, poly[(i + 1) % poly.length], p) >= -1e-9)

/** Point-in-shape for a convex clockwise polygon whose vertices are filleted (exactly what polyPath draws). */
export function insideRounded(poly, p) {
  if (!inConvex(poly, p)) return false
  for (const fl of fillets(poly)) {
    if (!fl) continue
    const kite = [fl.v, fl.t2, fl.c, fl.t1]
    const kiteCw = cross(kite[0], kite[1], kite[2]) >= 0 ? kite : kite.slice().reverse()
    if (inConvex(kiteCw, p) && len(sub(p, fl.c)) > fl.r) return false
  }
  return true
}

/**
 * The N for an S x S tile drawn on whole pixels: the vector geometry sampled at pixel centres with no
 * anti-aliasing, so there is no grey/brown blending between the yellow card, the white columns and the tile.
 * The N box is [m, S - m] in both directions. A charcoal gap of at least `minGap` px is kept where the card lies
 * over the left column (the true 3.2/100 gap is less than a pixel at 16 px).
 * Returns { col, thought } path data in pixel units (one rectangle per horizontal run).
 */
export function rasterN(geo, { S, m, minGap = 1 }) {
  const W = S - 2 * m
  const k = W / geo.bounds.w
  const toBox = (px) => geo.bounds.x + (px - m) / k
  const [left, card, right] = geo.pieces.map((p) => p.poly)
  const leftRect = rectPoly(geo.bounds.x, geo.bounds.y, left.reduce((mx, v) => Math.max(mx, v.x), 0) - geo.bounds.x, geo.bounds.h)
  const cell = {}
  const key = (x, y) => x + ',' + y
  for (let y = m; y < S - m; y++)
    for (let x = m; x < S - m; x++) {
      const p = { x: toBox(x + 0.5), y: toBox(y + 0.5) }
      if (insideRounded(right, p)) cell[key(x, y)] = 'c'
      else if (insideRounded(card, p)) cell[key(x, y)] = 't'
      else if (insideRounded(left, p)) cell[key(x, y)] = 'c'
      else if (inConvex(leftRect, p)) cell[key(x, y)] = 'L' // under the card or in its gap
    }
  // widen the gap to minGap px: a left-column pixel may not touch a card pixel to its right or above it
  for (let y = m; y < S - m; y++)
    for (let x = m; x < m + W / 2; x++) {
      if (cell[key(x, y)] !== 'c') continue
      for (let d = 1; d <= minGap; d++) if (cell[key(x + d, y)] === 't' || cell[key(x, y - d)] === 't') cell[key(x, y)] = 'L'
    }
  // the card's tip stands on the baseline (as in the vector drawing), even where sampling left the last row empty
  const baseRow = S - m - 1
  let tip = null
  for (let y = m; y < S - m; y++) for (let x = m; x < S - m; x++) if (cell[key(x, y)] === 't' && (!tip || y >= tip.y)) tip = { x, y }
  if (tip) for (let y = tip.y + 1; y <= baseRow; y++) cell[key(tip.x, y)] = 't'
  const runs = (want) => {
    let d = ''
    for (let y = m; y < S - m; y++) {
      let x = m
      while (x < S - m) {
        if (cell[key(x, y)] !== want) { x++; continue }
        let e = x
        while (e < S - m && cell[key(e, y)] === want) e++
        d += `M${x} ${y}h${e - x}v1h${x - e}z`
        x = e
      }
    }
    return d
  }
  return { col: runs('c'), thought: runs('t') }
}

export const uri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
