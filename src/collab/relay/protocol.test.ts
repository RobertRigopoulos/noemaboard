import { describe, expect, it } from 'vitest'
import {
  Decoder,
  Encoder,
  HELLO_PROBE,
  MAX_WIRE_FRAME,
  MSG,
  PROTOCOL_VERSION,
  ProtocolError,
  Reassembler,
  decodeServerFrame,
  encodeCompact,
  encodeEph,
  encodeHello,
  encodePush,
  splitFrame,
} from './protocol'

describe('relay protocol codec', () => {
  it('round-trips varUints including large values', () => {
    const values = [0, 1, 127, 128, 255, 16383, 16384, 2 ** 31, 2 ** 32 + 5, Number.MAX_SAFE_INTEGER]
    const e = new Encoder(4)
    for (const v of values) e.varUint(v)
    const d = new Decoder(e.done())
    for (const v of values) expect(d.varUint()).toBe(v)
    expect(() => new Encoder().varUint(-1)).toThrow()
    expect(() => new Encoder().varUint(1.5)).toThrow()
  })

  it('matches lib0 varUint encoding', () => {
    expect(Array.from(new Encoder().varUint(300).done())).toEqual([0xac, 0x02])
  })

  it('encodes client frames', () => {
    const hello = new Decoder(encodeHello({ roomId: 'r'.repeat(22), token: 't'.repeat(43), accessKey: 'k', since: 42, flags: HELLO_PROBE }))
    expect(hello.u8()).toBe(MSG.HELLO)
    expect(hello.varUint()).toBe(PROTOCOL_VERSION)
    expect(hello.varUint()).toBe(HELLO_PROBE)
    expect(hello.string()).toBe('r'.repeat(22))
    expect(hello.string()).toBe('t'.repeat(43))
    expect(hello.string()).toBe('k')
    expect(hello.varUint()).toBe(42)

    const push = new Decoder(encodePush(7, new Uint8Array([1, 2, 3])))
    expect([push.u8(), push.varUint(), Array.from(push.bytes())]).toEqual([MSG.PUSH, 7, [1, 2, 3]])
    const eph = new Decoder(encodeEph(new Uint8Array([4])))
    expect([eph.u8(), Array.from(eph.bytes())]).toEqual([MSG.EPH, [4]])
    const compact = new Decoder(encodeCompact(9, new Uint8Array([5, 6])))
    expect([compact.u8(), compact.varUint(), Array.from(compact.bytes())]).toEqual([MSG.COMPACT, 9, [5, 6]])
  })

  it('decodes server frames', () => {
    const welcome = new Encoder()
      .u8(MSG.WELCOME)
      .varUint(3)
      .varUint(5)
      .varUint(100)
      .varUint(2)
      .bytes(new Uint8Array([9, 9]))
      .varUint(2)
      .varUint(4)
      .bytes(new Uint8Array([1]))
      .varUint(5)
      .bytes(new Uint8Array([2]))
      .done()
    const w = decodeServerFrame(welcome)
    expect(w).toMatchObject({ type: MSG.WELCOME, snapSeq: 3, head: 5, logBytes: 100, peers: 2 })
    if (w.type !== MSG.WELCOME) throw new Error('unreachable')
    expect(Array.from(w.snapshot!)).toEqual([9, 9])
    expect(w.updates.map((u) => u.seq)).toEqual([4, 5])

    // Older relays send no message limit.
    expect(w.maxMessage).toBeNull()

    const empty = decodeServerFrame(new Encoder().u8(MSG.WELCOME).varUint(0).varUint(0).varUint(0).varUint(0).bytes(new Uint8Array()).varUint(0).done())
    expect(empty).toMatchObject({ snapshot: null, updates: [], maxMessage: null })
    // Newer relays append their message limit.
    const limited = decodeServerFrame(
      new Encoder().u8(MSG.WELCOME).varUint(0).varUint(0).varUint(0).varUint(0).bytes(new Uint8Array()).varUint(0).varUint(16 * 1024 * 1024).done(),
    )
    expect(limited).toMatchObject({ maxMessage: 16 * 1024 * 1024 })

    expect(decodeServerFrame(new Encoder().u8(MSG.ACK).varUint(1).varUint(2).done())).toEqual({ type: MSG.ACK, id: 1, seq: 2 })
    expect(decodeServerFrame(new Encoder().u8(MSG.COMPACTED).varUint(10).varUint(20).done())).toEqual({ type: MSG.COMPACTED, snapSeq: 10, logBytes: 20 })
    expect(decodeServerFrame(new Encoder().u8(MSG.ERR).varUint(5).varUint(3).string('full').done())).toEqual({
      type: MSG.ERR,
      code: 5,
      ref: 3,
      message: 'full',
    })
    expect(decodeServerFrame(new Encoder().u8(MSG.PEERS).varUint(4).done())).toEqual({ type: MSG.PEERS, peers: 4 })
  })

  it('rejects malformed frames', () => {
    expect(() => decodeServerFrame(new Uint8Array([]))).toThrow(ProtocolError)
    expect(() => decodeServerFrame(new Uint8Array([MSG.UPD, 1, 200]))).toThrow(ProtocolError)
    expect(() => decodeServerFrame(new Uint8Array([99]))).toThrow(ProtocolError)
    expect(() => decodeServerFrame(new Uint8Array([MSG.ACK, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toThrow(ProtocolError)
    // Claims a huge update count with no data behind it.
    expect(() => decodeServerFrame(new Encoder().u8(MSG.WELCOME).varUint(0).varUint(0).varUint(0).varUint(0).bytes(new Uint8Array()).varUint(1e6).done())).toThrow(
      ProtocolError,
    )
    expect(() => decodeServerFrame(new Uint8Array([MSG.ERR, 1, 0, 2, 0xff, 0xfe]))).toThrow(ProtocolError)
  })
})

describe('large frames', () => {
  it('leaves small frames alone and splits big ones', () => {
    const small = new Uint8Array(100)
    expect(splitFrame(small, 1)).toEqual([small])
    const big = new Uint8Array(MAX_WIRE_FRAME * 2 + 123).map((_, i) => i % 251)
    const parts = splitFrame(big, 7)
    expect(parts.length).toBeGreaterThan(2)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(MAX_WIRE_FRAME)
    const r = new Reassembler(10 * MAX_WIRE_FRAME)
    let out: Uint8Array | null = null
    for (const p of parts) out = r.push(p)
    expect(out).not.toBeNull()
    expect(out!.length).toBe(big.length)
    expect(out!.every((b, i) => b === i % 251)).toBe(true)
  })

  it('refuses out-of-order, oversized and excessive transfers', () => {
    const big = new Uint8Array(MAX_WIRE_FRAME * 2)
    const parts = splitFrame(big, 1)
    expect(() => new Reassembler(10 * MAX_WIRE_FRAME).push(parts[1])).toThrow(ProtocolError)
    const tiny = new Reassembler(MAX_WIRE_FRAME / 2)
    expect(() => {
      for (const p of parts) tiny.push(p)
    }).toThrow(/too large/)
    const r = new Reassembler(100 * MAX_WIRE_FRAME, 2)
    r.push(splitFrame(big, 1)[0])
    r.push(splitFrame(big, 2)[0])
    expect(() => r.push(splitFrame(big, 3)[0])).toThrow(/too many/)
    r.reset()
    expect(r.push(splitFrame(big, 3)[0])).toBeNull()
  })
})
