import { execFileSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSync } from 'node:fs'

/** Stop whatever copy is holding the port, then start this build in its place. */
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const port = Number(process.env.AB_PORT ?? 8899)

try {
  const pids = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')
  for (const pid of pids.filter(Boolean)) {
    process.kill(Number(pid), 'SIGTERM')
    console.log(`stopped pid ${pid}`)
  }
} catch {
  // Nothing was listening; that is the normal first run.
}

await new Promise((r) => setTimeout(r, 800))
const log = openSync('/tmp/naoba.log', 'a')
const child = spawn(join(root, 'node_modules/.bin/electron'), [join(root, 'dist/main.js'), ...process.argv.slice(2)], {
  cwd: root,
  detached: true,
  stdio: ['ignore', log, log],
})
child.unref()
console.log(`started pid ${child.pid}; log at /tmp/naoba.log`)
