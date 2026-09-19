/**
 * The one place an address is handed to another application on this machine.
 *
 * It is one line of Electron, and it is in a file of its own so that there is
 * one call site to audit rather than three: `tab.ts` hands on an address an
 * agent named, `context.ts` hands on one a page asked for by a click or by a
 * window, and both go through here. What may be handed on at all is decided in
 * `schemes.ts`, which knows nothing about Electron.
 *
 * A test run does not hand anything on. The integration suite drives real pages
 * with real mail links, and opening the owner's mail client eight times in a
 * test would be a defect of its own — so `main.ts` calls
 * `recordInsteadOfOpening()` when it is a test run, which it already works out
 * for `--admit-everything` and only outside a packaged copy. The record the tab
 * keeps is written either way, so a test asserts the same hand-off the real
 * path makes, and only the launch is missing.
 */

import { shell } from 'electron'

let launches = true

/** Stop handing addresses to the machine. A test run, and nothing else. */
export function recordInsteadOfOpening(): void {
  launches = false
}

/**
 * Hand the address over. It never throws: whether the machine had an
 * application for it is not something this browser can find out, and an agent
 * has already been told where the address went.
 */
export async function openExternally(url: string): Promise<void> {
  if (!launches) return
  try {
    await shell.openExternal(url)
  } catch {
    // The machine refused it, which the person sees for themselves. A throw
    // here would reach an agent as a fault of the browser's, which it is not.
  }
}
