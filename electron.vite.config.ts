/**
 * Desktop build (electron-vite): main + preload from electron/, renderer = the same web app as
 * vite.config.ts (index.html at the root), all emitted to out/.
 */
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { rendererConfig } from './vite.config'

const root = import.meta.dirname

export default defineConfig({
  main: {
    build: {
      // Bundle everything (htmlparser2, electron-updater): the packaged app ships no node_modules.
      externalizeDeps: false,
      outDir: resolve(root, 'out/main'),
      rolldownOptions: {
        input: { index: resolve(root, 'electron/main.ts') },
        // CommonJS (.cjs because package.json is "type": "module") for __dirname and CJS deps.
        output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: 'chunks/[name]-[hash].cjs' },
      },
    },
  },
  preload: {
    build: {
      // A sandboxed preload must be a single CommonJS file that only requires 'electron'.
      externalizeDeps: false,
      outDir: resolve(root, 'out/preload'),
      rolldownOptions: {
        input: { index: resolve(root, 'electron/preload.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs', codeSplitting: false },
      },
    },
  },
  renderer: {
    root,
    ...rendererConfig(),
    server: { port: 5174 },
    build: {
      outDir: resolve(root, 'out/renderer'),
      rolldownOptions: { input: { index: resolve(root, 'index.html') } },
    },
  },
})
