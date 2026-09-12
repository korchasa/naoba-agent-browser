import type { AgentHandle, ProjectContext } from './context.ts'
import type { ProjectIdentity } from './project.ts'
import { type FileBoundary, resolveUploadPaths, resolveWritePath } from './files.ts'
import type { Tab } from './tab.ts'
import { pause } from './tab.ts'
import type { Holder } from './lease.ts'
import { describeVisits, VisitLog } from './visits.ts'
import { fullReference, helpFor } from '../../packages/bridge/reference.mjs'
import { app } from 'electron'
import { join } from 'node:path'

export interface ApiOptions {
  timeout?: number
  visible?: boolean
  /** How many moves a drag is broken into; more is smoother, and slower. */
  steps?: number
  /**
   * Work inside one of the page's frames instead of the page: an index from
   * `frames()`, or any part of the frame's address or name. A payment form, an
   * embedded editor and a documentation sandbox are all frames, and a selector
   * run against the page never sees inside them.
   */
  frame?: string | number
}

/** A place on the page, in CSS pixels from the top-left of the view. */
export interface Point {
  x: number
  y: number
}

/** How a drag end reads in the activity log. */
function label(what: string | Point): string {
  return typeof what === 'string' ? what : `${what.x},${what.y}`
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

  const guard = async <T>(what: string, run: (tab: Tab) => Promise<T>, options?: ApiOptions): Promise<T> => {
    const target = tab()
    await target.whenReady()
    await hooks.waitForTab(target.id)
    context.touch()
    const result = await target.withFrame(options?.frame, () => run(target))
    log(options?.frame === undefined ? what : `${what} in frame ${options.frame}`)
    return result
  }

  return {
    // ------------------------------------------------------------------ DOM

    async waitFor(selector: string, options?: ApiOptions) {
      return guard(
        `waitFor(${selector})`,
        (tab) => tab.waitFor(selector, t(options), options?.visible ?? false),
        options,
      )
    },

    async click(selector: string, options?: ApiOptions) {
      return guard(`click(${selector})`, async (tab) => {
        const point = await tab.clickPointFor(selector, t(options))
        await tab.clickAt(point.x, point.y)
        return true
      }, options)
    },

    async dblclick(selector: string, options?: ApiOptions) {
      return guard(`dblclick(${selector})`, async (tab) => {
        const point = await tab.clickPointFor(selector, t(options))
        await tab.clickAt(point.x, point.y, 2)
        return true
      }, options)
    },

    async rightClick(selector: string, options?: ApiOptions) {
      return guard(`rightClick(${selector})`, async (tab) => {
        const point = await tab.clickPointFor(selector, t(options))
        await tab.clickAt(point.x, point.y, 1, 'right')
        return true
      }, options)
    },

    /** Append text, the way typing does. */
    async type(selector: string, text: string, options?: ApiOptions) {
      return guard(`type(${selector})`, async (tab) => {
        await tab.focus(selector, t(options))
        await tab.insertText(text)
        return true
      }, options)
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
      }, options)
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
      }, options)
    },

    /**
     * Put a local file into a file input — including the hidden one behind a
     * styled "choose a photo" button, which is exactly what `fill` and `click`
     * cannot reach: a file input's value is not settable from script, and the
     * click path refuses a zero-size element.
     *
     * Only files inside this project are read; see `UploadBoundary` in
     * `files.ts` for why, and what an agent is told instead.
     */
    async setFiles(selector: string, paths: string | string[], options?: ApiOptions) {
      if (options?.frame !== undefined) {
        throw new Error(
          'setFiles does not reach inside a frame yet: the input it takes has to be in the page itself',
        )
      }
      const files = await resolveUploadPaths(Array.isArray(paths) ? paths : [paths], fileBoundary(context.identity))
      const many = files.length === 1 ? '1 file' : `${files.length} files`
      // No `options` for guard: the frame it would enter is refused above.
      return guard(`setFiles(${selector}, ${many})`, (tab) => tab.setFiles(selector, files, t(options)))
    },

    async check(selector: string, options?: ApiOptions) {
      return guard(`check(${selector})`, (tab) => setChecked(tab, selector, true, t(options)), options)
    },

    async uncheck(selector: string, options?: ApiOptions) {
      return guard(`uncheck(${selector})`, (tab) => setChecked(tab, selector, false, t(options)), options)
    },

    /**
     * Drag from one place to another. Either end may be a selector, a snapshot
     * ref, or a point — a canvas takes points, a sortable list takes selectors.
     */
    async drag(from: string | Point, to: string | Point, options?: ApiOptions) {
      return guard(`drag(${label(from)} → ${label(to)})`, async (tab) => {
        const start = typeof from === 'string' ? await tab.clickPointFor(from, t(options)) : from
        const end = typeof to === 'string' ? await tab.centerOf(to, t(options)) : to
        await tab.dragFromTo(start, end, options?.steps ?? 12)
        return true
      }, options)
    },

    async hover(selector: string, options?: ApiOptions) {
      return guard(`hover(${selector})`, async (tab) => {
        const point = await tab.clickPointFor(selector, t(options))
        await tab.hoverAt(point.x, point.y)
        return true
      }, options)
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
      }, options)
    },

    async getText(selector?: string, options?: ApiOptions) {
      return guard(`getText(${selector ?? 'body'})`, (tab) =>
        tab.call<string>(
          `(sel) => { const el = sel ? window.__abQuery(sel) : document.body; return el ? el.innerText : '' }`,
          selector ?? null,
        ), options)
    },

    /** The frames inside this page: their index, address and name. */
    async frames() {
      return guard('frames()', (tab) => Promise.resolve(tab.frames()))
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

    async eval(expression: string, options?: ApiOptions) {
      return guard('eval()', (tab) => tab.js(expression), options)
    },

    async attr(selector: string, name: string, options?: ApiOptions) {
      return guard(`attr(${selector}, ${name})`, (tab) =>
        tab.call<string | null>(
          `(sel, name) => { const el = window.__abQuery(sel); return el ? el.getAttribute(name) : null }`,
          selector,
          name,
        ), options)
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
      }, options)
    },

    /**
     * Wait for where the page ends up, rather than for a pause long enough to
     * cover it. The pattern is a substring or a regular expression, and an
     * in-page move counts — a single-page form never loads again.
     */
    async waitForUrl(pattern: string | RegExp, options?: ApiOptions) {
      // A regular expression prints as it was written, a substring as itself:
      // the activity log shows what the agent asked for, not a sentence about it.
      return guard(`waitForUrl(${String(pattern)})`, (tab) => tab.waitForUrl(pattern, options?.timeout ?? 30_000))
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

    async newTab(url: string) {
      context.touch()
      if (typeof url !== 'string' || url.trim() === '') {
        throw new Error(
          'newTab needs the address of the page to open, as in newTab("https://example.com"). ' +
            'A tab with nothing in it is not something an agent can work with.',
        )
      }
      // An agent is given a tab before its script runs, so the queue has
      // something to key on. When the script's first act is `newTab`, that tab
      // is still empty and untouched — use it rather than leaving it behind for
      // the rest of the session.
      const current = agent.currentTabId ? context.tab(agent.currentTabId) : null
      // A tab created a moment ago has committed no document yet, so its URL is
      // the empty string rather than `about:blank` — check for both, or the
      // reuse silently never happens.
      const parked = current ? current.wc.getURL() : null
      const spare = current && !current.destroyed && (parked === '' || parked === 'about:blank') &&
        !context.leases.holderOf(current.id)
      const created = spare ? current : context.openTab(url, agent.id)
      // Navigating a blank tab to `about:blank` is a move to where it already
      // is, which Chromium aborts with ERR_FAILED rather than treating as done.
      if (spare && parked !== url && url !== 'about:blank') await created.navigate(url)
      agent.currentTabId = created.id
      log(`newTab(${url})`)
      await created.waitForLoad()
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

    /**
     * The picture goes to a file and the agent gets its path. A PNG of a real
     * page is a couple of hundred kilobytes of base64 — more than the wire
     * carries in one value, and more than any agent wants to read as text.
     */
    async screenshot(path?: string) {
      const target = path === undefined
        ? defaultShotPath(context.identity.name)
        : await resolveWritePath(path, fileBoundary(context.identity))
      return guard(`screenshot() to ${target}`, (tab) => tab.screenshot(target))
    },

    async resize(width: number, height: number) {
      context.touch()
      const window = context.shell.window()
      window.setContentSize(Math.round(width), Math.round(height) + 96)
      context.shell.layout()
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
      if (typeof requestId !== 'string' || requestId === '') {
        throw new Error('getResponseBody needs a requestId from getNetworkLog — the log may still be empty')
      }
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

      // Everything the page does from here until the person is finished is the
      // account the agent gets back. `did-navigate` is the main frame's alone,
      // `did-navigate-in-page` is not — an advertisement calling `pushState` is
      // not something the person did, so the flag is read rather than trusted.
      const walk = new VisitLog(Date.now())
      const onNavigate = (_event: unknown, url: string) => walk.add('navigate', url, Date.now())
      const onInPage = (_event: unknown, url: string, isMainFrame: boolean) => {
        if (isMainFrame) walk.add('in-page', url, Date.now())
      }
      target.wc.on('did-navigate', onNavigate)
      target.wc.on('did-navigate-in-page', onInPage)

      context.leases.takeOver(target.id, { kind: 'human' })
      context.selectTab(target.id)
      log(`requestHuman(${reason})`)

      let outcome: 'done' | 'cancelled' | 'timeout'
      try {
        outcome = await new Promise<'done' | 'cancelled' | 'timeout'>((resolve) => {
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
      } finally {
        // Every exit passes here, including the two that throw; a listener left
        // on the tab would keep recording for the next person who holds it.
        if (!target.destroyed) {
          target.wc.off('did-navigate', onNavigate)
          target.wc.off('did-navigate-in-page', onInPage)
        }
      }

      const account = { url: target.url, title: target.title, ...walk.report(Date.now()) }

      if (outcome === 'timeout') {
        // The account matters most here: nobody pressed the button, and the
        // agent has to decide whether the wait was wasted or the person got
        // halfway. `runner.ts` rebuilds a thrown error and keeps only the
        // message, the stack, the logs and `code`, so the one line goes in the
        // message and the list rides on the object for a scenario that catches.
        const pointer = account.visitedCount > 0 ? ' — the steps are on this error as .visited' : ''
        throw Object.assign(
          new Error(`nobody finished "${reason}" in time; ${describeVisits(account, account.url)}${pointer}`),
          { code: 'timeout', ...account },
        )
      }
      if (outcome === 'cancelled') {
        // Unreachable while anybody is listening: the only producer of this
        // outcome is `ProjectContext.removeAgent`, which resolves the pending
        // requests of an agent that has already disconnected. It carries the
        // account anyway, because the day it gets a second producer the caller
        // will be alive to read it.
        throw Object.assign(
          new Error(`the request "${reason}" was cancelled; ${describeVisits(account, account.url)}`),
          { code: 'taken-over', ...account },
        )
      }
      context.leases.release(target.id, { kind: 'human' })
      context.broadcast({ type: 'human-done', tabId: target.id })
      return account
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

    /**
     * The manual. The tool description reaches an agent unasked and the client
     * cuts it at about 2040 characters, so only a summary fits there; this is
     * where the rest of it lives. One text, in `packages/bridge/reference.mjs`,
     * because a second copy would drift at the next helper.
     */
    help(name?: string): string {
      return name === undefined ? fullReference() : helpFor(name)
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
  const point = await tab.clickPointFor(selector, timeout)
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

/**
 * Where a picture goes when the agent named no path: the system's temporary
 * directory, under one folder of ours.
 *
 * A screenshot is working material — an agent takes one, reads it, and is done
 * with it — and the path comes back from the call, so nothing has to be found
 * later. Keeping them instead is what the old default did, and what it produced
 * was 30 forgotten files nobody ever opened. The system clears this directory
 * on its own, which is the whole point; a picture somebody wants to keep is
 * copied out by the agent's own tools, where the person is asked.
 *
 * The project's name goes in the filename so the path reads as something when
 * an agent shows it to a person, and a timestamp sorts them.
 */
function defaultShotPath(projectName: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = projectName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  return join(app.getPath('temp'), 'naoba', `${name}-${stamp}.png`)
}

/**
 * What `setFiles` may read and `screenshot` may write: the project's own
 * directory, and nothing else. The temporary directory above is not in it on
 * purpose — only the default writes there, and a path an agent names has to be
 * somewhere the person would look.
 */
function fileBoundary(identity: ProjectIdentity): FileBoundary {
  return {
    roots: [identity.root],
    describe: identity.root,
  }
}
