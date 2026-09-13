import { execFileSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSync } from 'node:fs'

/** Stop the copy this checkout left running, then start this build in its place. */
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const port = Number(process.env.AB_PORT ?? 8899)

for (const pid of listening(port)) {
  const program = programOf(pid)
  // An installed copy answers on this port too, and its agents are configured
  // for it: killing it would leave every one of them with a 401 from a browser
  // that keeps a different token, and nothing would say why. Only a process
  // this checkout started is this script's to stop.
  if (!program?.startsWith(root)) {
    console.error(
      `port ${port} is held by pid ${pid}${program ? ` (${program})` : ''}, which this checkout did not start`,
    )
    console.error('quit that copy yourself, or run this with AB_PORT set to a port of your own')
    process.exit(1)
  }
  process.kill(pid, 'SIGTERM')
  console.log(`stopped pid ${pid}`)
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

function listening(on) {
  try {
    const out = execFileSync('lsof', ['-t', `-iTCP:${on}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    return out.trim().split('\n').filter(Boolean).map(Number)
  } catch {
    // Nothing was listening; that is the normal first run.
    return []
  }
}

/** The executable behind a pid, which is what says whose copy it is. */
function programOf(pid) {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}
