/**
 * Whether the application starts when the person logs in.
 *
 * Pure on purpose: the unit tests load this file the way they load the tree,
 * and the Electron calls that act on these answers live in `main.ts`. The OS is
 * the only source of truth for the item's state; the application registers
 * itself once and never argues with what the person set in System Settings.
 */

/** What `app.getLoginItemSettings().status` says on macOS 13 and later. */
export type LoginStatus = 'not-registered' | 'enabled' | 'requires-approval' | 'not-found'

/**
 * Register on the first start of an installed copy, and never otherwise.
 *
 * `packaged` is false for a checkout and for a test run, both of which run the
 * Electron.app inside node_modules — a login item for that would start a stray
 * Electron at every login. `offered` is the marker written once the OS has
 * taken a registration; from then on the person and System Settings decide.
 */
export function decideLoginItem(
  { packaged, offered }: { packaged: boolean; offered: boolean | undefined },
): 'register' | 'leave' {
  if (!packaged) return 'leave'
  if (offered !== undefined) return 'leave'
  return 'register'
}

/**
 * A registration the OS took. `requires-approval` counts: the item exists and
 * only waits for the person's nod. `not-registered` after a registration means
 * the OS refused (an unsigned bundle, for one), and the marker must not be
 * written, or the next start would never try again.
 */
export function accepted(status: LoginStatus | string): boolean {
  return status === 'enabled' || status === 'requires-approval'
}

/** The sentence under the switch in the settings window. */
export function describeLoginItem({ packaged, status }: { packaged: boolean; status: LoginStatus | string }): string {
  if (!packaged) return 'Not available from a checkout — install the application first.'
  if (status === 'enabled') return 'Starts when you log in.'
  if (status === 'requires-approval') return 'Waiting for your approval in System Settings › Login Items.'
  return 'Off.'
}
