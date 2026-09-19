---
date: "2026-09-19"
status: done
implements: [FR-TAB-4]
tags: [agent-browser, naoba, navigation, boundary, agent-experience]
related_tasks:
  [a-password-prompt-that-never-appears, events-in-the-session-nobody-listens-to]
---
# An address in a scheme nobody here handles

## Goal

A link this browser cannot open itself does something sensible instead of
failing. The person gets the mail window they clicked for; the agent gets a
sentence saying what the link was and why the page did not move.

## Overview

An address in an unknown scheme fails the load. Measured on 2026-09-19:

```
loadURL('mailto:probe@example.com') → ERR_FAILED (-2)
```

Nothing is handed to the system. Nothing in `src/main` calls
`shell.openExternal`, registers a scheme, or listens for `open-url`, so every
scheme outside http, https, file and about ends the same way.

Two different things break on this, and they are worth separating.

The ordinary one is `mailto:` and `tel:` on a normal page. A person working in
the window clicks "write to us" and nothing happens at all — no mail window, no
message. That is a plain defect in the window.

The sharper one is a sign-in that hands off to an application on the machine.
Some providers, and a good deal of enterprise single sign-on, bounce the browser
into a scheme registered by a native client and expect to come back. Here the
bounce is a dead load, so the sign-in stops halfway, which puts this in the same
family as the popup bug that started this line of work.

This is also a boundary question, not only a feature. Opening a scheme hands an
address to whatever application the system has registered for it, chosen by a
page rather than by the person — so it is exactly the kind of move this
application asks about elsewhere rather than performing quietly.

### Affected Surface

The independent scout pass (`surface-scout`, dispatched with this task's Goal,
Overview and Definition of Done as its only input, 2026-09-19), verbatim:

```
## Surface

- `src/main/tab.ts:265-300` (`navigate()`) — the single entry point where `loadURL` fails today (`ERR_FAILED (-2)` for an unhandled scheme); this is the primary fix site by the request's own measurement, and it already contains the closely analogous `will-download`/`ERR_ABORTED` disambiguation logic the new scheme check would sit beside. Evidence: `await this.wc.loadURL(target)` at line 287, and the download-vs-failure handling in the surrounding `try/catch` (lines 288-303).
- `src/main/context.ts:231-249` (`setWindowOpenHandler`) — parallel implementation: a page handing off to a native app via `window.open()`/SSO popup instead of a same-tab navigation is the same "chosen by a page rather than the person" boundary case the request calls "the sharper one," and it currently always `action: 'allow'`s with no scheme check. Evidence: `tab.wc.setWindowOpenHandler(() =&gt; ({ action: 'allow', ...`.
- `src/main/permissions.ts:1-33` — parallel boundary-decision surface with the same shape the request asks for ("who decides ... the rule is the same for every project"): a pure, Electron-free function of "what a page may have," currently a blanket refusal with named exceptions documented inline. Evidence: `export function permitted(_permission: string): boolean { return false }` (lines 30-32) and the comment block above it describing the "named exception with its reason beside it" pattern.
- `src/main/downloads.ts:1-52` (`DownloadLog`) — parallel implementation of the same "agent-initiated vs. page-initiated" asymmetry the request's scheme rule needs ("which schemes go straight through, which ask, which are refused"); its `Claim`/`expect` mechanism is the existing template for distinguishing an agent's own `navigate()` from a page acting on its own. Evidence: class comment lines 39-51, `Claim` interface lines 32-36.
- `src/main/urls.ts:1-49` — not affected. Provides `matcherFor`/`describePattern` for `waitForUrl` pattern matching only; no scheme dispatch or navigation-failure handling. Evidence: file is entirely about `UrlPattern` matching for `waitForUrl`.
- `src/main/api.ts:276-279` (`navigate` command) — consumer that must be updated per DoD item "`api.navigate` to such an address answers with that same explanation instead of throwing `ERR_FAILED`." Evidence: `async navigate(url: string) { return guard(\`navigate(${url})\`, async (tab) =&gt; { await tab.navigate(url)`.
- `src/main/api.ts:568-589` (`requestHuman`) — candidate consumer/parallel mechanism for "hands it on" — the existing way the codebase already "asks" by surfacing a tab to the person; a scheme handoff to a mail client is a related but distinct case (no tab surfacing needed, since `mailto:`/`tel:` just need `shell.openExternal`). Evidence: `async requestHuman(reason: string, options?: { timeout?: number })` at line 568.
- `src/main/visits.ts:1-40` (`VisitLog`/`Visit`) — consumer-pattern precedent for DoD item "An agent can read from the tab that a link tried to leave for another application, and where it was going": this is the existing mechanism for exposing "what happened in a tab" to an agent, currently limited to `'navigate' | 'in-page'` kinds. Evidence: `export type VisitKind = 'navigate' | 'in-page'` (line 17), class comment lines 1-14 about `requestHuman`'s report of tab activity.
- `src/main/protocol.ts:37-50` (`TabDescriptor`) and `:117-127` (`AppEvent`) — consumer of navigation outcomes on the wire; has no field/event today for "a link tried to leave for another scheme," which DoD requires an agent to read. Evidence: `TabDescriptor` fields listed (id, index, title, url, active, loading, heldBy, waitingForHuman, askedBy, openedBy) with no external-scheme field; `AppEvent` union (lines 118-127) has `tab-navigated`, `human-requested`, etc., but nothing scheme-related.
- `src/main/reference.mjs:85-141` — agent-facing documentation that must describe the new behavior, directly parallel to how it already documents the download/`ERR_FAILED` disambiguation. Evidence: `api.navigate(url)` entry (line 94) and the `ERR_FAILED`-adjacent download note (lines 133-135: "navigate() to an address that turns out to be a file downloads it too, and stays on the page you were on").
- `src/main/tray.ts:158` — not affected. Its `loadURL` targets a `data:` URL for the tray's own generated HTML, unrelated to page-initiated navigation. Evidence: `await window.loadURL(\`data:text/html;charset=utf-8,${encodeURIComponent(html)}\`)`.
- `src/main/snapshot.ts:189` — not affected. Registers a `https` protocol handler for the snapshot/reference server, not for dispatching unknown external schemes. Evidence: `session.protocol.handle('https', (request) =&gt; {`.
- `AGENTS.md:363-368` — documentation that must be extended: it currently records the precise `ERR_FAILED (-2)` / `ERR_ABORTED` distinction for downloads that this request's scheme case parallels and partially reuses. Evidence: "an address that turns out to be a file raised `ERR_FAILED (-2)` when it was measured against GitHub's archive link on 2026-09-15."
- `AGENTS.md:188-200` — documentation of the existing permission-refusal boundary rule, the closest existing precedent for "who decides ... written down ... the rule is the same for every project" that DoD item 3 asks for. Evidence: `Notification.permission` / automation-override paragraph, lines 188-200.
- `documents/decisions/0001-chromium-inside-the-application.md` — likely needs a new decision record for the scheme-dispatch policy (which schemes pass, ask, or refuse), following this repo's existing ADR practice. Not read in full; flagged as candidate, not confirmed affected.
- `src/main/reference.mjs` / `src/main/tools.mjs` / `src/main/render.mjs` — the agent-facing help/tooling trio; `reference.mjs` confirmed affected (see above), `tools.mjs` and `render.mjs` not inspected for content, only grepped with no scheme/download hits beyond reference.mjs. Evidence: grep of all three for `navigate|download|mailto|tel:` returned hits only in `reference.mjs`.
- `test/integration.test.mjs:177-277` (download tests) and `:472-505` (`popup-opener`/`popup-closer` tests) — parallel/consumer tests establishing the pattern a new "external scheme" integration test (DoD item 6) should follow. Evidence: `test('an address that turns out to be a file is a download, not a failed navigation', ...)` (line 242); `test('...opener...')` block (line 472 onward, `sawOpener`).
- `test/fixtures/download.html` and `test/fixtures/opener.html` — parallel fixtures; a new fixture (e.g. a page with a `mailto:`/`tel:` link) is needed alongside these for the new integration test. Evidence: `download.html` full contents shown (link `href="/report.csv"`, blob-download button); `opener.html` referenced by the popup tests at `test/integration.test.mjs:475,478`.
- `test/fixtures/server.mjs:29-73` — not affected on its own, but is the static file server the new fixture would be served from; no scheme-specific routing exists today. Evidence: generic file-serving branch at lines 63-73, only a special-cased `/drip.html` route at line 29.
- `src/renderer/chrome.ts:191-223` (address bar) — consumer/parallel entry point: a person typing a `mailto:`/`tel:` address directly into the panel's address bar goes through the same `ab.navigate` IPC call as a page-initiated link click, so it's a second place the fix's user-facing behavior must hold. Evidence: `void ab.navigate(front.projectId, front.tab.id, value)` (line 223), `navigate(projectId: string, tabId: string, url: string): Promise&lt;boolean&gt;` (line 55).
- `src/renderer/tree.ts` — not affected as inspected: grep for url/status/failed/error found no matches; it appears to render only tab hierarchy, not per-visit outcome detail. Evidence: `grep -n "url\|status\|failed\|error" src/renderer/tree.ts` returned no output.
- `src/main/urls.ts` `matcherFor` — not affected (see above, restated for completeness as a "parallel address-handling implementation" candidate that was checked and ruled out).
- `README.md:234-302` — public-facing documentation of `api.navigate`/`api.download` behavior that states the current `ERR_FAILED`-adjacent contract ("Navigating to an address that turns out to be a file downloads it too...") and will need a parallel note for external schemes. Evidence: line 296, "Navigating to an address that turns out to be a file downloads it too, and the..." and line 302, "...download the page started by itself is never written inside the project at all."
- `src/main/hub.ts`, `src/main/main.ts` — MCP/IPC dispatch tables that route `navigate` and tab-descriptor broadcasts; confirmed they call `context.describeTab(s)` and would carry through any new `TabDescriptor`/`AppEvent` field once added, but were not read in full. Evidence: `context.describeTabs()` calls at `src/main/hub.ts:395`, `src/main/main.ts:532`, `src/main/main.ts:549`.
- `src/main/preferences.ts:1-70` and the "directories the person has been asked about" admission-record pattern — parallel precedent for a per-scheme "asked/refused" register, structurally similar to what DoD item 3 (documented, uniform decision rule) might need if schemes are meant to be remembered per-project like directory grants. Evidence: comment "the register of directories the person has been asked about... is the other half of what that window is for" (lines 54-58).

## Could not rule out

- Whether `src/main/main.ts` wires a second `will-navigate`/`webContents.on('will-navigate', ...)` handler outside `tab.ts` that could also need the scheme check — not fully read.
- Whether `src/preload/preload.ts` exposes any renderer-side navigation trigger independent of `chrome.ts`'s address bar.
- Whether `documents/tasks/2026/` contains an existing task file already scoping this same request (the request text reads like a task-file spec), which could itself be an affected/duplicate surface.
```

What each of those is for this task — the union of the scout's list and the
enumeration made here:

- `src/main/tab.ts` `navigate()` (loadURL at :287) — covered-by DoD «never ends as a bare load failure» and DoD «`api.navigate` answers with that same explanation»: the scheme is judged before `loadURL` is called.
- `src/main/context.ts` — covered-by three ways: `setWindowOpenHandler` (:231) takes the same decision for a window a page opens; the tab-event wiring gains the listener that catches an ordinary link click (Solution step 3), which is the only entry point DoD 1 can arrive through; and `openTab` (:214) must catch the sentence rather than leave a rejection for `faults.ts`. Recording an attempt reuses `context.ts:443`, the existing path to the panel.
- `src/main/api.ts` `navigate` (:276) and `newTab` (:351) — covered-by DoD «`api.navigate` … answers with that same explanation» and Solution step 5: `navigate` passes the thrown sentence on, and `newTab` judges the address before opening a tab so an agent never gets a blank one with no explanation.
- `src/main/protocol.ts` `TabDescriptor` — `not affected`, and deliberately: its own comment (:54-59) forbids a record of what happened in a tab from riding on that type, because it is re-sent to every agent on every title change. The attempt reaches the agent through the `status` answer instead (Solution step 4). `AgentCommand` in the same file is the shape the panel's entry takes and is unchanged.
- `src/main/hub.ts` (:385, the `status` answer) — covered-by DoD «an agent can read from the tab that a link tried to leave»: the answer gains `leftFor` beside `faults`. `main.ts` (:532, :549) pass `describeTabs()` through and are `not affected` by that; `main.ts:566` (`ab:navigate`) is covered-by Solution step 5, because it must stop logging `went to ${url}` for a move that did not happen.
- `src/main/visits.ts` `VisitKind` — `not affected` under the chosen variant: the record goes on the tab, where `status` already reads it, and the visit log answers a different question — what the person did while holding the tab.
- `src/main/reference.mjs` (:85-141) — covered-by DoD «who decides is written down»: the manual an agent reads is where the rule reaches it.
- `README.md` (:296) — covered-by the same DoD item: it states the neighbouring `navigate`-to-a-file contract and would otherwise be the one public page still promising a bare failure.
- `test/integration.test.mjs` + a new fixture beside `test/fixtures/download.html` — covered-by DoD «an integration test covers a page whose link leaves for another scheme».
- `documents/requirements.md` FR-TAB-4 — covered-by: its acceptance reads **not yet** and names this task; the same edit that proves it names the test.
- `documents/design.md` §2 module map and §7 «A window a page opens» — covered-by: a new pure module has to appear in the map, and §7 states the window-open contract this changes.
- `documents/decisions/` — deferred — human choice: the rule and the alternatives weighed against it are written in this task, which is enough for the change itself. Whether it also earns a numbered record is in `## Follow-ups`.
- `src/renderer/chrome.ts` address bar (:223) and `src/preload/preload.ts` (:21) — `not affected` — both reach the same `ab:navigate` IPC and end in `Tab.navigate`, so the rule holds there by construction. Inspected: `preload.ts:21` is the only navigation the preload exposes.
- `src/main/permissions.ts` — `not affected` — `permitted(_permission)` (:30-32) judges capability names, not addresses. It is the pattern the new module copies, not a file this task edits.
- `src/main/downloads.ts` `Claim` (:32-36) — `not affected` — the claim register tells an agent's download from the page's; here the caller is already known, because `Tab.navigate` and the window-open handler are different entry points.
- `src/main/urls.ts` — `not affected` — `matcherFor`/`describePattern` serve `waitForUrl` only, with no scheme dispatch.
- `src/main/tray.ts` (:158) — `not affected` — `loadURL` on a `data:` URL for the tray's own HTML, outside any project session.
- `src/main/snapshot.ts` (:189) — `not affected` — `session.protocol.handle('https', …)` serves the snapshot's own pages.
- `src/main/tools.mjs`, `src/main/render.mjs` — `not affected` — a grep for `navigate|download|mailto|tel:` hits only `reference.mjs`.
- `src/renderer/tree.ts` — `not affected` — it draws the tab tree and carries no per-navigation outcome.
- `test/fixtures/server.mjs` (:63-73) — `not affected` — it serves any file in the fixture directory, so a new fixture needs no route.
- `src/main/preferences.ts` (:54-58) — `not affected` under the chosen variant: it remembers nothing and asks nobody, so no per-scheme grant is stored. The register would appear only with the variant that asks the person, which is in `## Follow-ups`.
- `AGENTS.md` (:188-200, :363-368) — covered-by DoD «who decides is written down», with one caveat: the file is deliberately untracked in this repository (`git ls-files` does not know it), so the edit lands on disk and never in a commit.
- The scout's third «could not rule out» is this file: `documents/tasks/2026/09/an-address-in-a-scheme-nobody-here-handles.md` is the task, not a duplicate of it. Its first two are ruled out by the greps above — no `will-navigate`, `will-redirect` or `open-url` listener exists anywhere in `src/`, and the preload exposes one navigation call.

### What the events actually do

Measured on 2026-09-19 against Electron 44.4.3, in a window of its own with a
page holding a `mailto:` link, a link in a scheme nothing on this machine
registers, and a button calling `window.open`:

```
click on mailto:        will-navigate + will-frame-navigate + did-start-navigation
click on x-nothing-here will-navigate + will-frame-navigate + did-start-navigation
window.open('mailto:')  setWindowOpenHandler, with the address in details.url
loadURL('mailto:…')     rejected, ERR_FAILED (-2)
loadURL('x-nothing…')   rejected, ERR_FAILED (-2)
did-fail-load           never fired, for any of them
will-navigate + preventDefault()  the tab stays on the page it was on
```

Three things follow, and each one changes the plan.

- **A click arrives only at `will-navigate`.** It reaches neither `Tab.navigate`
  nor the window-open handler, so a rule wired to those two alone cannot do what
  a person clicking «write to us» expects.
- **The error code cannot tell an unhandled scheme from a broken page.** Both
  come back `ERR_FAILED (-2)`, which is also what an address that turns out to
  be a file raises (AGENTS.md, 2026-09-15). So the decision has to be taken
  before the load, from the scheme itself.
- **`isProtocolHandled` answers nothing useful.** It returned `false` for all 18
  schemes tried, `http` and `file` included: it reports what the application
  registered, not what Chromium renders. So the set of schemes this browser
  loads has to be written down, and it was measured rather than guessed:
  `about:`, `data:`, `view-source:`, `devtools:`, `file:` and `blob:` all load
  (`blob:` from a page that made the address itself), while `chrome://version`
  is refused by Chromium with `ERR_UNKNOWN_URL_SCHEME (-300)` and `ftp://` with
  `ERR_FAILED (-2)`.

## Definition of Done

- [x] `mailto:` and `tel:` from a page do what a person clicking them expects.
      *(FR-TAB-4 · `test/integration.test.mjs` "a mail link a page offers is
      handed to the system and the tab stays where it was" · `deno task test`,
      plus a measurement of the hand-off itself, which a test run never makes:
      `shell.openExternal('mailto:…')` resolved on this machine on 2026-09-19
      with Mail already running. That the compose window appeared could not be
      asserted from here — this session has no permission to send Apple events
      to Mail (`-1743`) — so the evidence is that the machine accepted the
      address, not that it drew a window.)*
- [x] A scheme this browser cannot open never ends as a bare load failure: it is
      either handed on or refused with a message naming the address.
      *(FR-TAB-4 · `test/integration.test.mjs` "an address in a scheme nobody
      here handles is refused in words, not by a bare error code" ·
      `deno task test`)*
- [x] Who decides is written down — which schemes go straight through, which
      ask, and which are refused — and the rule is the same for every project.
      *(FR-TAB-4 · `test/unit.test.mjs` "the scheme rule hands on three schemes
      and refuses by wording, not by a list of its own" · `deno task test`.
      Read the rule as three outcomes: **no scheme asks**, and the task says so
      in as many words — see the note under the Solution.)*
- [x] An agent can read from the tab that a link tried to leave for another
      application, and where it was going.
      *(FR-TAB-4 · `test/integration.test.mjs` "status says where a tab tried to
      leave for another application" · `deno task test`)*
- [x] `api.navigate` to such an address answers with that same explanation
      instead of throwing `ERR_FAILED`.
      *(FR-TAB-4 · `test/integration.test.mjs` "an address in a scheme nobody
      here handles is refused in words, not by a bare error code" ·
      `deno task test`)*
- [x] An integration test covers a page whose link leaves for another scheme.
      *(FR-TAB-4 · `test/integration.test.mjs` "a mail link a page offers is
      handed to the system and the tab stays where it was" · `deno task test`)*

## Solution

The chosen shape is **three outcomes — load, hand on, refuse — decided by the
scheme alone and the same in every project** (the variant weighed and picked on
2026-09-19). Nothing is remembered and nobody is asked: a question to the person
would stop an agent's scenario in the middle, which is the one thing this
browser is built to avoid.

Two things this rule deliberately does **not** do, because both were argued and
rejected while it was written:

- **No scheme asks.** DoD 3 lists three classes and one of them is "ask"; here
  that class is empty, and that is the answer rather than missing work. The seam
  where a question would go is named in step 4.
- **The list of schemes this browser renders is written down, because nothing
  else will say it.** The first draft avoided the list by reading the load's
  error code; the measurement above killed that — an unhandled scheme and a
  broken page both come back `ERR_FAILED (-2)`. `isProtocolHandled` cannot stand
  in either. So the list exists, every entry in it was measured, and the refusal
  names the scheme, so an entry missing from the list shows up in the sentence
  rather than as silence.

**0. Measure first, because Electron's defaults decide the shape.** Done, under
`### What the events actually do` above. Two of its three findings overturned
the first draft of this Solution, which is what the step is for.

**1. `src/main/schemes.ts` — new, pure, imports no `electron`.** It sits beside
`permissions.ts` and is written the same way: the whole decision in one small
file, with the reason for every entry next to it.

```ts
export type SchemeOutcome = 'load' | 'hand-on' | 'refuse'
export function schemeOf(url: string): string
export function outcomeFor(url: string): SchemeOutcome
export function handOffNotice(url: string, stayedAt: string): string
export function refusalFor(url: string, stayedAt: string): string
export function tooSoon(lastHandOff: number | null, now: number): boolean
```

- **Loaded**: `http`, `https`, `file`, `about`, `data`, `blob`, `view-source`,
  `devtools` — every one of them measured on 2026-09-19, above. This opens
  nothing new: it is what already renders, written down so the rule can be read.
- **Handed on**: `mailto`, `tel`, `sms`. Each opens a window the person then
  types into; none of them acts by itself. This is the whole of what a page may
  make this machine do, and the list grows only by an edit with a reason beside
  it.
- **Refused**: everything the machine would answer with a native client,
  including every single sign-on that bounces into one. The sentence names the
  address in full and says the tab did not move, because the agent reading it
  has to tell a sign-in hand-off from a typo.
- **`tooSoon`** is the flood guard promised when the variant was chosen: one
  hand-off per tab per second, the rest refused. One timestamp, one comparison —
  a page that loops `mailto:` cannot open a column of compose windows.

**2. `src/main/hand-off.ts` — new, the one place `shell.openExternal` is
called.** It exports `openExternally(url)` and `recordInsteadOfOpening()`. A test
run calls the second, through the `isTestRun` flag `main.ts` already computes
(`--admit-everything && !app.isPackaged`, `main.ts:57`) — so no new flag is
added, and the affordance cannot be switched on in an installed copy. The record
on the tab is written in both modes, so a test asserts the same hand-off the real
path makes; only the launch is missing, and the walk covers that.

**3. Where the decision is taken.** Three entry points, because a page click, an
agent's call and a page opening a window are three different arrivals:

- **`Tab.navigate`** (`tab.ts:267`) — after `normalizeUrl`: a handed-on scheme
  is opened externally, recorded, and answered without moving the page; anything
  else loads as today, and a scheme outside the rendered list is refused before
  the load rather than after it, because the code a failed load comes back with
  says nothing. `navigate` keeps its
  `Promise<void>` signature and **throws** an `Error` whose message is the
  sentence. It throws for a hand-off as well as for a refusal, because in both
  the page did not move, and a scenario that carries on as if it had is the
  defect this task exists to remove. `runner.ts` already turns a thrown error
  into the agent's answer with the trail of what ran before it, so the sentence
  arrives in the shape agents already read.
- **`will-navigate`** (wired in `context.ts` beside the other tab events) — the
  event a click raises, and the only one that does. It calls `preventDefault()`,
  which the measurement shows leaves the tab where it was, then hands on or
  refuses and records. There is no scenario to answer, so nothing is thrown. **This is the entry point that carries DoD 1**: a click on an
  ordinary link goes through neither `Tab.navigate` nor the window-open handler.
- **`setWindowOpenHandler`** (`context.ts:231`) — the handler takes `details`
  and reads `details.url`. A loadable address keeps today's `allow` branch
  untouched, including the adopted `webContents` that sign-in popups depend on.
  A handed-on or refused address is recorded and answered `{ action: 'deny' }`,
  because an allowed open of an address Chromium cannot render leaves a blank
  tab nobody closes.

**4. Where the record lives, and why not on `TabDescriptor`.** `protocol.ts:54`
says a record of what happened in a tab never rides on `TabDescriptor`: that
type is re-sent to every agent on every title change. So:

- `Tab` keeps `#leftFor`, the last 10 attempts, each `{ url, outcome, at }` —
  history with timestamps rather than a "current state" field, so nothing goes
  stale and a later reader can tell a minute-old attempt from this one.
- `status` (`hub.ts:385`) gains `leftFor`, built on demand from the project's
  tabs as `{ tabId, url, outcome, at }`. It sits beside `faults` for the same
  reason faults do: an agent has no other way to learn that the browser, not the
  page, decided something.
- The person sees it too: each attempt is added to the tab's `CommandLog`, which
  already reaches the panel on its own channel (`context.ts:443`).
- This is also the seam a later "ask the person" would use: the record exists,
  and only the answer would have to be waited for.

**5. The three other callers of `Tab.navigate`**, none of which may swallow the
sentence:

- `context.ts:214` (`openTab`) catches it and leaves the blank tab where it is —
  the record is already on the tab, and an unhandled rejection inside `track`
  would otherwise be filed as a fault of the application's own.
- `api.ts:351` (`newTab`) judges the address **before** opening a tab: a handed
  on or refused address is dealt with on the current tab and thrown, so an agent
  never gets back a blank tab and no explanation.
- `main.ts:566` (`ab:navigate`, the address bar and the preload's one navigation
  call) catches it, writes the sentence to the tab's log instead of
  `went to ${url}`, and answers `false`, so the panel does not claim a move that
  did not happen.

**6. `src/main/api.ts` — `navigate` keeps returning the URL.** The throw carries
the explanation, so the answer's type stays what `reference.mjs:94` and
`README.md` promise: an address, never prose an agent cannot tell from one.

**7. The manual and the public page.** `src/main/reference.mjs` gains one line in
the navigation block, beside the note that a `navigate` to a file is a download.
`README.md` gains the matching sentence, so the one public statement of this
contract does not go on promising a bare failure.

**8. Documents.** `documents/requirements.md`: FR-TAB-4's acceptance stops
reading **not yet** and names the integration test. `documents/design.md`:
`schemes.ts` and `hand-off.ts` enter the module map, §7 records that a
window-open in a scheme this browser does not render is denied and handed on or
refused, §12 adds `schemes.ts` to the pure list. `AGENTS.md` gets the
measurements from step 0 beside the download lesson they belong next to; that
file is deliberately untracked here, so the edit lands on disk and in no commit.

**9. Tests.**

- `test/unit.test.mjs`: the three outcomes over the measured schemes, a scheme
  nobody has heard of refused, a refusal that names the address and says where
  the tab stayed, and `tooSoon` at its boundary.
- `test/fixtures/leaves.html`: a `mailto:` link, a `tel:` link, a link in a
  scheme nothing here handles, and a button that opens one in a new window.
- `test/integration.test.mjs`: the mail link clicked leaves the tab where it was
  and records the hand-off; `status` carries it with the tab's id;
  `api.navigate` to a refused address answers with the sentence and the tab has
  not moved; a page opening a mail window gets no blank tab.

**Verification**: `deno task check`, `deno task test`, and a walk of the real
window with the hand-off live — the fixture page open, the mail link clicked,
the mail window on screen and the tab still where it was. The walk is the only
evidence that the hand-off reaches the machine, because a test run never
launches anything.
## Follow-ups

- A sign-in that bounces into a scheme a native client registered is still
  refused, in words. Opening it needs the person's answer, remembered per
  project — the third variant weighed on 2026-09-19, deliberately not built
  here because a question in the middle of a scenario stops the agent.
- Whether the scheme rule earns a numbered record under `documents/decisions/`
  is the owner's call. It is not written now: the rule is small, and its reasons
  sit beside it in `src/main/schemes.ts`.
