import { app } from 'electron'
import { chmodSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where a bridge learns how to reach this copy of the application.
 *
 * The file names the port, the token and the process of the running copy. It
 * sits in the state directory, so the release copy, the development copy and a
 * checkout each have one of their own and a bridge that finds this copy's file
 * cannot talk to another copy with it. Mode 0600: the token is the whole reason
 * the port is not open to everything on the machine.
 *
 * The process id is there because the port alone does not say which copy a file
 * belongs to. The file is removed when the application quits politely; a copy
 * that was killed, that crashed, or that was replaced by an update leaves its
 * file behind, still naming a port another copy may take next. A bridge that
 * believed it would present a dead copy's token and be turned away.
 *
 * `packages/bridge/handshake.mjs` is the other half of this, and the file name
 * is the contract between them.
 */
const FILE = 'bridge.json'

export function handshakePath(): string {
  return join(app.getPath('userData'), FILE)
}

export function writeHandshake(port: number, token: string): void {
  const path = handshakePath()
  writeFileSync(path, JSON.stringify({ port, token, pid: process.pid }) + '\n', { mode: 0o600 })
  // `mode` applies only when the file is created, and this one is rewritten on
  // every start — so the second start of a copy whose file somebody widened
  // would otherwise keep the wider mode.
  chmodSync(path, 0o600)
}

/** Nothing is listening any more, so nothing should read the token as if something were. */
export function clearHandshake(): void {
  try {
    unlinkSync(handshakePath())
  } catch {
    // Already gone, or the state directory went with it. Neither is worth
    // failing a shutdown for.
  }
}
