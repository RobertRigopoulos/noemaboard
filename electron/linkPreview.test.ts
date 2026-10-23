import http from 'node:http'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLimiter, defaultUserAgent, fetchImage, fetchLinkPreview, type FetchOptions } from './linkPreview'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])

let server: http.Server
let port = 0
const seenHeaders: http.IncomingHttpHeaders[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seenHeaders.push(req.headers)
    const url = req.url ?? '/'
    switch (url) {
      case '/page': {
        const html = Buffer.from(
          '<html><head><title>Caf\xe9</title><meta property="og:image" content="/cover.png"><meta name="description" content="Hello"></head><body>x</body></html>',
          'latin1',
        )
        res.writeHead(200, { 'Content-Type': 'text/html; charset=windows-1252', 'Content-Encoding': 'gzip' })
        res.end(zlib.gzipSync(html))
        return
      }
      case '/redirect':
        res.writeHead(302, { Location: '/page' })
        res.end()
        return
      case '/loop':
        res.writeHead(301, { Location: '/loop' })
        res.end()
        return
      case '/to-private':
        res.writeHead(302, { Location: 'http://10.0.0.1/' })
        res.end()
        return
      case '/to-localhost':
        res.writeHead(307, { Location: `http://localhost:${port}/page` })
        res.end()
        return
      case '/endless-body':
        // Head arrives, the body never ends: the preview must not wait for it.
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.write('<html><head><title>Streaming</title></head><body>')
        return
      case '/slow':
        return // never responds
      case '/pdf':
        res.writeHead(200, { 'Content-Type': 'application/pdf' })
        res.end('%PDF-1.7')
        return
      case '/missing':
        res.writeHead(404, { 'Content-Type': 'text/html' })
        res.end('<title>Not found</title>')
        return
      case '/image.png':
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(PNG)
        return
      case '/octet':
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.end(PNG)
        return
      case '/fake.png':
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end('<html>error</html>')
        return
      case '/vector.svg':
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
        res.end('<svg xmlns="http://www.w3.org/2000/svg"/>')
        return
      case '/huge.png':
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(20 * 1024 * 1024) })
        res.write(PNG)
        return
      case '/brotli':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'br' })
        res.end(zlib.brotliCompressSync(Buffer.from('<head><meta property="og:title" content="Brötli"></head>')))
        return
      default:
        res.writeHead(500)
        res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

/** "site.test" resolves to the local test server, which this policy allows (and nothing else). */
const opts: FetchOptions = {
  timeoutMs: 2000,
  resolve: async (host) => (host === 'site.test' ? [{ address: '127.0.0.1', family: 4 }] : []),
  isBlocked: (ip) => ip !== '127.0.0.1',
}
const site = (path: string) => `http://site.test:${port}${path}`

describe('fetchLinkPreview', () => {
  it('fetches, decompresses, decodes and parses a page', async () => {
    const p = await fetchLinkPreview(site('/page'), opts)
    expect(p).toMatchObject({ title: 'Café', description: 'Hello', image: `http://site.test:${port}/cover.png` })
    const h = seenHeaders.at(-1)!
    expect(h['user-agent']).toMatch(/Mozilla\/5\.0/)
    expect(h.cookie).toBeUndefined()
    expect(h.authorization).toBeUndefined()
  })

  it('follows redirects and reports the final URL', async () => {
    const p = await fetchLinkPreview(site('/redirect'), opts)
    expect(p?.url).toBe(site('/page'))
  })

  it('gives up on redirect loops', async () => {
    expect(await fetchLinkPreview(site('/loop'), opts)).toBeNull()
  })

  it('refuses redirects to private or local targets', async () => {
    expect(await fetchLinkPreview(site('/to-private'), opts)).toBeNull()
    expect(await fetchLinkPreview(site('/to-localhost'), opts)).toBeNull()
  })

  it('stops reading at </head>', async () => {
    const started = Date.now()
    const p = await fetchLinkPreview(site('/endless-body'), opts)
    expect(p?.title).toBe('Streaming')
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('times out', async () => {
    expect(await fetchLinkPreview(site('/slow'), { ...opts, timeoutMs: 300 })).toBeNull()
  })

  it('handles non-HTML and error responses', async () => {
    expect(await fetchLinkPreview(site('/pdf'), opts)).toMatchObject({ title: 'pdf', image: null })
    expect(await fetchLinkPreview(site('/image.png'), opts)).toMatchObject({ image: site('/image.png') })
    expect(await fetchLinkPreview(site('/missing'), opts)).toBeNull()
  })

  it('supports brotli', async () => {
    expect((await fetchLinkPreview(site('/brotli'), opts))?.title).toBe('Brötli')
  })

  it('blocks hosts that resolve to private addresses (default policy)', async () => {
    const rebinding: FetchOptions = { timeoutMs: 2000, resolve: async () => [{ address: '127.0.0.1', family: 4 }] }
    expect(await fetchLinkPreview(site('/page'), rebinding)).toBeNull()
    const mixed: FetchOptions = {
      timeoutMs: 2000,
      resolve: async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '93.184.215.14', family: 4 },
      ],
    }
    expect(await fetchLinkPreview(site('/page'), mixed)).toBeNull()
  })

  it('rejects invalid input without touching the network', async () => {
    expect(await fetchLinkPreview('http://127.0.0.1:1/', opts)).toBeNull()
    expect(await fetchLinkPreview('file:///c:/windows/win.ini', opts)).toBeNull()
    expect(await fetchLinkPreview(undefined, opts)).toBeNull()
  })
})

describe('fetchImage', () => {
  it('downloads raster images', async () => {
    const img = await fetchImage(site('/image.png'), opts)
    expect(img?.mime).toBe('image/png')
    expect(img?.bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(img!.bytes).equals(PNG)).toBe(true)
  })

  it('accepts generic binary types when the bytes are an image', async () => {
    expect((await fetchImage(site('/octet'), opts))?.mime).toBe('image/png')
  })

  it('refuses SVG, HTML disguised as images, non-images and oversized files', async () => {
    expect(await fetchImage(site('/vector.svg'), opts)).toBeNull()
    expect(await fetchImage(site('/fake.png'), opts)).toBeNull()
    expect(await fetchImage(site('/page'), opts)).toBeNull()
    expect(await fetchImage(site('/huge.png'), opts)).toBeNull()
  })
})

describe('helpers', () => {
  it('builds a browser-like user agent', () => {
    expect(defaultUserAgent('140.0.7339.80', 'win32')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    )
  })

  it('limits concurrency', async () => {
    const run = createLimiter(2)
    let active = 0
    let peak = 0
    const task = () =>
      run(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
      })
    await Promise.all(Array.from({ length: 8 }, task))
    expect(peak).toBe(2)
  })
})
