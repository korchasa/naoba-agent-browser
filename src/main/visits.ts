/**
 * What a tab did while somebody else was holding it.
 *
 * `requestHuman` hands the tab to the person and used to return only the state
 * it came back in — the final URL and title. That is the answer to "where are
 * we now", never to "what did they do". One session asked a person to attach
 * photographs to a listing and explicitly asked them not to publish it; the
 * person published, and the agent worked that out six calls later from a URL
 * that had changed underneath it.
 *
 * Only a move of the page counts as a step. A title change on the same URL does
 * not: pages rewrite titles for unread counters and clocks, so it is the
 * noisiest signal available, and the one title that answers a question — the one
 * the person left behind — comes back with the report anyway.
 */

export type VisitKind = 'navigate' | 'in-page'

export interface Visit {
  /** Milliseconds after the hand-over, so the agent can read the pacing. */
  at: number
  kind: VisitKind
  url: string
}

export interface VisitReport {
  /** The most recent steps, oldest first, at most `VISIT_LIMIT` of them. */
  visited: Visit[]
  /** Every step, including the ones the list no longer holds. */
  visitedCount: number
  /** How long the hold lasted. */
  seconds: number
}

/**
 * The tail is the half worth keeping: the agent already knows where it handed
 * the tab over, because it navigated there itself, and what it cannot know is
 * where the person ended up and by which route. A list without a limit is a
 * different kind of unusable — a person browsing for an hour would bury the
 * answer in its own middle.
 */
export const VISIT_LIMIT = 20

export class VisitLog {
  readonly #startedAt: number
  readonly #kept: Visit[] = []
  #count = 0
  #last: { kind: VisitKind; url: string } | null = null

  constructor(startedAt: number) {
    this.#startedAt = startedAt
  }

  add(kind: VisitKind, url: string, at: number): void {
    // A single-page form that rewrites the same address twice moved the page
    // once. The comparison is against the last step recorded rather than the
    // last one kept, so a dropped step cannot resurrect a repeat.
    if (this.#last && this.#last.kind === kind && this.#last.url === url) return
    this.#last = { kind, url }
    this.#count += 1
    this.#kept.push({ at: Math.max(0, Math.round(at - this.#startedAt)), kind, url })
    if (this.#kept.length > VISIT_LIMIT) this.#kept.shift()
  }

  report(now: number): VisitReport {
    return {
      visited: this.#kept.map((visit) => ({ ...visit })),
      visitedCount: this.#count,
      seconds: Math.round(Math.max(0, now - this.#startedAt) / 100) / 10,
    }
  }
}

/**
 * The same account in one line, for a message.
 *
 * An error thrown out of a scenario is rebuilt on its way to the agent
 * (`runner.ts` keeps the message, the stack, the logs and `code`, and drops
 * everything else), so the message is the only part that reaches an agent which
 * does not catch. The list itself rides on the error object for one that does.
 */
export function describeVisits(report: VisitReport, url: string): string {
  const where = url ? `, ending at ${url}` : ''
  if (report.visitedCount === 0) {
    return url
      ? `the page did not move in ${report.seconds}s and is still at ${url}`
      : `the page did not move in ${report.seconds}s`
  }
  const times = report.visitedCount === 1 ? 'once' : `${report.visitedCount} times`
  return `the page moved ${times} in ${report.seconds}s${where}`
}
