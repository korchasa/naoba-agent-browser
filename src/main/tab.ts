import { WebContentsView } from 'electron'
import type { Session, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { toTransferable } from './serialize.ts'

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

const INPUT_SETTLE_MS = 16

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
  readonly console: ConsoleEntry[] = []
  readonly network = new Map<string, NetworkEntry>()

  /** Resolves when the tab has a document to talk to. */
  #ready: Promise<void> = Promise.resolve()
  #consoleCapturing = false
  #networkCapturing = false
  #dialogRule: DialogRule | null = null
  #debuggerAttached = false
  #dialogsEnabled = false
  #destroyed = false
  readonly dialogs: { type: string; message: string; at: number; handled: 'accept' | 'dismiss' }[] = []

  constructor(session: Session, preload: string) {
    this.view = new WebContentsView({
      webPreferences: {
        session,
        preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        // Every tab of a project shares one session, so a login done by hand in
        // one tab is available to the agent in the next one.
      },
    })
    this.#wireDialogs()
  }

  get wc(): WebContents {
    return this.view.webContents
  }

  get destroyed(): boolean {
    return this.#destroyed || this.wc.isDestroyed()
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

  async navigate(url: string): Promise<void> {
    await this.#ready
    const target = normalizeUrl(url)
    try {
      await this.wc.loadURL(target)
    } catch (error) {
      // ERR_ABORTED is raised by a redirect, by a page that replaces its own
      // load, and by a download — none of which is a failed navigation. What
      // matters is where the tab ended up.
      const code = (error as { errno?: number }).errno
      if (code !== -3) throw error
      await this.waitForLoad()
    }
  }

  async goBack(): Promise<boolean> {
    if (!this.wc.navigationHistory.canGoBack()) return false
    this.wc.navigationHistory.goBack()
    await this.waitForLoad()
    return true
  }

  async goForward(): Promise<boolean> {
    if (!this.wc.navigationHistory.canGoForward()) return false
    this.wc.navigationHistory.goForward()
    await this.waitForLoad()
    return true
  }

  async reload(): Promise<void> {
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

  // ------------------------------------------------------------------ scripting

  /** Run an expression in the page's own world and bring the value back JSON-safe. */
  async js<T = unknown>(expression: string): Promise<T> {
    const value = await this.wc.executeJavaScript(expression, true)
    return toTransferable(value) as T
  }

  /** Run a function body in the page with arguments, without string-splicing the caller's data in. */
  async call<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
    const payload = JSON.stringify(args)
    // `__abQuery` is defined on every call rather than injected once, because a
    // single-page application replaces the document without ever reloading, and
    // a helper installed at load time quietly disappears with it. A `ref_N`
    // comes from the last snapshot and resolves against the list it left behind.
    const wrapped = `(async () => {
      window.__abQuery = (sel) => {
        if (sel === null || sel === undefined) return null
        if (typeof sel !== 'string') return sel
        if (/^ref_\\d+$/.test(sel)) return (window.__abRefs || [])[Number(sel.slice(4))] || null
        return document.querySelector(sel)
      }
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
    const rect = await this.call<{ x: number; y: number; w: number; h: number; matches: number; visible: number } | null>(
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
          const all = [...document.querySelectorAll(sel)]
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
    return { x: (rect.x + rect.w / 2) * zoom, y: (rect.y + rect.h / 2) * zoom }
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
    const common = { x, y, button, clickCount, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4 }
    await this.#input('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await this.#input('Input.dispatchMouseEvent', { type: 'mousePressed', ...common })
    await this.#input('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common })
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

  async focus(selector: string, timeoutMs: number): Promise<void> {
    await this.waitFor(selector, timeoutMs, false)
    const ok = await this.call<boolean>(
      `(sel) => { const el = window.__abQuery(sel); if (!el) return false; el.focus(); return document.activeElement === el }`,
      selector,
    )
    if (!ok) {
      // Some controls only take focus from a real click.
      const point = await this.centerOf(selector, timeoutMs)
      await this.clickAt(point.x, point.y)
    }
  }

  /** Insert text into whatever holds focus, as an input event the page cannot tell from typing. */
  async insertText(text: string): Promise<void> {
    this.#attachDebugger()
    await this.#input('Input.insertText', { text })
    await pause(INPUT_SETTLE_MS)
  }

  async pressKey(key: string, modifiers: string[] = []): Promise<void> {
    this.#attachDebugger()
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
        throw new Error(`no ${visible ? 'visible ' : ''}element matched ${selector} within ${timeoutMs}ms`)
      }
      await pause(50)
    }
  }

  // ------------------------------------------------------------------- capture

  async screenshot(): Promise<string> {
    const image = await this.wc.capturePage()
    return image.toPNG().toString('base64')
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
    const result = (await this.wc.debugger.sendCommand('Network.getResponseBody', { requestId })) as {
      body: string
      base64Encoded: boolean
    }
    return result
  }

  #attachDebugger(): void {
    if (this.#debuggerAttached) return
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3')
    this.#debuggerAttached = true
    this.wc.debugger.on('message', (_event, method, params) => this.#onDebuggerMessage(method, params as Record<string, unknown>))
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

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `example.com` is what a person types and what an agent tends to pass. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
