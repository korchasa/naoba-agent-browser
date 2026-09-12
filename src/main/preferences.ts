/**
 * What the person sets by hand, described once for both sides of the wire.
 *
 * The main process owns every value — it clamps it, applies it live and writes
 * it down — and the settings window draws what came back. This file is what
 * they agree on: which preferences there are, what each is called, the sentence
 * under it, and the unit the person types in where that differs from the unit
 * the application counts in.
 *
 * Pure on purpose, like `login.ts`: the unit tests load it without Electron,
 * and the settings window's renderer bundles it. Nothing here may import
 * `electron`, and no colour, markup or DOM belongs in it either.
 */

/**
 * The panel is the window's whole chrome, so it has to hold an address bar and
 * a four-level tree without either one being unreadable.
 */
export const PANEL_WIDTH = 340
/** Narrower than this and the address bar has no room for an address. */
export const PANEL_MIN_WIDTH = 240

/**
 * Where the application shows itself. macOS has one knob for it,
 * `NSApplicationActivationPolicy`, and it says only whether there is a Dock
 * icon; the menu-bar icon is a separate object that exists or does not. So
 * these three are two independent facts, drawn as one row because the fourth
 * combination — neither icon — must be unreachable.
 */
export type Presence = 'menu-bar' | 'dock' | 'both'

/** The OS's answer about the login item, in the two forms a row draws. */
export interface LoginItemState {
  on: boolean
  status: string
  sentence: string
}

/** Everything the main process sends the settings window about itself. */
export interface PreferenceValues {
  loginItem: LoginItemState
  presence: Presence
  announceAutomation: boolean
  panelWidth: number
  orphanCloseMs: number
}

export type PreferenceKey = keyof PreferenceValues

/**
 * What the settings window is sent, whole: the preferences, and the register of
 * directories the person has been asked about. The register is not a preference
 * — there is no row for it, and `PREFERENCES` stays mapped over the values
 * alone — but it is the other half of what that window is for.
 */
export interface SettingsSnapshot extends PreferenceValues {
  projects: AdmissionRecord[]
}

/** What a row looks like once a value has been put in it. */
export type Drawn =
  | { kind: 'switch'; hint: string; on: boolean }
  | { kind: 'number'; hint: string; value: number; floor: number; unit: string }
  | { kind: 'choice'; hint: string; value: string; options: Option[] }

/** One segment of a choice: the value that is kept, and the word on it. */
export interface Option {
  value: string
  label: string
}

export type Row = Drawn & { key: PreferenceKey; label: string }

/**
 * A number the person types in one unit and the application keeps in another,
 * with the floor it may not go below. There is no ceiling here: the panel's
 * upper bound is half the window, which only the window knows, so the shell
 * clamps again on its side.
 */
interface Scale {
  /** How many of the application's units one of the person's is worth. */
  per: number
  floor: number
  unit: string
}

interface Entry {
  label: string
  draw(values: PreferenceValues): Drawn
  /** Present only on a preference the person types a number into. */
  scale?: Scale
}

/**
 * Mapped over the keys, which is the whole point: a value the main process
 * starts sending with no row for it does not compile. `Settings` is an
 * interface and is gone by run time, so this is the only place the promise can
 * be made at all — no test in this repository could make it.
 *
 * The order here is the order the window draws.
 */
export const PREFERENCES: { [K in PreferenceKey]: Entry } = {
  loginItem: {
    label: 'Open at login',
    // The sentence is the OS's, passed through: the window must not say "Off."
    // while System Settings says on.
    draw: (values) => ({ kind: 'switch', hint: values.loginItem.sentence, on: values.loginItem.on }),
  },
  presence: {
    label: 'Show the application in',
    draw: (values) => ({
      kind: 'choice',
      hint: PRESENCE_HINT[values.presence],
      value: values.presence,
      options: [
        { value: 'menu-bar', label: 'Menu bar' },
        { value: 'dock', label: 'Dock' },
        { value: 'both', label: 'Both' },
      ],
    }),
  },
  announceAutomation: {
    label: 'Announce automation',
    draw: (values) => ({
      kind: 'switch',
      hint: values.announceAutomation
        ? 'This browser tells pages that a program drives it.'
        : 'Pages see an ordinary Chromium.',
      on: values.announceAutomation,
    }),
  },
  panelWidth: {
    label: 'Panel width',
    scale: { per: 1, floor: PANEL_MIN_WIDTH, unit: 'points' },
    draw: (values) => ({
      kind: 'number',
      hint: "Dragging the panel's right edge sets the same width.",
      value: asShown('panelWidth', values.panelWidth),
      floor: PANEL_MIN_WIDTH,
      unit: 'points',
    }),
  },
  orphanCloseMs: {
    label: "Close a departed agent's tabs after",
    scale: { per: 60_000, floor: 0, unit: 'minutes' },
    draw: (values) => ({
      kind: 'number',
      hint: 'An agent that reconnects still wants the page it was on, so its tabs wait this long.',
      value: asShown('orphanCloseMs', values.orphanCloseMs),
      floor: 0,
      unit: 'minutes',
    }),
  },
}

/**
 * What each choice gets the person, which is the only reason to prefer one.
 * Three sentences rather than one: a row that says the same thing whatever is
 * picked is a row that explains nothing.
 */
const PRESENCE_HINT: Record<Presence, string> = {
  'menu-bar': 'The menu-bar icon counts the connected agents.',
  dock: 'The Dock icon puts the window in the app switcher.',
  both: 'You get the count in the menu bar and the window in the app switcher.',
}

/** Which icons a choice asks for. Never neither — that is the point of the row. */
export function presenceOf(presence: Presence): { menuBar: boolean; dock: boolean } {
  return { menuBar: presence !== 'dock', dock: presence !== 'menu-bar' }
}

/**
 * What `settings.json` holds, turned into a choice. Anything else — a file
 * edited by hand, a field an older version never wrote — is the menu bar,
 * which is what the application did before there was a choice.
 */
export function asPresence(value: unknown): Presence {
  return value === 'dock' || value === 'both' ? value : 'menu-bar'
}

/** Every row the settings window draws, in order, filled in from one answer. */
export function rowsFor(values: PreferenceValues): Row[] {
  return (Object.keys(PREFERENCES) as PreferenceKey[]).map((key) => ({
    key,
    label: PREFERENCES[key].label,
    ...PREFERENCES[key].draw(values),
  }))
}

/**
 * The number the person typed, in the unit the application keeps — clamped to
 * the floor, never refused for being under it. The grip on the panel's edge
 * answers a drag below the floor with the floor, and a field that refused
 * instead would be one preference with two behaviours.
 *
 * `null` means something else entirely: what was typed is not a number, so
 * there is nothing to keep.
 */
export function asKept(key: PreferenceKey, typed: number): number | null {
  const scale = PREFERENCES[key].scale
  if (!scale) return null
  if (!Number.isFinite(typed)) return null
  return Math.max(scale.floor, Math.round(typed * scale.per))
}

/** The other direction: what the application keeps, in the unit the person reads. */
export function asShown(key: PreferenceKey, kept: number): number {
  const scale = PREFERENCES[key].scale
  if (!scale) return kept
  return Math.round(kept / scale.per)
}

/** One answer the person gave about a directory, as the hub keeps it. */
export interface AdmissionRecord {
  decision: 'allowed' | 'denied'
  name: string
  root: string
  at: number
}

export interface ProjectRow {
  name: string
  root: string
  allowed: boolean
  hint: string
  at: number
}

/**
 * The directories the person has been asked about, refusals included — a
 * refusal is why an agent working there gets nothing, and forgetting the record
 * is the only cure, so it has to be visible.
 *
 * By name, because that is what the person scans for; the order they happened
 * to be asked in tells them nothing.
 */
export function projectRows(records: AdmissionRecord[]): ProjectRow[] {
  return records
    .map((record) => ({
      // A record written before the name was kept still has its directory.
      name: record.name || lastSegment(record.root),
      root: record.root,
      allowed: record.decision === 'allowed',
      // One word, not a sentence: the same explanation repeated down a list of
      // a dozen projects is noise, and it is written once under the list
      // instead. Looked at in the snapshot before this was changed.
      hint: record.decision === 'allowed' ? 'Allowed' : 'Refused',
      at: record.at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The directory's own name. Spelled by hand: `node:path` is not in a browser bundle. */
function lastSegment(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}
