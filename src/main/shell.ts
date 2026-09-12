import { app, BaseWindow, dialog, screen, WebContentsView } from 'electron'
import { appName } from './variant.ts'
// One floor for the panel's width, wherever it is set: the grip clamps a drag
// to it, and the settings window clamps a typed number to the same one.
import { PANEL_MIN_WIDTH, PANEL_WIDTH } from './preferences.ts'

export interface ShellPaths {
  preload: string
  chromeHtml: string
  /** A test run drives the browser without putting windows on the owner's screen. */
  headless?: boolean
  /** The panel's width as the person last left it. */
  panelWidth?: number
}

/**
 * The one window of the application: a panel down the left edge, and to its
 * right whichever tab is in front. Every project's tabs are views in this
 * window — the projects keep their sessions apart, and the window is what
 * they share. The panel draws them all, project by project.
 */
export class Shell {
  #window: BaseWindow | null = null
  #panel: WebContentsView | null = null
  /** Whether the person has actually been shown the window. */
  #onScreen = false
  #closing = false
  #panelWidth: number
  /** Every tab view in the window, in the order they were added. */
  readonly #views = new Set<WebContentsView>()
  /** The view to the right of the panel; the rest are hidden. */
  #front: WebContentsView | null = null
  #onFrontChange: (() => void) | null = null

  readonly #paths: ShellPaths
  readonly headless: boolean

  constructor(paths: ShellPaths) {
    this.#paths = paths
    this.headless = paths.headless ?? false
    this.#panelWidth = paths.panelWidth ?? PANEL_WIDTH
  }

  /** Called whenever another view comes to the front, so the panel can be told. */
  onFrontChange(handler: () => void): void {
    this.#onFrontChange = handler
  }

  get loaded(): boolean {
    return this.#window !== null
  }

  /** Whether the person can see the window right now. */
  get onScreen(): boolean {
    return this.#onScreen
  }

  // ------------------------------------------------------------------- window

  window(): BaseWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window

    // Wide on purpose. The panel takes 340 of it, and what is left is what the
    // site sees: below about 1000 CSS pixels many sites (Wikipedia among them)
    // switch to a phone layout, where a "Sign in" link becomes a hamburger
    // button and an agent looking for it finds nothing. It must still fit on
    // the screen — a window hanging off the edge is not composited there, and
    // clicks aimed at that part land on nothing.
    const room = screen.getPrimaryDisplay().workAreaSize
    const window = new BaseWindow({
      width: Math.min(1520, Math.max(1000, room.width - 80)),
      height: Math.min(940, Math.max(700, room.height - 80)),
      show: false,
      title: appName(),
      titleBarStyle: 'hiddenInset',
      // The panel is drawn over the system's sidebar material, the way a native
      // source list is: the desktop shows through it, and the appearance
      // switch is the system's, not a stylesheet's.
      vibrancy: 'sidebar',
      backgroundColor: '#00000000',
    })
    this.#window = window

    // One view, down the left edge: the address bar and the tree of projects,
    // their agents, the agents' tabs and what they did there. It is on the
    // left because `titleBarStyle: 'hiddenInset'` puts the window buttons over
    // the top-left of the content — a panel on the right would leave the page
    // painted underneath them.
    const panel = new WebContentsView({
      // The window spends most of its life shown but transparent, which
      // Chromium treats as hidden: a throttled panel stops producing frames,
      // so what a snapshot captures — and what the person sees on reveal — is
      // the tree as it was a step ago.
      webPreferences: {
        preload: this.#paths.preload,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    // Transparent, or the page paints over the material and there is none.
    panel.setBackgroundColor('#00000000')
    window.contentView.addChildView(panel)
    void panel.webContents.loadFile(this.#paths.chromeHtml)
    this.#panel = panel
    for (const view of this.#views) window.contentView.addChildView(view)

    window.on('resize', () => this.layout())
    // The close button is ambiguous for a menu-bar application: the person may
    // want the window out of the way, or the whole thing gone. Ask, every
    // time — the two answers differ by every tab the agents are working in.
    window.on('close', (event) => {
      if (this.#closing) return
      event.preventDefault()
      void this.#askToClose()
    })
    window.on('closed', () => {
      this.#window = null
      this.#panel = null
      this.#onScreen = false
    })

    this.layout()
    return window
  }

  panel(): WebContentsView | null {
    return this.#panel
  }

  panelWidth(): number {
    const width = this.#window?.getContentBounds().width ?? this.#panelWidth
    return Math.max(PANEL_MIN_WIDTH, Math.min(this.#panelWidth, Math.floor(width / 2)))
  }

  /** Take a width the person dragged to, keep it within reason, and lay out; returns what was kept. */
  setPanelWidth(width: number): number {
    const window = this.#window?.getContentBounds().width ?? Number.MAX_SAFE_INTEGER
    this.#panelWidth = Math.max(PANEL_MIN_WIDTH, Math.min(Math.round(width), Math.floor(window / 2)))
    this.layout()
    return this.#panelWidth
  }

  layout(): void {
    const window = this.#window
    if (!window || window.isDestroyed()) return
    const { width, height } = window.getContentBounds()
    const panelWidth = this.panelWidth()

    this.#panel?.setBounds({ x: 0, y: 0, width: panelWidth, height })
    for (const view of this.#views) {
      const visible = view === this.#front
      view.setVisible(visible)
      if (visible) view.setBounds({ x: panelWidth, y: 0, width: Math.max(0, width - panelWidth), height })
    }
  }

  // -------------------------------------------------------------------- views

  /** Put a tab's view in the window and in front. */
  attach(view: WebContentsView): void {
    const window = this.window()
    this.#views.add(view)
    window.contentView.addChildView(view)
    this.bringFront(view)
  }

  /** Take a tab's view out; if it was in front, the one named next takes its place. */
  detach(view: WebContentsView, next: WebContentsView | null): void {
    this.#views.delete(view)
    if (this.#window && !this.#window.isDestroyed()) this.#window.contentView.removeChildView(view)
    if (this.#front === view) this.bringFront(next)
    else this.layout()
  }

  bringFront(view: WebContentsView | null): void {
    const changed = this.#front !== view
    this.#front = view
    this.layout()
    if (changed) this.#onFrontChange?.()
  }

  isFront(view: WebContentsView): boolean {
    return this.#front === view
  }

  // --------------------------------------------------------------- on screen

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

  /** Take the window off screen the way `show` keeps it: alive, transparent, out of the way. */
  hide(): void {
    const window = this.#window
    if (!window || window.isDestroyed()) return
    this.#onScreen = false
    window.setOpacity(0)
    window.setIgnoreMouseEvents(true)
    window.blur()
  }

  /** Put the window on screen for real: the person asked, or an agent needs them. */
  reveal(focus: boolean): void {
    if (this.headless) return
    const window = this.window()
    this.#onScreen = true
    window.setIgnoreMouseEvents(false)
    window.setOpacity(1)
    if (focus) {
      // A menu-bar application has no dock icon and is not "active"; without
      // this the window is shown, but behind whatever the person is in.
      app.focus({ steal: true })
      window.show()
      window.focus()
    } else if (!window.isVisible()) {
      window.showInactive()
    }
  }

  async #askToClose(): Promise<void> {
    const window = this.window()
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      message: `Close the ${appName()} window?`,
      detail: 'Hide it and the agents keep working in their tabs. Quit and every project closes.',
      buttons: ['Hide to Menu Bar', `Quit ${appName()}`, 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    })
    if (response === 0) this.hide()
    else if (response === 1) {
      this.#closing = true
      app.quit()
    }
  }

  // ------------------------------------------------------------------- panel

  toChrome(channel: string, payload: unknown): void {
    const view = this.#panel
    if (!view || view.webContents.isDestroyed()) return
    view.webContents.send(channel, payload)
  }
}
