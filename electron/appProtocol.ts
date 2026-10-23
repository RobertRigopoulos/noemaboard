/** Serves the built renderer from app://bundle/ (a secure, standard origin; not file://). */
import { protocol } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { APP_HOST, APP_SCHEME, CONTENT_SECURITY_POLICY, contentTypeFor, resolveBundlePath, wantsSpaFallback } from './bundle'

/** Must run before the app 'ready' event. */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true },
    },
  ])
}

const textResponse = (status: number, body: string) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } })

async function readFile(file: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const buf = await fs.readFile(file)
    return new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength)
  } catch {
    return null
  }
}

/** Call after 'ready'. `rendererDir` is the built renderer (out/renderer, inside app.asar when packaged). */
export function handleAppScheme(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return textResponse(400, 'Bad request')
    }
    if (url.host !== APP_HOST) return textResponse(404, 'Not found')
    if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, 'Method not allowed')

    let file = resolveBundlePath(rendererDir, url.pathname)
    if (!file) return textResponse(400, 'Bad request')
    let body = await readFile(file)
    if (!body && wantsSpaFallback(url.pathname)) {
      file = path.join(rendererDir, 'index.html')
      body = await readFile(file)
    }
    if (!body) return textResponse(404, 'Not found')

    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: {
        'Content-Type': contentTypeFor(file),
        'Content-Length': String(body.byteLength),
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
      },
    })
  })
}
