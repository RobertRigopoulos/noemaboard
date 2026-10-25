#!/usr/bin/env node
/**
 * Renders the trailer with its music in every format into out/ (or only the formats named: 16x9,
 * 4x5, 9x16). `silent` makes versions without sound instead, saved as ...-silent.mp4.
 *
 *   npm run render
 *   npm run render -- 9x16
 *   npm run render -- silent
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ALL = ['16x9', '4x5', '9x16']
const args = process.argv.slice(2)
const wanted = args.filter((f) => ALL.includes(f))
const formats = wanted.length ? wanted : ALL
const silent = args.includes('silent')

fs.mkdirSync(path.join(HERE, 'out'), { recursive: true })
for (const format of formats) {
  const out = path.join('out', `noemaboard-trailer-${format}${silent ? '-silent' : ''}.mp4`)
  console.log(`render: ${format} -> ${out}`)
  const cli = path.join(HERE, 'node_modules/@remotion/cli/remotion-cli.js')
  const props = `--props=${JSON.stringify({ music: !silent })}`
  const res = spawnSync(process.execPath, [cli, 'render', 'src/index.ts', `Trailer-${format}`, out, '--codec=h264', '--crf=16', '--log=warn', props], {
    cwd: HERE,
    stdio: 'inherit',
  })
  if (res.status !== 0) process.exit(res.status ?? 1)
}
