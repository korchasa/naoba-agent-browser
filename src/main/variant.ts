import { app } from 'electron'

/**
 * Which copy of the application this is.
 *
 * The development copy is built under its own bundle id and name — "Naoba Dev",
 * the way the other applications keep a " Dev" copy next to the release one —
 * so both can be installed at once and neither touches the other's state. The
 * name is the one fact Electron hands us about it: `productName` from the
 * bundled package.json, which is also what names the state directory.
 */
export const DEV_NAME_SUFFIX = ' Dev'

export function appName(): string {
  return app.getName()
}

export function isDevVariant(): boolean {
  return appName().endsWith(DEV_NAME_SUFFIX)
}
