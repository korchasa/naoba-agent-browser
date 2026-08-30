import type { ProjectContext, AgentHandle } from './context.ts'
import type { Tab } from './tab.ts'
import { pause } from './tab.ts'
import type { Holder } from './lease.ts'

export interface ApiOptions {
  timeout?: number
  visible?: boolean
}

const DEFAULT_TIMEOUT = 5_000

/**
 * The object an agent's script runs against.
 *
 * Names and shapes follow FoxCode's `browser-api.js` deliberately: a scenario
 * written for FoxCode has to run here unchanged, or the migration is a rewrite
 * and nobody does it. Everything past `getConsoleLogs` is new — the network
 * log, the tab lease, and asking the person for help.
 */
export interface ApiHooks {
  /** Blocks until nobody else is holding the tab, or explains who is. */
  waitForTab(tabId: string): Promise<void>
}

export function buildApi(context: ProjectContext, agent: AgentHandle, log: (text: string) => void, hooks: ApiHooks) {
  const holder: Holder = { kind: 'agent', id: agent.id, label: agent.label }
  const tab = (): Tab => context.tabFor(agent)
  const t = (options?: ApiOptions) => options?.timeout ?? DEFAULT_TIMEOUT

  const guard = async <T>(what: string, run: (tab: Tab) => Promise<T>): Promise<T> => {
    const target = tab()
    await target.whenReady()
    await hooks.waitForTab(target.id)
    context.touch()
    const result = await run(target)
    log(what)
    return result
  }

  return {
    // ------------------------------------------------------------------ DOM

    async waitFor(selector: string, options?: ApiOptions) {
      return guard(`waitFor(${selector})`, (tab) => tab.waitFor(selector, t(options), options?.visible ?? false))
    },

    async click(selector: string, options?: ApiOptions) {
      return guard(`click(${selector})`, async (tab) => {
        const point = await tab.centerOf(selector, t(options))
        await tab.clickAt(point.x, point.y)
        return true
      })
    },

    async dblclick(selector: string, options?: ApiOptions) {
      return guard(`dblclick(${selector})`, async (tab) => {
        const point = await tab.centerOf(selector, t(options))
        await tab.clickAt(point.x, point.y, 2)
        return true
      })
    },

    async rightClick(selector: string, options?: ApiOptions) {
      return guard(`rightClick(${selector})`, async (tab) => {
        const point = await tab.centerOf(selector, t(options))
        await tab.clickAt(point.x, point.y, 1, 'right')
        return true
      })
    },

    /** Append text, the way typing does. */
    async type(selector: string, text: string, options?: ApiOptions) {
      return guard(`type(${selector})`, async (tab) => {
        await tab.focus(selector, t(options))
        await tab.insertText(text)
        return true
      })
    },

    /** Replace the field's contents. */
    async fill(selector: string, value: string, options?: ApiOptions) {
      return guard(`fill(${selector})`, async (tab) => {
        await tab.focus(selector, t(options))
        await tab.selectAll()
        if (value === '') {
          await tab.pressKey('Delete')
        } else {
          await tab.insertText(value)
        }
        return true
      })
    },

    async select(selector: string, value: string, options?: ApiOptions) {
      return guard(`select(${selector})`, async (tab) => {
        await tab.waitFor(selector, t(options), false)
        return tab.call<boolean>(
          `(sel, val) => {
            const el = window.__abQuery(sel)
            if (!el) return false
            el.value = val
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return el.value === val
          }`,
          selector,
          value,
        )
      })
    },

    async check(selector: string, options?: ApiOptions) {
      return guard(`check(${selector})`, (tab) => setChecked(tab, selector, true, t(options)))
    },

    async uncheck(selector: string, options?: ApiOptions) {
      return guard(`uncheck(${selector})`, (tab) => setChecked(tab, selector, false, t(options)))
    },

    async hover(selector: string, options?: ApiOptions) {
      return guard(`hover(${selector})`, async (tab) => {
        const point = await tab.centerOf(selector, t(options))
        await tab.hoverAt(point.x, point.y)
        return true
      })
    },

    async press(key: string, modifiers: string[] = []) {
      return guard(`press(${key})`, async (tab) => {
        await tab.pressKey(key, modifiers)
        return true
      })
    },

    async scrollTo(x: number, y: number) {
      return guard(`scrollTo(${x}, ${y})`, async (tab) => {
        await tab.scrollTo(x, y)
        return true
      })
    },

    async scrollBy(dx: number, dy: number) {
      return guard(`scrollBy(${dx}, ${dy})`, async (tab) => {
        await tab.scrollBy(dx, dy)
        return true
      })
    },

    // ---------------------------------------------------------------- reading

    /**
     * A compact tree of what is on the page and what can be interacted with.
     * Every interactive node carries a `ref_N` that every other helper accepts
     * in place of a CSS selector, which is what makes a page with generated
     * class names workable at all.
     */
    async snapshot(selector?: string, options?: ApiOptions) {
      return guard(`snapshot(${selector ?? 'document'})`, async (tab) => {
        if (selector) await tab.waitFor(selector, t(options), false)
        return tab.call<string>(SNAPSHOT_FN, selector ?? null)
      })
    },

    async getText(selector?: string) {
      return guard(`getText(${selector ?? 'body'})`, (tab) =>
        tab.call<string>(
          `(sel) => { const el = sel ? window.__abQuery(sel) : document.body; return el ? el.innerText : '' }`,
          selector ?? null,
        ))
    },

    async getTitle() {
      return guard('getTitle()', async (tab) => tab.title)
    },

    async getUrl() {
      return guard('getUrl()', async (tab) => tab.url)
    },

    async getSelectedText() {
      return guard('getSelectedText()', (tab) => tab.call<string>(`() => String(window.getSelection() ?? '')`))
    },

    async eval(expression: string) {
      return guard('eval()', (tab) => tab.js(expression))
    },

    async attr(selector: string, name: string) {
      return guard(`attr(${selector}, ${name})`, (tab) =>
        tab.call<string | null>(
          `(sel, name) => { const el = window.__abQuery(sel); return el ? el.getAttribute(name) : null }`,
          selector,
          name,
        ))
    },

    // ------------------------------------------------------------- navigation

    async navigate(url: string) {
      return guard(`navigate(${url})`, async (tab) => {
        await tab.navigate(url)
        return tab.url
      })
    },

    async goBack() {
      return guard('goBack()', (tab) => tab.goBack())
    },

    async goForward() {
      return guard('goForward()', (tab) => tab.goForward())
    },

    async reload() {
      return guard('reload()', async (tab) => {
        await tab.reload()
        return true
      })
    },

    async waitForLoad(options?: ApiOptions) {
      return guard('waitForLoad()', async (tab) => {
        await tab.waitForLoad(options?.timeout ?? 30_000)
        return true
      })
    },

    // ------------------------------------------------------------------- tabs

    async getTabs() {
      context.touch()
      return context.describeTabs()
    },

    /** The tab this agent's calls act on — the one to hand another agent when sharing. */
    async currentTab() {
      context.touch()
      return context.describeTab(tab())
    },

    async newTab(url?: string) {
      context.touch()
      const created = context.openTab(url)
      agent.currentTabId = created.id
      log(`newTab(${url ?? 'blank'})`)
      if (url) await created.waitForLoad()
      return context.describeTab(created)
    },

    async closeTab(which?: number | string) {
      context.touch()
      const target = resolveTab(context, which) ?? tab()
      const closed = context.closeTab(target.id)
      log(`closeTab(${target.id})`)
      return closed
    },

    async selectTab(which: number | string) {
      context.touch()
      const target = resolveTab(context, which)
      if (!target) throw Object.assign(new Error(`no tab ${which}`), { code: 'no-tab' })
      context.selectTab(target.id)
      agent.currentTabId = target.id
      log(`selectTab(${target.id})`)
      return context.describeTab(target)
    },

    // ---------------------------------------------------------------- cookies

    async getCookies(filter: Record<string, unknown> = {}) {
      context.touch()
      return context.session.cookies.get(filter)
    },

    async setCookie(details: Record<string, unknown>) {
      context.touch()
      await context.session.cookies.set(details as never)
      log('setCookie()')
      return true
    },

    async deleteCookie(url: string, name: string) {
      context.touch()
      await context.session.cookies.remove(url, name)
      log('deleteCookie()')
      return true
    },

    async clearStorage() {
      context.touch()
      await context.session.clearStorageData()
      log('clearStorage()')
      return true
    },

    // ---------------------------------------------------------------- capture

    async screenshot() {
      return guard('screenshot()', (tab) => tab.screenshot())
    },

    async resize(width: number, height: number) {
      context.touch()
      const window = context.window()
      window.setContentSize(Math.round(width), Math.round(height) + 96)
      context.layout()
      await pause(120)
      log(`resize(${width}, ${height})`)
      return true
    },

    async captureConsole(on = true) {
      return guard(`captureConsole(${on})`, async (tab) => {
        tab.captureConsole(on)
        return true
      })
    },

    async getConsoleLogs() {
      return guard('getConsoleLogs()', async (tab) => [...tab.console])
    },

    async interceptDialog(action: 'accept' | 'dismiss', promptText?: string) {
      return guard(`interceptDialog(${action})`, async (tab) => {
        await tab.enableDialogs()
        tab.setDialogRule({ action, promptText })
        return true
      })
    },

    // ---------------------------------------------------------------- network

    async captureNetwork(on = true) {
      return guard(`captureNetwork(${on})`, async (tab) => {
        await tab.captureNetwork(on)
        return true
      })
    },

    async getNetworkLog(filter?: { url?: string; status?: number }) {
      return guard('getNetworkLog()', async (tab) => {
        let entries = [...tab.network.values()]
        if (filter?.url) entries = entries.filter((entry) => entry.url.includes(filter.url!))
        if (filter?.status !== undefined) entries = entries.filter((entry) => entry.status === filter.status)
        return entries
      })
    },

    /**
     * Response bodies live in the page's own buffer, so they survive only until
     * that tab navigates away. Saying so beats letting the protocol's "no
     * resource with given identifier" reach an agent that has no way to know
     * what it means.
     */
    async getResponseBody(requestId: string) {
      return guard('getResponseBody()', async (tab) => {
        try {
          return await tab.responseBody(requestId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (/no resource with given identifier/i.test(message)) {
            throw Object.assign(
              new Error(
                `the body of ${requestId} is gone; a response body is only readable until its tab navigates, so read it before the next navigate()`,
              ),
              { code: 'no-tab' },
            )
          }
          throw error
        }
      })
    },

    // -------------------------------------------------- coordination & people

    /** Hold the current tab across several calls, so another agent cannot step in. */
    async claimTab(options?: { timeout?: number; reason?: string }) {
      const target = tab()
      const outcome = context.leases.claim(target.id, holder, options?.timeout ?? 120_000, options?.reason ?? null)
      if (!outcome.ok) {
        throw Object.assign(new Error(`tab is held by ${describeHolder(outcome.heldBy)}`), { code: 'tab-held' })
      }
      log('claimTab()')
      return context.describeTab(target)
    },

    async releaseTab() {
      const target = tab()
      const released = context.leases.release(target.id, holder)
      log('releaseTab()')
      return released
    },

    /**
     * Hand the tab to the person and wait. This is the call that closes the
     * product's main story: agents cannot log into sites, people can, and
     * without this an agent meeting a login form can only fail.
     */
    async requestHuman(reason: string, options?: { timeout?: number }) {
      const target = tab()
      context.touch()
      // The one call that is allowed to interrupt the person, because it is the
      // one that needs them.
      context.bringToFront()
      context.leases.takeOver(target.id, { kind: 'human' })
      context.selectTab(target.id)
      log(`requestHuman(${reason})`)

      const outcome = await new Promise<'done' | 'cancelled' | 'timeout'>((resolve) => {
        const timer = setTimeout(() => {
          context.pendingHuman.delete(target.id)
          context.notifyTabs()
          resolve('timeout')
        }, options?.timeout ?? 10 * 60_000)

        context.pendingHuman.set(target.id, {
          tabId: target.id,
          reason,
          agentId: agent.id,
          resolve: (result) => {
            clearTimeout(timer)
            context.pendingHuman.delete(target.id)
            resolve(result)
          },
        })
        context.broadcast({ type: 'human-requested', tabId: target.id, reason })
        context.notifyTabs()
      })

      if (outcome === 'timeout') {
        throw Object.assign(new Error(`nobody finished "${reason}" in time`), { code: 'timeout' })
      }
      if (outcome === 'cancelled') {
        throw Object.assign(new Error(`the request "${reason}" was cancelled`), { code: 'taken-over' })
      }
      context.leases.release(target.id, { kind: 'human' })
      context.broadcast({ type: 'human-done', tabId: target.id })
      return { url: target.url, title: target.title }
    },

    /** Who else is working in this project right now. */
    async agents() {
      return [...context.agents.values()].map((other) => ({
        id: other.id,
        label: other.label,
        ide: other.descriptor.ide,
        self: other.id === agent.id,
        tabId: other.currentTabId,
      }))
    },

    async project() {
      return { id: context.identity.id, name: context.identity.name, root: context.identity.root }
    },

    sleep: pause,
  }
}

export type AgentApi = ReturnType<typeof buildApi>

function describeHolder(holder: Holder): string {
  return holder.kind === 'human' ? 'the person at the keyboard' : holder.label
}

function resolveTab(context: ProjectContext, which?: number | string): Tab | null {
  if (which === undefined) return null
  if (typeof which === 'number') return context.tabs[which] ?? null
  return context.tab(which) ?? context.tabs[Number(which)] ?? null
}

async function setChecked(tab: Tab, selector: string, wanted: boolean, timeout: number): Promise<boolean> {
  await tab.waitFor(selector, timeout, false)
  const already = await tab.call<boolean | null>(
    `(sel) => { const el = window.__abQuery(sel); return el ? !!el.checked : null }`,
    selector,
  )
  if (already === null) throw new Error(`no element matches ${selector}`)
  if (already === wanted) return true
  const point = await tab.centerOf(selector, timeout)
  await tab.clickAt(point.x, point.y)
  return await tab.call<boolean>(`(sel) => !!window.__abQuery(sel)?.checked`, selector) === wanted
}

/**
 * Snapshot renders the page the way an agent reads it: structure, text, and a
 * stable handle per interactive element. Kept in one string so the whole thing
 * crosses the wire as a single value.
 */
const SNAPSHOT_FN = `(rootSel) => {
  const root = rootSel ? window.__abQuery(rootSel) : document.body
  if (!root) return ''
  const refs = []
  window.__abRefs = refs
  const interactive = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'LABEL'])
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'HEAD'])
  const lines = []

  const visible = (el) => {
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const label = (el) => {
    const own = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim()
    if (own) return own
    const text = (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ')
    return text.length > 120 ? text.slice(0, 120) + '…' : text
  }
  const walk = (el, depth) => {
    if (depth > 24 || skip.has(el.tagName)) return
    if (!visible(el)) return
    const role = el.getAttribute('role') || el.tagName.toLowerCase()
    const isInteractive = interactive.has(el.tagName) || el.hasAttribute('onclick') || el.getAttribute('role') === 'button'
    if (isInteractive) {
      refs.push(el)
      const ref = 'ref_' + (refs.length - 1)
      const type = el.getAttribute('type') ? ' type=' + el.getAttribute('type') : ''
      lines.push('  '.repeat(depth) + role + type + ' "' + label(el) + '" [' + ref + ']')
    } else {
      const direct = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\\s+/g, ' ')
      if (direct) lines.push('  '.repeat(depth) + (direct.length > 200 ? direct.slice(0, 200) + '…' : direct))
    }
    for (const child of el.children) walk(child, depth + 1)
  }
  walk(root, 0)
  return lines.join('\\n')
}`
