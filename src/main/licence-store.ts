import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  activateRequest,
  asksWhoYouAre,
  type Buyer,
  checkRequest,
  deactivateRequest,
  describe,
  type LicenceRecord,
  type LicenceState,
  newUid,
  readRefusal,
  recordFrom,
  refreshed,
  type Refusal,
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

/**
 * Raised when the key is good but belongs to nobody: the window has to ask for
 * a name and an address before trying again. Its own class, because the window
 * answers it by drawing three more fields rather than by printing a complaint.
 */
export class NeedsBuyer extends Error {
  constructor() {
    super('This key has no buyer on it yet.')
    this.name = 'NeedsBuyer'
  }
}

/** Take a key the person typed, ask the service, and keep the answer. */
export async function activate(key: string, buyer: Buyer | null = null): Promise<LicenceState> {
  const trimmed = key.trim()
  if (!trimmed) throw new Error('Enter the key from your purchase receipt.')
  const uid = load()?.uid ?? newUid((count) => randomBytes(count))
  let answer: unknown
  try {
    answer = await send(activateRequest(trimmed, uid, hostname(), buyer))
  } catch (error) {
    if (asksWhoYouAre((error as { code?: unknown }).code)) throw new NeedsBuyer()
    throw error
  }
  save(recordFrom(answer, trimmed, uid))
  schedule()
  return state()
}

/** Ask the service whether the stored key still stands. Silent when the network is not there. */
export async function check(): Promise<LicenceState> {
  const current = load()
  if (!current) return state()
  try {
    save(refreshed(current, await send(checkRequest(current))))
  } catch (error) {
    try {
      await afterRefusal(current, error)
    } catch {
      // Writing the answer down failed — a full disk, or a state directory that
      // went away. The stored answer holds, as it does when the network is out,
      // and the next check is in six hours. This is the last catch on the path:
      // the timer calls check() with nobody waiting on the promise.
    }
  }
  return state()
}

/**
 * What to make of a check that did not come back with a licence.
 *
 * A failure the service did not put a code on is the network — offline, or the
 * service is down — and the stored answer holds until the grace period in
 * `licence.ts` runs out, with the settings window saying when that is.
 *
 * A refusal is about this key, and it must not be mistaken for the network:
 * that is exactly what let a refunded copy stay unlocked for a month and then
 * blame the internet for it. The service answers the same
 * `invalid_license_key` to a key that was refunded and to a key whose
 * installation it has forgotten, so this asks the one question that separates
 * them — it activates again, on the same key and the same uid. Activation
 * succeeds for a key that is still good, and the copy carries on with the
 * installation the service just made. When it fails, the reason it fails with
 * is the one the person reads.
 */
async function afterRefusal(current: LicenceRecord, error: unknown): Promise<void> {
  const refusal = refusalOf(error)
  if (!refusal) return
  if (refusal.kind === 'final') return save(refused(current, refusal.sentence))
  try {
    save(recordFrom(await send(activateRequest(current.key, current.uid, hostname())), current.key, current.uid))
  } catch (again) {
    const second = refusalOf(again)
    if (second?.kind === 'final') save(refused(current, second.sentence))
  }
}

/** Why the service refused, and the hour it said so. Nothing else about the key changes. */
function refused(current: LicenceRecord, sentence: string): LicenceRecord {
  return { ...current, refusal: sentence, checkedAt: Date.now() }
}

/** The refusal in an error from `send`, or `null` when the service never answered. */
function refusalOf(error: unknown): Refusal | null {
  const code = (error as { code?: unknown })?.code
  if (code === undefined) return null
  return readRefusal(code, (error as Error).message)
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
  const error = (parsed as { error?: { message?: string; code?: string } })?.error
  if (error) {
    const refusal = new Error(error.message ?? 'the licensing service refused this key') as Error & { code?: string }
    refusal.code = error.code
    throw refusal
  }
  if (!response.ok) throw new Error(`the licensing service answered ${response.status}`)
  return parsed
}
