import { app, session as electronSession } from 'electron'
import type { Session, WebContents } from 'electron'
import { type Holder, holderLabel, LeaseTable } from './lease.ts'
import { KeyedQueue } from './queue.ts'
import { partitionFor, type ProjectIdentity } from './project.ts'
import { type HandOff, normalizeUrl, Tab } from './tab.ts'
import { DownloadLog, temporaryDownloadPath } from './downloads.ts'
import { userAgentFor } from './disguise.ts'
import { permitted } from './permissions.ts'
import { outcomeFor } from './schemes.ts'
import type { Shell } from './shell.ts'
import type { AgentCommand, AgentDescriptor, AgentRow, AppEvent, ServerMessage, TabDescriptor } from './protocol.ts'

/**
 * The actor a line in a tab's history belongs to when neither an agent nor the
 * person did it — an address handed to the machine, an address refused.
 */
const BROWSER = { id: null, label: 'the browser' }

/** The one line the person's panel shows for an address that left, or did not. */
function describeHandOff(handOff: HandOff): string {
  return handOff.outcome === 'hand-on'
    ? `handed ${handOff.url} to this machine`
    : `refused ${handOff.url} — nothing here opens it`
}

export interface AgentHandle {
  readonly id: string
  readonly label: string
  readonly descriptor: AgentDescriptor
  currentTabId: string | null
  send(message: ServerMessage): void
}

export interface PendingHuman {
  readonly tabId: string
  readonly reason: string
  readonly agentId: string
  resolve(outcome: 'done' | 'cancelled'): void
}

export interface ContextPaths {
  /** The window every project's tabs live in. */
  shell: Shell
  /** How long a departed agent's tabs stay open before they are closed. */
  orphanCloseMs?: number
  /** Whether pages are told that a program drives the browser, at the start. */
  announceAutomation?: boolean
}

/**
 * One project: its own browsing session, its own tabs, and the agents allowed
 * to drive them. Nothing here is reachable from another project — that is the
 * whole point of the application, and the reason each context builds its own
 * Electron session from a partition named after the project's hash. The
 * window is the one thing projects share; it is the shell's.
 */
export class ProjectContext {
  readonly identity: ProjectIdentity
  readonly session: Session
  readonly leases: LeaseTable
  readonly queue = new KeyedQueue()
  readonly agents = new Map<string, AgentHandle>()
  readonly pendingHuman = new Map<string, PendingHuman>()
  readonly downloads: DownloadLog

  readonly shell: Shell
  #tabs: Tab[] = []
  #activeTabId: string | null = null
  /** Pending closes of tabs whose agent has gone, keyed by that agent. */
  readonly #orphanTimers = new Map<string, NodeJS.Timeout>()
  /**
   * Agents that have disconnected while tabs of theirs are still open. The
   * panel keeps drawing such an agent, dimmed, so its tabs have a heading to
   * hang under until they go.
   */
  readonly #departed = new Map<string, { label: string; ide: string }>()
  #lastTouched = Date.now()
  #announceAutomation: boolean
  #orphanCloseMs: number

  readonly #paths: ContextPaths

  constructor(identity: ProjectIdentity, paths: ContextPaths) {
    this.shell = paths.shell
    this.identity = identity
    this.#paths = paths
    this.session = electronSession.fromPartition(partitionFor(identity.id))
    this.#announceAutomation = paths.announceAutomation ?? false
    this.#orphanCloseMs = paths.orphanCloseMs ?? 0
    this.session.setUserAgent(userAgentFor(this.#announceAutomation))
    this.downloads = new DownloadLog((filename) =>
      temporaryDownloadPath(app.getPath('temp'), this.identity.name, filename)
    )
    // Naming a save path is what stops the system's "Save as" panel appearing:
    // this window normally sits off screen in the menu bar, so that panel would
    // wait where nobody can answer it and the scenario would time out.
    //
    // The session comes from `fromPartition` and so outlives this context — a
    // project unloaded for being idle and loaded again builds a second context
    // on the same session. Without the removal, that project's next download
    // would be handled twice, and the second handler would name a save path for
    // an item Electron had already been given one for.
    this.session.removeAllListeners('will-download')
    this.session.on('will-download', (_event, item, webContents) => {
      this.downloads.accept(item, webContents ?? null)
    })
    // Nothing a page asks for is granted, and the refusal is prompt: the
    // callback is what makes it so, and a request left unanswered reads to an
    // agent as a page that will not finish rather than as a decision.
    //
    // Unlike `will-download` three lines above, these are setters rather than
    // listeners — a second context built on the same partition replaces them
    // instead of stacking a second one, so no removal is needed here.
    this.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permitted(permission)))
    // The other half. `navigator.permissions.query()` never reaches the request
    // handler, so without this a page is told `granted` for a permission that
    // would be refused the moment it asked for it.
    this.session.setPermissionCheckHandler((_wc, permission) => permitted(permission))
    // Devices are a separate gate the two handlers above never see: this one
    // answers a permission Electron would otherwise keep in memory once the
    // person had picked a device, without any request being made again.
    this.session.setDevicePermissionHandler(() => false)
    // And pairing, which is its own setter again. `confirmed: false` is how a
    // pairing is turned down; answering at all is what keeps it from waiting.
    this.session.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }))
    // `setDisplayMediaRequestHandler` is deliberately NOT set. Measured
    // 2026-09-19: with no handler, `getDisplayMedia` fails with
    // `NotSupportedError`, so screen capture is already refused — installing a
    // handler is the only way to open it. A later session adding one would be
    // granting this browser's own screen, sessions and all, to a page.

    this.leases = new LeaseTable()
    this.leases.onChange((event) => {
      if (event.type === 'claimed') {
        this.broadcast({ type: 'tab-claimed', tabId: event.tabId, holder: holderLabel(event.holder) })
      } else if (event.type === 'released' || event.type === 'expired') {
        this.broadcast({ type: 'tab-released', tabId: event.tabId, holder: holderLabel(event.holder) })
      } else if (event.type === 'taken-over') {
        this.broadcast({ type: 'tab-taken-over', tabId: event.tabId, by: holderLabel(event.to) })
      }
    })
  }

  get lastTouched(): number {
    return this.#lastTouched
  }

  touch(): void {
    this.#lastTouched = Date.now()
  }

  /** Whether renderers of this project exist — tabs, in a window shared with every other project. */
  get loaded(): boolean {
    return this.#tabs.length > 0
  }

  get tabs(): readonly Tab[] {
    return this.#tabs
  }

  /**
   * Flip the disguise for every tab of this project, open or yet to open. A
   * page already loaded keeps its user agent until it navigates; the
   * `webdriver` flag changes on the spot.
   */
  /** Applies to the next agent that leaves; a timer already running keeps its old length. */
  setOrphanCloseMs(ms: number): void {
    this.#orphanCloseMs = ms
  }

  async setAnnounceAutomation(on: boolean): Promise<void> {
    this.#announceAutomation = on
    this.session.setUserAgent(userAgentFor(on))
    await Promise.all(this.#tabs.map((tab) => tab.announceAutomation(on)))
  }

  // ------------------------------------------------------------------- window

  /** Make the window exist, off screen, so the tabs have a compositor. */
  show(): void {
    this.shell.show()
  }

  /** Put the window on screen with this project's tab in front. */
  reveal(focus: boolean): void {
    const active = this.activeTab()
    if (active) this.shell.bringFront(active.view)
    this.shell.reveal(focus)
  }

  bringToFront(): void {
    this.reveal(true)
  }

  /**
   * Push the session to disk. Cookies and local storage are written lazily, so
   * a login made a moment ago is still only in memory: without this, quitting
   * loses it and the person is asked to sign in again for no reason.
   */
  async flush(): Promise<void> {
    await this.session.cookies.flushStore()
    await this.session.flushStorageData()
  }

  /** Free the renderers of a project nobody is using; its session stays on disk. */
  unload(): void {
    this.downloads.clear()
    for (const tab of [...this.#tabs]) this.closeTab(tab.id)
    for (const timer of this.#orphanTimers.values()) clearTimeout(timer)
    this.#orphanTimers.clear()
    this.#departed.clear()
    this.#activeTabId = null
  }

  // --------------------------------------------------------------------- tabs

  openTab(url?: string, openedBy: string | null = null): Tab {
    const tab = this.#adopt(new Tab(this.session), openedBy)
    // A view with no document at all makes `executeJavaScript` wait forever, so
    // a blank tab is a real blank page rather than nothing. Tracking the load
    // is what stops the agent's first navigate from racing it. The disguise
    // goes on once that blank page is there — a tab with no document cannot
    // answer the DevTools protocol — and is tracked in turn, so the agent's
    // first navigate waits for it and the first real page sees the browser as
    // it should. Each step waits on the one tracked before it; a single chain
    // holding both would be waiting on itself.
    // An address this browser does not show throws, and the throw is the agent's
    // answer when it asked for the navigation itself. Here nobody asked for one
    // — the tab is being opened — so that one throw is caught: the attempt is
    // already recorded on the tab, and an unhandled rejection would be filed as
    // a fault of the application's own. A load that failed for any other reason
    // is left to reach `faults.ts`, the way it always has.
    const opening = tab.navigate(url ?? 'about:blank')
    void tab.track(
      outcomeFor(normalizeUrl(url ?? 'about:blank')) === 'load' ? opening : opening.catch(() => {}),
    )
    void tab.track(tab.announceAutomation(this.#announceAutomation))
    return tab
  }

  /**
   * Take a tab into the project: put it in the list, give it the window, and
   * wire everything the panel and the agents read. It says nothing about what
   * the tab shows — `openTab` sends it to an address, while a window a page
   * opened is loaded by Chromium itself.
   */
  #adopt(tab: Tab, openedBy: string | null): Tab {
    tab.openedBy = openedBy
    this.#tabs.push(tab)
    this.#activeTabId = tab.id
    this.shell.attach(tab.view)

    tab.onLeft = (handOff: HandOff) => {
      this.log(BROWSER, describeHandOff(handOff), tab.id)
    }

    // A click on a link in an address this browser does not show arrives here
    // and nowhere else: it reaches neither `Tab.navigate` nor the window-open
    // handler, and `did-fail-load` never fires for it (measured 2026-09-19).
    // Without this the person clicking "write to us" gets nothing at all.
    tab.wc.on('will-navigate', (event, url) => {
      const outcome = outcomeFor(url)
      if (outcome === 'load') return
      // Preventing the navigation leaves the tab on the page it was on, which
      // is what the sentence the agent reads promises.
      event.preventDefault()
      void tab.leave(url, outcome)
    })

    tab.wc.setWindowOpenHandler((details) => {
      // A window a page opens in an address this browser cannot show is not a
      // tab: allowing it would leave a blank tab with no document, which nobody
      // closes and an agent can pick to work in. It takes the same decision a
      // click does, and the person's panel says so.
      const outcome = outcomeFor(details.url)
      if (outcome !== 'load') {
        void tab.leave(details.url, outcome)
        return { action: 'deny' as const }
      }
      return {
        // A page opening a window becomes a tab, never a stray window the agent
        // cannot see or the person cannot close. It has to be a real child window
        // all the same. Refusing the open and reopening the address as a fresh
        // tab looks the same on screen and is not the same page: `window.open`
        // answers null, and the new page has no `opener`. Signing in through a
        // provider is built on both. "Sign in with Apple" asks for
        // `response_mode=web_message` and posts the code back to the window that
        // opened it, so with a refused open the person signs in and the site
        // never hears of it — praktiker.bg answered "Apple Sign-In Error" six
        // seconds after the click (2026-09-19).
        action: 'allow' as const,
        // The tab stands on its own, the way it did when it was a fresh tab:
        // closing the page that opened it leaves it where it is.
        outlivesOpener: true,
        // Chromium has already made the renderer and tied it to the page that
        // opened it; the tab takes that one over rather than building its own.
        createWindow: (options: unknown) => {
          const pending = (options as { webContents?: WebContents }).webContents
          const child = this.#adopt(new Tab(this.session, pending), tab.openedBy)
          child.trackAdoptedLoad()
          void child.track(child.announceAutomation(this.#announceAutomation))
          return child.wc
        },
      }
    })
    // A page can close the window it opened, and the sign-in page does exactly
    // that once it has posted the code back. Nothing goes through `closeTab`
    // then, so without this the panel keeps drawing a tab whose renderer is
    // gone and an agent can pick it to work in.
    tab.wc.once('destroyed', () => {
      if (this.#tabs.includes(tab)) this.closeTab(tab.id)
    })
    tab.wc.on('console-message', (event) => {
      tab.recordConsole({
        level: String(event.level),
        message: event.message,
        source: event.sourceId ?? '',
        line: event.lineNumber ?? 0,
        at: Date.now(),
      })
    })
    tab.wc.on('page-title-updated', () => this.notifyTabs())
    tab.wc.on('did-navigate', () => {
      this.notifyTabs()
      this.broadcast({ type: 'tab-navigated', tab: this.describeTab(tab) })
    })
    tab.wc.on('did-navigate-in-page', () => this.notifyTabs())
    tab.wc.on('did-stop-loading', () => this.notifyTabs())

    this.broadcast({ type: 'tab-opened', tab: this.describeTab(tab) })
    this.notifyTabs()
    return tab
  }

  closeTab(tabId: string): boolean {
    const at = this.#tabs.findIndex((tab) => tab.id === tabId)
    if (at < 0) return false
    const [tab] = this.#tabs.splice(at, 1)
    if (!tab) return false
    if (this.#activeTabId === tabId) this.#activeTabId = this.#tabs.at(-1)?.id ?? null
    for (const agent of this.agents.values()) {
      if (agent.currentTabId === tabId) agent.currentTabId = this.#activeTabId
    }
    this.shell.detach(tab.view, this.activeTab()?.view ?? null)
    tab.destroy()
    this.broadcast({ type: 'tab-closed', tabId })
    this.notifyTabs()
    // The last tab of a departed agent takes the agent's row with it.
    const owner = tab.openedBy
    if (owner && this.#departed.has(owner) && !this.#tabs.some((left) => left.openedBy === owner)) {
      this.#departed.delete(owner)
      this.notifyAgents()
    }
    return true
  }

  tab(tabId: string): Tab | null {
    return this.#tabs.find((tab) => tab.id === tabId) ?? null
  }

  activeTab(): Tab | null {
    if (!this.#activeTabId) return this.#tabs.at(-1) ?? null
    return this.tab(this.#activeTabId)
  }

  selectTab(tabId: string): boolean {
    const tab = this.tab(tabId)
    if (!tab) return false
    this.#activeTabId = tabId
    this.shell.bringFront(tab.view)
    this.notifyTabs()
    return true
  }

  /**
   * The tab an agent's next call acts on.
   *
   * A new agent gets a tab of its own rather than whatever happens to be in
   * front. Agents in a project can see and drive each other's tabs — that is
   * the point of sharing a window — but landing on one by accident turns two
   * agents doing unrelated work into a queue for no reason. Sharing a tab is
   * something an agent asks for with `selectTab`.
   */
  tabFor(agent: AgentHandle): Tab {
    if (agent.currentTabId) {
      const chosen = this.tab(agent.currentTabId)
      if (chosen && !chosen.destroyed) return chosen
    }
    const fresh = this.openTab(undefined, agent.id)
    agent.currentTabId = fresh.id
    return fresh
  }

  describeTab(tab: Tab): TabDescriptor {
    const holder = this.leases.holderOf(tab.id)
    const waiting = this.pendingHuman.get(tab.id)
    return {
      id: tab.id,
      index: this.#tabs.indexOf(tab),
      title: tab.title,
      url: tab.url,
      active: this.shell.isFront(tab.view),
      loading: tab.loading,
      heldBy: holder ? holderLabel(holder) : null,
      waitingForHuman: waiting ? waiting.reason : null,
      askedBy: waiting ? this.agents.get(waiting.agentId)?.label ?? null : null,
      openedBy: tab.openedBy,
    }
  }

  describeTabs(): TabDescriptor[] {
    return this.#tabs.map((tab) => this.describeTab(tab))
  }

  // ------------------------------------------------------------------- agents

  addAgent(agent: AgentHandle): void {
    this.agents.set(agent.id, agent)
    this.touch()
    this.broadcast({ type: 'agent-joined', agentId: agent.id, label: agent.label })
    this.notifyAgents()
  }

  removeAgent(agentId: string): void {
    const agent = this.agents.get(agentId)
    if (!agent) return
    this.agents.delete(agentId)
    const holder: Holder = { kind: 'agent', id: agent.id, label: agent.label }
    this.leases.releaseAll(holder)
    for (const [tabId, pending] of [...this.pendingHuman]) {
      if (pending.agentId === agentId) {
        this.pendingHuman.delete(tabId)
        pending.resolve('cancelled')
      }
    }
    // Everything this agent opened goes with it, but not at once. Sessions
    // come and go all day, and without any closing the window fills with pages
    // nobody is reading — twelve blank tabs out of twenty-seven after ten
    // minutes of four agents working. Closing on the spot is the other
    // mistake: a session that restarts comes back as a new agent, and the
    // page it was on — a form half filled, a login just made — is gone with
    // the old one. So the tabs wait a while, and go only if nobody has picked
    // them up.
    if (this.#tabs.some((tab) => tab.openedBy === agentId)) {
      this.#departed.set(agentId, { label: agent.label, ide: agent.descriptor.ide })
    }
    const grace = this.#orphanCloseMs
    const timer = setTimeout(() => {
      this.#orphanTimers.delete(agentId)
      this.closeOrphans(agentId)
    }, grace)
    this.#orphanTimers.set(agentId, timer)
    this.broadcast({ type: 'agent-left', agentId })
    this.notifyAgents()
  }

  /**
   * Close what a departed agent left behind, except a tab somebody is using:
   * one an agent has moved into, or one the person is holding.
   */
  closeOrphans(agentId: string): void {
    const inUse = new Set<string>()
    for (const agent of this.agents.values()) if (agent.currentTabId) inUse.add(agent.currentTabId)
    for (const tab of this.#tabs) if (this.leases.holderOf(tab.id)) inUse.add(tab.id)
    for (const tab of this.#tabs.filter((tab) => tab.openedBy === agentId && !inUse.has(tab.id))) {
      this.closeTab(tab.id)
    }
  }

  // ------------------------------------------------------------------- events

  broadcast(event: AppEvent, exceptAgentId?: string): void {
    for (const agent of this.agents.values()) {
      if (agent.id === exceptAgentId) continue
      agent.send({ type: 'event', event })
    }
    this.notifyTabs()
  }

  /**
   * Record what an actor just did, against the tab it did it in.
   *
   * The history lives on the tab rather than in one list per project, because
   * that is the shape the panel reads it in: an agent, the tabs it has been in,
   * and what it did in each. A call whose tab has already gone — `closeTab`
   * names the tab it destroyed — is dropped, since there is no longer a place
   * in the tree to show it.
   */
  log(actor: { id: string | null; label: string }, text: string, tabId: string | null): void {
    const tab = tabId ? this.tab(tabId) : null
    if (!tab) return
    const command: AgentCommand = { at: Date.now(), agentId: actor.id, agentLabel: actor.label, text }
    tab.commands.add(command)
    this.toChrome('commands', { tabId: tab.id, commands: [...tab.commands.entries] })
  }

  /** Every tab's history, the way the panel wants it when it starts. */
  commandsByTab(): Record<string, AgentCommand[]> {
    const all: Record<string, AgentCommand[]> = {}
    for (const tab of this.#tabs) all[tab.id] = [...tab.commands.entries]
    return all
  }

  notifyTabs(): void {
    this.toChrome('tabs', { tabs: this.describeTabs() })
  }

  notifyAgents(): void {
    this.toChrome('agents', { agents: this.agentRows() })
  }

  /** The agents the panel draws: the connected ones, then the departed ones whose tabs are still here. */
  agentRows(): AgentRow[] {
    const connected = [...this.agents.values()].map((agent) => ({
      id: agent.id,
      label: agent.label,
      ide: agent.descriptor.ide,
      tabId: agent.currentTabId,
      gone: false,
    }))
    const departed = [...this.#departed].map(([id, { label, ide }]) => ({ id, label, ide, tabId: null, gone: true }))
    return [...connected, ...departed]
  }

  /** Everything the panel draws goes out stamped with the project it belongs to. */
  toChrome(channel: string, payload: Record<string, unknown>): void {
    this.shell.toChrome(channel, { projectId: this.identity.id, ...payload })
  }
}
