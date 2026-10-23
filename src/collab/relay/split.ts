/**
 * Splits a large Yjs update into several smaller, valid updates, so a big change (a whole board
 * pushed when a relay is first configured, edits piled up offline) fits the relay's message limit.
 *
 * Pieces are cut at struct boundaries: each holds runs of consecutive structs (at most one run per
 * client), and the delete set travels in the last piece or in pieces of its own. Applying every
 * piece, in any order, has exactly the effect of applying the original update (Yjs keeps structs
 * whose dependencies have not arrived yet pending). Structs are re-encoded with Yjs' own writers,
 * the same way Y.mergeUpdates does it.
 */
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'

type Struct = Y.Item | Y.GC | Y.Skip
type DsEntry = [client: number, ranges: { clock: number; len: number }[]]

interface Run {
  client: number
  clock: number
  count: number
  body: encoding.Encoder
}

/** Upper bound for a run/delete-set header (varUint count + client + clock) or a piece's framing. */
const HEADER_BYTES = 24
/** Upper bound for one delete-set range (two varUints). */
const DS_RANGE_BYTES = 16

function encodeStruct(s: Struct): Uint8Array {
  const e = new Y.UpdateEncoderV1()
  s.write(e, 0)
  return e.toUint8Array()
}

/** Writes a Yjs v1 update: struct runs, then the delete set. */
function encodePiece(runs: Run[], ds: DsEntry[]): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, runs.length)
  for (const r of runs) {
    encoding.writeVarUint(e, r.count)
    encoding.writeVarUint(e, r.client)
    encoding.writeVarUint(e, r.clock)
    encoding.writeUint8Array(e, encoding.toUint8Array(r.body))
  }
  encoding.writeVarUint(e, ds.length)
  for (const [client, ranges] of ds) {
    encoding.writeVarUint(e, client)
    encoding.writeVarUint(e, ranges.length)
    for (const r of ranges) {
      encoding.writeVarUint(e, r.clock)
      encoding.writeVarUint(e, r.len)
    }
  }
  return encoding.toUint8Array(e)
}

/**
 * Splits `update` (Yjs v1 encoding) into updates of at most `maxBytes` each. Returns `[update]`
 * when it already fits. A single struct larger than `maxBytes` (e.g. one enormous pasted text)
 * cannot be cut and comes back as a piece of its own that is still too large.
 */
export function splitUpdate(update: Uint8Array, maxBytes: number): Uint8Array[] {
  if (update.length <= maxBytes) return [update]
  const { structs, ds } = Y.decodeUpdate(update)
  const budget = Math.max(1, maxBytes - HEADER_BYTES)

  const pieces: { runs: Run[]; size: number }[] = []
  let runs: Run[] = []
  let size = 0
  let run: Run | null = null
  /** Hole inside the current run (merged updates contain them); kept only if the run continues. */
  let gap: Uint8Array | null = null

  const endPiece = () => {
    if (runs.length) pieces.push({ runs, size })
    runs = []
    size = 0
    run = null
    gap = null
  }

  for (const s of structs as Struct[]) {
    if (run && s.id.client !== run.client) {
      run = null
      gap = null
    }
    if (s instanceof Y.Skip) {
      // A hole at the start of a run is dropped: the run starts at the next real struct.
      if (run) gap = encodeStruct(s)
      continue
    }
    const bytes = encodeStruct(s)
    const extra = bytes.length + (run ? (gap?.length ?? 0) : HEADER_BYTES)
    if (size > 0 && size + extra > budget) endPiece()
    if (!run) {
      run = { client: s.id.client, clock: s.id.clock, count: 0, body: encoding.createEncoder() }
      runs.push(run)
      size += HEADER_BYTES
    } else if (gap) {
      encoding.writeUint8Array(run.body, gap)
      run.count++
      size += gap.length
    }
    gap = null
    encoding.writeUint8Array(run.body, bytes)
    run.count++
    size += bytes.length
  }
  endPiece()

  const out = pieces.map((p) => encodePiece(p.runs, []))
  const dsEntries: DsEntry[] = Array.from(ds.clients.entries()).filter(([, ranges]) => ranges.length > 0)
  if (!dsEntries.length) return out.length ? out : [update]

  // The delete set joins the last piece when it fits, otherwise it gets pieces of its own.
  const dsSize = dsEntries.reduce((n, [, ranges]) => n + HEADER_BYTES + ranges.length * DS_RANGE_BYTES, 0)
  const last = pieces[pieces.length - 1]
  if (last && last.size + dsSize <= budget) {
    out[out.length - 1] = encodePiece(last.runs, dsEntries)
    return out
  }
  let chunk: DsEntry[] = []
  let chunkSize = 0
  for (const [client, ranges] of dsEntries) {
    let part: DsEntry[1] = []
    for (const r of ranges) {
      if (chunkSize > 0 && chunkSize + DS_RANGE_BYTES + (part.length ? 0 : HEADER_BYTES) > budget) {
        if (part.length) chunk.push([client, part])
        out.push(encodePiece([], chunk))
        chunk = []
        chunkSize = 0
        part = []
      }
      chunkSize += DS_RANGE_BYTES + (part.length ? 0 : HEADER_BYTES)
      part.push(r)
    }
    if (part.length) chunk.push([client, part])
  }
  if (chunk.length) out.push(encodePiece([], chunk))
  return out
}
