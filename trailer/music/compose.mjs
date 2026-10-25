#!/usr/bin/env node
/**
 * The trailer's music: an original track written and synthesised here (no samples, no libraries),
 * so it is free to use anywhere. F major, 100 BPM, 16 bars of 2.4 s = 38.4 s, laid out on the same
 * bar grid as the trailer's scenes (src/Trailer.tsx):
 *
 *   bar  1      intro      pad swell; bell notes on the beats the headline appears
 *   bars 2-7    add, organise   light groove: piano, plucked arpeggios, bass, soft drums
 *   bars 8-12   together, share  lift: lead melody, shaker, fuller drums (bars 11-12 a bit calmer)
 *   bars 13-14  three points     build: bell per point, rising noise, faster arpeggio, drum roll
 *   bars 15-16  end card         resolves on Fmaj9 as the logo lands, then rings out
 *
 *   node music/compose.mjs     writes public/music/noemaboard-theme.wav, mastered to -14 LUFS (the
 *                              common loudness target for online video) with peaks under -1 dBTP
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '../public/music/noemaboard-theme.wav')

const SR = 48000
const BPM = 100
const BEAT = 60 / BPM
const BAR = 4 * BEAT
const BARS = 16
const LENGTH = BARS * BAR
const N = Math.round(LENGTH * SR)
const TAU = Math.PI * 2

// Deterministic "randomness": the same track every run.
let seed = 20261025
const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
const jitter = (amount) => (rand() * 2 - 1) * amount
const mtof = (m) => 440 * 2 ** ((m - 69) / 12)
/** Seconds at bar (1-based) and beat (0-based, may be fractional). */
const at = (bar, beat = 0) => (bar - 1) * BAR + beat * BEAT

// ---------------------------------------------------------------------------
// Filters

/** RBJ biquad; returns a per-sample function. */
function biquad(type, f0, q = 0.707) {
  const w = (TAU * f0) / SR
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)
  let b0, b1, b2
  if (type === 'lowpass') [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
  else if (type === 'highpass') [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
  else [b0, b1, b2] = [alpha, 0, -alpha] // bandpass, peak gain = 1
  const a0 = 1 + alpha
  const a1 = -2 * cos
  const a2 = 1 - alpha
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  return (x) => {
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x; y2 = y1; y1 = y
    return y
  }
}

/** RBJ high shelf: lifts (or cuts) everything above `f0` by `db`. */
function highShelf(f0, db) {
  const A = 10 ** (db / 40)
  const w = (TAU * f0) / SR
  const cos = Math.cos(w)
  const alpha = (Math.sin(w) / 2) * Math.SQRT2
  const sq = 2 * Math.sqrt(A) * alpha
  const b0 = A * (A + 1 + (A - 1) * cos + sq)
  const b1 = -2 * A * (A - 1 + (A + 1) * cos)
  const b2 = A * (A + 1 + (A - 1) * cos - sq)
  const a0 = A + 1 - (A - 1) * cos + sq
  const a1 = 2 * (A - 1 - (A + 1) * cos)
  const a2 = A + 1 - (A - 1) * cos - sq
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  return (x) => {
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x; y2 = y1; y1 = y
    return y
  }
}

/** One-pole low-pass with a cutoff that may change every sample. */
function onePole() {
  let y = 0
  return (x, cutoff) => {
    const g = 1 - Math.exp((-TAU * cutoff) / SR)
    y += g * (x - y)
    return y
  }
}

// ---------------------------------------------------------------------------
// Instruments: each returns a mono Float32Array for one note.

const buffer = (seconds) => new Float32Array(Math.ceil(seconds * SR))

/** Band-limited saw (polyBLEP). */
function saw(phase, dt) {
  let v = 2 * phase - 1
  if (phase < dt) {
    const t = phase / dt
    v -= t + t - t * t - 1
  } else if (phase > 1 - dt) {
    const t = (phase - 1) / dt
    v -= t * t + t + t + 1
  }
  return v
}

/** Warm pad: five detuned saws, slowly opening low-pass, long attack and release. */
function pad(freq, dur, attack = 0.7) {
  const rel = 1.4
  const out = buffer(dur + rel)
  const detune = [-11, -5, 0, 6, 12].map((c) => freq * 2 ** (c / 1200))
  const phase = detune.map(() => rand())
  const lp1 = onePole()
  const lp2 = onePole()
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    let s = 0
    for (let v = 0; v < detune.length; v++) {
      const dt = detune[v] / SR
      phase[v] += dt
      if (phase[v] >= 1) phase[v] -= 1
      s += saw(phase[v], dt)
    }
    const cutoff = 1200 + 2000 * Math.min(1, t / 2)
    const env = t < attack ? (1 - Math.cos((Math.PI * t) / attack)) / 2 : t < dur ? 1 : Math.exp(-(t - dur) / 0.45)
    out[i] = (lp2(lp1(s / detune.length, cutoff), cutoff) * env) * 0.9
  }
  return out
}

/** Electric piano: two-operator FM with a soft bell attack and gentle tremolo. */
function piano(freq, dur, vel) {
  const out = buffer(dur + 1.6)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const index = (1.8 * Math.exp(-t / 0.18) + 0.3) * (0.6 + 0.4 * vel)
    const s =
      Math.sin(TAU * freq * t + index * Math.sin(TAU * freq * t)) +
      0.2 * Math.sin(TAU * 2 * freq * t) * Math.exp(-t / 0.35) +
      0.08 * Math.sin(TAU * 4 * freq * t) * Math.exp(-t / 0.12)
    const env = (1 - Math.exp(-t / 0.003)) * Math.exp(-t / 1.25) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.12))
    out[i] = s * env * (1 + 0.05 * Math.sin(TAU * 4.6 * t)) * vel
  }
  return out
}

/** Plucked string (Karplus-Strong), softened. */
function pluck(freq, vel, bright = 0.62, decay = 0.996) {
  const out = buffer(1.4)
  const period = Math.max(2, Math.round(SR / freq))
  const ring = new Float32Array(period)
  let prev = 0
  for (let k = 0; k < period; k++) {
    prev += bright * (rand() * 2 - 1 - prev)
    ring[k] = prev
  }
  const lp = onePole()
  let idx = 0
  for (let i = 0; i < out.length; i++) {
    const a = ring[idx]
    const b = ring[(idx + 1) % period]
    ring[idx] = decay * 0.5 * (a + b)
    idx = (idx + 1) % period
    const fade = i > out.length - 2000 ? (out.length - i) / 2000 : 1
    out[i] = lp(a, 7000) * vel * 0.85 * fade
  }
  return out
}

/** Soft bell: a brief inharmonic shimmer on the attack, then a round, fairly short ring. */
function bell(freq, vel) {
  const out = buffer(2.4)
  const tail = 0.3 * SR
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const index = 0.8 * Math.exp(-t / 0.12)
    const s = Math.sin(TAU * freq * t + index * Math.sin(TAU * 3.5 * freq * t))
    out[i] = s * (1 - Math.exp(-t / 0.004)) * Math.exp(-t / 0.75) * Math.min(1, (out.length - i) / tail) * vel
  }
  return out
}

/** Round bass: sine with a little second harmonic, lightly saturated. */
function bass(freq, dur, vel) {
  const out = buffer(dur + 0.12)
  const lp = onePole()
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const s = Math.sin(TAU * freq * t) + 0.4 * Math.sin(TAU * 2 * freq * t) + 0.12 * Math.sin(TAU * 3 * freq * t)
    const env = Math.min(1, t / 0.01) * (t < dur ? 1 - 0.3 * Math.min(1, t / dur) : Math.exp(-(t - dur) / 0.04))
    out[i] = lp(Math.tanh(1.3 * s) / Math.tanh(1.3), 900) * env * vel
  }
  return out
}

/** Lead: triangle and saw through a low-pass, with delayed vibrato. */
function lead(freq, dur, vel) {
  const out = buffer(dur + 0.35)
  const lp1 = onePole()
  const lp2 = onePole()
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const vib = 1 + 0.0045 * Math.sin(TAU * 5.3 * t) * Math.min(1, Math.max(0, (t - 0.18) / 0.3))
    const dt = (freq * vib) / SR
    phase = (phase + dt) % 1
    const tri = 4 * Math.abs(phase - 0.5) - 1
    const s = 0.65 * tri + 0.35 * saw(phase, dt)
    const env = Math.min(1, t / 0.025) * (t < dur ? 0.85 + 0.15 * Math.exp(-t / 0.2) : Math.exp(-(t - dur) / 0.09))
    out[i] = lp2(lp1(s, 3600), 3600) * env * vel
  }
  return out
}

function kick(vel) {
  const out = buffer(0.5)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    phase += (TAU * (52 + 78 * Math.exp(-t / 0.032))) / SR
    const body = Math.sin(phase) * Math.exp(-t / 0.15)
    const click = (rand() * 2 - 1) * Math.exp(-t / 0.003) * 0.12
    out[i] = Math.tanh(1.5 * (body + click)) * vel
  }
  return out
}

/** Finger snap / soft clap: three quick filtered noise bursts and a short tail. */
function snap(vel) {
  const out = buffer(0.4)
  const bp = biquad('bandpass', 2400, 1.1)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    let env = Math.exp(-t / 0.085) * 0.6
    for (const b of [0, 0.011, 0.022]) if (t >= b) env += Math.exp(-(t - b) / 0.006)
    out[i] = bp(rand() * 2 - 1) * env * vel * 1.6
  }
  return out
}

function hat(vel, open = false) {
  const out = buffer(open ? 0.4 : 0.07)
  const hp = biquad('highpass', 7200, 0.8)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    out[i] = hp(rand() * 2 - 1) * Math.exp(-t / (open ? 0.13 : 0.016)) * vel
  }
  return out
}

function shaker(vel) {
  const out = buffer(0.1)
  const bp = biquad('bandpass', 6500, 1.5)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    out[i] = bp(rand() * 2 - 1) * Math.min(1, t / 0.008) * Math.exp(-t / 0.03) * vel * 2
  }
  return out
}

/** Filtered noise that rises over `seconds` and stops dead. */
function riser(seconds) {
  const out = buffer(seconds)
  const lp = onePole()
  for (let i = 0; i < out.length; i++) {
    const x = i / out.length
    out[i] = lp(rand() * 2 - 1, 350 * (9000 / 350) ** x) * x * x * 0.55
  }
  return out
}

/** Soft low boom and airy noise for the final chord. */
function impact() {
  const out = buffer(2.6)
  const hp = biquad('highpass', 4000, 0.7)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    phase += (TAU * (50 + 40 * Math.exp(-t / 0.1))) / SR
    out[i] = Math.sin(phase) * Math.exp(-t / 0.4) * 0.7 + hp(rand() * 2 - 1) * Math.exp(-t / 0.9) * 0.1
  }
  return out
}

// ---------------------------------------------------------------------------
// Mixing: notes go to the dry mix (or the "ducked" mix that dips on each kick), plus sends.

const stereo = () => [new Float32Array(N), new Float32Array(N)]
const dry = stereo()
const ducked = stereo()
const reverbSend = stereo()
const delaySend = stereo()
const duck = new Float32Array(N).fill(1)

/** Places a note at `time` seconds: gain, pan (-1..1), reverb and delay sends, and whether it ducks. */
function place(note, time, { gain = 1, pan = 0, rev = 0, del = 0, ducks = false } = {}) {
  const start = Math.round(time * SR)
  const angle = ((pan + 1) * Math.PI) / 4
  const l = Math.cos(angle) * Math.SQRT2 * gain
  const r = Math.sin(angle) * Math.SQRT2 * gain
  const target = ducks ? ducked : dry
  for (let k = 0; k < note.length; k++) {
    const i = start + k
    if (i < 0) continue
    if (i >= N) break
    const v = note[k]
    target[0][i] += v * l
    target[1][i] += v * r
    if (rev) {
      reverbSend[0][i] += v * l * rev
      reverbSend[1][i] += v * r * rev
    }
    if (del) {
      delaySend[0][i] += v * l * del
      delaySend[1][i] += v * r * del
    }
  }
}

/** A kick also pushes the ducked mix down for a moment (the gentle "pump" of modern pop). */
function placeKick(time, vel) {
  place(kick(vel), time, { gain: 0.37 })
  const start = Math.round(time * SR)
  const ramp = SR * 0.006
  for (let k = 0; k < SR * 0.4; k++) {
    const i = start + k
    if (i >= N) break
    const depth = 0.3 * Math.min(1, k / ramp) * Math.exp(-Math.max(0, k - ramp) / (SR * 0.12))
    duck[i] = Math.min(duck[i], 1 - depth)
  }
}

// ---------------------------------------------------------------------------
// The score

/** Chord voicings (MIDI notes) and bass notes. */
const CHORDS = {
  Fmaj9: { notes: [53, 57, 60, 64, 67], bass: 41 },
  Fmaj7: { notes: [53, 57, 60, 64], bass: 41 },
  Am7: { notes: [52, 55, 57, 60], bass: 45 },
  Bbmaj7: { notes: [53, 57, 58, 62], bass: 34 },
  Cadd9: { notes: [52, 55, 60, 62], bass: 36 },
  Dm7: { notes: [53, 57, 60, 62], bass: 38 },
  Gm7: { notes: [53, 58, 62, 65], bass: 43 },
  C7sus4: { notes: [53, 55, 58, 60], bass: 36 },
}
const PROGRESSION = ['Fmaj9', 'Fmaj7', 'Am7', 'Bbmaj7', 'Cadd9', 'Fmaj7', 'Am7', 'Bbmaj7', 'Cadd9', 'Am7', 'Dm7', 'Bbmaj7', 'Gm7', 'C7sus4', 'Fmaj9', 'Fmaj9']
const chordAt = (bar) => CHORDS[PROGRESSION[bar - 1]]

const LIFT = (bar) => bar >= 8 && bar <= 12
const CALM = (bar) => bar >= 11 && bar <= 12
/** Drum and bass energy per bar: builds from a sparse start to the lift, eases off, builds again. */
const ENERGY = [0, 0.6, 0.8, 0.85, 0.85, 0.85, 0.9, 1, 1, 1, 0.8, 0.8, 0.9, 1, 1, 1]
const energy = (bar) => ENERGY[bar - 1]

// Pad: every bar, louder in the lift; the intro swells in slowly.
for (let bar = 1; bar <= 14; bar++) {
  const chord = chordAt(bar)
  const gain = bar === 1 ? 0.075 : LIFT(bar) && !CALM(bar) ? 0.1 : CALM(bar) ? 0.075 : 0.06
  chord.notes.forEach((n, k) => place(pad(mtof(n), BAR, bar === 1 ? 1.8 : 0.5), at(bar), { gain, pan: -0.5 + (k / (chord.notes.length - 1)) * 1, rev: 0.35, ducks: true }))
}
// The last chord rings over the end card, with the top an octave up.
for (const [k, n] of [...CHORDS.Fmaj9.notes, 69, 72].entries()) place(pad(mtof(n), 2 * BAR - 1.2, 0.08), at(15), { gain: 0.08, pan: -0.6 + k * 0.2, rev: 0.45 })

// Piano: half notes in the groove, pulsing eighths in the lift; one big chord at the end.
for (let bar = 2; bar <= 14; bar++) {
  const chord = chordAt(bar)
  const hits = LIFT(bar) && !CALM(bar) ? [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] : bar >= 13 ? [0, 1, 2, 3] : [0, 2]
  for (const beat of hits) {
    const len = hits.length > 2 ? 0.42 * BEAT : 1.9 * BEAT
    const vel = (beat % 1 === 0 ? 0.55 : 0.38) + jitter(0.05)
    chord.notes.forEach((n, k) => place(piano(mtof(n + 12), len, vel), at(bar, beat) + jitter(0.004), { gain: 0.09, pan: -0.25 + k * 0.17, rev: 0.22, ducks: true }))
  }
}
CHORDS.Fmaj9.notes.forEach((n, k) => place(piano(mtof(n + 12), 3.5, 0.75), at(15) + k * 0.012, { gain: 0.085, pan: -0.3 + k * 0.15, rev: 0.4 }))

// Bass: root, a push on the "and", root, fifth; long notes under the end.
for (let bar = 2; bar <= 14; bar++) {
  const root = chordAt(bar).bass
  const pattern = [
    [0, 1.35, root],
    [1.5, 0.42, root],
    [2, 1.35, root],
    [3.5, 0.42, root + 7],
  ]
  for (const [beat, len, note] of pattern) place(bass(mtof(note), len * BEAT, (0.95 + jitter(0.04)) * energy(bar)), at(bar, beat), { gain: 0.16, ducks: true })
}
place(bass(mtof(41), 2.8, 0.9), at(15), { gain: 0.16 })

// Plucked arpeggios through the dotted-eighth delay; sixteenths in the build.
const ARP = [0, 2, 1, 3, 2, 1, 3, 2]
for (let bar = 3; bar <= 14; bar++) {
  const tones = chordAt(bar).notes.slice(0, 4).map((n) => n + 12)
  if (bar >= 13) {
    for (let s = 0; s < 16; s++) {
      const n = tones[s % 4] + 12 * Math.floor(s / 8)
      place(pluck(mtof(n), 0.35 + (s / 16) * 0.3 + jitter(0.04)), at(bar, s / 4), { gain: 0.11, pan: s % 2 ? 0.35 : -0.35, rev: 0.25, del: 0.2 })
    }
    continue
  }
  ARP.forEach((idx, e) => {
    place(pluck(mtof(tones[idx]), (e % 2 ? 0.32 : 0.42) + jitter(0.05)), at(bar, e / 2) + jitter(0.003), { gain: CALM(bar) ? 0.08 : 0.11, pan: e % 2 ? 0.35 : -0.35, rev: 0.25, del: 0.32 })
  })
}

// Lead melody in the lift (MIDI note, beat, length in beats).
const MELODY = {
  8: [[77, 0, 1], [74, 1, 0.5], [72, 1.5, 0.5], [74, 2, 2]],
  9: [[76, 0, 1], [74, 1, 0.5], [72, 1.5, 0.5], [67, 2, 2]],
  10: [[72, 0, 1], [69, 1, 0.5], [67, 1.5, 0.5], [69, 2, 2]],
  11: [[69, 0, 1], [72, 1, 1], [74, 2, 1], [77, 3, 1]],
  12: [[74, 0, 3], [72, 3, 1]],
}
for (const [bar, notes] of Object.entries(MELODY)) {
  for (const [n, beat, len] of notes) place(lead(mtof(n), len * BEAT * 0.92, 0.9), at(Number(bar), beat), { gain: 0.1, pan: 0.05, rev: 0.3, del: 0.22 })
}

// Bells: on the intro's beats (logo, "Lay out your ideas.", "Together."), one per point in the
// build, and a falling line over the end card. Kept soft, with little echo, so they mark the
// moments without sounding festive.
for (const [n, beat, vel] of [[72, 0, 0.5], [69, 1, 0.45], [77, 2, 0.6]]) place(bell(mtof(n), vel), at(1, beat), { gain: 0.065, pan: 0.15, rev: 0.25, del: 0.12 })
for (const [k, n] of [65, 69, 72, 76].entries()) place(pluck(mtof(n), 0.3), at(1, 3 + k * 0.25), { gain: 0.08, pan: -0.2 + k * 0.15, rev: 0.25, del: 0.2 })
for (const [k, n] of [70, 74, 77].entries()) place(bell(mtof(n + 12), 0.45), at(13, k), { gain: 0.05, pan: -0.3 + k * 0.3, rev: 0.2 })
for (const [k, n] of [81, 77, 72, 76].entries()) place(bell(mtof(n), 0.45 - k * 0.06), at(15, 1 + k), { gain: 0.05, pan: 0.2 - k * 0.12, rev: 0.3, del: 0.12 })

// Drums: bar 2 is just kick, snaps and hats join in bar 3, the lift adds a busier kick and shaker.
for (let bar = 2; bar <= 14; bar++) {
  const e = energy(bar)
  const kicks = bar === 14 ? [0, 1, 2, 3] : LIFT(bar) && !CALM(bar) ? [0, 1.5, 2, 3.5] : [0, 2]
  for (const beat of kicks) placeKick(at(bar, beat), 0.95 * e)
  if (bar >= 3 && bar !== 14) for (const beat of [1, 3]) place(snap((0.6 + jitter(0.05)) * e), at(bar, beat) + jitter(0.003), { gain: 0.17, pan: 0.05, rev: 0.28 })
  if (bar >= 3) {
    for (let n = 0; n < 8; n++) {
      if (bar === 14 && n === 7) continue
      place(hat(((n % 2 ? 0.5 : 0.28) + jitter(0.05)) * e), at(bar, n / 2) + jitter(0.003), { gain: 0.13, pan: 0.25 })
    }
  }
  if (LIFT(bar) && !CALM(bar)) {
    for (let n = 0; n < 16; n++) place(shaker((n % 4 === 2 ? 0.55 : 0.3) + jitter(0.06)), at(bar, n / 4) + jitter(0.004), { gain: 0.085, pan: -0.3 })
    place(hat(0.45, true), at(bar, 3.5), { gain: 0.1, pan: 0.25 })
  }
}
// A short rush of air into the lift ("Edit together, live").
place(riser(2 * BEAT), at(7, 2), { gain: 0.06, rev: 0.2 })
// A rising roll into the end chord, stopping an eighth before it.
for (let s = 8; s < 14; s++) place(snap(0.2 + ((s - 8) / 6) * 0.5), at(14, s / 4), { gain: 0.14, rev: 0.25 })
place(riser(2 * BAR - BEAT / 2), at(13), { gain: 0.08, rev: 0.2 })
place(impact(), at(15), { gain: 0.3, rev: 0.25 })
placeKick(at(15), 1)

// ---------------------------------------------------------------------------
// Effects and master

/** Freeverb (Jezar), stereo. */
function freeverb([inL, inR], { room = 0.86, damp = 0.25, width = 1 } = {}) {
  const scale = SR / 44100
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
  const allpasses = [556, 441, 341, 225]
  const make = (spread) => ({
    combs: combs.map((n) => ({ buf: new Float32Array(Math.round((n + spread) * scale)), i: 0, store: 0 })),
    alls: allpasses.map((n) => ({ buf: new Float32Array(Math.round((n + spread) * scale)), i: 0 })),
  })
  const feedback = room * 0.28 + 0.7
  const damping = damp * 0.4
  const run = (ch, x) => {
    let out = 0
    for (const c of ch.combs) {
      const y = c.buf[c.i]
      c.store = y * (1 - damping) + c.store * damping
      c.buf[c.i] = x + c.store * feedback
      if (++c.i >= c.buf.length) c.i = 0
      out += y
    }
    for (const a of ch.alls) {
      const b = a.buf[a.i]
      a.buf[a.i] = out + b * 0.5
      out = b - out
      if (++a.i >= a.buf.length) a.i = 0
    }
    return out
  }
  const L = make(0)
  const R = make(23)
  const outL = new Float32Array(N)
  const outR = new Float32Array(N)
  const w1 = width / 2 + 0.5
  const w2 = (1 - width) / 2
  for (let i = 0; i < N; i++) {
    const x = (inL[i] + inR[i]) * 0.015
    const l = run(L, x)
    const r = run(R, x)
    outL[i] = l * w1 + r * w2
    outR[i] = r * w1 + l * w2
  }
  return [outL, outR]
}

/** Ping-pong delay, dotted eighth, darkening repeats. */
function pingPong([inL, inR], seconds, feedback = 0.38) {
  const d = Math.round(seconds * SR)
  const bufL = new Float32Array(d)
  const bufR = new Float32Array(d)
  const lpL = onePole()
  const lpR = onePole()
  const outL = new Float32Array(N)
  const outR = new Float32Array(N)
  for (let i = 0, j = 0; i < N; i++, j = (j + 1) % d) {
    const yl = bufL[j]
    const yr = bufR[j]
    bufL[j] = lpL(inL[i] + inR[i] + yr * feedback, 3500)
    bufR[j] = lpR(yl * feedback, 3500)
    outL[i] = yl
    outR[i] = yr
  }
  return [outL, outR]
}

/** Integrated loudness in LUFS, as ITU-R BS.1770-4 measures it: K-weighted, 400 ms blocks, gated. */
function loudness(chs) {
  // The standard's 48 kHz filters: a +4 dB shelf above about 1.5 kHz, then a 38 Hz high-pass.
  const K_WEIGHTING = [
    [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
    [1, -2, 1, -1.99004745483398, 0.99007225036621],
  ]
  const stage = ([b0, b1, b2, a1, a2]) => {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    return (x) => {
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1; x1 = x; y2 = y1; y1 = y
      return y
    }
  }
  // Running sums of the weighted signal squared, so each block's mean is one subtraction.
  const sums = chs.map((x) => {
    const [shelf, highPass] = K_WEIGHTING.map(stage)
    const sum = new Float64Array(N + 1)
    for (let i = 0; i < N; i++) {
      const y = highPass(shelf(x[i]))
      sum[i + 1] = sum[i] + y * y
    }
    return sum
  })
  const block = 0.4 * SR
  const powers = []
  for (let s = 0; s + block <= N; s += block / 4) powers.push(sums.reduce((p, sum) => p + (sum[s + block] - sum[s]) / block, 0))
  const lufs = (p) => -0.691 + 10 * Math.log10(p)
  const mean = (ps) => ps.reduce((a, b) => a + b, 0) / ps.length
  const audible = powers.filter((p) => lufs(p) > -70)
  const gate = lufs(mean(audible)) - 10
  return lufs(mean(audible.filter((p) => lufs(p) > gate)))
}

/**
 * Look-ahead limiter, worked out over the whole track at once. Every peak above `ceiling`, counting
 * the peaks between samples, gets a dip that ramps in over `attack` seconds either side of it (so it
 * is in place before the peak arrives) and recovers over `release`. Changes `chs` in place and
 * returns the deepest dip in dB.
 */
function limit(chs, ceiling, attack = 0.002, release = 0.08) {
  const reach = Math.round(attack * SR)
  const need = new Float32Array(N).fill(1)
  for (let i = 1; i < N - 2; i++) {
    let peak = 0
    for (const x of chs) {
      // Catmull-Rom through the neighbours estimates the waveform between samples i and i + 1.
      const [a, b, c, d] = [x[i - 1], x[i], x[i + 1], x[i + 2]]
      for (const t of [0, 0.25, 0.5, 0.75]) {
        peak = Math.max(peak, Math.abs(b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)))))
      }
    }
    if (peak <= ceiling) continue
    for (let k = Math.max(0, i - reach); k <= Math.min(N - 1, i + 1 + reach); k++) need[k] = Math.min(need[k], ceiling / peak)
  }
  // Averaging over the same reach turns each dip into a smooth ramp and never lifts a peak's gain:
  // every sample in that window already holds the peak's gain or less.
  const edge = (k) => need[Math.min(N - 1, Math.max(0, k))]
  let sum = 0
  for (let k = -reach; k <= reach; k++) sum += edge(k)
  const recover = 1 - Math.exp(-1 / (release * SR))
  let gain = 1
  let deepest = 1
  for (let i = 0; i < N; i++) {
    // The gain falls as fast as the ramp asks but rises back only at the release rate.
    gain = Math.min(sum / (2 * reach + 1), gain + (1 - gain) * recover)
    deepest = Math.min(deepest, gain)
    for (const x of chs) x[i] *= gain
    sum += edge(i + reach + 1) - edge(i - reach)
  }
  return 20 * Math.log10(deepest)
}

const [revL, revR] = freeverb(reverbSend)
const [delL, delR] = pingPong(delaySend, 0.75 * BEAT)
const mix = [new Float32Array(N), new Float32Array(N)]
for (let ch = 0; ch < 2; ch++) {
  const hp1 = biquad('highpass', 32, 0.707)
  const hp2 = biquad('highpass', 32, 0.707)
  const air = highShelf(3500, 4)
  const rev = ch ? revR : revL
  const del = ch ? delR : delL
  for (let i = 0; i < N; i++) {
    const x = dry[ch][i] + ducked[ch][i] * duck[i] + rev[i] * 0.9 + del[i] * 0.5
    mix[ch][i] = air(hp2(hp1(x)))
  }
}
// Fade the ring-out to silence by the end of the video.
const fadeFrom = Math.round((LENGTH - 1.6) * SR)
for (let i = fadeFrom; i < N; i++) {
  const g = Math.cos(((i - fadeFrom) / (N - fadeFrom)) * (Math.PI / 2)) ** 2
  mix[0][i] *= g
  mix[1][i] *= g
}
// Master: gentle soft clip, then -14 LUFS with peaks held under -1.5 dBFS (about -1 dBTP). The
// limiter takes a little loudness back, so the gain settles over a few passes.
for (const ch of mix) for (let i = 0; i < N; i++) ch[i] = Math.tanh(ch[i])
const TARGET = -14
let gain = 10 ** ((TARGET - loudness(mix)) / 20)
let master, dip, level
for (let pass = 0; pass < 4; pass++) {
  master = mix.map((ch) => ch.map((v) => v * gain))
  dip = limit(master, 10 ** (-1.5 / 20))
  level = loudness(master)
  if (Math.abs(level - TARGET) < 0.05) break
  gain *= 10 ** ((TARGET - level) / 20)
}

// 16-bit stereo WAV
const data = Buffer.alloc(N * 4)
for (let i = 0; i < N; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, master[0][i])) * 32767), i * 4)
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, master[1][i])) * 32767), i * 4 + 2)
}
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + data.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(2, 22)
header.writeUInt32LE(SR, 24)
header.writeUInt32LE(SR * 4, 28)
header.writeUInt16LE(4, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(data.length, 40)
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, Buffer.concat([header, data]))
console.log(`compose: ${LENGTH.toFixed(1)} s at ${level.toFixed(1)} LUFS, limiter dips ${(-dip).toFixed(1)} dB at most -> ${path.relative(process.cwd(), OUT)}`)
