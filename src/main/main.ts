import { app, dialog, ipcMain, Menu } from 'electron'
import { join } from 'node:path'
import { Hub } from './hub.ts'
import { installTray } from './tray.ts'
import { DEFAULT_PORT } from './protocol.ts'
import { normalizeUrl } from './tab.ts'

// Every page an agent visits is somebody else's, and Electron's warning about
// their content security policy would drown the console an agent reads.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

// The default user agent announces both this application and Electron, and a
// bot check reads that as an automated client: Cloudflare's sign-in page
// refuses its own verification widget before a person can even use it. What is
// underneath is Chromium, so that is what the browser says it is.
app.userAgentFallback = app.userAgentFallback
  .replace(/ agent-browser\/[\d.]+/, '')
  .replace(/ Electron\/[\d.]+/, '')

// Held for the lifetime of the app; a tray dropped by the collector disappears
// from the menu bar.
let trayHandle: import('electron').Tray | null = null

const flags = new Set(process.argv.slice(1))
const isTestRun = flags.has('--admit-everything')

// The state directory has to be chosen before anything reads it, and the
// single-instance lock lives inside it: set it later and a test run fights the
// copy the owner is actually using for a lock neither of them wants to share.
const userDataDir = stringFlag('--user-data-dir')
if (userDataDir) app.setPath('userData', userDataDir)

/**
 * One application, one server, many agents. A second launch must never start a
 * rival listener — it focuses whatever is already running instead.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void start()
}

async function start(): Promise<void> {
  await app.whenReady()

  const hub = new Hub({
    preload: join(__dirname, 'preload.js'),
    chromeHtml: join(__dirname, 'chrome.html'),
    idleUnloadMs: numberFlag('--idle-unload-ms', 10 * 60_000),
    contentionWaitMs: numberFlag('--contention-wait-ms', 30_000),
    defaultScriptTimeoutMs: numberFlag('--script-timeout-ms', 60_000),
    admitEverything: isTestRun,
    headless: flags.has('--headless'),
  })

  wireChrome(hub)

  const snapshotDir = stringFlag('--snapshot')
  if (snapshotDir) {
    await hub.start(numberFlag('--port', DEFAULT_PORT + 40))
    const { writeSnapshots } = await import('./snapshot.ts')
    await writeSnapshots(hub, snapshotDir, `file://${join(__dirname, 'demo.html')}`)
    app.exit(0)
    return
  }

  try {
    const port = await hub.start(numberFlag('--port', DEFAULT_PORT))
    // The bridge reads this line when it starts the app itself.
    process.stdout.write(`agent-browser listening on 127.0.0.1:${port}\n`)
  } catch (error) {
    dialog.showErrorBox('Agent Browser cannot start', String(error))
    app.quit()
    return
  }

  // The window is hidden while agents work; these are the ways a person asks
  // for it. Both are deliberate acts, which is the whole rule: the browser
  // never puts itself on screen uninvited.
  const revealAll = () => {
    for (const context of hub.contexts.values()) if (context.loaded) context.reveal(true)
  }
  app.on('second-instance', revealAll)
  app.on('activate', revealAll)
  buildMenu(hub)

  if (!isTestRun) {
    // The application belongs in the menu bar, not in the Dock: it runs all day
    // for agents that need it, and it should cost the person nothing to have
    // running.
    trayHandle = installTray(hub)
    app.dock?.hide()
  }

  // The app is a server as much as a window: closing every window leaves it
  // running so the next agent call still has somewhere to land.
  app.on('window-all-closed', () => undefined)

  // Quitting has to wait for the sessions to reach disk. Cookies and local
  // storage are written lazily, so a sign-in from a minute ago can still be
  // memory-only — and losing it means asking the person to sign in again.
  let leaving = false
  app.on('before-quit', (event) => {
    if (leaving) return
    leaving = true
    event.preventDefault()
    hub.stop()
    trayHandle?.destroy()
    trayHandle = null
    void hub.flushAll().finally(() => app.exit(0))
  })

  // A supervisor (or a test) ends the app with a signal; without this the
  // sessions never get their chance to be written.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => app.quit())
}

function stringFlag(name: string): string | null {
  const at = process.argv.indexOf(name)
  if (at < 0) return null
  return process.argv[at + 1] ?? null
}

/** A minimal menu, whose real job is the list of project windows. */
function buildMenu(hub: Hub): void {
  const projects = () =>
    [...hub.contexts.values()].map((context) => ({
      label: context.identity.name,
      click: () => context.reveal(true),
    }))

  const rebuild = () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        {
          label: 'Projects',
          submenu: projects().length > 0 ? projects() : [{ label: 'No project has connected yet', enabled: false }],
        },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]),
    )
  }
  rebuild()
  setInterval(rebuild, 5_000).unref?.()
}

function numberFlag(name: string, fallback: number): number {
  const at = process.argv.indexOf(name)
  if (at < 0) return fallback
  const value = Number(process.argv[at + 1])
  return Number.isFinite(value) ? value : fallback
}

/** The person, as an actor in a tab's history. */
const YOU = { id: null, label: 'you' }

/** What the window's own interface can ask the main process to do. */
function wireChrome(hub: Hub): void {
  const contextOf = (projectId: string) => hub.contexts.get(projectId) ?? null

  ipcMain.handle('ab:state', (_event, projectId: string) => {
    const context = contextOf(projectId)
    if (!context) return null
    return {
      project: context.identity,
      tabs: context.describeTabs(),
      agents: [...context.agents.values()].map((agent) => ({
        id: agent.id,
        label: agent.label,
        ide: agent.descriptor.ide,
        tabId: agent.currentTabId,
      })),
      commands: context.commandsByTab(),
    }
  })

  ipcMain.handle('ab:new-tab', (_event, projectId: string, url?: string) => {
    const context = contextOf(projectId)
    if (!context) return null
    const tab = context.openTab(url ? normalizeUrl(url) : undefined)
    context.log(YOU, `opened a tab`, tab.id)
    return context.describeTab(tab)
  })

  ipcMain.handle(
    'ab:select-tab',
    (_event, projectId: string, tabId: string) => contextOf(projectId)?.selectTab(tabId) ?? false,
  )

  ipcMain.handle(
    'ab:close-tab',
    (_event, projectId: string, tabId: string) => contextOf(projectId)?.closeTab(tabId) ?? false,
  )

  ipcMain.handle('ab:navigate', async (_event, projectId: string, tabId: string, url: string) => {
    const context = contextOf(projectId)
    const tab = context?.tab(tabId)
    if (!context || !tab) return false
    await tab.navigate(normalizeUrl(url))
    context.log(YOU, `went to ${url}`, tabId)
    return true
  })

  /** The person always wins a tab; the agent holding it is told, never left guessing. */
  ipcMain.handle('ab:take-over', (_event, projectId: string, tabId: string) => {
    const context = contextOf(projectId)
    if (!context) return false
    context.leases.takeOver(tabId, { kind: 'human' })
    context.log(YOU, 'took over this tab', tabId)
    return true
  })

  ipcMain.handle('ab:release', (_event, projectId: string, tabId: string) => {
    const context = contextOf(projectId)
    if (!context) return false
    context.leases.release(tabId, { kind: 'human' })
    context.log(YOU, 'gave the tab back', tabId)
    return true
  })

  /** The person is done with what an agent asked for; the waiting call resumes. */
  ipcMain.handle('ab:human-done', (_event, projectId: string, tabId: string) => {
    const context = contextOf(projectId)
    const pending = context?.pendingHuman.get(tabId)
    if (!context || !pending) return false
    pending.resolve('done')
    context.log(YOU, 'finished what the agent asked for', tabId)
    return true
  })

  ipcMain.handle('ab:projects', () => hub.admissions())
  ipcMain.handle('ab:forget-project', (_event, root: string) => {
    hub.forget(root)
    return true
  })
}
