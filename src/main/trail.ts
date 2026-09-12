/**
 * What a scenario had already done when it failed.
 *
 * A scenario that throws half way through used to come back as the error and
 * nothing else: the clicks that had landed, and everything the steps before had
 * read, were gone, and the whole scenario had to be written again from the top.
 * One session lost a click and four reads that way and spent six calls
 * rebuilding them.
 *
 * What can be recovered is bounded by what the runtime can see. A scenario is
 * arbitrary JavaScript compiled in a `node:vm` context, so a value it kept in a
 * variable of its own and never returned is invisible here and always will be.
 * An `api` call is the one thing that is visible — the runtime owns the function
 * object, so it sees the arguments, the answer and the throw. That is what this
 * records, and the agent is told as much in so many words.
 *
 * The one thing a reader must not conclude: this is a record of what was done,
 * never a checkpoint to resume from. The steps listed already happened, and an
 * agent that re-runs its scenario runs them a second time — which, for a step
 * that bought something, is the expensive way to learn the difference.
 */

import { type SerializeLimits, toTransferable } from './serialize.ts'

export interface TrailCall {
  /** Counted over every call the scenario made, so a dropped head is visible. */
  step: number
  /** The helper with its arguments, shortened to a label. */
  call: string
  ok: boolean
  /**
   * The call had not come back when the trail was read. A scenario that runs
   * out of time dies inside a call, and that call is the most useful fact about
   * the failure — so a call is written down when it starts and filled in when it
   * settles, rather than appearing only if it ever does.
   */
  pending?: true
  /** What the call answered. Absent when it answered nothing, or threw. */
  value?: unknown
  /** Why it threw. Absent when it did not. */
  error?: string
}

export interface TrailReport {
  /** The most recent calls, oldest first, at most `TRAIL_LIMIT` of them. */
  calls: TrailCall[]
  /** Every call, including the ones the list no longer holds. */
  callCount: number
}

/**
 * Measured over the 74 scenarios of the session this came from: a median of 3
 * api calls each and a maximum of 7. Twenty covers every one of them with room
 * for the loop none of them happened to write — and a limit is needed anyway,
 * because the trail is charged to the agent's context on every failure.
 */
export const TRAIL_LIMIT = 20

/**
 * Tighter than `DEFAULT_LIMITS` (8 / 200_000 / 1_000 / 200), because twenty of
 * these ride on one error message. A `snapshot()` or a `getText()` in a trail is
 * a summary; `toTransferable` marks a cut string with the length it had, so an
 * agent can tell a truncated read from a short one and ask for the rest.
 */
export const TRAIL_LIMITS: SerializeLimits = {
  maxDepth: 4,
  maxStringLength: 1_000,
  maxArrayLength: 20,
  maxKeys: 20,
}

export class CallTrail {
  readonly #kept: TrailCall[] = []
  #count = 0

  /**
   * A call that has begun. Numbering at the start rather than at the end also
   * puts two calls a scenario ran together in the order it wrote them, instead
   * of the order they happened to finish in.
   */
  begin(call: string): TrailCall {
    const entry: TrailCall = { step: ++this.#count, call, ok: false, pending: true }
    this.#kept.push(entry)
    if (this.#kept.length > TRAIL_LIMIT) this.#kept.shift()
    return entry
  }

  /** A call that answered. `undefined` is left off: the label already says it ran. */
  returned(entry: TrailCall, value: unknown): void {
    this.#settle(entry, () => {
      entry.ok = true
      if (value !== undefined) entry.value = toTransferable(value, TRAIL_LIMITS)
    })
  }

  /** A call that threw — including one the scenario caught and carried on from. */
  failed(entry: TrailCall, error: unknown): void {
    this.#settle(entry, () => {
      entry.error = messageOf(error)
    })
  }

  report(): TrailReport {
    return { calls: this.#kept.map((call) => ({ ...call })), callCount: this.#count }
  }

  /**
   * Nothing in here may throw. This is the machinery that reports a failure,
   * and a throw from it would replace the message the agent was waiting for
   * with one about the reporter — the `fbb746b` lesson, one layer up.
   */
  #settle(entry: TrailCall, fill: () => void): void {
    delete entry.pending
    try {
      fill()
    } catch {
      entry.value = { $type: 'unserialisable', reason: 'the answer could not be read' }
    }
  }
}

/**
 * The same surface, with every call written down.
 *
 * One wrapper rather than a line inside each helper: `api.ts`'s own `log` fires
 * after the helper returns, so the failing call — the one the agent most needs
 * named — is precisely the one that channel can never record, and six helpers
 * reach neither `guard` nor `log`. Wrapping the finished object covers all of
 * them, and covers the helper somebody adds next month without a second place
 * to remember.
 *
 * The keys come back in the order they went in, and an own property stays an
 * own property: an agent discovers this surface with `Object.keys(api)`, and a
 * test compares that list against the manual in both directions.
 */
export function recordCalls<T extends object>(api: T, trail: CallTrail): T {
  const wrapped: Record<string, unknown> = {}
  for (const name of Object.keys(api)) {
    const member = (api as Record<string, unknown>)[name]
    wrapped[name] = typeof member === 'function' ? wrap(api, name, member as Helper, trail) : member
  }
  return wrapped as T
}

type Helper = (...args: unknown[]) => unknown

function wrap(api: object, name: string, helper: Helper, trail: CallTrail): Helper {
  return (...args: unknown[]) => {
    const entry = trail.begin(describeCall(name, args))
    let answer: unknown
    try {
      // Called on the original object, not bare: no helper uses `this` today,
      // and a wrapper is the wrong place for that to start mattering.
      answer = helper.call(api, ...args)
    } catch (error) {
      trail.failed(entry, error)
      throw error
    }
    // `help()` is synchronous and has to stay so: a wrapper that awaited
    // everything would hand a Promise to a scenario that writes no `await`.
    if (!isThenable(answer)) {
      trail.returned(entry, answer)
      return answer
    }
    return (answer as Promise<unknown>).then((value) => {
      trail.returned(entry, value)
      return value
    }, (error: unknown) => {
      trail.failed(entry, error)
      throw error
    })
  }
}

/**
 * `fill('#descr', 'a long…')` — enough to tell two calls of the same helper
 * apart. The panel's own line for the same call names only the selector, and the
 * difference is deliberate: that line is drawn on the person's screen, while
 * this one goes back to the agent that wrote the arguments in the first place.
 */
export function describeCall(name: string, args: unknown[]): string {
  try {
    return `${name}(${args.map((arg) => renderArg(arg, 0)).join(', ')})`
  } catch {
    return `${name}(…)`
  }
}

const ARG_STRING = 60
const ARG_ITEMS = 5
const ARG_DEPTH = 2

function renderArg(value: unknown, depth: number): string {
  if (typeof value === 'string') return `'${cut(value, ARG_STRING)}'`
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? 'fn' : cut(String(value), ARG_STRING)
  }
  if (depth >= ARG_DEPTH) return '…'
  if (Array.isArray(value)) return `[${items(value, depth).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length === 0) return cut(String(value), ARG_STRING)
  const shown = keys.slice(0, ARG_ITEMS)
    .map((key) => `${key}:${renderArg((value as Record<string, unknown>)[key], depth + 1)}`)
  if (keys.length > shown.length) shown.push('…')
  return `{${shown.join(',')}}`
}

function items(value: unknown[], depth: number): string[] {
  const shown = value.slice(0, ARG_ITEMS).map((item) => renderArg(item, depth + 1))
  if (value.length > shown.length) shown.push('…')
  return shown
}

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * Duck-typed, because the thrown value can come from the scenario's own realm,
 * where `instanceof Error` lies (`AGENTS.md`), and because reading `message` is
 * itself a read that can throw.
 */
function messageOf(error: unknown): string {
  try {
    const message = (error as { message?: unknown })?.message
    if (typeof message === 'string') return message
    return String(error)
  } catch {
    return 'the reason could not be read'
  }
}

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  try {
    return typeof (value as { then?: unknown }).then === 'function'
  } catch {
    return false
  }
}
