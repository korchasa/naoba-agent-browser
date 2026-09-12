import { build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(root, 'dist')
const watch = process.argv.includes('--watch')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'node22',
}

await build({
  ...common,
  entryPoints: [join(root, 'src/main/main.ts')],
  outfile: join(out, 'main.js'),
  platform: 'node',
  format: 'cjs',
  // Electron provides its own runtime; bundling it would ship a second copy.
  external: ['electron'],
})

await build({
  ...common,
  entryPoints: [join(root, 'src/preload/preload.ts')],
  outfile: join(out, 'preload.js'),
  platform: 'node',
  // A sandboxed preload has to be CommonJS: it runs before the module loader.
  format: 'cjs',
  external: ['electron'],
})

await build({
  ...common,
  entryPoints: [join(root, 'src/renderer/chrome.ts')],
  outfile: join(out, 'chrome.js'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
})

await build({
  ...common,
  entryPoints: [join(root, 'src/renderer/settings.ts')],
  outfile: join(out, 'settings.js'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
})

await cp(join(root, 'src/renderer/chrome.html'), join(out, 'chrome.html'))
await cp(join(root, 'src/renderer/palette.css'), join(out, 'palette.css'))
await cp(join(root, 'src/renderer/chrome.css'), join(out, 'chrome.css'))
await cp(join(root, 'src/renderer/settings.html'), join(out, 'settings.html'))
await cp(join(root, 'src/renderer/settings.css'), join(out, 'settings.css'))
await cp(join(root, 'src/renderer/demo.html'), join(out, 'demo.html'))

console.log(`built into ${out}${watch ? ' (watch is not wired yet)' : ''}`)
