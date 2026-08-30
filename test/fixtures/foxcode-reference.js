/**
 * A FoxCode scenario, run here unchanged.
 *
 * Every call below is one FoxCode's `browser-api.js` provides, in the shapes
 * its README and its own helpers use — `navigate` then `getTitle`, waits with
 * `{ timeout }`, `fill`/`type` by selector, `getCookies` with a filter object,
 * `captureConsole` before `getConsoleLogs`. If this file needs an edit to run,
 * the compatibility promise is broken and the migration is a rewrite.
 *
 * The fixture origin is substituted for __ORIGIN__ by the test.
 */
await api.navigate('__ORIGIN__/page.html')
const title = await api.getTitle()

await api.waitFor('#go', { timeout: 3000 })
await api.click('#go')
const trusted = await api.getText('#trusted')

await api.fill('#field', 'from foxcode')
await api.type('#field', ' plus more')
const fieldValue = await api.eval('document.getElementById("field").value')

await api.check('#check')
await api.select('#picker', 'b')
await api.hover('#heading')
await api.scrollBy(0, 50)
const scrolled = await api.eval('window.scrollY')
await api.scrollTo(0, 0)

await api.captureConsole()
await api.eval('console.log("scenario running")')
await api.sleep(100)
const logs = await api.getConsoleLogs()

const cookiesBefore = await api.getCookies({})
await api.setCookie({ url: '__ORIGIN__', name: 'foxcode', value: 'was-here' })
const cookiesAfter = await api.getCookies({ name: 'foxcode' })

const tabs = await api.getTabs()
await api.newTab('__ORIGIN__/second.html')
await api.waitForLoad()
const secondTitle = await api.getTitle()
await api.closeTab()

const snapshot = await api.snapshot()
const shot = await api.screenshot()

return {
  title,
  trusted,
  fieldValue,
  scrolled,
  logged: logs.some((entry) => entry.message.includes('scenario running')),
  cookieCountGrew: cookiesAfter.length > 0 && cookiesBefore.length <= cookiesAfter.length + 1,
  cookieValue: cookiesAfter[0] && cookiesAfter[0].value,
  tabsBefore: tabs.length,
  secondTitle,
  snapshotHasRefs: snapshot.includes('[ref_0]'),
  screenshotBytes: shot.length,
}
