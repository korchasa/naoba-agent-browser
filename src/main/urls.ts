/**
 * What an agent means when it names a URL to wait for.
 *
 * Two vocabularies, because each answers a question the other cannot. A
 * substring is what the rest of this surface already means by matching a URL —
 * `getNetworkLog({url})` and `{frame: 'stripe'}` both use `includes` — and it
 * is what an agent has after a form submit, which knows the shape of the
 * address and not the id in it. A regular expression is the only way to anchor
 * one: `/second\.html$/` says "ends there", and a site whose every step carries
 * the same prefix needs that.
 *
 * A pattern the scenario built itself belongs to the `node:vm` realm, so
 * `instanceof RegExp` answers false for it — the trap this repository has paid
 * for twice already. The tag is read instead, and paired with the member the
 * caller is about to use, because `Symbol.toStringTag` is writable and a plain
 * object can wear `'RegExp'` without being one.
 */

export type UrlPattern = string | RegExp

const REFUSED = 'waitForUrl takes a substring or a regular expression, as in ' +
  `waitForUrl('/checkout/') or waitForUrl(/\\/orders\\/\\d+$/)`

function asRegExp(pattern: unknown): { test(url: string): boolean; source: string } | null {
  if (pattern === null || typeof pattern !== 'object') return null
  if (Object.prototype.toString.call(pattern) !== '[object RegExp]') return null
  const candidate = pattern as { test?: unknown; source?: unknown }
  if (typeof candidate.test !== 'function') return null
  return pattern as { test(url: string): boolean; source: string }
}

export function matcherFor(pattern: unknown): (url: string) => boolean {
  if (typeof pattern === 'string') {
    // An empty string matches every page, so it would answer at once and read
    // as an arrival. The usual way to write one is by accident, from a variable
    // that held nothing.
    if (pattern === '') throw new Error('waitForUrl needs something to match; an empty string matches every page')
    return (url: string) => url.includes(pattern)
  }
  const expression = asRegExp(pattern)
  if (expression) return (url: string) => expression.test(url)
  throw new Error(REFUSED)
}

/** The pattern as the agent wrote it, for the one line a timeout has room for. */
export function describePattern(pattern: unknown): string {
  const expression = asRegExp(pattern)
  if (expression) return `a URL matching /${expression.source}/`
  return `a URL containing "${String(pattern)}"`
}
