import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How the bridge learns the token the application demands.
 *
 * The application writes `bridge.json` — the port it listens on, the token for
 * this run and its process id — into its state directory, mode 0600. Every copy
 * has a state directory of its own.
 *
 * The port does not identify a copy on its own, which is why this returns a
 * list rather than an answer. A copy that quits politely deletes its file; one
 * that was killed, that crashed, or that an update replaced leaves it behind,
 * still naming a port the next copy may take. Believing such a file means
 * presenting a dead copy's token to a live copy and being turned away — so the
 * candidates are ordered by whose process is still running, and the caller
 * tries them in turn.
 *
 * `src/main/handshake.ts` in the application is the other half of this.
 */
const FILE = 'bridge.json'

/**
 * Where a copy of the application keeps its state. `Naoba` is the release copy,
 * `Naoba Dev` the development one, and `Electron` is what a bare `electron
 * dist/main.js` from a checkout calls its directory.
 */
export function stateDirs(env = process.env) {
  const explicit = env.NAOBA_STATE_DIR
  if (explicit) return [explicit]
  const home = env.HOME ?? ''
  const support = join(home, 'Library', 'Application Support')
  return [join(support, 'Naoba'), join(support, 'Naoba Dev'), join(support, 'Electron')]
}

/**
 * Whether the copy that wrote a file is still there. `true` and `false` are
 * facts; `null` means the file is from a version that wrote no process id, and
 * such a file is tried after the live ones and before the dead.
 */
function stillRunning(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  try {
    // Signal 0 asks about a process without touching it.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Somebody else's process: alive, and not ours to signal.
    return error?.code === 'EPERM'
  }
}

const RANK = { true: 0, null: 1, false: 2 }

/**
 * Every token that might belong to the copy listening on `port`, best first,
 * with the places we looked. Empty when nothing named that port.
 */
export function tokensForPort(port, env = process.env) {
  const looked = []
  const found = []
  for (const dir of stateDirs(env)) {
    const path = join(dir, FILE)
    looked.push(path)
    let record
    let writtenAt = 0
    try {
      record = JSON.parse(readFileSync(path, 'utf8'))
      writtenAt = statSync(path).mtimeMs
    } catch {
      continue
    }
    if (record?.port !== port || typeof record.token !== 'string') continue
    found.push({ path, token: record.token, running: stillRunning(record.pid), writtenAt })
  }
  // A live copy first; between two of the same standing, the newer file.
  found.sort((a, b) => RANK[String(a.running)] - RANK[String(b.running)] || b.writtenAt - a.writtenAt)
  return { candidates: found, looked }
}

/** The error for a port nothing claims, naming every place we looked. */
export function noTokenFound(port, looked) {
  const error = new Error(
    `Naoba is listening on ${port}, but the file naming its token was not found. Looked in:\n  ` +
      looked.join('\n  ') +
      '\nStart the application again, or set NAOBA_STATE_DIR to its state directory.',
  )
  error.code = 'token-not-found'
  return error
}
