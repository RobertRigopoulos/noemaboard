import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrintToPdfOptions } from './desktop'

type Printer = (opts: PrintToPdfOptions) => Promise<unknown>

/** Loads desktop.ts as the renderer would see it, with or without the preload bridge. */
async function load(printToPdf?: Printer) {
  vi.resetModules()
  if (printToPdf) vi.stubGlobal('window', { desktop: { printToPdf } })
  return import('./desktop')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('printToPdf', () => {
  it('is null outside the desktop app', async () => {
    const { printToPdf } = await load()
    expect(await printToPdf({ pageSize: 'A4', landscape: false })).toBeNull()
  })

  it('passes exactly the page size and a boolean orientation to the shell', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const shell = vi.fn<Printer>(async () => pdf)
    const { printToPdf } = await load(shell)
    const opts = { pageSize: 'Letter', landscape: 'yes', extra: 1 } as unknown as PrintToPdfOptions
    expect(await printToPdf(opts)).toBe(pdf)
    expect(shell).toHaveBeenCalledWith({ pageSize: 'Letter', landscape: false })
  })

  it('is null when the shell fails or returns nothing usable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const result of [Promise.reject(new Error('boom')), Promise.resolve(null), Promise.resolve(new Uint8Array(0)), Promise.resolve('pdf')]) {
      result.catch(() => {})
      const { printToPdf } = await load(() => result)
      expect(await printToPdf({ pageSize: 'A3', landscape: true })).toBeNull()
    }
    warn.mockRestore()
  })
})
