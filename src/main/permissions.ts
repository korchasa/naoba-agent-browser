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
