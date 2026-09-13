import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The token an IDE presents to reach this browser.
 *
 * It is long-lived, and that is a deliberate step down from what came before.
 * The token used to be new on every run, because the thing presenting it read a
 * file at the moment it connected. An IDE reads nothing: the token has to sit
 * in its configuration, so it has to outlive a restart of the application.
 *
 * What it still does is the part that matters. The port is open to every
 * process on this machine — loopback is not a boundary between them — and the
 * browser behind it holds the person's logged-in sessions. Without the token a
 * request gets 401 and reaches no project, no tab and no cookie.
 *
 * Kept in the state directory at mode 0600, so reading it means already being
 * this user. Each copy of the application has a state directory of its own, so
 * the development copy and the release copy have different tokens and different
 * ports, and a configuration naming one cannot reach the other.
 */
const FILE = 'mcp-token'

export function mcpToken(): string {
  const path = join(app.getPath('userData'), FILE)
  try {
    const kept = readFileSync(path, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(kept)) return kept
  } catch {
    // No file yet, or one nobody can read. Either way we write a fresh one
    // below rather than failing a start over it.
  }
  const fresh = randomBytes(32).toString('hex')
  writeFileSync(path, fresh + '\n', { mode: 0o600 })
  // `mode` applies only when the file is created, and this one can be
  // rewritten — so a file somebody widened would otherwise keep the wider mode.
  chmodSync(path, 0o600)
  return fresh
}
