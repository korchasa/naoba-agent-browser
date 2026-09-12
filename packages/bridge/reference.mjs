/**
 * The manual, in one place, because it is read in two.
 *
 * The bridge builds the `evalInBrowser` description from it, and the
 * application answers `api.help()` from it. Neither can reach the other: the
 * bridge is a standalone package an IDE launches on its own, and the app is a
 * bundle that does not carry it — so whatever the bridge needs has to live
 * inside `packages/bridge/`, and the app imports this one module and lets
 * esbuild bundle it. Two copies of this text would drift the first time a
 * helper was added.
 *
 * The description is a budget, not a manual: the client cuts it at about 2040
 * characters and appends "… [truncated]", which is how the whole second half of
 * this reference reached nobody until 2026-09-12. Everything new goes into
 * MANUAL; the description only points at it.
 */

/** What an agent gets before it can ask for anything: the shape of a scenario,
 * the way to read the rest, and the few helpers that save a round trip. */
export const TOOL_DESCRIPTION = `Run a browser scenario in this project's window and get the result. Write
JavaScript: \`api\` is in scope, top-level await works, and whatever you return
comes back to you. Put the whole flow in one call — navigate, act, read, return.

This is the short form. The rest is one call away:
  api.help()                         every helper, with its arguments
  api.help('click')                  one of them
  Object.keys(api)                   the bare list of names

Enough to start
  api.navigate(url)                  goes, waits for the load, returns the URL
  api.snapshot(selector?)            a readable tree of the page; every clickable
                                     node carries a [ref_N] you can pass anywhere
                                     a selector is taken — the way to work with
                                     generated class names
  api.getText(selector?)             visible text, whole page by default
  api.click(sel) / api.fill(sel, value) / api.type(sel, text)
                                     real input events: the page sees isTrusted
  api.waitFor(sel, {timeout, visible}) / api.waitForLoad({timeout})
  api.waitForUrl('/checkout/')       where a submit ends up, rather than a guess
  api.sleep(ms)                      rather than a setTimeout you guessed at
  api.requestHuman(reason)           hand the tab to the person and wait — a
                                     login, a payment, a captcha, anything you
                                     must not do yourself
  {frame} on any call above reaches inside an iframe; api.frames() lists them

Tabs, cookies, storage, screenshots, console and network capture, dialogs and
the other agents here: api.help(). Sites stay logged in between runs.`

const PREAMBLE = `Write JavaScript. \`api\` is in scope, top-level await works, and whatever you
return comes back to you. One call should carry the whole scenario.`

/**
 * Laid out for a reader, and parsed for one helper at a time: a section is a
 * line at column 0, an entry a line indented by two, and anything deeper
 * belongs to the entry above it.
 */
const MANUAL = `Finding things
  api.snapshot(selector?)            a readable tree of the page; every clickable
                                     node carries a [ref_N] you can pass anywhere
                                     a selector is taken — the way to work with
                                     generated class names
  api.getText(selector?)             visible text, whole page by default
  api.attr(selector, name)           one attribute
  api.eval(expression)               run an expression in the page and get the value
  api.getTitle() / api.getUrl() / api.getSelectedText()
  api.help(name?)                    this reference, or one helper's entry

Acting (real input events — the page sees isTrusted: true)
  api.click(sel, {timeout}) / api.dblclick(sel) / api.rightClick(sel)
  api.fill(sel, value)               replaces the field's contents
  api.type(sel, text)                appends, the way typing does
  api.select(sel, value)             a <select>
  api.setFiles(sel, path | paths)    a file into an input[type=file] — the hidden
                                     one behind a "choose a photo" button too,
                                     which is the one thing fill cannot do. Reads
                                     only files inside this project's directory:
                                     copy anything else in first
  api.check(sel) / api.uncheck(sel)
  api.hover(sel) / api.press(key, modifiers) / api.scrollTo(x, y) / api.scrollBy(dx, dy)
  api.drag(from, to, {steps})        press, move, release — a canvas, a slider, a
                                     sortable list. Either end is a selector, a
                                     [ref_N], or a point {x, y}
  api.waitFor(sel, {timeout, visible})

Frames
  api.frames()                       the frames inside the page: index, url, name
  every call above takes {frame}     an index from frames(), or any part of a
                                     frame's address or name. A payment form, an
                                     embedded editor and a documentation sandbox
                                     each live in a frame, and a selector run
                                     against the page never sees inside one:
                                     api.click('#pay', {frame: 'stripe'})

Moving around
  api.navigate(url)                  goes, waits for the load, and returns the
                                     final URL — no pause of your own afterwards
  api.goBack() / api.goForward() / api.reload()
  api.waitForLoad({timeout})         the load something else started, a form
                                     submit or a link, rather than a guessed pause
  api.waitForUrl(pattern, {timeout}) where the page ends up, and gives that URL
                                     back. A substring or a regular expression —
                                     waitForUrl('/checkout/'),
                                     waitForUrl(/orders\\/\\d+$/). A move that
                                     loads nothing counts, which is how a
                                     single-page form ends; a frame moving on its
                                     own does not
  api.getTabs() / api.newTab(url) / api.selectTab(indexOrId) / api.closeTab(indexOrId?)
  api.currentTab()                   the tab your calls act on; each agent gets
                                     its own, so this is the id to pass another
                                     agent when you want to share one

State
  api.getCookies(filter) / api.setCookie(details) / api.deleteCookie(url, name)
  api.clearStorage()
  api.screenshot(path?)              writes a PNG and returns its path. With no
                                     path it goes to a temporary file the system
                                     clears on its own — read it, and copy it
                                     out if it is worth keeping. A path you name
                                     has to be inside the project, the same
                                     boundary setFiles reads within
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
                                     You get back {url, title, seconds, visited,
                                     visitedCount}: every move the page made
                                     while they held it, as {at, kind, url},
                                     newest 20. Read it — a person often does
                                     more than you asked. A timeout throws, and
                                     carries the same record on the error.
  api.agents()                       who else is working in this project
  api.project()                      which project this browser belongs to
  api.sleep(ms)                      a pause when nothing else will do; every
                                     wait above beats it

Notes
  A scenario that fails keeps the work before it: the error carries the api
  calls that already ran, what each one answered, and the one that failed. So
  write the long scenario rather than a timid one. What comes back is a record
  of what was done, not a checkpoint — those steps already happened, and
  running the scenario again runs them a second time.
  Sites stay logged in between runs, per project. If something needs an account,
  call requestHuman rather than trying to log in.
  Agents in other projects share nothing with you: not tabs, not cookies, not logins.`

const SECTIONS = parse(MANUAL)

function parse(text) {
  const sections = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    if (!line.startsWith(' ')) {
      sections.push({ title: line, entries: [] })
      continue
    }
    const section = sections[sections.length - 1]
    if (!section) continue
    const entries = section.entries
    // Deeper than an entry's own indent, so it is the tail of the one above.
    if (line.startsWith('   ') && entries.length > 0) {
      entries[entries.length - 1].lines.push(line)
      continue
    }
    entries.push({ names: namesIn(line), lines: [line] })
  }
  return sections
}

/**
 * Only the entry's first line is read for names, so the example inside the
 * Frames paragraph does not claim to be the entry for `click`.
 */
export function namesIn(line) {
  return [...line.matchAll(/\bapi\.([a-zA-Z0-9_$]+)/g)].map((match) => match[1])
}

export function fullReference() {
  return `${PREAMBLE}\n\n${MANUAL}`
}

/** Once each: one line can name three helpers, and the drift test compares keys. */
export function documentedNames() {
  const names = new Set()
  for (const section of SECTIONS) {
    for (const entry of section.entries) {
      for (const name of entry.names) names.add(name)
    }
  }
  return [...names]
}

/**
 * One helper's entry, under its section so the reader sees what it sits among.
 * An agent writes the name the way it would call it, so `api.click(sel)`,
 * `click()` and `click` all have to answer.
 */
export function helpFor(name) {
  const asked = String(name ?? '').trim().replace(/^api\./, '').replace(/\(.*$/, '').trim()
  if (asked === '') return fullReference()
  const wanted = asked.toLowerCase()
  for (const section of SECTIONS) {
    const entries = section.entries
    for (let index = 0; index < entries.length; index++) {
      if (!entries[index].names.some((known) => known.toLowerCase() === wanted)) continue
      // The paragraphs a section ends with name no helper and belong to the
      // ones above them: the {frame} rule is the whole point of Frames, and an
      // agent stuck on an iframe asks for `frames`.
      const lines = [...entries[index].lines]
      for (let after = index + 1; after < entries.length && entries[after].names.length === 0; after++) {
        lines.push(...entries[after].lines)
      }
      return `${section.title}\n${lines.join('\n')}`
    }
  }
  return `there is no api.${asked}. What there is:\n  ${documentedNames().join(', ')}\n\n` +
    'api.help() prints all of it, with the arguments.'
}
