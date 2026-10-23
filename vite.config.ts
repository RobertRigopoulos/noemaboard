/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { defineConfig, type UserConfig } from 'vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

/** Yjs breaks if two copies are bundled ("Yjs was already imported"). */
export const DEDUPE = ['yjs', 'y-protocols', 'lib0', '@tiptap/pm', '@tiptap/core', '@tiptap/y-tiptap']

/** Renderer settings shared by the web build and the desktop renderer (electron.vite.config.ts). */
export function rendererConfig(): Pick<UserConfig, 'plugins' | 'resolve' | 'define'> {
  return {
    plugins: [react()],
    resolve: { dedupe: DEDUPE },
    define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) },
  }
}

// Relative base so the same build works from GitHub Pages sub-paths and inside Electron.
export default defineConfig({
  base: './',
  ...rendererConfig(),
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
  },
})
