import { BaseWindow, screen, session as electronSession, WebContentsView } from 'electron'
import type { Session } from 'electron'
import { type Holder, holderLabel, LeaseTable } from './lease.ts'
import { KeyedQueue } from './queue.ts'
import { partitionFor, type ProjectIdentity } from './project.ts'
import { Tab } from './tab.ts'
import type { AgentDescriptor, AppEvent, ServerMessage, TabDescriptor } from './protocol.ts'

export const CHROME_HEIGHT = 68
export const PANEL_WIDTH = 300

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
  readonly activity: { at: number; agent: string; text: string; tabId: string | null }[] = []

  #window: BaseWindow | null = null
  #chrome: WebContentsView | null = null
  #panel: WebContentsView | null = null
  #panelOpen = true
  #chromeHeight = CHROME_HEIGHT
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

    // Wide on purpose. The panel takes 300 of it, and what is left is what the
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
      title: `${this.identity.name} — Agent Browser`,
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#1c1c1e',
    })
    this.#window = window

    const makeView = (part: 'top' | 'side') => {
      const view = new WebContentsView({
        webPreferences: { preload: this.#paths.preload, contextIsolation: true, sandbox: true },
      })
      window.contentView.addChildView(view)
      void view.webContents.loadFile(this.#paths.chromeHtml, {
        query: { project: this.identity.id, name: this.identity.name, part },
      })
      return view
    }
    // Two views of one page: the tab strip on top, the agent panel at the side.
    // A view is a rectangle, and the chrome is an L.
    this.#chrome = makeView('top')
    this.#panel = makeView('side')

    window.on('resize', () => this.layout())
    window.on('closed', () => {
      this.#window = null
      this.#chrome = null
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

  chrome(): WebContentsView | null {
    return this.#chrome
  }

  panel(): WebContentsView | null {
    return this.#panel
  }

  /**
   * The strip measures itself and says how much room its text needs; at a
   * larger text size that is more than the default. Anything outside the range
   * is a renderer that has just been resized mid-render, so it is ignored.
   */
  setChromeHeight(height: number): void {
    const wanted = Math.round(height)
    if (!Number.isFinite(wanted) || wanted < CHROME_HEIGHT || wanted > 240) return
    if (wanted === this.#chromeHeight) return
    this.#chromeHeight = wanted
    this.layout()
  }

  layout(): void {
    const window = this.#window
    if (!window || window.isDestroyed()) return
    const { width, height } = window.getContentBounds()
    const panelWidth = this.#panelOpen ? Math.min(PANEL_WIDTH, Math.floor(width / 3)) : 0
    const chromeHeight = this.#chromeHeight

    this.#chrome?.setBounds({ x: 0, y: 0, width, height: chromeHeight })
    this.#panel?.setVisible(this.#panelOpen)
    if (this.#panelOpen) {
      this.#panel?.setBounds({
        x: width - panelWidth,
        y: chromeHeight,
        width: panelWidth,
        height: Math.max(0, height - chromeHeight),
      })
    }
    for (const tab of this.#tabs) {
      const visible = tab.id === this.#activeTabId
      tab.view.setVisible(visible)
      if (visible) {
        tab.view.setBounds({
          x: 0,
          y: chromeHeight,
          width: Math.max(0, width - panelWidth),
          height: Math.max(0, height - chromeHeight),
        })
      }
    }
  }

  togglePanel(open?: boolean): boolean {
    this.#panelOpen = open ?? !this.#panelOpen
    this.layout()
    return this.#panelOpen
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
  unload(): void {
    if (!this.#window) return
    for (const tab of this.#tabs) tab.destroy()
    this.#tabs = []
    this.#activeTabId = null
    if (!this.#window.isDestroyed()) this.#window.destroy()
    this.#window = null
    this.#chrome = null
    this.#panel = null
  }

  // --------------------------------------------------------------------- tabs

  openTab(url?: string): Tab {
    this.window()
    const tab = new Tab(this.session, this.#paths.preload)
    this.#tabs.push(tab)
    this.#window?.contentView.addChildView(tab.view)
    this.#activeTabId = tab.id

    tab.wc.setWindowOpenHandler(({ url: target }) => {
      // A page opening a window becomes a tab, never a stray window the agent
      // cannot see or the person cannot close.
      const child = this.openTab(target)
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
    const fresh = this.openTab()
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

  log(agentLabel: string, text: string, tabId: string | null): void {
    this.activity.unshift({ at: Date.now(), agent: agentLabel, text, tabId })
    if (this.activity.length > 300) this.activity.length = 300
    this.toChrome('activity', this.activity.slice(0, 60))
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
    for (const view of [this.#chrome, this.#panel]) {
      if (!view || view.webContents.isDestroyed()) continue
      view.webContents.send(channel, payload)
    }
  }
}
