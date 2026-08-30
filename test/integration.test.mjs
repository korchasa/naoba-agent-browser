import { strict as assert } from 'node:assert'
import { after, before, test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nextPort, startApp } from './helpers/app.mjs'
import { startFixtureServer } from './fixtures/server.mjs'

const here = dirname(fileURLToPath(import.meta.url))

let app
let fixture
let origin

before(async () => {
  fixture = await startFixtureServer()
  origin = fixture.origin
  app = await startApp({ port: 8951 })
})

after(async () => {
  await app?.stop()
  fixture?.server.close()
})

const PROJECT_A = '/tmp/agent-browser-tests/project-a'
const PROJECT_B = '/tmp/agent-browser-tests/project-b'

test('input reaches the page as a real event, not a synthetic one', async () => {
  const agent = await app.agent(PROJECT_A, 'trust')
  const outcome = await agent.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    await api.click('#go')
    return await api.getText('#trusted')
  `)
  // This is the capability an extension cannot have, and half the reason the
  // product is an application at all.
  assert.equal(outcome.value, 'isTrusted=true')
  agent.close()
})

test('the browser does not announce itself as an automated client', async () => {
  const agent = await app.agent(PROJECT_A, 'ua')
  const outcome = await agent.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    return await api.eval('navigator.userAgent')
  `)
  // Cloudflare's sign-in page refused to run its own verification widget while
  // the user agent carried these two words, and the person could not sign in at
  // all. What is underneath is Chromium, and that is what it must say.
  assert.doesNotMatch(outcome.value, /Electron/)
  assert.doesNotMatch(outcome.value, /agent-browser/)
  assert.match(outcome.value, /Chrome\/\d+/)
  agent.close()
})

test('a screenshot reaches the agent as a file, even with no window on screen', async () => {
  const agent = await app.agent(PROJECT_A, 'shot')
  const target = join(await mkdtemp(join(tmpdir(), 'agent-browser-shot-')), 'page.png')
  const outcome = await agent.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    return await api.screenshot(${JSON.stringify(target)})
  `)
  assert.equal(outcome.value, target)
  // A real page is a couple of hundred kilobytes of base64, which the wire
  // truncates and no agent wants to read; and Chromium refuses capturePage for
  // a window nobody is looking at, which is how this browser normally runs.
  const bytes = await readFile(target)
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
  assert.ok(bytes.length > 1000, `the picture is only ${bytes.length} bytes`)
  agent.close()
})

test('a click lands on the right element when the page is zoomed', async () => {
  const agent = await app.agent(PROJECT_A, 'zoom')
  const outcome = await agent.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    await api.eval('document.body.style.zoom = "1.5"')
    await api.click('#zoomed')
    return await api.getText('#zoomhit')
  `)
  assert.equal(outcome.value, 'yes')
  agent.close()
})

test('pressing Enter in a field submits the form, the way a person searching would', async () => {
  // Enter without a character attached arrives as a key nobody typed: Chromium
  // raises no keypress and the form stays where it is. Two real search engines
  // were failing on exactly this until the key started carrying its own text.
  const agent = await app.agent(PROJECT_A, 'enter-submits')
  const outcome = await agent.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    await api.type('#query', 'hello')
    await api.press('Enter')
    await api.waitForLoad()
    return { url: await api.getUrl(), heading: await api.getText('h1') }
  `)
  assert.match(outcome.value.url, /second\.html\?q=hello$/)
  assert.equal(outcome.value.heading, 'Second page')
  agent.close()
})

test('a drag is a press, a run of moves, and a release — not a click', async () => {
  // A canvas app or a sortable list follows the pointer. One jump from start to
  // finish reads to them as no movement at all.
  const agent = await app.agent(PROJECT_A, 'drag')
  const outcome = await agent.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    await api.drag('#drag-area', { x: 500, y: 200 })
    return await api.getText('#drag-report')
  `)
  assert.match(outcome.value, /^dragged -?\d+px in \d+ moves$/)
  assert.ok(Number(/in (\d+) moves/.exec(outcome.value)[1]) >= 5, outcome.value)
  agent.close()
})

test('a snapshot ref can be used wherever a selector can', async () => {
  const agent = await app.agent(PROJECT_A, 'refs')
  const outcome = await agent.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    const snapshot = await api.snapshot()
    const ref = /button "Press me" \\[(ref_\\d+)\\]/.exec(snapshot)[1]
    await api.click(ref)
    return { ref, trusted: await api.getText('#trusted') }
  `)
  assert.equal(outcome.value.trusted, 'isTrusted=true')
  agent.close()
})

test('a login survives the application being restarted, not just the tab being closed', async () => {
  // The session lives on disk, keyed to the project. Closing a window must not
  // take it, and neither must quitting: the person signs in once. The cookie
  // carries an expiry on purpose — a cookie without one is a session cookie,
  // and every browser is meant to drop those when it quits.
  const dir = await mkdtemp(join(tmpdir(), 'agent-browser-restart-'))
  const port = nextPort()
  const first = await startApp({ port, userDataDir: dir, keepState: true })
  const before = await first.agent(PROJECT_A, 'restart-before')
  await before.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    await api.eval('document.cookie = "session=alive; path=/; max-age=3600"; localStorage.setItem("who", "the person")')
  `)
  await first.stop()

  const second = await startApp({ port, userDataDir: dir, keepState: true })
  const after = await second.agent(PROJECT_A, 'restart-after')
  const outcome = await after.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    return await api.eval('({ cookie: document.cookie, who: localStorage.getItem("who") })')
  `)
  await second.stop()
  await rm(dir, { recursive: true, force: true })

  assert.match(outcome.value.cookie, /session=alive/)
  assert.equal(outcome.value.who, 'the person')
})

test('keys reach the page even though the window is not the one the person is using', async () => {
  // Chromium drops key events aimed at a widget that holds no focus, and the
  // window an agent works in never holds any. Mouse events arrive regardless,
  // so this failed as "typing does nothing while clicking works" — and only
  // outside headless, which is why the rest of the suite never saw it.
  const own = await startApp({ port: nextPort(), headless: false })
  const agent = await own.agent(PROJECT_A, 'keys-in-a-window')
  const outcome = await agent.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    await api.click('#field')
    await api.press('h')
    await api.press('i')
    return { value: await api.eval('document.getElementById("field").value'), title: await api.getTitle() }
  `)
  await own.stop()
  assert.equal(outcome.value.value, 'hi')
  assert.equal(outcome.value.title, 'Fixture: hi')
})

test('a frame is reachable: read it, type in it, click in it', async () => {
  // A page is often not one document — a payment form, an embedded editor, a
  // documentation sandbox each live in a frame, and a selector run against the
  // page never sees inside them.
  const agent = await app.agent(PROJECT_A, 'frames')
  const outcome = await agent.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    await api.waitFor('#inner')
    const frames = await api.frames()
    const inner = { frame: 'inner.html' }
    await api.type('#inner-field', 'typed inside', inner)
    await api.click('#inner-button', inner)
    return {
      frames: frames.map((f) => f.url.replace(${JSON.stringify(origin)}, '')),
      heading: await api.getText('#inner-heading', inner),
      field: await api.eval('document.getElementById("inner-field").value', inner),
      clicked: await api.getText('#inner-result', inner),
      outerStillWorks: await api.getText('#heading'),
    }
  `)
  assert.deepEqual(outcome.value.frames, ['/inner.html'])
  assert.equal(outcome.value.heading, 'Inside the frame')
  assert.equal(outcome.value.field, 'typed inside')
  assert.equal(outcome.value.clicked, 'clicked, isTrusted=true')
  assert.equal(outcome.value.outerStillWorks, 'Fixture page')
  agent.close()
})

test('two agents in one project share the same tabs', async () => {
  const one = await app.agent(PROJECT_A, 'shared-one')
  const two = await app.agent(PROJECT_A, 'shared-two')

  const opened = await one.run(`
    const tab = await api.newTab(${JSON.stringify(origin + '/second.html')})
    return tab.id
  `)
  const seen = await two.run(`return (await api.getTabs()).map((tab) => tab.id)`)

  assert.equal(one.project.id, two.project.id)
  assert.ok(seen.value.includes(opened.value), 'the second agent cannot see the tab the first one opened')
  one.close()
  two.close()
})

test('two projects share nothing: not cookies, not storage, not tabs', async () => {
  const a = await app.agent(PROJECT_A, 'iso-a')
  const b = await app.agent(PROJECT_B, 'iso-b')

  await a.run(`
    await api.navigate(${JSON.stringify(origin + '/set-cookie?v=only-in-a')})
    await api.eval('localStorage.setItem("secret", "a-only")')
    await api.newTab(${JSON.stringify(origin + '/second.html')})
  `)

  const inB = await b.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    return {
      cookies: (await api.getCookies({})).map((cookie) => cookie.name),
      storage: await api.eval('localStorage.getItem("secret")'),
      tabs: (await api.getTabs()).length,
      project: (await api.project()).name,
    }
  `)

  assert.notEqual(a.project.id, b.project.id)
  assert.deepEqual(inB.value.cookies, [], 'a cookie from another project is visible')
  assert.equal(inB.value.storage, null, 'storage from another project is visible')
  assert.equal(inB.value.tabs, 1, "another project's tabs are visible")
  a.close()
  b.close()
})

test('two agents typing into one field produce whole words, not interleaved letters', async () => {
  const one = await app.agent(PROJECT_A, 'alpha')
  const two = await app.agent(PROJECT_A, 'beta')

  const shared = await one.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    await api.eval('document.getElementById("field").value = ""')
    return (await api.currentTab()).id
  `)
  // Agents get their own tab by default, so sharing one is deliberate — which
  // is exactly the case this test is about.
  await two.run(`await api.selectTab(${JSON.stringify(shared.value)})`)

  const typeLetterByLetter = (word) => `
    for (const letter of ${JSON.stringify(word)}) {
      await api.type('#field', letter)
      await api.sleep(20)
    }
    return await api.eval('document.getElementById("field").value')
  `
  const outcomes = await Promise.all([one.run(typeLetterByLetter('alpha')), two.run(typeLetterByLetter('beta'))])

  const final = await one.run(`return await api.eval('document.getElementById("field").value')`)
  assert.ok(
    final.value === 'alphabeta' || final.value === 'betaalpha',
    `expected two whole words in queue order, got ${JSON.stringify(final.value)} after ${
      JSON.stringify(outcomes.map((outcome) => outcome.value))
    }`,
  )
  one.close()
  two.close()
})

test('a claimed tab keeps another agent out, and names who is holding it', async () => {
  const holder = await app.agent(PROJECT_A, 'holder')
  const other = await app.agent(PROJECT_A, 'other')

  const tabId = await holder.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    await api.claimTab({ timeout: 60000, reason: 'filling a form' })
    return (await api.getTabs()).find((tab) => tab.heldBy).id
  `)
  await other.run(`await api.selectTab(${JSON.stringify('TAB')})`.replace('TAB', tabId.value))

  await assert.rejects(
    other.run(`return await api.getTitle()`),
    (error) => error.code === 'tab-held' && /holder/.test(error.message),
  )

  await holder.run(`await api.releaseTab()`)
  const afterRelease = await other.run(`return await api.getTitle()`)
  assert.equal(typeof afterRelease.value, 'string')
  holder.close()
  other.close()
})

test('an agent that disconnects mid-lease lets go of the tab', async () => {
  const holder = await app.agent(PROJECT_A, 'leaver')
  const other = await app.agent(PROJECT_A, 'stayer')

  const held = await holder.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    await api.claimTab({ timeout: 60000 })
    return (await api.getTabs()).find((tab) => tab.heldBy).id
  `)
  await other.run(`await api.selectTab(${JSON.stringify('TAB')})`.replace('TAB', held.value))
  holder.close()
  await new Promise((resolve) => setTimeout(resolve, 500))

  const outcome = await other.run(`return await api.getTitle()`)
  assert.equal(outcome.value, 'Fixture')
  other.close()
})

test('an agent can hand a tab to the person and carry on afterwards', async () => {
  const agent = await app.agent(PROJECT_A, 'asker')
  const watcher = await app.agent(PROJECT_A, 'watcher')

  const asked = agent.run(
    `
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    const result = await api.requestHuman('log into the fixture', { timeout: 15000 })
    return result.title
  `,
    20_000,
  )

  // Wait for the other agent to be told, then do the person's part.
  await waitFor(() => watcher.events.some((event) => event.type === 'human-requested'), 5000)
  const request = watcher.events.find((event) => event.type === 'human-requested')
  assert.equal(request.reason, 'log into the fixture')

  const tabs = await watcher.run(`return (await api.getTabs()).filter((tab) => tab.waitingForHuman)`, 8000)
  assert.equal(tabs.value.length, 1)
  assert.equal(tabs.value[0].waitingForHuman, 'log into the fixture')

  await watcher.client.call('test:human-done', { tabId: request.tabId })
  const outcome = await asked
  assert.equal(outcome.value, 'Fixture')
  agent.close()
  watcher.close()
})

test('a FoxCode scenario runs unchanged', async () => {
  const agent = await app.agent(PROJECT_B, 'foxcode')
  const source = await readFile(join(here, 'fixtures/foxcode-reference.js'), 'utf8')
  const outcome = await agent.run(source.replaceAll('__ORIGIN__', origin), 40_000)

  const value = outcome.value
  assert.equal(value.title, 'Fixture')
  assert.equal(value.trusted, 'isTrusted=true')
  assert.equal(value.fieldValue, 'from foxcode plus more')
  assert.ok(value.scrolled >= 0)
  assert.equal(value.logged, true)
  assert.equal(value.cookieValue, 'was-here')
  assert.equal(value.secondTitle, 'Second')
  assert.equal(value.snapshotHasRefs, true)
  // The one place this browser deliberately parts company with FoxCode: a
  // picture comes back as a path, not as base64, because base64 of a real page
  // is too big for the wire and useless in an agent's context.
  const shot = await readFile(value.screenshotPath)
  assert.ok(shot.length > 1000, `the picture is only ${shot.length} bytes`)
  agent.close()
})

test('the network log carries requests and their bodies', async () => {
  const agent = await app.agent(PROJECT_B, 'network')
  const outcome = await agent.run(`
    await api.newTab()
    await api.captureNetwork(true)
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    await api.waitFor('#appeared', { timeout: 4000 })
    // The page asks for it on load, so the entry can arrive after the element.
    let log = []
    for (let tries = 0; tries < 20 && log.length === 0; tries++) {
      log = await api.getNetworkLog({ url: 'data.json' })
      if (log.length === 0) await api.sleep(150)
    }
    const last = log[log.length - 1]
    const body = await api.getResponseBody(last.requestId)
    return { status: last.status, body: body.body }
  `)
  assert.equal(outcome.value.status, 200)
  assert.match(outcome.value.body, /"ok":true/)
  agent.close()
})

test('dialogs are answered the way the agent asked', async () => {
  const agent = await app.agent(PROJECT_B, 'dialogs')
  const outcome = await agent.run(`
    await api.navigate(${JSON.stringify(origin + '/dialog')})
    await api.interceptDialog('accept')
    await api.click('#ask')
    await api.sleep(300)
    const accepted = await api.getTitle()
    await api.interceptDialog('dismiss')
    await api.click('#ask')
    await api.sleep(300)
    return { accepted, dismissed: await api.getTitle() }
  `)
  assert.equal(outcome.value.accepted, 'accepted')
  assert.equal(outcome.value.dismissed, 'dismissed')
  agent.close()
})

test('a failing script explains itself instead of returning nothing', async () => {
  const agent = await app.agent(PROJECT_B, 'failing')
  await assert.rejects(
    agent.run(`
      console.log('before the failure')
      await api.click('#nothing-matches-this', { timeout: 300 })
    `),
    (error) => {
      assert.match(error.message, /#nothing-matches-this/)
      assert.ok(error.details.logs.some((line) => line.includes('before the failure')))
      return true
    },
  )
  agent.close()
})

test('a login made by hand survives the tab being closed', async () => {
  const agent = await app.agent(PROJECT_A, 'session')
  await agent.run(`
    const tab = await api.newTab(${JSON.stringify(origin + '/set-cookie?v=persisted')})
    await api.waitForLoad()
    await api.closeTab()
  `)
  const outcome = await agent.run(`
    await api.navigate(${JSON.stringify(origin + '/page.html')})
    return (await api.getCookies({ name: 'fixture' })).map((cookie) => cookie.value)
  `)
  assert.ok(
    outcome.value.includes('persisted'),
    `expected the cookie to outlive the tab, got ${JSON.stringify(outcome.value)}`,
  )
  agent.close()
})

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('condition never became true')
}
