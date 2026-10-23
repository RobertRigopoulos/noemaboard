/**
 * Manual check against a DEPLOYED relay (skipped unless NOEMA_RELAY_URL is set), e.g.
 *   NOEMA_RELAY_URL=wss://noema.example.workers.dev/relay npx vitest run src/collab/relay/deployed.manual.test.ts
 * Device A writes a board and a file, disconnects; device B connects later and must get both.
 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { newSecret } from '../../model/ids'
import { hashBytes } from '../crypto'
import { RelayConnection } from './connection'
import { deriveRelayKeys } from './keys'
import { memoryStateStore } from './state'
import { parseRelayUrl } from './url'
import { downloadBlob, uploadBlob } from './blobs'

const URL_ENV: string = ((globalThis as any).process?.env?.NOEMA_RELAY_URL as string | undefined) ?? ''

async function waitFor(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.skipIf(!URL_ENV)('deployed relay', () => {
  it('keeps a board and its files available while the author is offline', async () => {
    const endpoint = parseRelayUrl(URL_ENV)!
    const keys = await deriveRelayKeys(newSecret())
    const mk = (doc: Y.Doc) =>
      new RelayConnection({ boardId: 'deployed-check-1', endpoint, keys, doc, store: memoryStateStore(), onStatus: () => {} })

    const docA = new Y.Doc()
    const a = mk(docA)
    a.start()
    await waitFor(() => a.connected, 15000, 'A connects')
    docA.getMap('cards').set('note', 'written while B was offline')
    await waitFor(() => a.clean, 15000, 'A pushed')

    const bytes = new TextEncoder().encode('file bytes ' + Date.now())
    const hash = await hashBytes(bytes)
    await uploadBlob({ endpoint, keys }, hash, new Blob([bytes], { type: 'text/plain' }))
    a.stop()

    const docB = new Y.Doc()
    const b = mk(docB)
    b.start()
    await waitFor(() => docB.getMap('cards').get('note') === 'written while B was offline', 15000, 'B receives')
    const got = await downloadBlob({ endpoint, keys }, hash)
    expect(got && new TextDecoder().decode(new Uint8Array(await got.arrayBuffer()))).toBe(new TextDecoder().decode(bytes))
    b.stop()
  }, 60000)
})
