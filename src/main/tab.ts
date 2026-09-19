import { WebContentsView } from 'electron'
import type { Session, WebContents, WebFrameMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { toTransferable } from './serialize.ts'
import { CommandLog } from './commands.ts'
import { userAgentFor } from './disguise.ts'
import { describePattern, matcherFor, type UrlPattern } from './urls.ts'
import { describeVisits, VisitLog } from './visits.ts'
import { handOffNotice, outcomeFor, refusalFor, type SchemeOutcome, tooSoon, tooSoonNotice } from './schemes.ts'
import { openExternally } from './hand-off.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One address this tab tried to leave for, and what this browser did about it. */
export interface HandOff {
  readonly url: string
  readonly outcome: 'hand-on' | 'refuse'
  readonly at: number
}

export interface ConsoleEntry {
  level: string
  message: string
  source: string
  line: number
  at: number
}

export interface NetworkEntry {
  requestId: string
  method: string
  url: string
  resourceType: string
  status: number | null
  mimeType: string | null
  at: number
  finishedAt: number | null
  failed: string | null
}

export interface DialogRule {
  action: 'accept' | 'dismiss'
  promptText?: string
}

const FIRST_PAINT_WAIT_MS = 400
const INPUT_SETTLE_MS = 16
/**
 * How long a failed navigation is given to turn out to be a download. Chromium
 * rejects the load before it announces the download, and the gap is a few
 * milliseconds — this is generous, and it is only ever paid by a navigation
 * that failed anyway.
 */
const DOWNLOAD_HANDOVER_MS = 1_000

/**
 * A snapshot ref, bare and in the form `snapshot()` actually prints it: `ref_7`
 * and `[ref_7]`.
 *
 * The printed form is the one an agent has in hand — the manual tells it to
 * pass exactly that — and it used to fall through to `document.querySelector`,
 * where `[ref_7]` reads as an attribute selector for an attribute no page
 * carries and so matched nothing, ever. One agent lost every ref it copied and
 * went back to writing its own DOM walks. The resolver in the page and the
 * stale-ref diagnostic both read this one pattern: they used to carry a copy
 * each, which is how the diagnostic came to answer for a form the resolver no
 * longer accepted.
 */
const REF_SELECTOR = /^\[?ref_(\d+)\]?$/

/**
 * The resolver the page answers selectors with, in one place because it is
 * installed in two: every `call` defines it, and `setFiles` evaluates it
 * through the DevTools protocol to get a handle on the node rather than a
 * value. It is defined per call and never installed once, because a single-page
 * application replaces the document without ever reloading and a helper left at
 * load time quietly disappears with it. A `ref_N` comes from the last snapshot
 * and resolves against the list it left behind.
 */
const PAGE_HELPERS = `
      window.__abRefIndex = (sel) => {
        if (typeof sel !== 'string') return null
        const found = ${REF_SELECTOR}.exec(sel)
        return found ? Number(found[1]) : null
      }
      window.__abQuery = (sel) => {
        if (sel === null || sel === undefined) return null
        if (typeof sel !== 'string') return sel
        const index = window.__abRefIndex(sel)
        if (index !== null) return (window.__abRefs || [])[index] || null
        return document.querySelector(sel)
      }
      // Everything a selector answers to. A ref names exactly one node, and
      // asking the document instead gives two different answers to the same
      // question: \`[ref_7]\` is a valid selector that matches nothing, while
      // \`ref_7\` is not a selector at all and throws.
      window.__abAll = (sel) => {
        if (window.__abRefIndex(sel) !== null) {
          const one = window.__abQuery(sel)
          return one ? [one] : []
        }
        return [...document.querySelectorAll(sel)]
      }
`

/**
 * One page. Everything an agent does lands here in the end.
 *
 * Interaction goes through `sendInputEvent` rather than synthetic DOM events,
 * so the page sees `isTrusted: true`. That is the single capability an
 * extension-based tool like FoxCode can never have, and half the reason this is
 * an application.
 */
export class Tab {
  readonly id = randomUUID()
  readonly view: WebContentsView
  readonly #contents: WebContents
  readonly console: ConsoleEntry[] = []
  readonly network = new Map<string, NetworkEntry>()
  /** What has been done in this tab, newest first. */
  readonly commands = new CommandLog()

  /**
   * The addresses this tab tried to leave for, newest last, and what became of
   * each. History rather than a "where it is now" field, because an attempt is
   * over the moment it is made and a reader a minute later has to be able to
   * tell that. It does not ride on `TabDescriptor` — see the comment on that
   * type — so `status` builds it on demand instead.
   */
  readonly leftFor: HandOff[] = []
  #lastHandOff: number | null = null

  /**
   * Set by the project when it takes the tab in: the person watching the panel
   * is told an address left as well as the agents are. The tab does not know
   * the project, so it says what happened and the project does the telling.
   */
  onLeft: ((handOff: HandOff) => void) | null = null

  /**
   * The agent that opened this tab, or null when the person did. An agent's
   * tabs go away with it: a session that ends leaves nothing behind for the
   * next one to wade through.
   */
  openedBy: string | null = null

  /** Resolves when the tab has a document to talk to. */
  #ready: Promise<void> = Promise.resolve()
  #consoleCapturing = false
  #networkCapturing = false
  #dialogRule: DialogRule | null = null
  #debuggerAttached = false
  /** Whether this page has painted since it was last loaded. */
  #painted = false
  /** The frame the current call runs against, or the page itself. */
  #frame: WebFrameMain | null = null
  #frameOffset = { x: 0, y: 0 }
  #dialogsEnabled = false
  #destroyed = false
  readonly dialogs: { type: string; message: string; at: number; handled: 'accept' | 'dismiss' }[] = []

  // No preload. The one this application has carries the window's own controls,
  // and `contextBridge.exposeInMainWorld` puts them in the page's world by
  // design — so a tab that loaded it handed every site `window.ab`, and with it
  // the register of admitted projects, their absolute paths, and the login
  // item. Nothing a page needs comes from a preload anyway: `__abRefs` and the
  // rest are installed per call, because a single-page application drops them.
  //
  // A window a page opened arrives as a renderer Chromium has already made and
  // already tied to the page that opened it, and `adopted` is that renderer.
  // Building a fresh one for it instead is refused — "Created window should be
  // connected to webContents passed with options object" — and what survives
  // the refusal is a view that never loads anything: the popup goes to a window
  // of Chromium's own, outside the project. Its preferences come from the page
  // that opened it, which is another tab of this project, so they are the ones
  // below already.
  constructor(session: Session, adopted?: WebContents) {
    this.view = adopted ? new WebContentsView({ webContents: adopted }) : new WebContentsView({
      webPreferences: {
        session,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        // Every tab of a project shares one session, so a login done by hand in
        // one tab is available to the agent in the next one.
      },
    })
    this.#contents = this.view.webContents
    this.#wireDialogs()
  }

  /**
   * The renderer, held rather than read back from the view each time.
   *
   * Electron 44 clears `WebContentsView.webContents` once the renderer is gone,
   * so a view whose page closed itself answers `undefined` — and every getter
   * here that went through the view threw `Cannot read properties of undefined`
   * instead of saying the tab was destroyed. A held reference still answers
   * `isDestroyed()`, which is the question being asked.
   */
  get wc(): WebContents {
    return this.#contents
  }

  get destroyed(): boolean {
    return this.#destroyed || this.#contents.isDestroyed()
  }

  get title(): string {
    return this.destroyed ? '' : this.wc.getTitle()
  }

  get url(): string {
    return this.destroyed ? '' : this.wc.getURL()
  }

  get loading(): boolean {
    return this.destroyed ? false : this.wc.isLoading()
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#detachDebugger()
    if (!this.wc.isDestroyed()) this.wc.close()
  }

  // ----------------------------------------------------------------- disguise

  /**
   * Whether pages are told that a program drives this tab.
   *
   * Hidden, the page sees plain Chromium and `navigator.webdriver` is false —
   * the two things a bot check reads first. Announced, the Electron user agent
   * is back and the flag is set through the DevTools protocol, which changes
   * the document already open and not only the next one. The person building
   * such a check wants both sides of it, so this can flip while the tab lives.
   */
  async announceAutomation(on: boolean): Promise<void> {
    // A tab that has never loaded anything has no renderer to answer the
    // DevTools protocol, and a command sent to it never returns.
    await this.#ready
    if (this.destroyed) return
    this.wc.setUserAgent(userAgentFor(on))
    if (!on && !this.#debuggerAttached) return
    this.#attachDebugger()
    await this.wc.debugger.sendCommand('Emulation.setAutomationOverride', { enabled: on }).catch(() => undefined)
  }

  // ---------------------------------------------------------------- navigation

  /**
   * Wait until this tab has finished whatever load it was already doing.
   *
   * A fresh tab loads `about:blank` so that scripting works at all, and an
   * agent's first `navigate` would otherwise race it: the blank page finishes
   * last and wins, leaving the agent looking at nothing on a page it just
   * asked for.
   */
  whenReady(): Promise<void> {
    return this.#ready
  }

  track(work: Promise<void>): Promise<void> {
    this.#ready = work.catch(() => undefined)
    return work
  }

  /**
   * Wait for a load this tab never asked for — the one Chromium runs itself for
   * a window a page opened.
   *
   * `waitForLoad` cannot stand in for it. At the moment the popup's renderer is
   * handed over the load has not started yet, so `isLoading()` is false and
   * that wait returns at once, leaving an agent looking at a blank page on a
   * tab that is about to show a sign-in form.
   */
  trackAdoptedLoad(timeoutMs = 30_000): void {
    void this.track(
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          this.wc.off('did-stop-loading', done)
          resolve()
        }
        const timer = setTimeout(done, timeoutMs)
        this.wc.on('did-stop-loading', done)
      }),
    )
  }

  /**
   * Take the address out of this browser: hand it to the machine, or refuse it.
   * Answers the sentence an agent reads, and records the attempt either way.
   *
   * The flood guard is here rather than in the caller because every caller
   * needs it: a page can loop a `mailto:` from a click, from `window.open` and
   * from an agent's own scenario.
   */
  async leave(url: string, outcome: SchemeOutcome, now = Date.now()): Promise<string> {
    const stayedAt = this.url
    if (outcome === 'hand-on') {
      if (tooSoon(this.#lastHandOff, now)) {
        this.#record({ url, outcome: 'refuse', at: now })
        return tooSoonNotice(url, stayedAt)
      }
      this.#lastHandOff = now
      this.#record({ url, outcome: 'hand-on', at: now })
      await openExternally(url)
      return handOffNotice(url, stayedAt)
    }
    this.#record({ url, outcome: 'refuse', at: now })
    return refusalFor(url, stayedAt)
  }

  #record(handOff: HandOff): void {
    this.leftFor.push(handOff)
    // Ten is what a reader can use: an attempt older than that has been
    // answered, or was never going to be.
    while (this.leftFor.length > 10) this.leftFor.shift()
    this.onLeft?.(handOff)
  }

  async navigate(url: string): Promise<void> {
    await this.#ready
    const target = normalizeUrl(url)
    // An address this browser does not show is decided before the load, not
    // after it: a load that fails answers ERR_FAILED (-2) whether the scheme is
    // unknown or the page is broken, so the code cannot tell them apart
    // (measured 2026-09-19). Both outcomes throw, because in both the page did
    // not move, and a scenario carrying on as though it had is the defect this
    // was written to remove.
    const outcome = outcomeFor(target)
    if (outcome !== 'load') throw new Error(await this.leave(target, outcome))
    // A new document has painted nothing yet.
    this.#painted = false

    // An address that turns out to be a file is a download, and the tab stays
    // on the page it was already showing. Chromium reports that as a load
    // failure — `ERR_FAILED (-2)` for the GitHub archive link this was measured
    // on (2026-09-15), not the `ERR_ABORTED` handled below — so the error alone
    // cannot tell the two apart, and an agent following a link to a file would
    // otherwise have to wrap every navigate in a try/catch.
    let becameDownload = false
    const onDownload = (_event: unknown, _item: unknown, source: WebContents | null) => {
      if (source === this.wc) becameDownload = true
    }
    const session = this.wc.session
    session.on('will-download', onDownload)

    try {
      await this.wc.loadURL(target)
    } catch (error) {
      // ERR_ABORTED is raised by a redirect and by a page that replaces its own
      // load, neither of which is a failed navigation. What matters is where
      // the tab ended up.
      const code = (error as { errno?: number }).errno
      if (code === -3) {
        await this.waitForLoad()
        return
      }
      // The event can arrive after the rejection does, so the answer is not
      // ready at the moment of the throw — it is worth a short wait before
      // calling this a failure.
      if (await waitUntil(() => becameDownload, DOWNLOAD_HANDOVER_MS)) return
      throw error
    } finally {
      session.off('will-download', onDownload)
    }
  }

  async goBack(): Promise<boolean> {
    if (!this.wc.navigationHistory.canGoBack()) return false
    this.#painted = false
    this.wc.navigationHistory.goBack()
    await this.waitForLoad()
    return true
  }

  async goForward(): Promise<boolean> {
    if (!this.wc.navigationHistory.canGoForward()) return false
    this.#painted = false
    this.wc.navigationHistory.goForward()
    await this.waitForLoad()
    return true
  }

  async reload(): Promise<void> {
    this.#painted = false
    this.wc.reload()
    await this.waitForLoad()
  }

  waitForLoad(timeoutMs = 30_000): Promise<void> {
    if (!this.wc.isLoading()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer)
        this.wc.off('did-stop-loading', onStop)
        this.wc.off('did-fail-load', onFail)
        error ? reject(error) : resolve()
      }
      const onStop = () => done()
      const onFail = (_e: unknown, code: number, description: string, validated: string) => {
        // -3 is ERR_ABORTED, which a redirect or a cancelled subframe raises routinely.
        if (code === -3) return
        done(new Error(`navigation failed (${code} ${description}) for ${validated}`))
      }
      const timer = setTimeout(() => done(new Error(`page still loading after ${timeoutMs}ms`)), timeoutMs)
      this.wc.on('did-stop-loading', onStop)
      this.wc.on('did-fail-load', onFail)
    })
  }

  /**
   * Wait until the page is at an address this pattern matches.
   *
   * A form submit ends at a URL, and nothing here waited for one: the session
   * this helper comes from spent 281 s — 48% of its machine time — in 79
   * pauses it made up, most of them sitting after a submit. `waitForLoad` is
   * not the same wait. A single-page form moves with `pushState` and never
   * loads again, which is exactly how the Bazar.bg listing ended, so both
   * events are watched — and `did-navigate-in-page` fires for sub-frames too,
   * so its `isMainFrame` flag is read rather than trusted. An advertisement
   * calling `pushState` is not the form arriving.
   */
  async waitForUrl(pattern: UrlPattern, timeoutMs: number): Promise<string> {
    const matches = matcherFor(pattern)
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    const walk = new VisitLog(startedAt)
    let arrived: (() => void) | null = null
    const onNavigate = (_event: unknown, url: string) => {
      walk.add('navigate', url, Date.now())
      if (matches(url)) arrived?.()
    }
    const onInPage = (_event: unknown, url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return
      walk.add('in-page', url, Date.now())
      if (matches(url)) arrived?.()
    }
    // The listeners go on before the current address is tested: between the two
    // there is nothing to await, so an arrival cannot fall between them.
    this.wc.on('did-navigate', onNavigate)
    this.wc.on('did-navigate-in-page', onInPage)
    try {
      if (!matches(this.url)) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            const report = walk.report(Date.now())
            reject(Object.assign(
              new Error(
                `waited ${timeoutMs}ms for ${describePattern(pattern)}; ${describeVisits(report, this.url)}`,
              ),
              { code: 'timeout', ...report },
            ))
          }, timeoutMs)
          arrived = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
    } finally {
      if (!this.destroyed) {
        this.wc.off('did-navigate', onNavigate)
        this.wc.off('did-navigate-in-page', onInPage)
      }
    }
    // An address commits before its document arrives, so a navigation is waited
    // out and an in-page move has nothing to wait for. The budget is the
    // caller's: a page that never stops loading — a long poll, a tracker — must
    // not turn an address that did arrive into a failure.
    while (this.wc.isLoading() && Date.now() < deadline) await pause(50)
    return this.url
  }

  // ------------------------------------------------------------------ scripting

  /** Run an expression in the page's own world and bring the value back JSON-safe. */
  async js<T = unknown>(expression: string): Promise<T> {
    const target = this.#frame ?? this.wc.mainFrame
    const value = await target.executeJavaScript(expression, true)
    return toTransferable(value) as T
  }

  /**
   * The frames inside this page, in the order they appear in it.
   *
   * A page is often not one document: a payment form, an embedded editor, a
   * documentation sandbox all live in frames of their own, and a selector run
   * against the page never sees inside them.
   */
  frames(): { index: number; url: string; name: string }[] {
    return this.#frameList().map((frame, index) => ({ index, url: frame.url, name: frame.name }))
  }

  /**
   * Run everything inside `run` against one frame instead of the page.
   *
   * Clicks need more than a different document: the point measured inside a
   * frame is relative to that frame, so where the frame itself sits has to be
   * added back before the click is sent.
   */
  async withFrame<T>(match: string | number | null | undefined, run: () => Promise<T>): Promise<T> {
    if (match === null || match === undefined) return await run()
    const frame = this.#resolveFrame(match)
    const previousFrame = this.#frame
    const previousOffset = this.#frameOffset
    this.#frame = frame
    this.#frameOffset = await this.#offsetOf(frame)
    try {
      return await run()
    } finally {
      this.#frame = previousFrame
      this.#frameOffset = previousOffset
    }
  }

  #frameList(): WebFrameMain[] {
    const main = this.wc.mainFrame
    return main.framesInSubtree.filter((frame) => frame !== main)
  }

  #resolveFrame(match: string | number): WebFrameMain {
    const frames = this.#frameList()
    if (frames.length === 0) throw new Error('this page has no frames')
    if (typeof match === 'number') {
      const frame = frames[match]
      if (!frame) throw new Error(`this page has ${frames.length} frames, so there is no frame ${match}`)
      return frame
    }
    const found = frames.find((frame) => frame.url.includes(match) || frame.name === match)
    if (found) return found
    const listed = frames.map((frame, index) => `${index}: ${frame.name || frame.url || 'unnamed'}`).join(', ')
    throw new Error(`no frame matches ${match}. This page has: ${listed}`)
  }

  /** Where a frame sits in the page, so a click inside it lands in the right place. */
  async #offsetOf(frame: WebFrameMain): Promise<{ x: number; y: number }> {
    const index = this.#frameList().indexOf(frame)
    const boxes = await this.wc.mainFrame.executeJavaScript(
      `[...document.querySelectorAll('iframe,frame')].map((f) => {
        const r = f.getBoundingClientRect()
        return { src: f.src || '', x: r.x, y: r.y }
      })`,
      true,
    ) as { src: string; x: number; y: number }[]
    // Match by address first — a frame that carries one is unambiguous. A frame
    // written inline (`srcdoc`) has no address, so fall back to its position in
    // the page, which is the same order both lists are built in.
    const byUrl = frame.url ? boxes.find((box) => box.src === frame.url) : undefined
    const box = byUrl ?? boxes[index]
    return box ? { x: box.x, y: box.y } : { x: 0, y: 0 }
  }

  /** Run a function body in the page with arguments, without string-splicing the caller's data in. */
  async call<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
    const payload = JSON.stringify(args)
    const wrapped = `(async () => {
      ${PAGE_HELPERS}
      const __args = ${payload}
      return await (${fn}).apply(null, __args)
    })()`
    return await this.js<T>(wrapped)
  }

  // ---------------------------------------------------------------------- input

  /**
   * Element geometry in the coordinate space `sendInputEvent` expects.
   *
   * The page reports CSS pixels; the view wants them multiplied by the zoom
   * factor. Getting this wrong lands every click in the wrong place at any zoom
   * other than 100%, and only at a zoom nobody tests.
   */
  async centerOf(selector: string, timeoutMs: number): Promise<{ x: number; y: number }> {
    await this.waitFor(selector, timeoutMs, false)
    const rect = await this.call<
      { x: number; y: number; w: number; h: number; matches: number; visible: number } | null
    >(
      `(sel) => {
        const el = window.__abQuery(sel)
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        const r = el.getBoundingClientRect()
        // How many others answer to the same selector, and how many of those a
        // person could actually click: a page that keeps a hidden copy of its
        // search field is the usual reason the first match has no size.
        let matches = 1
        let visible = 0
        try {
          const all = window.__abAll(sel)
          matches = all.length
          visible = all.filter((n) => {
            const b = n.getBoundingClientRect()
            return b.width > 0 && b.height > 0
          }).length
        } catch {}
        return { x: r.x, y: r.y, w: r.width, h: r.height, matches, visible }
      }`,
      selector,
    )
    if (!rect) throw new Error(`no element matches ${selector}`)
    if (rect.w === 0 || rect.h === 0) {
      const others = rect.visible > 0
        ? `${rect.visible} of the ${rect.matches} elements matching it are visible — narrow the selector to one of those`
        : 'nothing matching it is visible on the page right now'
      throw new Error(`element ${selector} has no size, so it cannot be clicked: ${others}`)
    }
    const zoom = this.wc.getZoomFactor()
    return {
      x: (this.#frameOffset.x + rect.x + rect.w / 2) * zoom,
      y: (this.#frameOffset.y + rect.y + rect.h / 2) * zoom,
    }
  }

  /**
   * Where to click so the click actually reaches this element.
   *
   * A page still laying itself out — a font arriving, an image sizing, a frame
   * loading, an animation running — moves things under the pointer between the
   * moment a rectangle is measured and the moment the click is sent. So the
   * point is measured and then checked against what sits there: if it is not
   * this element or something inside it, wait a beat and measure again.
   */
  async clickPointFor(selector: string, timeoutMs: number): Promise<{ x: number; y: number }> {
    const deadline = Date.now() + Math.min(timeoutMs, 3_000)
    let point = await this.centerOf(selector, timeoutMs)
    for (;;) {
      const hit = await this.call<boolean>(
        `(sel, x, y) => {
          const el = window.__abQuery(sel)
          if (!el) return false
          const at = document.elementFromPoint(x, y)
          return !!at && (at === el || el.contains(at) || at.contains(el))
        }`,
        selector,
        point.x / this.wc.getZoomFactor() - this.#frameOffset.x,
        point.y / this.wc.getZoomFactor() - this.#frameOffset.y,
      )
      if (hit || Date.now() > deadline) return point
      await pause(80)
      point = await this.centerOf(selector, timeoutMs)
    }
  }

  /**
   * Input goes through the DevTools protocol rather than `sendInputEvent`.
   *
   * Both produce events the page sees as `isTrusted: true`, but
   * `sendInputEvent` is delivered through the window, so it does nothing at all
   * when that window is hidden or minimised — an agent working while the person
   * has the window tucked away would silently click nothing. The protocol talks
   * to the renderer directly and does not care whether anyone is looking.
   */
  async clickAt(x: number, y: number, clickCount = 1, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    this.#attachDebugger()
    await this.#awaitFirstPaint()
    const common = { x, y, button, clickCount, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4 }
    await this.#input('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await this.#input('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
    await this.#input('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
    await pause(INPUT_SETTLE_MS)
  }

  /**
   * Press at one point, move, release at another — the way a person drags.
   *
   * The move is broken into steps on purpose: a canvas app or a sortable list
   * follows the pointer, and one jump from start to finish reads to them as no
   * movement at all.
   */
  async dragFromTo(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12): Promise<void> {
    this.#attachDebugger()
    await this.#awaitFirstPaint()
    await this.#input('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x,
      y: from.y,
      button: 'none',
      buttons: 0,
    })
    await this.#input('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      clickCount: 1,
      buttons: 1,
    })
    for (let step = 1; step <= steps; step++) {
      const at = step / steps
      await this.#input('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + (to.x - from.x) * at),
        y: Math.round(from.y + (to.y - from.y) * at),
        button: 'left',
        buttons: 1,
      })
      await pause(16)
    }
    await this.#input('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      clickCount: 1,
      buttons: 1,
    })
    await pause(INPUT_SETTLE_MS)
  }

  async hoverAt(x: number, y: number): Promise<void> {
    this.#attachDebugger()
    await this.#input('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await pause(INPUT_SETTLE_MS)
  }

  async #input(method: string, params: Record<string, unknown>): Promise<void> {
    await this.wc.debugger.sendCommand(method, params)
  }

  /**
   * Put files into a file input, through the browser rather than through the page.
   *
   * A file input's value cannot be set from script — that is a browser rule and
   * not a gap — so this is the one route there is, and it is also the only one
   * that works on the input these sites actually use: `display: none` behind a
   * styled button. Nothing on this path may ask for size, visibility or focus
   * for that reason. Because it is the browser placing the file, the page gets
   * its own `input` and `change` events and reacts as it would to a person
   * picking one, which is what a site listening for `change` needs.
   *
   * The node is resolved in the page and handed over as a remote object, not
   * looked up with `DOM.querySelector`: a `[ref_7]` names an entry in
   * `window.__abRefs`, which no CSS selector can reach.
   */
  async setFiles(selector: string, paths: string[], timeoutMs: number): Promise<{ name: string; size: number }[]> {
    await this.waitFor(selector, timeoutMs, false)
    const found = await this.call<{ tag: string; type: string; multiple: boolean } | null>(
      `(sel) => {
        const el = window.__abQuery(sel)
        if (!el) return null
        return { tag: el.tagName.toLowerCase(), type: String(el.type || '').toLowerCase(), multiple: !!el.multiple }
      }`,
      selector,
    )
    if (!found) throw new Error(this.#nothingMatched(selector, timeoutMs, false))
    if (found.tag !== 'input' || found.type !== 'file') {
      const what = found.tag === 'input' ? `an <input type=${found.type || 'text'}>` : `a <${found.tag}>`
      throw new Error(
        `${selector} is ${what}, not an input[type=file]. The file input is usually hidden next to the button ` +
          `that opens the picker: look for input[type=file] in the same form.`,
      )
    }
    if (paths.length > 1 && !found.multiple) {
      throw new Error(
        `${selector} takes one file at a time — it carries no multiple attribute, and ${paths.length} were given`,
      )
    }
    this.#attachDebugger()
    const handle = await this.wc.debugger.sendCommand('Runtime.evaluate', {
      expression: `(() => {${PAGE_HELPERS}
        return window.__abQuery(${JSON.stringify(selector)})
      })()`,
    }) as { result?: { objectId?: string } }
    const objectId = handle.result?.objectId
    if (!objectId) throw new Error(`${selector} was there a moment ago and is not now — take a fresh snapshot`)
    try {
      await this.wc.debugger.sendCommand('DOM.setFileInputFiles', { objectId, files: paths })
    } finally {
      await this.wc.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined)
    }
    // What the input holds now, read back from the page: evidence the files
    // arrived, in the page's own terms rather than ours.
    return await this.call<{ name: string; size: number }[]>(
      `(sel) => [...(window.__abQuery(sel)?.files ?? [])].map((f) => ({ name: f.name, size: f.size }))`,
      selector,
    )
  }

  async focus(selector: string, timeoutMs: number): Promise<void> {
    await this.waitFor(selector, timeoutMs, false)
    const ok = await this.call<boolean>(
      `(sel) => { const el = window.__abQuery(sel); if (!el) return false; el.focus(); return document.activeElement === el }`,
      selector,
    )
    if (ok) return
    try {
      // Some controls only take focus from a real click.
      const point = await this.centerOf(selector, timeoutMs)
      await this.clickAt(point.x, point.y)
    } catch (error) {
      // The field a rich editor replaces cannot be focused or clicked: it is
      // there for the form to submit and nothing else. The message that lands
      // here named the cause, which is why the agent that first met this could
      // act at all, so it is kept whole and the way through is added to it.
      throw await this.#editorRouteFor(selector, error)
    }
  }

  /**
   * The editor drawn over a field, and the call that reaches it.
   *
   * A page that hides a `textarea` and draws an editor over it leaves the agent
   * with a field it cannot write to and no way to know there is anywhere else
   * to write — the message for a hidden field with an editor over it used to be
   * the same sentence, word for word, as for a hidden field with nothing there.
   * Naming the route rather than typing into it on the agent's behalf is
   * deliberate: an editor keeps its own model of the document, and a value put
   * into the wrong layer of it is submitted as something nobody saw. That is a
   * failure that looks like success, which is the one kind this surface must
   * not add.
   *
   * The candidate has to FOLLOW the field: an editor replaces the field it is
   * built from and is inserted after it, and without that rule any hidden field
   * in a form with an editor somewhere gets pointed at that editor.
   */
  async #editorRouteFor(selector: string, failure: unknown): Promise<unknown> {
    // A diagnostic that throws would replace the real failure with its own,
    // which is worse than not answering: the message it was about to improve is
    // the one the agent needs.
    const found = await this.#editorNear(selector).catch(() => null)
    if (!found) return failure
    const message = failure instanceof Error ? failure.message : String(failure)
    const route = found.kind === 'frame' ? this.#frameRoute(found) : this.#pageRoute(found)
    return new Error(
      `${message}. A rich editor is drawn over it: ${route} It is the editor that keeps ${selector} in step, so read ` +
        `${selector} back afterwards to be sure it did.`,
    )
  }

  #editorNear(selector: string) {
    return this.call<
      { kind: 'frame' | 'page'; selector: string | null; src: string; position: number } | null
    >(
      `(sel) => {
        const el = window.__abQuery(sel)
        if (!el) return null
        const scope = el.closest('form') || el.parentElement || document.body
        const drawn = (node) => {
          const box = node.getBoundingClientRect()
          return box.width > 0 && box.height > 0
        }
        const editableIn = (doc) => {
          if (!doc) return null
          if (doc.designMode === 'on') return 'body'
          if (doc.body && doc.body.isContentEditable) return 'body'
          return doc.querySelector('[contenteditable=""], [contenteditable="true"]') ? '[contenteditable]' : null
        }
        // The one selector that names this node and nothing else, or nothing.
        const only = (candidate, node) => {
          if (!candidate) return null
          try {
            const all = document.querySelectorAll(candidate)
            return all.length === 1 && all[0] === node ? candidate : null
          } catch { return null }
        }
        const iframes = [...document.querySelectorAll('iframe, frame')]
        for (const node of scope.querySelectorAll('iframe, frame, [contenteditable=""], [contenteditable="true"]')) {
          const follows = el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING
          if (!follows || node.contains(el) || !drawn(node)) continue
          if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
            let inside = null
            // A frame from another site answers nothing, and an editor nobody
            // can look into is not a route worth naming.
            try { inside = editableIn(node.contentDocument) } catch { inside = null }
            if (!inside) continue
            return { kind: 'frame', selector: inside, src: node.src || '', position: iframes.indexOf(node) }
          }
          return {
            kind: 'page',
            selector: only(node.id ? '#' + CSS.escape(node.id) : null, node) || only('[contenteditable]', node),
            src: '',
            position: -1,
          }
        }
        return null
      }`,
      selector,
    )
  }

  #frameRoute(found: { selector: string | null; src: string; position: number }): string {
    // The page counts its iframes in document order and `frames()` lists them
    // in the order they appear too, which is the same correspondence `#offsetOf`
    // relies on. An address is unambiguous where there is one; a frame a script
    // built has none, and only its index reaches it.
    const list = this.frames()
    const byUrl = found.src ? list.find((one) => one.url === found.src) : undefined
    const byPosition = list[found.position]
    // A frame inside a frame is in `frames()` and not in the page's own count,
    // so the two orders can part company. An index is only named when the frame
    // it lands on is the addressless one the page reported.
    const frame = byUrl ??
      (byPosition && !found.src && (byPosition.url === 'about:blank' || byPosition.url === '') ? byPosition : undefined)
    if (!frame) return `write into the frame it is in — api.frames() lists them, and {frame: index} reaches one.`
    const handle = frame.url && frame.url !== 'about:blank' ? `'${frame.url}'` : String(frame.index)
    return `write into that instead, with fill('${found.selector}', value, {frame: ${handle}}).`
  }

  #pageRoute(found: { selector: string | null }): string {
    if (!found.selector) {
      return `it is a contenteditable element in this same document — snapshot() the form for its [ref_N] and fill that.`
    }
    return `write into that instead, with fill('${found.selector}', value).`
  }

  /**
   * Wait until the page has actually painted since it was loaded.
   *
   * Input sent before the first frame is composited is accepted and dropped:
   * the click leaves, nothing receives it, and the page looks like it ignored
   * it. Two animation frames is the first moment the page's own pixels exist.
   */
  async #awaitFirstPaint(): Promise<void> {
    if (this.#painted) return
    this.#painted = true
    try {
      // Capped on purpose: a page whose window is not on screen may never run
      // an animation frame at all, and waiting for one that never comes would
      // hang every click instead of the one it was meant to save.
      await Promise.race([
        this.wc.executeJavaScript(
          'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(1))))',
          true,
        ),
        pause(FIRST_PAINT_WAIT_MS),
      ])
    } catch {
      // A page that went away mid-wait needs no frame.
    }
  }

  /** Insert text into whatever holds focus, as an input event the page cannot tell from typing. */
  async insertText(text: string): Promise<void> {
    this.#attachDebugger()
    await this.#awaitFirstPaint()
    await this.#input('Input.insertText', { text })
    await pause(INPUT_SETTLE_MS)
  }

  async pressKey(key: string, modifiers: string[] = []): Promise<void> {
    this.#attachDebugger()
    await this.#awaitFirstPaint()
    const known = KEYS[key]
    const modifierMask = modifiers.reduce((mask, name) => mask | (MODIFIERS[name.toLowerCase()] ?? 0), 0)
    const base = {
      modifiers: modifierMask,
      windowsVirtualKeyCode: known?.code ?? key.toUpperCase().charCodeAt(0),
      key: known?.key ?? key,
      code: known?.dom ?? `Key${key.toUpperCase()}`,
    }
    // A key that produces a character needs `text` on the keyDown, or the page
    // sees the key arrive and no character with it.
    const text = known?.text ?? (!known && key.length === 1 && modifierMask === 0 ? key : undefined)
    await this.#input('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(text ? { text, unmodifiedText: text } : {}),
    })
    await this.#input('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await pause(INPUT_SETTLE_MS)
  }

  async selectAll(): Promise<void> {
    await this.call(`() => {
      const el = document.activeElement
      if (!el) return false
      if (typeof el.select === 'function') { el.select(); return true }
      if (el.isContentEditable) {
        const range = document.createRange()
        range.selectNodeContents(el)
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        return true
      }
      return false
    }`)
    await pause(INPUT_SETTLE_MS)
  }

  async scrollBy(dx: number, dy: number): Promise<void> {
    await this.call(`(x, y) => window.scrollBy(x, y)`, dx, dy)
  }

  async scrollTo(x: number, y: number): Promise<void> {
    await this.call(`(x, y) => window.scrollTo(x, y)`, x, y)
  }

  // -------------------------------------------------------------------- waiting

  /**
   * An agent that reads "no element matched" goes hunting through its selector,
   * so the message has to rule out the two things that are not the selector: a
   * page that is not the one the agent thinks it is on, and a `ref_N` taken
   * from a snapshot the page has since replaced. Three agents in a row lost
   * several calls each to exactly this, on markup that was correct.
   */
  #nothingMatched(selector: string, timeoutMs: number, visible: boolean): string {
    const where = `the page here is ${this.wc.getURL()} ("${this.wc.getTitle()}")`
    if (REF_SELECTOR.test(selector)) {
      return `${selector} is not on this page: ${where}. A ref belongs to the snapshot() that produced it and dies when the page changes — take a fresh snapshot and use its refs.`
    }
    return `no ${visible ? 'visible ' : ''}element matched ${selector} within ${timeoutMs}ms; ${where}`
  }

  async waitFor(selector: string, timeoutMs: number, visible: boolean): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = await this.call<boolean>(
        `(sel, mustBeVisible) => {
          const el = window.__abQuery(sel)
          if (!el) return false
          if (!mustBeVisible) return true
          const r = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        }`,
        selector,
        visible,
      )
      if (found) return true
      if (Date.now() >= deadline) {
        throw new Error(this.#nothingMatched(selector, timeoutMs, visible))
      }
      await pause(50)
    }
  }

  // ------------------------------------------------------------------- capture

  /**
   * The window spends most of its life hidden in the menu bar, and Chromium
   * refuses `capturePage` for a view it is not compositing — an agent asking
   * for a picture got "Current display surface not available for capture"
   * instead. The debugger paints its own copy and does not care whether
   * anybody is looking.
   */
  async screenshot(path: string): Promise<string> {
    this.#attachDebugger()
    const shot = await this.wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    }) as { data: string }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.from(shot.data, 'base64'))
    return path
  }

  captureConsole(on: boolean): void {
    this.#consoleCapturing = on
    if (on) this.console.length = 0
  }

  get consoleCapturing(): boolean {
    return this.#consoleCapturing
  }

  recordConsole(entry: ConsoleEntry): void {
    if (!this.#consoleCapturing) return
    this.console.push(entry)
    if (this.console.length > 2_000) this.console.splice(0, this.console.length - 2_000)
  }

  setDialogRule(rule: DialogRule | null): void {
    this.#dialogRule = rule
  }

  #wireDialogs(): void {
    // A page's own `beforeunload` prompt would otherwise block an agent forever
    // with nobody there to click it.
    this.wc.on('will-prevent-unload', (event) => {
      if (this.#dialogRule?.action === 'accept') event.preventDefault()
    })
  }

  /**
   * `alert`, `confirm` and `prompt` are handled through the DevTools protocol
   * rather than by overriding them in the page: an override is visible to the
   * page and is lost on every navigation, while this is neither.
   */
  async enableDialogs(): Promise<void> {
    if (this.#dialogsEnabled) return
    this.#attachDebugger()
    await this.wc.debugger.sendCommand('Page.enable')
    this.#dialogsEnabled = true
  }

  get dialogRule(): DialogRule | null {
    return this.#dialogRule
  }

  // ------------------------------------------------------------------- network

  async captureNetwork(on: boolean): Promise<void> {
    if (on === this.#networkCapturing) return
    this.#networkCapturing = on
    if (on) {
      this.#attachDebugger()
      this.network.clear()
      await this.wc.debugger.sendCommand('Network.enable')
    } else if (this.#debuggerAttached) {
      await this.wc.debugger.sendCommand('Network.disable').catch(() => undefined)
    }
  }

  get networkCapturing(): boolean {
    return this.#networkCapturing
  }

  async responseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    this.#attachDebugger()
    // A body exists only once the response has finished arriving, and a request
    // shows up in the log before that. Asking a moment too early answers "no
    // data found", which reads as a lost body rather than an unfinished one —
    // so wait for it, and only then say it is gone.
    const deadline = Date.now() + 3_000
    for (;;) {
      try {
        return (await this.wc.debugger.sendCommand('Network.getResponseBody', { requestId })) as {
          body: string
          base64Encoded: boolean
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/No data found/i.test(message) || Date.now() > deadline) throw error
        await pause(100)
      }
    }
  }

  #attachDebugger(): void {
    if (this.#debuggerAttached) return
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3')
    this.#debuggerAttached = true
    this.wc.debugger.on(
      'message',
      (_event, method, params) => this.#onDebuggerMessage(method, params as Record<string, unknown>),
    )
    // The window an agent works in is not the window the person is using, so
    // it holds no keyboard focus — and Chromium drops key events aimed at a
    // widget that is not focused. Mouse events arrive either way, which is why
    // clicking worked while typing silently did nothing. This tells the page to
    // consider itself focused without taking the screen from anybody.
    void this.wc.debugger
      .sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      .catch(() => undefined)
  }

  #detachDebugger(): void {
    if (!this.#debuggerAttached) return
    this.#debuggerAttached = false
    try {
      if (this.wc.debugger.isAttached()) this.wc.debugger.detach()
    } catch {
      // The page may already be gone; nothing to detach from.
    }
  }

  #onDebuggerMessage(method: string, params: Record<string, unknown>): void {
    if (method === 'Page.javascriptDialogOpening') {
      const rule = this.#dialogRule ?? { action: 'dismiss' as const }
      this.dialogs.push({
        type: String(params.type ?? 'alert'),
        message: String(params.message ?? ''),
        at: Date.now(),
        handled: rule.action,
      })
      void this.wc.debugger
        .sendCommand('Page.handleJavaScriptDialog', {
          accept: rule.action === 'accept',
          promptText: rule.promptText ?? '',
        })
        .catch(() => undefined)
      return
    }
    if (!this.#networkCapturing) return
    if (method === 'Network.requestWillBeSent') {
      const request = params.request as { url: string; method: string }
      this.network.set(String(params.requestId), {
        requestId: String(params.requestId),
        method: request.method,
        url: request.url,
        resourceType: String(params.type ?? 'Other'),
        status: null,
        mimeType: null,
        at: Date.now(),
        finishedAt: null,
        failed: null,
      })
      if (this.network.size > 1_000) {
        const oldest = this.network.keys().next().value
        if (oldest) this.network.delete(oldest)
      }
    } else if (method === 'Network.responseReceived') {
      const entry = this.network.get(String(params.requestId))
      const response = params.response as { status: number; mimeType: string }
      if (entry) {
        entry.status = response.status
        entry.mimeType = response.mimeType
      }
    } else if (method === 'Network.loadingFinished') {
      const entry = this.network.get(String(params.requestId))
      if (entry) entry.finishedAt = Date.now()
    } else if (method === 'Network.loadingFailed') {
      const entry = this.network.get(String(params.requestId))
      if (entry) entry.failed = String(params.errorText ?? 'failed')
    }
  }
}

/** The few keys worth naming; anything else is treated as a printable character. */
// `text` matters: Chromium turns a key event into a character — and a form
// submit — only when the keyDown carries one. Enter without it arrives as a key
// nobody typed, and a search form silently does nothing.
const KEYS: Record<string, { code: number; key: string; dom: string; text?: string }> = {
  Enter: { code: 13, key: 'Enter', dom: 'Enter', text: '\r' },
  Tab: { code: 9, key: 'Tab', dom: 'Tab', text: '\t' },
  Escape: { code: 27, key: 'Escape', dom: 'Escape' },
  Backspace: { code: 8, key: 'Backspace', dom: 'Backspace' },
  Delete: { code: 46, key: 'Delete', dom: 'Delete' },
  ArrowUp: { code: 38, key: 'ArrowUp', dom: 'ArrowUp' },
  ArrowDown: { code: 40, key: 'ArrowDown', dom: 'ArrowDown' },
  ArrowLeft: { code: 37, key: 'ArrowLeft', dom: 'ArrowLeft' },
  ArrowRight: { code: 39, key: 'ArrowRight', dom: 'ArrowRight' },
  Home: { code: 36, key: 'Home', dom: 'Home' },
  End: { code: 35, key: 'End', dom: 'End' },
  PageUp: { code: 33, key: 'PageUp', dom: 'PageUp' },
  PageDown: { code: 34, key: 'PageDown', dom: 'PageDown' },
  Space: { code: 32, key: ' ', dom: 'Space', text: ' ' },
}

const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 }

/** Poll `ready` until it answers true, or the time runs out. */
async function waitUntil(ready: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (ready()) return true
    await pause(25)
  }
  return ready()
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `example.com` is what a person types and what an agent tends to pass. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
