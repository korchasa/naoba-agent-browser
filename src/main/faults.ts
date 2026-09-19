/**
 * What the application does when its own main process throws.
 *
 * Electron's answer, when nothing listens for `uncaughtException`, is a modal
 * window reading "A JavaScript error occurred in the main process" with a stack
 * trace in it and an OK button. That is the wrong answer here twice over. This
 * application lives in the menu bar with its window usually off screen, so the
 * dialog arrives with no context at all — the person is working in something
 * else and a browser they were not looking at demands a click. And the trace it
 * shows is addressed to whoever wrote the code, which on this machine is an
 * agent that never sees the window.
 *
 * So a fault is recorded here instead: the agents read it through `status`, the
 * person gets one ordinary system notification they can ignore, and the stack
 * goes to stderr where a terminal or a test run already looks. Nothing blocks.
 *
 * Pure on purpose, the way `login.ts` is: the Electron calls that act on these
 * answers live in `main.ts`, so the whole of the decision can be unit-tested.
 */

export interface Fault {
  /** Where it came from: a throw nobody caught, or a promise nobody handled. */
  readonly kind: 'exception' | 'rejection'
  /** The message alone, which is what a person reads. */
  readonly message: string
  /** The stack, for stderr and for an agent that wants to fix it. */
  readonly stack: string
  readonly at: number
}

/**
 * How many are kept. A fault usually arrives in a burst — one broken handler
 * fires once per tab — and the first few say everything the later ones do.
 */
const KEPT = 20

const faults: Fault[] = []

/** Turn whatever was thrown into a fault. Anything can be thrown, including a string or null. */
export function describeFault(kind: Fault['kind'], thrown: unknown, at: number): Fault {
  if (thrown instanceof Error) {
    return { kind, message: thrown.message || thrown.name, stack: thrown.stack ?? thrown.message, at }
  }
  const said = typeof thrown === 'string' ? thrown : safeStringify(thrown)
  return { kind, message: said, stack: said, at }
}

function safeStringify(thrown: unknown): string {
  try {
    return JSON.stringify(thrown) ?? String(thrown)
  } catch {
    return String(thrown)
  }
}

/** Keep a fault, oldest dropped first. Answers the fault as it was stored. */
export function record(fault: Fault): Fault {
  faults.push(fault)
  while (faults.length > KEPT) faults.shift()
  return fault
}

/** Newest first, which is the order anybody reading them wants. */
export function recent(): Fault[] {
  return [...faults].reverse()
}

export function clear(): void {
  faults.length = 0
}

/**
 * Whether this fault is worth a notification.
 *
 * A burst of the same message is one piece of news, and a notification per tab
 * turns a defect into a second defect. The first of a message is announced and
 * the repeats within the window are not — they are still recorded, and `status`
 * still carries every one of them.
 */
const REPEAT_WINDOW_MS = 60_000

export function announces(fault: Fault, kept: readonly Fault[], windowMs = REPEAT_WINDOW_MS): boolean {
  return !kept.some((seen) =>
    seen !== fault && seen.message === fault.message && fault.at - seen.at < windowMs
  )
}

/** The sentence the person reads. No stack: it is addressed to somebody who was not writing code. */
export function announcement(fault: Fault, appName: string): { title: string; body: string } {
  const what = fault.kind === 'exception' ? 'hit an error' : 'left a request unfinished'
  return {
    title: `${appName} ${what}`,
    body: `${fault.message}\nTabs and sessions are still open. The agents working here have been told.`,
  }
}
