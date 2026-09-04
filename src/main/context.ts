import { BaseWindow, screen, session as electronSession, WebContentsView } from 'electron'
import type { Session } from 'electron'
import { type Holder, holderLabel, LeaseTable } from './lease.ts'
import { KeyedQueue } from './queue.ts'
import { partitionFor, type ProjectIdentity } from './project.ts'
import { Tab } from './tab.ts'
import type { AgentCommand, AgentDescriptor, AppEvent, ServerMessage, TabDescriptor } from './protocol.ts'

/**
 * The panel is the window's whole chrome, so it has to hold an address bar and
 * a three-level tree without either one being unreadable.
 */
export const PANEL_WIDTH = 340

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
  preload: string
  chromeHtml: string
  headless?: boolean
}

/**
 * One project: its own browsing session, its own window, its own tabs, and the
 * agents allowed to drive them. Nothing here is reachable from another project
 * — that is the whole point of the application, and the reason each context
 * builds its own Electron session from a partition named after the project's
 * hash.
 */
export class ProjectContext {
  readonly identity: ProjectIdentity
  readonly session: Session
  readonly leases: LeaseTable
  readonly queue = new KeyedQueue()
  readonly agents = new Map<string, AgentHandle>()
  readonly pendingHuman = new Map<string, PendingHuman>()

  #window: BaseWindow | null = null
  #panel: WebContentsView | null = null
  /** Whether the person has actually been shown this window. */
  #onScreen = false
  #tabs: Tab[] = []
  #activeTabId: string | null = null
  #lastTouched = Date.now()

  readonly #paths: ContextPaths
  /** A test run drives the browser without putting windows on the owner's screen. */
  readonly headless: boolean

  constructor(identity: ProjectIdentity, paths: ContextPaths) {
    this.headless = paths.headless ?? false
    this.identity = identity
    this.#paths = paths
    this.session = electronSession.fromPartition(partitionFor(identity.id))
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

  get loaded(): boolean {
    return this.#window !== null
  }

  get tabs(): readonly Tab[] {
    return this.#tabs
  }

  // ------------------------------------------------------------------- window

  window(): BaseWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window

    // Wide on purpose. The panel takes 340 of it, and what is left is what the
    // site sees: below about 1000 CSS pixels many sites (Wikipedia among them)
    // serve their compact layout, where the search field is folded behind a
    // button and an agent looking for it finds nothing. It must still fit on
    // the screen — a window hanging off the edge is not composited there, and
    // clicks aimed at that part land on nothing.
    const room = screen.getPrimaryDisplay().workAreaSize
    const window = new BaseWindow({
      width: Math.min(1520, Math.max(1000, room.width - 80)),
      height: Math.min(940, Math.max(700, room.height - 80)),
      show: false,
      title: `${this.identity.name} — Naoba`,
      titleBarStyle: 'hiddenInset',
      // The panel is drawn over the system's sidebar material, the way a native
      // source list is: the desktop shows through it, and the appearance
      // switch is the system's, not a stylesheet's.
      vibrancy: 'sidebar',
      backgroundColor: '#00000000',
    })
    this.#window = window

    // One view, down the left edge: the address bar and the tree of agents,
    // their tabs and what they did there. It is on the left because
    // `titleBarStyle: 'hiddenInset'` puts the window buttons over the top-left
    // of the content — a panel on the right would leave the page painted
    // underneath them.
    const panel = new WebContentsView({
      // The window spends most of its life shown but transparent, which
      // Chromium treats as hidden: a throttled panel stops producing frames,
      // so what a snapshot captures — and what the person sees on reveal — is
      // the tree as it was a step ago.
      webPreferences: { preload: this.#paths.preload, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    })
    // Transparent, or the page paints over the material and there is none.
    panel.setBackgroundColor('#00000000')
    window.contentView.addChildView(panel)
    void panel.webContents.loadFile(this.#paths.chromeHtml, {
      query: { project: this.identity.id, name: this.identity.name },
    })
    this.#panel = panel

    window.on('resize', () => this.layout())
    window.on('closed', () => {
      this.#window = null
      this.#panel = null
      this.#onScreen = false
      // Tabs belong to the window; drop them with it, but keep the session on
      // disk so a login made by hand outlives the window.
      for (const tab of this.#tabs) tab.destroy()
      this.#tabs = []
      this.#activeTabId = null
    })

    this.layout()
    return window
  }

  panel(): WebContentsView | null {
    return this.#panel
  }

  panelWidth(): number {
    const width = this.#window?.getContentBounds().width ?? PANEL_WIDTH
    return Math.min(PANEL_WIDTH, Math.floor(width / 2))
  }

  layout(): void {
    const window = this.#window
    if (!window || window.isDestroyed()) return
    const { width, height } = window.getContentBounds()
    const panelWidth = this.panelWidth()

    this.#panel?.setBounds({ x: 0, y: 0, width: panelWidth, height })
    for (const tab of this.#tabs) {
      const visible = tab.id === this.#activeTabId
      tab.view.setVisible(visible)
      if (visible) {
        tab.view.setBounds({ x: panelWidth, y: 0, width: Math.max(0, width - panelWidth), height })
      }
    }
  }

  /**
   * An agent opening a browser must not interrupt whoever is at the keyboard.
   * The window appears behind what the person is doing; only `requestHuman`
   * earns the right to come forward.
   */
  /**
   * Make the window exist without putting it in anybody's way.
   *
   * A window that has never been shown has no compositor, and a renderer with
   * no compositor does no hit-testing — clicks would land on nothing. So the
   * window is shown, but fully transparent and deaf to the mouse. An agent
   * starting work must not take over the screen of the person who asked for the
   * work; the window becomes visible when they ask for it, or when an agent
   * needs them.
   *
   * Parking it off-screen is not an option: macOS slides a window back against
   * the edge, where it sits in the way.
   */
  show(): void {
    const window = this.window()
    if (this.#onScreen) return
    window.setOpacity(0)
    window.setIgnoreMouseEvents(true)
    if (!window.isVisible()) window.showInactive()
  }

  /** Put the window on screen for real: the person asked, or an agent needs them. */
  reveal(focus: boolean): void {
    if (this.headless) return
    const window = this.window()
    this.#onScreen = true
    window.setIgnoreMouseEvents(false)
    window.setOpacity(1)
    if (focus) {
      window.show()
      window.focus()
    } else if (!window.isVisible()) {
      window.showInactive()
    }
  }

  bringToFront(): void {
    this.reveal(true)
  }

  /** Free the renderers of a project nobody is using; its session stays on disk. */
  /**
   * Push the session to disk. Cookies and local storage are written lazily, so
   * a login made a moment ago is still only in memory: without this, quitting
   * loses it and the person is asked to sign in again for no reason.
   */
  async flush(): Promise<void> {
    await this.session.cookies.flushStore()
    await this.session.flushStorageData()
  }

  unload(): void {
    if (!this.#window) return
    for (const tab of this.#tabs) tab.destroy()
    this.#tabs = []
    this.#activeTabId = null
    if (!this.#window.isDestroyed()) this.#window.destroy()
    this.#window = null
    this.#panel = null
  }

  // --------------------------------------------------------------------- tabs

  openTab(url?: string, openedBy: string | null = null): Tab {
    this.window()
    const tab = new Tab(this.session, this.#paths.preload)
    tab.openedBy = openedBy
    this.#tabs.push(tab)
    this.#window?.contentView.addChildView(tab.view)
    this.#activeTabId = tab.id

    tab.wc.setWindowOpenHandler(({ url: target }) => {
      // A page opening a window becomes a tab, never a stray window the agent
      // cannot see or the person cannot close.
      const child = this.openTab(target, tab.openedBy)
      void child
      return { action: 'deny' }
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

    this.layout()
    this.broadcast({ type: 'tab-opened', tab: this.describeTab(tab) })
    this.notifyTabs()
    // A view with no document at all makes `executeJavaScript` wait forever, so
    // a blank tab is a real blank page rather than nothing. Tracking the load
    // is what stops the agent's first navigate from racing it.
    void tab.track(tab.navigate(url ?? 'about:blank'))
    return tab
  }

  closeTab(tabId: string): boolean {
    const at = this.#tabs.findIndex((tab) => tab.id === tabId)
    if (at < 0) return false
    const [tab] = this.#tabs.splice(at, 1)
    if (!tab) return false
    this.#window?.contentView.removeChildView(tab.view)
    tab.destroy()
    if (this.#activeTabId === tabId) this.#activeTabId = this.#tabs.at(-1)?.id ?? null
    for (const agent of this.agents.values()) {
      if (agent.currentTabId === tabId) agent.currentTabId = this.#activeTabId
    }
    this.layout()
    this.broadcast({ type: 'tab-closed', tabId })
    this.notifyTabs()
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
    if (!this.tab(tabId)) return false
    this.#activeTabId = tabId
    this.layout()
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
      active: tab.id === this.#activeTabId,
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
    // Everything this agent opened goes with it. Sessions come and go all day;
    // without this the window fills with pages nobody is reading — twelve blank
    // tabs out of twenty-seven after ten minutes of four agents working.
    for (const tabId of this.#tabs.filter((tab) => tab.openedBy === agentId).map((tab) => tab.id)) {
      this.closeTab(tabId)
    }
    this.broadcast({ type: 'agent-left', agentId })
    this.notifyAgents()
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
    this.toChrome('tabs', this.describeTabs())
  }

  notifyAgents(): void {
    this.toChrome(
      'agents',
      [...this.agents.values()].map((agent) => ({
        id: agent.id,
        label: agent.label,
        ide: agent.descriptor.ide,
        tabId: agent.currentTabId,
      })),
    )
  }

  toChrome(channel: string, payload: unknown): void {
    const view = this.#panel
    if (!view || view.webContents.isDestroyed()) return
    view.webContents.send(channel, payload)
  }
}
