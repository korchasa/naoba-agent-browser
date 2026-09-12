import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  activateRequest,
  checkRequest,
  deactivateRequest,
  describe,
  type LicenceRecord,
  type LicenceState,
  newUid,
  recordFrom,
  refreshed,
  type Request,
  verdict,
} from './licence.ts'

/**
 * The licence as this machine holds it: one file in the state directory, the
 * calls that fill it, and the check that runs while the application is open.
 *
 * The rules live in `licence.ts`; everything that touches disk, network or the
 * clock is here.
 */
const FILE = 'licence.json'

/** How often a running application asks the service whether the key still stands. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/** A check must not hang the window it was started from. */
const TIMEOUT_MS = 15_000

function path(): string {
  return join(app.getPath('userData'), FILE)
}

let record: LicenceRecord | null = null
let loaded = false
let timer: NodeJS.Timeout | null = null

function load(): LicenceRecord | null {
  if (loaded) return record
  loaded = true
  try {
    record = JSON.parse(readFileSync(path(), 'utf8')) as LicenceRecord
  } catch {
    record = null
  }
  return record
}

function save(next: LicenceRecord | null): void {
  record = next
  loaded = true
  if (!next) {
    try {
      if (existsSync(path())) unlinkSync(path())
    } catch {
      // Nothing to forget, or the state directory went with it.
    }
    return
  }
  writeFileSync(path(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path(), 0o600)
}

/** Whether this copy may be used at all. Reads the stored answer, never the network. */
export function licensed(): boolean {
  return verdict(load()).state === 'licensed'
}

/** Why it may not, in a sentence meant for the person. */
export function refusal(): string {
  const answer = verdict(load())
  return answer.state === 'licensed' ? '' : answer.reason
}

export function state(): LicenceState {
  return describe(load())
}

/** Take a key the person typed, ask the service, and keep the answer. */
export async function activate(key: string): Promise<LicenceState> {
  const trimmed = key.trim()
  if (!trimmed) throw new Error('Enter the key from your purchase receipt.')
  const uid = load()?.uid ?? newUid((count) => randomBytes(count))
  const answer = await send(activateRequest(trimmed, uid, hostname()))
  save(recordFrom(answer, trimmed, uid))
  schedule()
  return state()
}

/** Ask the service whether the stored key still stands. Silent when the network is not there. */
export async function check(): Promise<LicenceState> {
  const current = load()
  if (!current) return state()
  try {
    const answer = await send(checkRequest(current))
    save(refreshed(current, answer))
  } catch {
    // Offline, or the service is down. The stored answer holds until the grace
    // period in `licence.ts` runs out, and the settings window says when that is.
  }
  return state()
}

/** Give the activation back, so the key can be used on another Mac. */
export async function deactivate(): Promise<LicenceState> {
  const current = load()
  if (!current) return state()
  try {
    await send(deactivateRequest(current))
  } catch {
    // The service will free the install when the key is activated elsewhere;
    // refusing to forget it here would strand the person on a machine they are
    // leaving.
  }
  save(null)
  return state()
}

/** Re-check while the application is open; the first one runs at startup. */
export function schedule(): void {
  if (timer) clearInterval(timer)
  timer = setInterval(() => void check(), CHECK_EVERY_MS)
  timer.unref?.()
}

export function stopSchedule(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function send(request: Request): Promise<unknown> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.body ? { 'content-type': 'application/json' } : undefined,
    body: request.body ? JSON.stringify(request.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`the licensing service answered with something that is not JSON (${response.status})`)
  }
  const error = (parsed as { error?: { message?: string } })?.error
  if (error) throw new Error(error.message ?? 'the licensing service refused this key')
  if (!response.ok) throw new Error(`the licensing service answered ${response.status}`)
  return parsed
}
