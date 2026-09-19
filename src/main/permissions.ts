/**
 * What a page is allowed to ask this browser for. The answer is no.
 *
 * Electron installs no permission handler by default and grants whatever a page
 * requests. That is wrong everywhere and worse here: the window normally sits
 * off screen in the menu bar, so nobody is watching for a microphone
 * indicator, and the page doing the asking was chosen by an agent rather than
 * opened by the person. Measured on 2026-09-19 in a project tab on the
 * unchanged build — the microphone, notifications and clipboard read all came
 * back `granted`, and nothing recorded that anything had been asked.
 *
 * The rule takes the permission's name and ignores it. That is deliberate:
 * Electron 44 can pass 46 different names and a later version adds more, so a
 * rule that reads the name has to be revisited every upgrade, while one that
 * does not cannot be overtaken by the list. It is a function rather than a
 * constant because the decision is the thing under test, and because a later
 * rule that does distinguish between names changes this body without moving
 * anything around it.
 *
 * The cost is real and was accepted knowingly: a site's own copy button
 * (`clipboard-sanitized-write`), its full-screen view, a map's pointer lock and
 * the Storage Access API a third-party sign-in frame uses are all refused with
 * the rest. When a page is found broken by one of them, the fix belongs here,
 * as a named exception with its reason beside it.
 *
 * Pure on purpose, like `login.ts` and `dock.ts`: the unit tests load this file
 * without Electron, and `context.ts` makes the Electron calls. Nothing here may
 * import `electron`.
 */

/** Whether a page may have what it asked for. It may not. */
export function permitted(_permission: string): boolean {
  return false
}

/**
 * One thing a page asked this browser for, and what it was told.
 *
 * It is a history rather than a "what is granted here" table, because the
 * question an agent has is about a moment that has already passed: a scenario
 * stopped, and the cause may be a permission the page asked for once, before
 * anybody suspected it. The two existing ways to see what a page did — the
 * console and the network logs — both have to be switched on beforehand, which
 * is exactly what cannot be arranged for a request that happens once and is
 * remembered by Chromium afterwards.
 *
 * `outcome` carries what the handler answered rather than the constant
 * `refused`. `permitted` above is a function precisely so a later named
 * exception can change it, and a record that hard-coded the answer would start
 * lying on the day it does.
 */
export interface PermissionAsk {
  /** The name Electron passed. It is not always one thing — see `mediaTypes`. */
  readonly permission: string
  /** Whether the page asked outright, or only looked its state up. */
  readonly kind: 'asked' | 'checked'
  /** The page that asked, as precisely as the handler could say. */
  readonly url: string
  /**
   * What `media` meant this time, and empty for every other permission.
   * Electron sends `getDisplayMedia` and `getUserMedia` under the one name
   * `media`, a moment apart, from the same page, and tells both the same thing
   * — measured 2026-09-19. Without this an agent cannot tell which of the two
   * its page was refused, and the two collapse into a single line.
   */
  readonly mediaTypes: readonly string[]
  readonly outcome: 'granted' | 'refused'
  /** How many times in a row, so a page that polls is one line and not ten. */
  count: number
  /** The most recent of those times. */
  at: number
}

/**
 * How many asks of each kind one tab keeps.
 *
 * The count is per kind rather than over the record as a whole, and that is the
 * point of it. The check handler answers `navigator.permissions.query()`, which
 * a page may call as often as it likes; the request handler fires when a page
 * asks outright, which is rarer and is what an agent reading the record after a
 * failure came for. One cap over both would let a polling page evict every
 * outright ask and leave the agent reading its own noise.
 */
const KEPT_PER_KIND = 10

/** Whether two asks are the same thing said twice. */
function sameAsk(one: PermissionAsk, other: PermissionAsk): boolean {
  return one.permission === other.permission && one.kind === other.kind &&
    one.url === other.url && one.outcome === other.outcome &&
    one.mediaTypes.length === other.mediaTypes.length &&
    one.mediaTypes.every((type, at) => type === other.mediaTypes[at])
}

/**
 * Put an ask into a tab's record, and say whether it is news.
 *
 * A repeat of the newest entry is not a second line: its count goes up, its
 * time moves, and the answer is `null`. Measured 2026-09-19: one
 * `navigator.permissions.query()` call reached the check handler twice, and a
 * page that polls its own state would otherwise push everything else out on
 * its own.
 *
 * Only the newest entry is compared, so a page alternating between two
 * permissions keeps both rather than collapsing into whichever came first.
 *
 * The `null` is also what keeps the panel quiet: the caller draws a line for
 * what this answers with, so a repeat says nothing to the person.
 */
export function recordAsk(log: PermissionAsk[], ask: PermissionAsk): PermissionAsk | null {
  const newest = log.at(-1)
  if (newest && sameAsk(newest, ask)) {
    newest.count += ask.count
    newest.at = ask.at
    return null
  }
  log.push(ask)
  // Evicting within the kind, so that neither kind can crowd the other out.
  let over = log.filter((entry) => entry.kind === ask.kind).length - KEPT_PER_KIND
  for (let at = 0; at < log.length && over > 0; at++) {
    if (log[at]!.kind !== ask.kind) continue
    log.splice(at, 1)
    at--
    over--
  }
  return ask
}
