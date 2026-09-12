import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How the bridge learns the token the application demands.
 *
 * The application writes `bridge.json` — the port it listens on and the token
 * for this run — into its state directory, mode 0600. Every copy has a state
 * directory of its own, so the port in the file is what says which copy a file
 * belongs to: the one whose port answers is the one whose token to present.
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
 * The token for the copy listening on `port`, or an error naming every place
 * we looked — a bridge that cannot find the token is refused by the
 * application, and "denied" alone would say nothing about why.
 */
export function tokenForPort(port, env = process.env) {
  const looked = []
  for (const dir of stateDirs(env)) {
    const path = join(dir, FILE)
    looked.push(path)
    let record
    try {
      record = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    if (record?.port === port && typeof record.token === 'string') return record.token
  }
  const error = new Error(
    `Naoba is listening on ${port}, but the file naming its token was not found. Looked in:\n  ` +
      looked.join('\n  ') +
      '\nStart the application again, or set NAOBA_STATE_DIR to its state directory.',
  )
  error.code = 'token-not-found'
  throw error
}
