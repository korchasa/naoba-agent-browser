/**
 * What the application says about a new version of itself.
 *
 * The rules alone: which copies look for one, and the sentence the settings
 * window shows for each stage. Downloading it, and replacing the application
 * with it, live in `updates.ts`.
 *
 * Pure on purpose, like `licence.ts`: the unit tests load it without Electron.
 * Nothing here may import `electron` or `electron-updater`.
 */

export type UpdateStage = 'quiet' | 'checking' | 'downloading' | 'ready' | 'failed'

/** What the settings window is told about updates. */
export interface UpdateSummary {
  stage: UpdateStage
  /** The version waiting to be installed, when there is one. */
  version: string | null
  sentence: string
  /** Whether this copy looks for a new version at all. */
  watches: boolean
}

/**
 * Which copies replace themselves.
 *
 * Only the copy a person downloaded: it was signed with the same certificate
 * the update will carry, which is what macOS checks before swapping one for the
 * other. A copy run from a checkout has no signature to match, and the
 * development copy is built from source that is usually ahead of any release —
 * updating it would quietly replace the work in progress with the last thing
 * shipped.
 */
export function updatesItself(packaged: boolean, isDevCopy: boolean): boolean {
  return packaged && !isDevCopy
}

/** The row in the settings window, in the one form it takes per stage. */
export function describeUpdate(
  stage: UpdateStage,
  version: string | null,
  trouble: string | null,
  watches: boolean,
): UpdateSummary {
  if (!watches) {
    return {
      stage: 'quiet',
      version: null,
      watches: false,
      sentence: 'This copy was built rather than downloaded, so it does not replace itself.',
    }
  }
  switch (stage) {
    case 'checking':
      return { stage, version, watches, sentence: 'Looking for a newer version…' }
    case 'downloading':
      return { stage, version, watches, sentence: `Version ${version} is downloading.` }
    case 'ready':
      return {
        stage,
        version,
        watches,
        // Installing means quitting, and quitting takes every agent's tabs
        // with it — a person deciding when to press this needs to know that.
        sentence: `Version ${version} is ready. Installing it restarts Naoba and closes every agent's tabs.`,
      }
    case 'failed':
      return {
        stage,
        version,
        watches,
        // The reason is kept: "could not check" with no cause reads as a defect
        // in the application when it is usually a network that is not there.
        sentence: `The last check for a new version did not finish. ${trouble ?? ''}`.trim(),
      }
    default:
      return { stage: 'quiet', version, watches, sentence: 'Naoba is up to date.' }
  }
}
