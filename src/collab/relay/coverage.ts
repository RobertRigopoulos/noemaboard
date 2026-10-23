/**
 * What we know the relay already stores, as Yjs id ranges. Used to avoid pushing the same content
 * twice: when a teammate's edit reaches us peer-to-peer, they normally push it to the relay
 * themselves, so we only push it if the relay still lacks it after a grace period (e.g. their
 * network blocks the relay but not peer-to-peer).
 */
import * as Y from 'yjs'

/** Sorted, non-overlapping, non-adjacent half-open intervals [start, end). */
export class RangeSet {
  private starts: number[] = []
  private ends: number[] = []

  get size(): number {
    return this.starts.length
  }

  add(start: number, end: number) {
    if (!(end > start)) return
    const { starts, ends } = this
    // First interval whose end reaches `start` (touching intervals merge).
    let i = lowerBound(ends, start)
    let s = start
    let e = end
    let j = i
    while (j < starts.length && starts[j] <= e) {
      s = Math.min(s, starts[j])
      e = Math.max(e, ends[j])
      j++
    }
    starts.splice(i, j - i, s)
    ends.splice(i, j - i, e)
  }

  /** True if [start, end) lies entirely inside one stored interval. */
  covers(start: number, end: number): boolean {
    if (!(end > start)) return true
    const i = lowerBound(this.ends, start + 1)
    return i < this.starts.length && this.starts[i] <= start && this.ends[i] >= end
  }

  /** Length of the contiguous run starting at 0 (a Yjs state-vector clock). */
  prefixEnd(): number {
    return this.starts.length && this.starts[0] === 0 ? this.ends[0] : 0
  }

  toArray(): [number, number][] {
    return this.starts.map((s, i) => [s, this.ends[i]])
  }
}

/** Index of the first element >= x in a sorted array. */
function lowerBound(arr: number[], x: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

interface UpdateRanges {
  structs: Map<number, [number, number][]>
  deletes: Map<number, [number, number][]>
}

function rangesOf(update: Uint8Array): UpdateRanges {
  const { structs, ds } = Y.decodeUpdate(update)
  const s = new Map<number, [number, number][]>()
  for (const st of structs) {
    // Skip structs mark holes in an update, not content.
    if (st instanceof Y.Skip) continue
    const list = s.get(st.id.client) ?? []
    list.push([st.id.clock, st.id.clock + st.length])
    s.set(st.id.client, list)
  }
  const d = new Map<number, [number, number][]>()
  ds.clients.forEach((items, client) => {
    d.set(
      client,
      items.map((it) => [it.clock, it.clock + it.len]),
    )
  })
  return { structs: s, deletes: d }
}

export class RelayCoverage {
  private structs = new Map<number, RangeSet>()
  private deletes = new Map<number, RangeSet>()

  private static addAll(target: Map<number, RangeSet>, src: Map<number, [number, number][]>) {
    src.forEach((list, client) => {
      let set = target.get(client)
      if (!set) {
        set = new RangeSet()
        target.set(client, set)
      }
      for (const [a, b] of list) set.add(a, b)
    })
  }

  private static coversAll(target: Map<number, RangeSet>, src: Map<number, [number, number][]>): boolean {
    for (const [client, list] of src) {
      const set = target.get(client)
      for (const [a, b] of list) if (!set?.covers(a, b)) return false
    }
    return true
  }

  /** Records an update the relay is known to store. Malformed updates are ignored. */
  add(update: Uint8Array) {
    try {
      const r = rangesOf(update)
      RelayCoverage.addAll(this.structs, r.structs)
      RelayCoverage.addAll(this.deletes, r.deletes)
    } catch {
      // not a valid Yjs update: nothing to record
    }
  }

  /** Records that the relay holds every insert up to these clocks (e.g. remembered from a past session). */
  addStateVector(sv: Map<number, number>) {
    sv.forEach((clock, client) => {
      if (!Number.isSafeInteger(clock) || clock <= 0) return
      let set = this.structs.get(client)
      if (!set) {
        set = new RangeSet()
        this.structs.set(client, set)
      }
      set.add(0, clock)
    })
  }

  /** True if everything in `update` (inserts and deletions) is already on the relay. */
  covers(update: Uint8Array): boolean {
    try {
      const r = rangesOf(update)
      return RelayCoverage.coversAll(this.structs, r.structs) && RelayCoverage.coversAll(this.deletes, r.deletes)
    } catch {
      return false
    }
  }

  /** Contiguous-from-zero clocks per client: a valid Yjs state vector of known relay content. */
  stateVector(): Map<number, number> {
    const sv = new Map<number, number>()
    this.structs.forEach((set, client) => {
      const end = set.prefixEnd()
      if (end > 0) sv.set(client, end)
    })
    return sv
  }

  clear() {
    this.structs.clear()
    this.deletes.clear()
  }
}

/** Per-client maximum of two state vectors. */
export function mergeStateVectors(a: Map<number, number>, b: Map<number, number>): Map<number, number> {
  const out = new Map(a)
  b.forEach((clock, client) => out.set(client, Math.max(clock, out.get(client) ?? 0)))
  return out
}

/** True if `sv` has a clock beyond `base` for any client (i.e. content `base` lacks). */
export function exceeds(sv: Map<number, number>, base: Map<number, number>): boolean {
  for (const [client, clock] of sv) if (clock > (base.get(client) ?? 0)) return true
  return false
}
