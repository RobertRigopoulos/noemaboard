import { describe, expect, it } from 'vitest'
import { newSecret } from '../../model/ids'
import { KIND, SEAL_OVERHEAD, blobAlias, deriveRelayKeys, deriveRelayKeysUncached, open, seal } from './keys'
import { decryptBlob, encryptBlob } from './blobs'

describe('relay key derivation', () => {
  it('is deterministic per secret and different across secrets', async () => {
    const secret = newSecret()
    const a = await deriveRelayKeys(secret)
    // Bypass the cache: same secret string, fresh derivation.
    const b = await deriveRelayKeysUncached(secret)
    expect(a.roomId).toBe(b.roomId)
    expect(a.writeToken).toBe(b.writeToken)
    const other = await deriveRelayKeys(newSecret())
    expect(other.roomId).not.toBe(a.roomId)
    expect(other.writeToken).not.toBe(a.writeToken)
  })

  it('produces ids of the expected shape, never revealing the secret', async () => {
    const secret = newSecret()
    const k = await deriveRelayKeys(secret)
    expect(k.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(k.writeToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(k.roomId).not.toBe(k.writeToken.slice(0, 22))
    expect(k.writeToken).not.toContain(secret)
    expect(k.contentKey.extractable).toBe(false)
    expect(k.contentKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
  })

  it('matches known vectors (guards against accidental changes to the derivation)', async () => {
    const k = await deriveRelayKeys('fixed-test-secret-0000000000000000000000000')
    const again = await deriveRelayKeys('fixed-test-secret-0000000000000000000000000')
    expect(again).toBe(k)
    // Recompute independently with WebCrypto to pin the HKDF parameters.
    const enc = new TextEncoder()
    const ikm = await crypto.subtle.importKey('raw', enc.encode('fixed-test-secret-0000000000000000000000000'), 'HKDF', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('noema/relay/v1'), info: enc.encode('mnf relay room id') },
      ikm,
      128,
    )
    const b64 = btoa(String.fromCharCode(...new Uint8Array(bits))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(k.roomId).toBe(b64)
  })

  it('rejects an empty secret', async () => {
    await expect(deriveRelayKeys('')).rejects.toThrow()
  })
})

describe('relay encryption', () => {
  it('round-trips and uses a fresh IV every time', async () => {
    const k = await deriveRelayKeys(newSecret())
    const plain = new TextEncoder().encode('hello board')
    const a = await seal(k, KIND.UPDATE, plain)
    const b = await seal(k, KIND.UPDATE, plain)
    expect(a.length).toBe(plain.length + SEAL_OVERHEAD)
    expect(Array.from(a)).not.toEqual(Array.from(b))
    expect(new TextDecoder().decode(await open(k, KIND.UPDATE, a))).toBe('hello board')
    expect(new TextDecoder().decode(await open(k, KIND.UPDATE, b))).toBe('hello board')
  })

  it('handles empty payloads', async () => {
    const k = await deriveRelayKeys(newSecret())
    const sealed = await seal(k, KIND.SNAPSHOT, new Uint8Array(0))
    expect((await open(k, KIND.SNAPSHOT, sealed)).length).toBe(0)
  })

  it('fails on tampering, wrong kind, wrong board and garbage', async () => {
    const k = await deriveRelayKeys(newSecret())
    const sealed = await seal(k, KIND.UPDATE, new Uint8Array([1, 2, 3, 4]))
    const tampered = sealed.slice()
    tampered[tampered.length - 1] ^= 1
    await expect(open(k, KIND.UPDATE, tampered)).rejects.toThrow()
    await expect(open(k, KIND.AWARENESS, sealed)).rejects.toThrow()
    const other = await deriveRelayKeys(newSecret())
    await expect(open(other, KIND.UPDATE, sealed)).rejects.toThrow()
    // Same content key but another room id (AAD) must fail too.
    await expect(open({ ...k, roomId: other.roomId }, KIND.UPDATE, sealed)).rejects.toThrow()
    await expect(open(k, KIND.UPDATE, new Uint8Array(10))).rejects.toThrow()
    const badVersion = sealed.slice()
    badVersion[0] = 9
    await expect(open(k, KIND.UPDATE, badVersion)).rejects.toThrow()
  })

  it('derives stable, board-specific blob aliases', async () => {
    const k = await deriveRelayKeys(newSecret())
    const hash = 'a'.repeat(64)
    const a1 = await blobAlias(k, hash)
    expect(a1).toMatch(/^[0-9a-f]{64}$/)
    expect(await blobAlias(k, hash)).toBe(a1)
    expect(a1).not.toBe(hash)
    expect(await blobAlias(k, 'b'.repeat(64))).not.toBe(a1)
    expect(await blobAlias(await deriveRelayKeys(newSecret()), hash)).not.toBe(a1)
  })

  it('encrypts files with their type', async () => {
    const k = await deriveRelayKeys(newSecret())
    const data = new Blob([new Uint8Array([9, 8, 7, 6])], { type: 'image/png' })
    const sealed = await encryptBlob(k, data)
    const back = await decryptBlob(k, sealed)
    expect(back.type).toBe('image/png')
    expect(Array.from(new Uint8Array(await back.arrayBuffer()))).toEqual([9, 8, 7, 6])
    await expect(open(k, KIND.UPDATE, sealed)).rejects.toThrow()
  })
})
