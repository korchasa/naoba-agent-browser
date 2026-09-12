import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import { dirname, join } from 'node:path'
import { cpSync, existsSync } from 'node:fs'
import { Hub } from './hub.ts'
import { iconMenu, installTray, waitingForPerson } from './tray.ts'
import { installDock } from './dock.ts'
import { readSettings, writeSettings } from './settings.ts'
import { DEFAULT_PORT } from './protocol.ts'
import { normalizeUrl } from './tab.ts'
import { userAgentFor } from './disguise.ts'
import { appName, isDevVariant } from './variant.ts'
import { accepted, decideLoginItem, describeLoginItem } from './login.ts'
import { asPresence, type LoginItemState, type Presence, presenceOf, type SettingsSnapshot } from './preferences.ts'
import { SettingsWindow } from './settings-window.ts'
import { clearHandshake, writeHandshake } from './handshake.ts'
import { bridgeEntry, INSTALLED_BRIDGE } from './bridge-path.ts'
import {
  activate as activateLicence,
  check as checkLicence,
  deactivate as deactivateLicence,
  licensed,
  NeedsBuyer,
  schedule as scheduleLicenceChecks,
  state as licenceState,
  stopSchedule as stopLicenceChecks,
} from './licence-store.ts'
import { admitsWithoutKey, type Buyer } from './licence.ts'

/** Where a key is bought. The plan is a one-off payment; there is nothing else to sell. */
const CHECKOUT_URL = 'https://checkout.freemius.com/product/39376/plan/67545/'

// Every page an agent visits is somebody else's, and Electron's warning about
// their content security policy would drown the console an agent reads.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

// The default user agent announces both this application and Electron, and a
// bot check reads that as an automated client. Hidden is the rule; the switch
// in the settings window (or `--announce-automation`) puts the truth back for
// somebody building such a check.
app.userAgentFallback = userAgentFor(false)

// Held for the lifetime of the app; a tray dropped by the collector disappears
// from the menu bar.
let trayHandle: import('electron').Tray | null = null

/** Where the person last asked the application to show itself. */
let presence: Presence = 'menu-bar'

/** Stops the Dock icon's badge while there is one; `null` when there is not. */
let dockHandle: (() => void) | null = null

const flags = new Set(process.argv.slice(1))
const isTestRun = flags.has('--admit-everything')

// The state directory has to be chosen before anything reads it, and the
// single-instance lock lives inside it: set it later and a test run fights the
// copy the owner is actually using for a lock neither of them wants to share.
const userDataDir = stringFlag('--user-data-dir')
/** A run that exists only to photograph the window. */
const posingForPictures = stringFlag('--snapshot') !== null
if (userDataDir) app.setPath('userData', userDataDir)
else if (isDevVariant()) seedDevStateDirectory()
else adoptOldStateDirectory()

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
    // The flag wins over the setting so a test run keeps its short grace.
    orphanCloseMs: numberFlag('--orphan-close-ms', readSettings().orphanCloseMs ?? 5 * 60_000),
    panelWidth: readSettings().panelWidth,
    contentionWaitMs: numberFlag('--contention-wait-ms', 30_000),
    defaultScriptTimeoutMs: numberFlag('--script-timeout-ms', 60_000),
    admitEverything: isTestRun,
    // A test run and the snapshot run drive a browser nobody bought, and so
    // does the development copy: it is built from a checkout by the person
    // working on the application, under its own bundle id, and asking them to
    // buy their own work back on every reinstall helps nobody. The copy people
    // download asks for a key, and that is the one that is sold.
    licensed: admitsWithoutKey(isTestRun, isDevVariant()) ? () => true : licensed,
    headless: flags.has('--headless'),
    announceAutomation: flags.has('--announce-automation') || readSettings().announceAutomation === true,
  })

  const settings = installSettingsWindow(hub)
  hub.onAdmissions(settings.push)
  wireChrome(hub, settings)

  const snapshotDir = stringFlag('--snapshot')
  if (snapshotDir) {
    await hub.start(numberFlag('--port', DEFAULT_PORT + 40))
    const { writeSnapshots } = await import('./snapshot.ts')
    await writeSnapshots(hub, snapshotDir, `file://${join(__dirname, 'demo.html')}`, settings)
    app.exit(0)
    return
  }

  try {
    const port = await hub.start(numberFlag('--port', DEFAULT_PORT))
    // How a bridge reaches this copy: the port it listens on, and the token it
    // will demand on the first message. Written before the line below, so a
    // bridge that starts the moment it sees that line finds the file there.
    writeHandshake(port, hub.bridgeToken)
    // The bridge reads this line when it starts the app itself.
    process.stdout.write(`naoba listening on 127.0.0.1:${port}\n`)
  } catch (error) {
    dialog.showErrorBox(`${appName()} cannot start`, String(error))
    app.quit()
    return
  }

  // The window is hidden while agents work; these are the ways a person asks
  // for it. Both are deliberate acts, which is the whole rule: the browser
  // never puts itself on screen uninvited.
  const revealAll = () => hub.shell.reveal(true)
  app.on('second-instance', revealAll)
  app.on('activate', revealAll)
  buildMenu(hub, settings)

  if (!isTestRun) {
    // The menu bar alone is the default: the application runs all day for
    // agents that need it, and costs the person a Dock icon only if they ask
    // for one.
    presence = asPresence(readSettings().presence)
    showApplication(hub, settings)
    offerLoginItem()

    // The licence, once at startup and then on its own schedule. A copy that
    // has not been unlocked opens the settings window itself: an agent is
    // refused until it is, and nothing else in the application would say why.
    // The development copy refuses nobody, so it has nothing to explain.
    scheduleLicenceChecks()
    void checkLicence().then(() => {
      settings.push()
      if (!licensed() && !admitsWithoutKey(isTestRun, isDevVariant())) settings.open()
    })
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
    clearHandshake()
    stopLicenceChecks()
    dockHandle?.()
    dockHandle = null
    trayHandle?.destroy()
    trayHandle = null
    void hub.flushAll().finally(() => app.exit(0))
  })

  // A supervisor (or a test) ends the app with a signal; without this the
  // sessions never get their chance to be written.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => app.quit())
}

/**
 * The application used to be called Agent Browser, and Electron keeps the state
 * under the application's name — so the rename alone would have started every
 * project signed out and asked again about every folder. The old directory is
 * copied once, whole, and only while nothing has been written under the new
 * name yet; after that this is a no-op forever.
 */
function adoptOldStateDirectory(): void {
  seedStateDirectory(['agent-browser'])
}

/**
 * The development copy keeps its own state, like every " Dev" copy of the other
 * applications — but it is installed on a machine where the person has been
 * signing in through the checkout for weeks, and starting it signed out of
 * everything would make it useless on day one. So its first start copies the
 * state the checkout has been using: `Electron` is what a bare `electron
 * dist/main.js` names its directory, and `projects.json` inside it is the
 * proof the directory is this application's and not some other Electron app's.
 */
function seedDevStateDirectory(): void {
  seedStateDirectory(['Naoba', 'Electron', 'agent-browser'])
}

/**
 * Copy the first of `names` that holds this application's state into the state
 * directory of this copy, unless this copy has state of its own already.
 *
 * A copy, not a move: the source keeps working for whoever still runs it.
 * Chromium creates the directory itself before this code runs, so "nothing
 * written yet" is judged by `projects.json`, not by the directory existing;
 * and Chromium's own lock files are left behind, they belong to a process.
 */
function seedStateDirectory(names: string[]): void {
  const current = app.getPath('userData')
  const marker = 'projects.json'
  if (existsSync(join(current, marker))) return
  const support = dirname(current)
  const source = names.map((name) => join(support, name)).find((dir) =>
    dir !== current && existsSync(join(dir, marker))
  )
  if (!source) return
  cpSync(source, current, {
    recursive: true,
    force: true,
    filter: (path) => !/\/Singleton(Lock|Cookie|Socket)$/.test(path),
  })
}

/**
 * An installed copy starts with the person's login, and says so once by
 * registering itself. Once: the OS keeps the item and the person keeps the
 * right to remove it in System Settings, so every later start leaves the
 * registration alone and only reads it back for the settings window.
 */
function offerLoginItem(): void {
  const decision = decideLoginItem({ packaged: app.isPackaged, offered: readSettings().loginItemOffered })
  if (decision !== 'register') return
  setLoginItem(true)
}

/**
 * A refusal by the OS is a status, not an exception: the marker is written only
 * for a registration it took, so a refused one is offered again next start.
 */
function setLoginItem(on: boolean): LoginItemState {
  try {
    app.setLoginItemSettings({ openAtLogin: on })
  } catch (error) {
    console.error(`could not change the login item: ${(error as Error).message}`)
  }
  const state = loginItem()
  if (on && accepted(state.status)) writeSettings({ loginItemOffered: true })
  return state
}

/** The OS's answer, in the two forms the settings window draws: a switch and a sentence. */
function loginItem(): LoginItemState {
  const packaged = app.isPackaged
  const { openAtLogin, status } = packaged
    ? app.getLoginItemSettings()
    : { openAtLogin: false, status: 'not-registered' }
  return { on: packaged && openAtLogin, status, sentence: describeLoginItem({ packaged, status }) }
}

/** Everything the settings window shows, in one shape. */
/**
 * Put the application where the person asked for it. Both icons are live: the
 * Dock is `NSApplicationActivationPolicy` under another name, and the menu-bar
 * icon is a `Tray` that is made or destroyed. Called at start-up and again on
 * every change, so nothing here may assume it runs once.
 */
function showApplication(hub: Hub, settings: SettingsAccess): void {
  const wanted = presenceOf(presence)
  if (wanted.dock && app.dock) {
    void app.dock.show()
    if (!dockHandle) {
      // The Dock icon carries the one number that is about the person: how
      // many calls are waiting for them. How many agents are connected is
      // ambient status, and that is what the menu-bar icon is for.
      app.dock.setMenu(iconMenu(hub, settings))
      dockHandle = installDock(app.dock, () => waitingForPerson(hub))
    }
  } else {
    dockHandle?.()
    dockHandle = null
    app.dock?.hide()
  }
  if (wanted.menuBar && !trayHandle) trayHandle = installTray(hub, settings)
  if (!wanted.menuBar && trayHandle) {
    trayHandle.destroy()
    trayHandle = null
  }
}

function settingsFor(hub: Hub): SettingsSnapshot {
  return {
    loginItem: loginItem(),
    presence,
    announceAutomation: hub.announceAutomation,
    orphanCloseMs: hub.orphanCloseMs,
    projects: hub.admissions(),
    licence: licenceState(),
  }
}

/** How the rest of the application reaches the settings window. */
export interface SettingsAccess {
  /** Make it, or bring the one that is open forward. */
  open(): void
  /** Something changed elsewhere; redraw it if anybody is looking. */
  push(): void
  /** The window itself, for the snapshot run that photographs it. */
  current(): BrowserWindow | null
}

/**
 * The settings window, and everything done to it from outside. It is one
 * `BrowserWindow` — not a view in the browser's own window, because it is about
 * the application rather than about any project, and because a person reading
 * it must not lose the tree they were looking at.
 */
function installSettingsWindow(hub: Hub): SettingsAccess {
  // The real window, beside the policy that owns it: the snapshot run
  // photographs it, and `WindowLike` deliberately knows nothing about Electron.
  let real: BrowserWindow | null = null
  const settings = new SettingsWindow(() => {
    const window = new BrowserWindow({
      width: 540,
      height: 620,
      minWidth: 460,
      minHeight: 360,
      title: 'Settings',
      // Shown once it has something to draw, or the person watches an empty
      // window fill itself in.
      show: false,
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    })
    real = window
    window.on('closed', () => {
      if (real === window) real = null
    })
    void window.loadFile(join(__dirname, 'settings.html'))
    window.once('ready-to-show', () => {
      // A menu-bar application has no dock icon and is not "active", so without
      // this the window opens behind whatever the person is in.
      app.focus({ steal: true })
      window.show()
    })
    // The login item can be turned off in System Settings while this window
    // sits open, and the OS is the only source of truth for it. Its next focus
    // is the moment to ask again.
    window.on('focus', () => {
      if (settings.isOpen) settings.push(settingsFor(hub))
    })
    return {
      isDestroyed: () => window.isDestroyed(),
      focus: () => window.focus(),
      show: () => window.show(),
      send: (channel, payload) => {
        if (!window.isDestroyed()) window.webContents.send(channel, payload)
      },
      onClosed: (handler) => void window.on('closed', handler),
    }
  })

  let pending: NodeJS.Timeout | null = null
  return {
    open: () => void settings.open(),
    current: () => (real && !real.isDestroyed() ? real : null),
    push: () => {
      // Dragging the panel's grip sends a width on every animation frame, and
      // building the answer asks the OS about the login item — so the window is
      // redrawn about ten times a second rather than sixty.
      if (!settings.isOpen || pending) return
      pending = setTimeout(() => {
        pending = null
        if (settings.isOpen) settings.push(settingsFor(hub))
      }, 100)
    },
  }
}

function stringFlag(name: string): string | null {
  const at = process.argv.indexOf(name)
  if (at < 0) return null
  return process.argv[at + 1] ?? null
}

/** A minimal menu, whose real job is the list of project windows. */
function buildMenu(hub: Hub, settings: SettingsAccess): void {
  const projects = () =>
    [...hub.contexts.values()].map((context) => ({
      label: context.identity.name,
      click: () => context.reveal(true),
    }))

  // Rebuilt whole every few seconds for the list of projects, so the first
  // submenu is spelled out rather than taken from `role: 'appMenu'` — that role
  // has no place for Settings, and every item it used to supply has to be
  // re-listed here or it is simply gone.
  const rebuild = () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: appName(),
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => settings.open() },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
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
function wireChrome(hub: Hub, settings: SettingsAccess): void {
  const contextOf = (projectId: string) => hub.contexts.get(projectId) ?? null

  /** Everything the panel draws, for every project, the moment it starts. */
  ipcMain.handle('ab:state', () => ({
    port: hub.port,
    // The panel prints the line that connects an agent, and it has to name this
    // copy's own bridge — the one in the bundle, or the one in the checkout.
    bridge: posingForPictures ? INSTALLED_BRIDGE : bridgeEntry(app.isPackaged, process.resourcesPath, app.getAppPath()),
    projects: [...hub.contexts.values()].map((context) => ({
      id: context.identity.id,
      name: context.identity.name,
      root: context.identity.root,
      tabs: context.describeTabs(),
      agents: context.agentRows(),
      commands: context.commandsByTab(),
    })),
  }))

  /**
   * A tab the person opens belongs to the agent whose tab is in front: the
   * person works alongside an agent, never in a corner of their own, so with
   * no agent in the window there is nothing to open a tab for.
   */
  ipcMain.handle('ab:new-tab', (_event, projectId: string, url?: string) => {
    const context = contextOf(projectId)
    const owner = context?.activeTab()?.openedBy ?? null
    if (!context || !owner) return null
    const tab = context.openTab(url ? normalizeUrl(url) : undefined, owner)
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
  /**
   * The context menu of a tab row. Built here, not in the panel: a native menu
   * matches the rest of the machine, and every action it offers is one the
   * main process performs anyway.
   */
  ipcMain.handle('ab:tab-menu', (_event, projectId: string, tabId: string) => {
    const context = contextOf(projectId)
    const tab = context?.tab(tabId)
    if (!context || !tab) return
    const holder = context.leases.holderOf(tabId)
    const heldByPerson = holder?.kind === 'human'
    const menu = Menu.buildFromTemplate([
      { label: 'Bring to front', click: () => void context.selectTab(tabId) },
      {
        label: 'Reload',
        click: () => {
          void tab.reload()
          context.log(YOU, 'reloaded the page', tabId)
        },
      },
      { type: 'separator' },
      { label: 'Copy address', enabled: tab.url !== '', click: () => clipboard.writeText(tab.url) },
      { label: 'Copy title', enabled: tab.title !== '', click: () => clipboard.writeText(tab.title) },
      { type: 'separator' },
      heldByPerson
        ? {
          label: 'Give the tab back',
          click: () => {
            context.leases.release(tabId, { kind: 'human' })
            context.log(YOU, 'gave the tab back', tabId)
          },
        }
        : {
          label: holder
            ? `Take over from ${holder.kind === 'agent' ? holder.label : 'the holder'}`
            : 'Take over this tab',
          click: () => {
            context.leases.takeOver(tabId, { kind: 'human' })
            context.log(YOU, 'took over this tab', tabId)
          },
        },
      { type: 'separator' },
      { label: 'Close tab', click: () => void context.closeTab(tabId) },
    ])
    menu.popup({ window: hub.shell.window() })
  })

  // The grip on the panel's edge is the only thing that sets this width, so
  // nothing has to be told what it landed on — the panel is already that wide.
  ipcMain.handle('ab:panel-width', (_event, width: number) => {
    if (!Number.isFinite(width)) return null
    const kept = hub.shell.setPanelWidth(width)
    writeSettings({ panelWidth: kept })
    return kept
  })

  /** The disguise is one switch for the whole browser, kept across restarts like the panel width. */
  ipcMain.handle('ab:announce-automation', async (_event, on: boolean) => {
    await hub.setAnnounceAutomation(on === true)
    writeSettings({ announceAutomation: hub.announceAutomation })
    settings.push()
    return hub.announceAutomation
  })

  /** The gear in the panel's foot. The menu and the menu-bar icon call the same thing. */
  ipcMain.handle('ab:open-settings', () => settings.open())

  /** Read fresh: the OS may have changed the login item behind our back. */
  ipcMain.handle('ab:settings', () => settingsFor(hub))

  // The person's own browser, not a tab here: a card is usually saved there,
  // and a payment is not something an agent's browser should be holding.
  ipcMain.handle('ab:buy-licence', () => shell.openExternal(CHECKOUT_URL))
  ipcMain.handle('ab:activate-licence', async (_event, key: string, buyer: Buyer | null) => {
    // The error reaches the window as a rejected call and is drawn there; the
    // person typed a key, so they are the one who has to be told what happened.
    // One refusal is not a complaint but a question, and it comes back as an
    // answer the window can act on: a key nobody bought needs a name first.
    try {
      const licence = await activateLicence(String(key), buyer ?? null)
      settings.push()
      return { unlocked: true, licence }
    } catch (error) {
      if (error instanceof NeedsBuyer) return { unlocked: false, needsBuyer: true }
      throw error
    }
  })
  ipcMain.handle('ab:deactivate-licence', async () => {
    const answer = await deactivateLicence()
    settings.push()
    return answer
  })
  /** The switch in the settings window; the result is the OS's answer, not the request. */
  ipcMain.handle('ab:open-at-login', (_event, on: boolean) => {
    const item = setLoginItem(on === true)
    settings.push()
    return item
  })

  ipcMain.handle('ab:orphan-close-ms', (_event, ms: number) => {
    if (!Number.isFinite(ms)) return hub.orphanCloseMs
    // Clamped, like the panel's width: a number out of range comes back as the
    // nearest one that is in it, rather than leaving the field saying something
    // the application is not doing.
    const kept = Math.max(0, Math.round(ms))
    hub.setOrphanCloseMs(kept)
    writeSettings({ orphanCloseMs: kept })
    settings.push()
    return kept
  })

  /**
   * The Dock icon and the menu-bar icon, applied without a restart. The answer
   * is what was kept, not what was asked for: a value this application does
   * not know comes back as the menu bar rather than being refused.
   */
  ipcMain.handle('ab:presence', (_event, value: unknown) => {
    presence = asPresence(value)
    if (!isTestRun) showApplication(hub, settings)
    writeSettings({ presence })
    settings.push()
    return presence
  })

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
  // The push after a forget comes from `hub.onAdmissions`, which every change to
  // the register goes through — an admission the person granted in the dialog
  // included.
}
