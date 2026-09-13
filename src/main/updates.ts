import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { describeUpdate, type UpdateStage, type UpdateSummary, updatesItself } from './update-rules.ts'
import { isDevVariant } from './variant.ts'

/**
 * Replacing the application with a newer one.
 *
 * The releases live on GitHub, next to the disk image a person downloaded, and
 * each carries a `latest-mac.yml` written when the release was signed. macOS
 * swaps one copy for the other only when both were signed with the same
 * certificate, so this works on the downloaded copy and on nothing else — see
 * `updatesItself`.
 *
 * Nothing is installed behind the person's back. The new version is fetched in
 * the background and then waits: quitting Naoba takes every agent's tabs with
 * it, so the moment that happens is theirs to choose.
 */
const OWNER = 'korchasa'
const REPO = 'naoba-agent-browser'

/** How often a running application looks for a newer one. */
const LOOK_EVERY_MS = 6 * 60 * 60 * 1000

let stage: UpdateStage = 'quiet'
let version: string | null = null
let trouble: string | null = null
let timer: NodeJS.Timeout | null = null
let announce: () => void = () => undefined

export function updateState(): UpdateSummary {
  return describeUpdate(stage, version, trouble, watching())
}

function watching(): boolean {
  return updatesItself(app.isPackaged, isDevVariant())
}

/** Start looking, and keep looking while the application runs. */
export function watchForUpdates(onChange: () => void): void {
  announce = onChange
  if (!watching()) return

  autoUpdater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO })
  // Fetched on its own, installed only when the person says so.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => move('checking', null, null))
  autoUpdater.on('update-not-available', () => move('quiet', null, null))
  autoUpdater.on('update-available', (info) => move('downloading', info.version, null))
  autoUpdater.on('update-downloaded', (info) => move('ready', info.version, null))
  autoUpdater.on('error', (error) => move('failed', version, String(error?.message ?? error)))

  look()
  timer = setInterval(look, LOOK_EVERY_MS)
  timer.unref?.()
}

export function stopWatchingForUpdates(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/**
 * Quit and come back as the new version.
 *
 * `isSilent` is true so macOS does not put an installer on screen, and
 * `isForceRunAfter` brings the application back — an agent that reaches for it
 * a second later finds it listening again.
 */
export function installUpdate(): boolean {
  if (stage !== 'ready') return false
  autoUpdater.quitAndInstall(true, true)
  return true
}

function look(): void {
  // A check that throws — no network, GitHub down, a release without the file
  // beside it — is an event, not a crash: `error` above turns it into a
  // sentence and the application carries on with the version it has.
  void autoUpdater.checkForUpdates().catch(() => undefined)
}

function move(next: UpdateStage, found: string | null, why: string | null): void {
  stage = next
  version = found
  trouble = why
  announce()
}
