import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What the person has set by hand and expects to find again tomorrow. One
 * small JSON file in the user-data directory; nothing here is worth a store.
 */
interface Settings {
  panelWidth?: number
  /** Whether pages are told that a program drives the browser. Off is the disguise. */
  announceAutomation?: boolean
  /**
   * Written once the OS has taken the login-item registration. Never read for
   * the switch's position — the OS holds that — only to know that the offer
   * was made, so the person who turned it off is not asked again.
   */
  loginItemOffered?: true
  /** How long a departed agent's tabs stay open, in case its session comes back. */
  orphanCloseMs?: number
}

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Settings
  } catch {
    // First run, or a file we cannot read; the defaults apply.
    return {}
  }
}

export function writeSettings(patch: Settings): void {
  const merged = { ...readSettings(), ...patch }
  try {
    writeFileSync(file(), JSON.stringify(merged, null, 2))
  } catch (error) {
    console.error(`could not save settings: ${(error as Error).message}`)
  }
}
