// Minimal WOFF2 (TrueType flavour) reader that turns glyphs of a variable font into SVG path data.
// Supports: transformed glyf/loca streams, cmap 4/12, hmtx, fvar/avar normalisation, gvar deltas with IUP.
// Enough to convert a few letters of an OFL font (Fraunces) into outlines for a logo; not a general font engine.
import fs from 'node:fs'
import zlib from 'node:zlib'

const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill']

class Reader {
  constructor(buf, pos = 0) {
    this.b = buf
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    this.p = pos
  }
  u8() { return this.b[this.p++] }
  i8() { const v = this.dv.getInt8(this.p); this.p += 1; return v }
  u16() { const v = this.dv.getUint16(this.p); this.p += 2; return v }
  i16() { const v = this.dv.getInt16(this.p); this.p += 2; return v }
  u32() { const v = this.dv.getUint32(this.p); this.p += 4; return v }
  f2dot14() { return this.i16() / 16384 }
  fixed() { const v = this.dv.getInt32(this.p); this.p += 4; return v / 65536 }
  tag() { const s = this.b.toString('latin1', this.p, this.p + 4); this.p += 4; return s }
  u255() {
    const c = this.u8()
    if (c === 253) return this.u16()
    if (c === 255) return this.u8() + 253
    if (c === 254) return this.u8() + 506
    return c
  }
  base128() {
    let v = 0
    for (let i = 0; i < 5; i++) {
      const b = this.u8()
      v = (v * 128) + (b & 0x7f)
      if (!(b & 0x80)) return v
    }
    throw new Error('bad UIntBase128')
  }
}

function readWoff2(file) {
  const buf = fs.readFileSync(file)
  const r = new Reader(buf)
  if (r.tag() !== 'wOF2') throw new Error('not woff2')
  r.u32() // flavor
  r.u32() // length
  const numTables = r.u16()
  r.u16()
  r.u32() // totalSfntSize
  const totalCompressedSize = r.u32()
  r.p = 48
  const dir = []
  for (let i = 0; i < numTables; i++) {
    const flags = r.u8()
    const idx = flags & 0x3f
    const tag = idx === 63 ? r.tag() : KNOWN[idx]
    const tv = flags >> 6
    const origLength = r.base128()
    const transformed = tag === 'glyf' || tag === 'loca' ? tv === 0 : tv !== 0
    const transformLength = transformed ? r.base128() : origLength
    dir.push({ tag, tv, transformed, origLength, transformLength })
  }
  const data = zlib.brotliDecompressSync(buf.subarray(r.p, r.p + totalCompressedSize))
  const tables = {}
  let off = 0
  for (const t of dir) {
    tables[t.tag] = { ...t, data: data.subarray(off, off + t.transformLength) }
    off += t.transformLength
  }
  return tables
}

// ---- transformed glyf (WOFF2 5.1) -> per-glyph point lists
function decodeGlyf(glyfData, numGlyphsHint) {
  const h = new Reader(glyfData)
  h.u16()
  const optionFlags = h.u16()
  const numGlyphs = h.u16()
  h.u16() // indexFormat
  const sizes = [h.u32(), h.u32(), h.u32(), h.u32(), h.u32(), h.u32(), h.u32()]
  let o = h.p
  const streams = sizes.map((s) => { const st = new Reader(glyfData, o); o += s; return st })
  const [nContourS, nPointsS, flagS, glyphS, compositeS, , instrS] = streams
  void optionFlags
  void numGlyphsHint
  const glyphs = []
  for (let g = 0; g < numGlyphs; g++) {
    const nContours = nContourS.i16()
    if (nContours === 0) { glyphs.push({ contours: [] }); continue }
    if (nContours > 0) {
      const counts = []
      let total = 0
      for (let c = 0; c < nContours; c++) { const n = nPointsS.u255(); counts.push(n); total += n }
      const flags = []
      for (let i = 0; i < total; i++) flags.push(flagS.u8())
      let x = 0, y = 0
      const pts = []
      for (let i = 0; i < total; i++) {
        const fl = flags[i]
        const on = !(fl & 0x80)
        const flag = fl & 0x7f
        const ws = (f, v) => (f & 1 ? v : -v)
        let dx, dy
        if (flag < 10) { dx = 0; dy = ws(flag, ((flag & 14) << 7) + glyphS.u8()) }
        else if (flag < 20) { dx = ws(flag, (((flag - 10) & 14) << 7) + glyphS.u8()); dy = 0 }
        else if (flag < 84) {
          const b0 = flag - 20, b1 = glyphS.u8()
          dx = ws(flag, 1 + (b0 & 0x30) + (b1 >> 4))
          dy = ws(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f))
        } else if (flag < 120) {
          const b0 = flag - 84, b1 = glyphS.u8(), b2 = glyphS.u8()
          dx = ws(flag, 1 + (Math.floor(b0 / 12) << 8) + b1)
          dy = ws(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + b2)
        } else if (flag < 124) {
          const b1 = glyphS.u8(), b2 = glyphS.u8(), b3 = glyphS.u8()
          dx = ws(flag, (b1 << 4) + (b2 >> 4))
          dy = ws(flag >> 1, ((b2 & 0x0f) << 8) + b3)
        } else {
          const b1 = glyphS.u8(), b2 = glyphS.u8(), b3 = glyphS.u8(), b4 = glyphS.u8()
          dx = ws(flag, (b1 << 8) + b2)
          dy = ws(flag >> 1, (b3 << 8) + b4)
        }
        x += dx; y += dy
        pts.push({ x, y, on })
      }
      const instrLen = glyphS.u255()
      instrS.p += instrLen
      const contours = []
      let k = 0
      for (const n of counts) { contours.push(pts.slice(k, k + n)); k += n }
      glyphs.push({ contours })
    } else {
      // composite
      const comps = []
      let flags, haveInstr = false
      do {
        flags = compositeS.u16()
        const glyphIndex = compositeS.u16()
        let dx, dy
        if (flags & 0x0001) { dx = compositeS.i16(); dy = compositeS.i16() } else { dx = compositeS.i8(); dy = compositeS.i8() }
        let m = [1, 0, 0, 1]
        if (flags & 0x0008) { const s = compositeS.f2dot14(); m = [s, 0, 0, s] }
        else if (flags & 0x0040) { m = [compositeS.f2dot14(), 0, 0, compositeS.f2dot14()] }
        else if (flags & 0x0080) { m = [compositeS.f2dot14(), compositeS.f2dot14(), compositeS.f2dot14(), compositeS.f2dot14()] }
        if (flags & 0x0100) haveInstr = true
        comps.push({ glyphIndex, dx, dy, m, xy: !!(flags & 0x0002) })
      } while (flags & 0x0020)
      if (haveInstr) { const n = glyphS.u255(); instrS.p += n }
      glyphs.push({ composite: comps })
    }
  }
  return glyphs
}

function parseCmap(d) {
  const r = new Reader(d)
  r.u16()
  const n = r.u16()
  const subs = []
  for (let i = 0; i < n; i++) subs.push({ pid: r.u16(), eid: r.u16(), off: r.u32() })
  const map = new Map()
  for (const s of subs) {
    const t = new Reader(d, s.off)
    const format = t.u16()
    if (format === 4) {
      t.u16(); t.u16()
      const segX2 = t.u16(); t.p += 6
      const segs = segX2 / 2
      const ends = [], starts = [], deltas = [], ros = []
      for (let i = 0; i < segs; i++) ends.push(t.u16())
      t.u16()
      for (let i = 0; i < segs; i++) starts.push(t.u16())
      for (let i = 0; i < segs; i++) deltas.push(t.i16())
      const roStart = t.p
      for (let i = 0; i < segs; i++) ros.push(t.u16())
      for (let i = 0; i < segs; i++) {
        for (let c = starts[i]; c <= ends[i] && c !== 0xffff; c++) {
          let g
          if (ros[i] === 0) g = (c + deltas[i]) & 0xffff
          else {
            const addr = roStart + i * 2 + ros[i] + (c - starts[i]) * 2
            g = new Reader(d, addr).u16()
            if (g) g = (g + deltas[i]) & 0xffff
          }
          if (!map.has(c)) map.set(c, g)
        }
      }
    } else if (format === 12) {
      t.u16(); t.u32(); t.u32()
      const ng = t.u32()
      for (let i = 0; i < ng; i++) {
        const a = t.u32(), b = t.u32(), g0 = t.u32()
        for (let c = a; c <= b; c++) if (!map.has(c)) map.set(c, g0 + c - a)
      }
    }
  }
  return map
}

function parseFvar(d) {
  const r = new Reader(d)
  r.u16(); r.u16()
  const axesOff = r.u16()
  r.u16()
  const axisCount = r.u16()
  const axisSize = r.u16()
  const axes = []
  for (let i = 0; i < axisCount; i++) {
    const a = new Reader(d, axesOff + i * axisSize)
    axes.push({ tag: a.tag(), min: a.fixed(), def: a.fixed(), max: a.fixed() })
  }
  return axes
}

function parseAvar(d) {
  if (!d) return null
  const r = new Reader(d)
  r.u16(); r.u16(); r.u16()
  const n = r.u16()
  const maps = []
  for (let i = 0; i < n; i++) {
    const c = r.u16()
    const m = []
    for (let k = 0; k < c; k++) m.push([r.f2dot14(), r.f2dot14()])
    maps.push(m)
  }
  return maps
}

function readPackedPoints(r) {
  let count = r.u8()
  if (count === 0) return null // all points
  if (count & 0x80) count = ((count & 0x7f) << 8) | r.u8()
  const pts = []
  let last = 0
  while (pts.length < count) {
    const ctrl = r.u8()
    const n = (ctrl & 0x7f) + 1
    for (let i = 0; i < n && pts.length < count; i++) {
      last += ctrl & 0x80 ? r.u16() : r.u8()
      pts.push(last)
    }
  }
  return pts
}

function readPackedDeltas(r, count) {
  const out = []
  while (out.length < count) {
    const ctrl = r.u8()
    const n = (ctrl & 0x3f) + 1
    for (let i = 0; i < n && out.length < count; i++) {
      if (ctrl & 0x80) out.push(0)
      else if (ctrl & 0x40) out.push(r.i16())
      else out.push(r.i8())
    }
  }
  return out
}

function iupSegment(coords, rc1, rd1, rc2, rd2, j) {
  let x1 = rc1[j], x2 = rc2[j], d1 = rd1[j], d2 = rd2[j]
  if (x1 === x2) return coords.map(() => (d1 === d2 ? d1 : 0))
  if (x1 > x2) { [x1, x2] = [x2, x1]; [d1, d2] = [d2, d1] }
  const sc = (d2 - d1) / (x2 - x1)
  return coords.map((p) => { const x = p[j]; return x <= x1 ? d1 : x >= x2 ? d2 : d1 + (x - x1) * sc })
}

/** Fill deltas for untouched points in a contour (gvar IUP). deltas: array of [dx,dy] or null. */
function iupContour(coords, deltas) {
  const n = coords.length
  const touched = []
  for (let i = 0; i < n; i++) if (deltas[i]) touched.push(i)
  if (!touched.length) return coords.map(() => [0, 0])
  if (touched.length === 1) return coords.map(() => deltas[touched[0]].slice())
  const out = deltas.map((d) => (d ? d.slice() : null))
  for (let t = 0; t < touched.length; t++) {
    const a = touched[t]
    const b = touched[(t + 1) % touched.length]
    const between = []
    for (let i = (a + 1) % n; i !== b; i = (i + 1) % n) between.push(i)
    if (!between.length) continue
    const cs = between.map((i) => coords[i])
    const dx = iupSegment(cs, coords[a], deltas[a], coords[b], deltas[b], 0)
    const dy = iupSegment(cs, coords[a], deltas[a], coords[b], deltas[b], 1)
    between.forEach((i, k) => (out[i] = [dx[k], dy[k]]))
  }
  return out
}

export class VarFont {
  constructor(file) {
    this.t = readWoff2(file)
    const head = new Reader(this.t.head.data)
    head.p = 18
    this.upem = head.u16()
    const maxp = new Reader(this.t.maxp.data, 4)
    this.numGlyphs = maxp.u16()
    const hhea = new Reader(this.t.hhea.data, 34)
    this.numHM = hhea.u16()
    this.cmap = parseCmap(this.t.cmap.data)
    this.axes = parseFvar(this.t.fvar.data)
    this.avar = parseAvar(this.t.avar?.data)
    this.glyphs = decodeGlyf(this.t.glyf.data, this.numGlyphs)
    const hm = new Reader(this.t.hmtx.data)
    this.adv = []
    this.lsb = []
    let last = 0
    for (let i = 0; i < this.numGlyphs; i++) {
      if (i < this.numHM) { last = hm.u16(); this.adv.push(last); this.lsb.push(hm.i16()) } else { this.adv.push(last); this.lsb.push(hm.i16()) }
    }
    this.parseGvar()
  }

  parseGvar() {
    const d = this.t.gvar.data
    const r = new Reader(d)
    r.u16(); r.u16()
    this.gAxisCount = r.u16()
    const sharedCount = r.u16()
    const sharedOff = r.u32()
    const glyphCount = r.u16()
    const flags = r.u16()
    const dataOff = r.u32()
    const offs = []
    for (let i = 0; i <= glyphCount; i++) offs.push(flags & 1 ? r.u32() : r.u16() * 2)
    this.gvarOffs = offs.map((o) => dataOff + o)
    const s = new Reader(d, sharedOff)
    this.shared = []
    for (let i = 0; i < sharedCount; i++) { const t = []; for (let a = 0; a < this.gAxisCount; a++) t.push(s.f2dot14()); this.shared.push(t) }
  }

  normalize(user) {
    return this.axes.map((ax, i) => {
      let v = user[ax.tag] ?? ax.def
      v = Math.min(ax.max, Math.max(ax.min, v))
      let n = v < ax.def ? (v - ax.def) / (ax.def - ax.min) : v > ax.def ? (v - ax.def) / (ax.max - ax.def) : 0
      const m = this.avar?.[i]
      if (m && m.length) {
        for (let k = 0; k < m.length - 1; k++) {
          const [a0, b0] = m[k], [a1, b1] = m[k + 1]
          if (n >= a0 && n <= a1) { n = a1 === a0 ? b0 : b0 + ((n - a0) * (b1 - b0)) / (a1 - a0); break }
        }
      }
      return n
    })
  }

  /** Variation deltas for glyph g: array per point (incl. 4 phantoms) of [dx,dy]. */
  deltas(g, coords, contourEnds, norm) {
    const n = coords.length
    const total = coords.map(() => [0, 0])
    const start = this.gvarOffs[g], end = this.gvarOffs[g + 1]
    if (end <= start) return total
    const d = this.t.gvar.data
    const r = new Reader(d, start)
    const tvc = r.u16()
    const count = tvc & 0x0fff
    const dataOffset = r.u16()
    const headers = []
    for (let i = 0; i < count; i++) {
      const size = r.u16()
      const idx = r.u16()
      let peak
      if (idx & 0x8000) { peak = []; for (let a = 0; a < this.gAxisCount; a++) peak.push(r.f2dot14()) } else peak = this.shared[idx & 0x0fff]
      let st = null, en = null
      if (idx & 0x4000) {
        st = []; en = []
        for (let a = 0; a < this.gAxisCount; a++) st.push(r.f2dot14())
        for (let a = 0; a < this.gAxisCount; a++) en.push(r.f2dot14())
      }
      headers.push({ size, priv: !!(idx & 0x2000), peak, st, en })
    }
    const sr = new Reader(d, start + dataOffset)
    const sharedPts = tvc & 0x8000 ? readPackedPoints(sr) : undefined
    for (const hd of headers) {
      const tupleStart = sr.p
      let scalar = 1
      for (let a = 0; a < this.gAxisCount; a++) {
        const pk = hd.peak[a]
        if (pk === 0) continue
        const v = norm[a]
        const s0 = hd.st ? hd.st[a] : Math.min(0, pk)
        const e0 = hd.en ? hd.en[a] : Math.max(0, pk)
        if (v === pk) continue
        if (v < s0 || v > e0 || v === 0) { scalar = 0; break }
        scalar *= v < pk ? (v - s0) / (pk - s0) : (e0 - v) / (e0 - pk)
      }
      const pts = hd.priv ? readPackedPoints(sr) : sharedPts === undefined ? null : sharedPts
      const m = pts ? pts.length : n
      const xs = readPackedDeltas(sr, m)
      const ys = readPackedDeltas(sr, m)
      sr.p = tupleStart + hd.size
      if (scalar === 0) continue
      if (!pts) {
        for (let i = 0; i < n; i++) { total[i][0] += xs[i] * scalar; total[i][1] += ys[i] * scalar }
      } else {
        const per = new Array(n).fill(null)
        pts.forEach((p, k) => { if (p < n) per[p] = [xs[k], ys[k]] })
        // IUP per contour (phantom points are never inferred)
        let s = 0
        for (const e of contourEnds) {
          const idxs = []
          for (let i = s; i <= e; i++) idxs.push(i)
          const filled = iupContour(idxs.map((i) => [coords[i].x, coords[i].y]), idxs.map((i) => per[i]))
          idxs.forEach((i, k) => { total[i][0] += filled[k][0] * scalar; total[i][1] += filled[k][1] * scalar })
          s = e + 1
        }
        for (let i = s; i < n; i++) if (per[i]) { total[i][0] += per[i][0] * scalar; total[i][1] += per[i][1] * scalar }
      }
    }
    return total
  }

  /** Instanced glyph: { contours: [[{x,y,on}]], advance } in font units (y up). */
  glyph(gid, user = {}) {
    const norm = this.normalize(user)
    const g = this.glyphs[gid]
    if (g.composite) {
      // component offsets are varied as "points" in gvar
      const comps = g.composite
      const coords = comps.map((c) => ({ x: c.dx, y: c.dy }))
      const xMin = 0
      const ph = [{ x: xMin - this.lsb[gid], y: 0 }, { x: xMin - this.lsb[gid] + this.adv[gid], y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
      const all = [...coords, ...ph]
      const dl = this.deltas(gid, all, [], norm)
      const contours = []
      comps.forEach((c, i) => {
        const sub = this.glyph(c.glyphIndex, user)
        const ox = c.dx + dl[i][0], oy = c.dy + dl[i][1]
        for (const ct of sub.contours) contours.push(ct.map((p) => ({ x: c.m[0] * p.x + c.m[2] * p.y + ox, y: c.m[1] * p.x + c.m[3] * p.y + oy, on: p.on })))
      })
      const advance = all[comps.length + 1].x + dl[comps.length + 1][0] - (all[comps.length].x + dl[comps.length][0])
      return { contours, advance }
    }
    const pts = g.contours.flat()
    const contourEnds = []
    let k = -1
    for (const c of g.contours) { k += c.length; contourEnds.push(k) }
    const xMin = pts.length ? Math.min(...pts.map((p) => p.x)) : 0
    const ph = [{ x: xMin - this.lsb[gid], y: 0 }, { x: xMin - this.lsb[gid] + this.adv[gid], y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
    const all = [...pts, ...ph]
    const dl = this.deltas(gid, all, contourEnds, norm)
    const moved = all.map((p, i) => ({ x: p.x + dl[i][0], y: p.y + dl[i][1], on: p.on }))
    const contours = []
    let s = 0
    for (const e of contourEnds) { contours.push(moved.slice(s, e + 1)); s = e + 1 }
    const advance = moved[pts.length + 1].x - moved[pts.length].x
    return { contours, advance, lsbShift: moved[pts.length].x }
  }

  gid(ch) { return this.cmap.get(ch.codePointAt(0)) ?? 0 }
}

const fmt = (n) => +n.toFixed(2)

/** TrueType quadratic contours -> SVG path data. Transform: x' = ox + x*s, y' = oy - y*s. */
export function contoursToPath(contours, ox = 0, oy = 0, s = 1) {
  const P = (p) => `${fmt(ox + p.x * s)} ${fmt(oy - p.y * s)}`
  let d = ''
  for (const c of contours) {
    if (!c.length) continue
    const n = c.length
    let startIdx = c.findIndex((p) => p.on)
    let start
    if (startIdx < 0) { start = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2, on: true }; startIdx = 0 } else start = c[startIdx]
    d += `M${P(start)}`
    let ctrl = null
    for (let k = 1; k <= n; k++) {
      const p = c[(startIdx + k) % n]
      if (k === n && c.findIndex((q) => q.on) < 0) {
        // all off-curve contour: close via first point
      }
      if (p.on) {
        if (ctrl) { d += `Q${P(ctrl)} ${P(p)}`; ctrl = null } else d += `L${P(p)}`
      } else {
        if (ctrl) {
          const mid = { x: (ctrl.x + p.x) / 2, y: (ctrl.y + p.y) / 2 }
          d += `Q${P(ctrl)} ${P(mid)}`
        }
        ctrl = p
      }
    }
    if (ctrl) d += `Q${P(ctrl)} ${P(start)}`
    d += 'Z'
  }
  return d
}
