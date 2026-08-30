/**
 * What the agent sees. The description of `evalInBrowser` is the whole manual:
 * an agent that has to guess the helper names will round-trip once per guess,
 * which is exactly the cost this tool exists to avoid.
 */
const API_REFERENCE = `
Write JavaScript. \`api\` is in scope, top-level await works, and whatever you
return comes back to you. One call should carry the whole scenario.

Finding things
  api.snapshot(selector?)            a readable tree of the page; every clickable
                                     node carries a [ref_N] you can pass anywhere
                                     a selector is taken — the way to work with
                                     generated class names
  api.getText(selector?)             visible text, whole page by default
  api.attr(selector, name)           one attribute
  api.eval(expression)               run an expression in the page and get the value
  api.getTitle() / api.getUrl() / api.getSelectedText()

Acting (real input events — the page sees isTrusted: true)
  api.click(sel, {timeout})          also dblclick, rightClick
  api.fill(sel, value)               replaces the field's contents
  api.type(sel, text)                appends, the way typing does
  api.select(sel, value)             a <select>
  api.check(sel) / api.uncheck(sel)
  api.hover(sel) / api.press(key, modifiers) / api.scrollTo(x, y) / api.scrollBy(dx, dy)
  api.waitFor(sel, {timeout, visible})

Moving around
  api.navigate(url) / api.goBack() / api.goForward() / api.reload() / api.waitForLoad()
  api.getTabs() / api.newTab(url?) / api.selectTab(indexOrId) / api.closeTab(indexOrId?)
  api.currentTab()                   the tab your calls act on; each agent gets
                                     its own, so this is the id to pass another
                                     agent when you want to share one

State
  api.getCookies(filter) / api.setCookie(details) / api.deleteCookie(url, name)
  api.clearStorage()
  api.screenshot()                   base64 PNG
  api.resize(width, height)

Watching
  api.captureConsole(true) then api.getConsoleLogs()
  api.captureNetwork(true) then api.getNetworkLog({url, status})
  api.getResponseBody(requestId)     only until that tab navigates away
  api.interceptDialog('accept'|'dismiss', promptText?)

Working next to other agents and next to the person
  api.claimTab({timeout, reason})    hold the tab across several calls
  api.releaseTab()
  api.requestHuman(reason, {timeout}) hand the tab over and wait — use this for a
                                     login, a payment, a captcha, anything you
                                     must not do yourself. The window comes
                                     forward with your reason on it, and your
                                     call resumes when the person marks it done.
  api.agents()                       who else is working in this project
  api.project()                      which project this browser belongs to
  api.sleep(ms)

Notes
  Sites stay logged in between runs, per project. If something needs an account,
  call requestHuman rather than trying to log in.
  Agents in other projects share nothing with you: not tabs, not cookies, not logins.
`.trim()

export const TOOLS = [
  {
    name: 'evalInBrowser',
    description:
      'Run a browser scenario in this project\'s window and get the result. ' +
      'Put the whole flow in one call — navigate, act, read, return.\n\n' +
      API_REFERENCE,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript to run, with `api` in scope. Top-level await works; return what you need.',
        },
        timeout: {
          type: 'number',
          description: 'Milliseconds the whole scenario may take. Default 60000.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'status',
    description:
      'What this project\'s browser looks like right now: the tabs and their state, the agents connected to it, ' +
      'and which of them is you.',
    inputSchema: { type: 'object', properties: {} },
  },
]
