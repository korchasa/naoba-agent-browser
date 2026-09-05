import { app } from 'electron'

/**
 * The user agent Electron would send on its own, read before anything changes
 * it. It names this application and Electron, which is what a bot check reads
 * as an automated client.
 */
const honest = app.userAgentFallback

/**
 * What the browser says it is.
 *
 * Hidden, it is plain Chromium: Cloudflare's sign-in page refused to run its
 * own verification widget while the user agent carried `naoba` or `Electron`,
 * and the person could not sign in at all. Announced, the two words are back —
 * the person building such a check needs a client that owns up, so the check
 * can be seen to fire.
 */
export function userAgentFor(announce: boolean): string {
  if (announce) return honest
  return honest.replace(/ naoba\/[\d.]+/, '').replace(/ Electron\/[\d.]+/, '')
}
