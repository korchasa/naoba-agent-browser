---
date: "2026-09-19"
status: done
implements: [FR-PERMISSION-2, FR-PERMISSION-5]
tags: [agent-browser, naoba, permissions, geolocation, agent-experience]
related_tasks:
  [nobody-is-asked-before-the-microphone-goes-on, events-in-the-session-nobody-listens-to]
---
# A permission that answers neither way

## Goal

A page that asks this browser where it is gets an answer. A refusal counts as an
answer; silence does not, because a scenario waiting on silence stops with
nothing to read.

## Overview

Geolocation neither grants nor denies. Measured on 2026-09-19, with the page's
own `timeout` set to 3 seconds and the probe's patience to 6:

```
new Promise(r => navigator.geolocation.getCurrentPosition(
  () => r("granted"), e => r("denied: " + e.message), { timeout: 3000 }))
  → still unsettled after 6 s
```

Neither callback ran. The page's own timeout should have fired the error
callback at 3 seconds and did not, which puts the stall below the page, in the
request this browser never completes. Chromium asks a location service that
needs an API key Electron does not ship, so the request goes out and nothing
comes back.

**That paragraph is wrong and is kept as it was written.** The location-service
explanation was never traced to anything; a second probe found the page's own
clock answering with `TIMEOUT`, and after the refusal the answer is
`PERMISSION_DENIED`. Both measurements are below, under "What the permission
handler did to it". The first Definition-of-Done item is ticked for the second
of them, not for this guess.

It reads to the agent as a page that will not finish loading, and the cause is
nowhere near the page. The same shape hides in every permission this application
does not answer — see [nobody is asked before the microphone goes
on](nobody-is-asked-before-the-microphone-goes-on.md) — but geolocation is the
one measured hanging, so it is written down on its own.

A refusal is a real answer here, and probably the right one. This browser drives
somebody else's sessions from a machine in one place; a site that wants a
location can have a denial promptly and fall back to asking.

### What the two handlers actually see (2026-09-19)

Measured before this Solution was written, not as its first step. A probe in
`context.ts` wrote every call of both permission handlers to a file while the
existing integration test drove `permissions.html`, and the probe was taken out
again afterwards. Six calls, in this order:

```
request | media          | tab=1c842dd8 | details={isMainFrame:true, mediaTypes:[],        requestingUrl:".../permissions.html", securityOrigin:"http://127.0.0.1:53527/"}
request | media          | tab=1c842dd8 | details={isMainFrame:true, mediaTypes:["audio"], requestingUrl:".../permissions.html", securityOrigin:"http://127.0.0.1:53527/"}
request | notifications  | tab=1c842dd8 | details={isMainFrame:true, requestingUrl:".../permissions.html"}
check   | clipboard-read | tab=1c842dd8 | origin="http://127.0.0.1:53527/"
check   | clipboard-read | tab=1c842dd8 | origin="http://127.0.0.1:53527/"
request | geolocation    | tab=1c842dd8 | details={isMainFrame:true, requestingUrl:".../permissions.html"}
```

Four things follow, and three of them were guesses until this ran.

- **The tab is knowable.** `webContents` was non-null on all six calls and
  matched exactly one open tab by `this.#tabs.find((t) => t.wc === wc)`. So a
  refusal can be attributed to the tab that earned it, which is what "from the
  tab" in the open item asks for. Electron's own types still allow a null
  `webContents` on the check handler, so the recording has to survive one.
- **Half of it never reaches the request handler.** `clipboard-read` arrives
  only as a check, because `navigator.permissions.query()` is a different path.
  A record built on the request handler alone would be blind to exactly the
  permission an agent meets most often.
- **A check repeats.** One `permissions.query()` call produced two identical
  check entries. Whatever is recorded has to collapse a repeat, or a page
  polling its own permission state fills the history on its own.
- **Screen capture is not `display-capture`.** `getDisplayMedia` arrives as
  `media` with an empty `mediaTypes`, not under a name of its own — the sibling
  task's note that "`display-capture` is one of the names the permission handler
  refuses first" is wrong about the name, though right about the outcome. The
  refusal is real either way; only the label was guessed.

### Affected Surface

The independent pass (`surface-scout`, dispatched 2026-09-19 from the Goal and
the open Definition-of-Done item alone), verbatim:

```
## Surface

- `src/main/context.ts:116-129` (`setPermissionRequestHandler`) — this is where a page's ask is currently observed and immediately discarded; the callback receives `webContents` (aliased `_wc`, unused) and `details`, so it is the only place in the codebase that currently sees which page asked, for what, at what moment — the exact three facts the open item needs to become visible. Evidence: currently contains **uncommitted, in-progress probe code** (`git status --short` shows `M src/main/context.ts`, though `git diff HEAD` on it returns empty output — an anomaly worth flagging, not resolving here) writing JSON lines to `/private/tmp/.../scratchpad/permission-probe.log`, matching `_wc` against `this.#tabs.find((t) => t.wc === _wc)` — i.e. someone has already begun exactly the webContents→Tab attribution this open item requires.
- `src/main/context.ts:119` (`setPermissionCheckHandler`) — the second half of the same decision (`navigator.permissions.query()`), same `_wc`/permission shape, currently has no attribution or recording at all.
- `src/main/context.ts:123,126` (`setDevicePermissionHandler`, `setBluetoothPairingHandler`) — two more gates answered by the same rule (`permitted`) with no attribution/recording; a complete "what a page asked and was refused" surface has to decide whether these count too, since they are refusals of the same shape.
- `src/main/permissions.ts:32` (`permitted(_permission)`) — the pure decision function; it takes only the permission name, never the tab, so it cannot itself carry an attribution — any recording has to happen at the call sites in `context.ts`, not here.
- `src/main/tab.ts:114-138` (`class Tab`) — holds the established pattern for "something happened in this tab, readable later": `readonly console: ConsoleEntry[]`, `readonly network = new Map(...)`, and specifically `readonly leftFor: HandOff[] = []` with `#record()` capping it at 10 entries and an `onLeft` callback that tells the project/panel. A permission log is structurally a fourth instance of the same shape, and `leftFor` is the closest sibling (a "what happened, newest last" per-tab array built specifically because it does *not* belong on `TabDescriptor`).
- `src/main/tab.ts:15` (`interface HandOff`) and its comment "This never rides on `TabDescriptor`... so `status` builds it on demand instead" — this is the exact design precedent the open item's data shape would follow: not a live field, a history array assembled into `status()`.
- `src/main/protocol.ts:37-52` (`interface TabDescriptor`) — the per-tab summary sent on every title/nav change (`tab-opened`, `tab-navigated`, panel `tabs` broadcast). Its own file comment (referenced from `tab.ts:57-60`) explicitly warns against putting a growing history here because it crosses the wire on every change — meaning a permission log almost certainly must NOT be added as a `TabDescriptor` field, the same reasoning that kept `leftFor` off it.
- `src/main/context.ts:22` (`describeHandOff`) and `:279-280` (`tab.onLeft = (handOff) => { this.log(BROWSER, describeHandOff(handOff), tab.id) }`) — the wiring that turns a `Tab`-level event into a project-level log line for the panel; a permission event would need the equivalent wiring if it is to reach the panel as well as `status()`.
- `src/main/context.ts:420-438` (`describeTab`/`describeTabs`) — builds `TabDescriptor` from `Tab` + `LeaseTable` + `pendingHuman`; not itself where a permission history would be read, but the sibling method for `TabDescriptor` construction, useful to confirm nothing is added there.
- `src/main/hub.ts:384-411` (`case 'status':`) — the actual agent-facing read path: assembles `tabs: context.describeTabs()`, then separately `leftFor: context.tabs.flatMap((tab) => tab.leftFor.map(...))` and `faults: recentFaults().map(...)`. This is precisely where a `permissionsAsked` (or similarly named) array, built the same way as `leftFor`, would be added to the `status` response.
- `src/main/faults.ts` — the other established "what happened, agent reads it through `status`" log (`record`, `recent`, bounded at `KEPT = 20`, `announces` dedup logic). A second, independent precedent for the same shape of feature (record → cap → expose via `status`), worth checking as an alternative design (global list vs. per-tab list) even though `leftFor` is the closer analog since permissions are inherently per-tab/per-page.
- `src/main/main.ts:13,232-246` — where `faults.ts`'s `record`/`describeFault`/`announces`/`announcement` are wired to Electron's `uncaughtException`/`unhandledRejection` and to a person-facing system notification. Relevant only as a second example of "record here, notify person here, read via status there" — not itself expected to change for a page-scoped permission event.
- `src/main/reference.mjs:97-104` — the agent-facing manual text that already documents the `leftFor` precedent verbatim ("A link the page followed itself is recorded the same way: status() carries it under leftFor"). A new permission-visibility mechanism needs an equivalent line here, competing for the same fixed ~2040-character budget noted by `tools.mjs`.
- `src/main/tools.mjs` — the three-tool MCP surface (not permission-specific); worth re-confirming no new tool is needed, since `status` and `eval` already exist and a permission history would ride `status` the way `leftFor` and `faults` do.
- `test/integration.test.mjs:641-660` (`'a page that asks for the microphone is refused, and hears the refusal'`) — the existing integration test for FR-PERMISSION-1; it drives `api.click('#ask')` on `permissions.html` and polls `window.__asked`, but never calls `agent.status()` to check attribution — the natural place to extend for "an agent can tell from the tab" once a mechanism exists, and evidence that no such assertion exists yet.
- `test/fixtures/permissions.html` (referenced by the test above via `origin + '/permissions.html'`) — the fixture page that requests the microphone; may need a second request type (e.g. geolocation) or an additional assertion hook if the DoD item is tested per-permission-kind.
- `test/unit.test.mjs:1544-1564` (`'every permission a page can ask for is refused, whatever its name'`) — tests `permitted()` directly with no tab/attribution involved; unaffected by this item unless the decision function itself gains a second responsibility.
- `documents/requirements.md` §15 (`FR-PERMISSION-1`, lines ~430-441) — its acceptance text and the linked follow-up task are the documentation surface that would need an added acceptance line once "an agent can tell from the tab" is implemented; currently the DoD item for it is unchecked only in the task file, not reflected as a distinct FR yet.
- `documents/tasks/2026/09/nobody-is-asked-before-the-microphone-goes-on.md` — its own `## Follow-ups` section (referenced repeatedly, not yet read in full) is where this exact deferred item ("no per-tab log is added... See the first entry under `## Follow-ups`") was written down at variant-selection time; the reasoning for *why* it was deferred lives there and directly bears on what the fix is expected to look like.
- `documents/design.md` — SDS; per the project's documentation hierarchy, a new per-tab data structure/status field is architecture-level and conventionally gets a design.md entry, the way the permission-handler installation apparently did (per the related task's disposition list).
- `src/renderer/chrome.ts:375-401` (`tabRow`) — the panel's per-tab rendering, which already special-cases `tab.waitingForHuman` and `tab.heldBy` from `TabDescriptor` with CSS classes and title tooltips. Not required by the open item's literal wording ("an agent can tell"), but the nearest existing UI precedent if a person-visible badge were ever considered alongside the agent-visible one — flagged because the goal statement talks about "an agent," while this file is the human-facing channel and was excluded deliberately in the sibling task's dispositions ("nobody is asked, so `#admit` is not reused").

## Not examined (budget)

- Full text of `nobody-is-asked-before-the-microphone-goes-on.md`'s `## Follow-ups` section past what was captured by the `head -200` read — the disposition list was seen, but the section header itself and any items after it were not confirmed read in full.
- `documents/design.md` — not opened, only inferred as a likely-affected doc from the sibling task's own disposition ("covered-by the documentation step... a session-level decision belongs in the module map").
- `src/main/mcp-http.ts` events/`session.events` mechanism — flagged as a candidate channel in the sibling task's scout pass but explicitly settled as "not affected" there; not independently re-verified here.
- The reason `git diff`/`git diff --cached`/`git diff HEAD` all return empty for `src/main/context.ts` despite `git status --short` showing it modified (permission mode change, CRLF, or a staged-then-reverted content change) — not investigated, flagged only as an anomaly the next session should resolve before editing that file.
- `test/helpers/app.mjs` and `test/fixtures/server.mjs` — not opened; only inferred as the harness `agent.status()`/`app.agent()` calls run through, based on their use in the integration test read.
- `documents/tasks/2026/09/a-passkey-this-browser-cannot-answer.md` and `a-password-prompt-that-never-appears.md` — not re-opened here; sibling task already ruled both "not affected" for the handler-installation item, not independently re-checked for this narrower attribution item.

## Could not rule out

- Whether device-permission/Bluetooth refusals (`setDevicePermissionHandler`, `setBluetoothPairingHandler`) are meant to be included in "a page asked and was refused," or whether the open item is scoped to `setPermissionRequestHandler`/`setPermissionCheckHandler` only — the task text says "a permission" without naming which gate.
- Whether the intended fix records every refusal or only distinguishes "asked and refused" from "never asked" (i.e., a boolean/last-request field vs. a full history array like `leftFor`) — both readings are consistent with the goal text, and the two designs affect different parts of `TabDescriptor` vs. `status()`.
- Whether the panel (`src/renderer/chrome.ts`) is in scope at all — the DoD line says "an agent," and the sibling task explicitly kept the person out of the loop ("nobody is asked"), but the panel already surfaces other tab-history facts (`leftFor` via `this.log`), so a person-visible echo is plausible but unconfirmed.
```

The dispositions below are mine. Every row of the block above has one, including
the rows the scout itself set aside.

- `src/main/context.ts` request handler — covered-by the recording step: this is
  where the refusal is decided and dropped today.
- `src/main/context.ts` check handler — covered-by the recording step. The
  measurement above says this half carries `clipboard-read` and nothing else
  does.
- `src/main/context.ts` device and Bluetooth handlers — deferred — human choice.
  Neither fired in the measurement, and no page has been observed reaching them;
  the repository's own rule is to measure before building. Recorded under
  `## Follow-ups`.
- `src/main/permissions.ts` — not affected — it takes a name and returns a
  boolean, and the scout is right that it cannot carry an attribution. Adding
  one would cost it the purity that lets the unit tests load it without
  Electron.
- `src/main/tab.ts` — covered-by the recording step: the history lives on the
  tab, in the shape `leftFor` already has.
- `src/main/tab.ts` `HandOff` — not affected as code, decisive as precedent: the
  new entry type sits beside it and follows the same rule about not riding on
  `TabDescriptor`.
- `src/main/protocol.ts` `TabDescriptor` — not affected — checked at
  `protocol.ts:37-52` and at the comment above `CommandEntry`: this type crosses
  the wire on every title change, which is the stated reason `leftFor` stays off
  it. A permission history has the same shape and the same reason.
- `src/main/context.ts` `describeHandOff` / `onLeft` wiring at `:254` —
  covered-by the panel step: a refusal becomes a line under the `BROWSER` actor
  the same way an address this browser will not open already does.
- `src/main/context.ts` `describeTab` / `describeTabs` — not affected —
  confirmed by the row above: nothing is added to the descriptor they build.
- `src/main/hub.ts` `case 'status'` — covered-by the reader step: the array is
  assembled there, next to `leftFor` and `faults`, from `context.tabs`.
- `src/main/faults.ts` — not affected — read it: a process-wide log of what the
  application itself got wrong, bounded at 20, with its own de-duplication for
  the person's notification. A page asking for the microphone is not a fault of
  this browser's, and putting it there would mix the two.
- `src/main/main.ts` — not affected — it wires `faults.ts` to Electron's
  `uncaughtException`, which the row above rules out.
- `src/main/reference.mjs` — covered-by the manual step. The scout is right that
  a new mechanism needs a line; it costs nothing against the description budget,
  because the sentence goes in `MANUAL` beside the existing `leftFor` line and
  `TOOL_DESCRIPTION` is not touched.
- `src/main/api.ts` — covered-by the reader step. Neither the scout nor my own
  first pass named this file, and `plan-critic` caught it: the sibling task
  defines closing its follow-up as "a per-tab log ... plus a reader in
  `api.ts`", and `status` is not reachable from inside a scenario, which is
  where an agent is standing when the thing it was doing stops working.
- `src/main/tools.mjs` — not affected — re-confirmed: the three tools do not
  change, and the record rides `status` exactly as `leftFor` and `faults` do.
- `test/integration.test.mjs:641-660` — covered-by the integration test: the
  existing test already drives every permission this needs, and gains the
  assertion the scout noticed is missing.
- `test/fixtures/permissions.html` — not affected — it already asks for five
  things across both handlers, which is more than the assertion needs.
- `test/unit.test.mjs:1544-1564` — not affected — `permitted()` gains no second
  responsibility, so the test that walks the name union is untouched. A new unit
  test is added beside it for the recording rule itself.
- `documents/requirements.md` §15 — covered-by the documentation step: a new
  `FR-PERMISSION-5` for what an agent can read, with its acceptance named.
- `documents/tasks/2026/09/nobody-is-asked-before-the-microphone-goes-on.md` —
  covered-by the documentation step: its first `## Follow-ups` entry is the
  deferral this task closes, and it is marked closed there rather than left
  reading as open.
- `documents/design.md` — covered-by the documentation step: a per-tab history
  read through `status` is architecture, and §3 already describes the four
  handlers this sits on.
- `src/renderer/chrome.ts` `tabRow` — not affected — nothing is added to
  `TabDescriptor`, so the panel's per-tab row does not change. The person sees
  the refusal as a history line under the tab, which the existing rendering of
  `this.log` already draws.
- `src/main/mcp-http.ts` events channel — not affected — settled the same way
  the sibling task settled it: no refusal is published as an event. `status` is
  a pull, and an agent reads it after a scenario fails, which is when this
  matters.
- The scout's `git status` anomaly — not affected — it is mine, and it is gone.
  The probe described in the measurement above was in `src/main/context.ts`
  while the scout ran; it was restored from a copy taken before the probe, and
  `git status` is clean. Nothing about the file was staged.
- The two open readings the scout could not settle — history or a single flag,
  and whether the panel is in scope — covered-by variant selection: both were
  put to the person as the difference between the variants.

## What the permission handler did to it (2026-09-19)

Settled by [nobody is asked before the microphone goes
on](nobody-is-asked-before-the-microphone-goes-on.md), which refuses every
permission on the project's session. Two things in the Overview above turned out
to be wrong, and are corrected here rather than quietly dropped.

**It was not hanging.** Measured again on the unchanged build, in a project tab,
with the page's own timeout at 2 seconds: the error callback ran with code 3,
`TIMEOUT`. The earlier probe used a 3-second timeout and 6 seconds of patience
and saw nothing, so "still unsettled after 6 s" was either a different session or
a slower run. What is certain is that the answer came from the page's clock, not
from the browser, and it said the wrong thing — a site reading `TIMEOUT` retries,
where a site reading `PERMISSION_DENIED` falls back.

**It is now refused promptly.** After the change the same probe returns code 1,
`PERMISSION_DENIED`, with no wait. That is the refusal this task argued was
probably the right answer.

What is still open is the last item below: an agent cannot see that a page asked
and was refused. That was dropped deliberately at variant selection on
2026-09-19 and is recorded under `## Follow-ups` in the task above.

## Definition of Done

- [x] The cause is pinned rather than assumed: the request is traced far enough
      to say whether it is the missing location service or something above it.
- [x] A page asking for a location gets a settled answer within a second or two,
      whatever that answer is.
- [x] An agent can tell from the tab that a page asked and was refused.
      *(FR-PERMISSION-5; `test/integration.test.mjs` — "an agent can tell from
      the tab that a page asked and was refused"; run it with `node --test
      --test-concurrency=1 --test-timeout=90000 --test-name-pattern='an agent
      can tell from the tab that a page asked' test/integration.test.mjs`)*
- [x] Every other permission is checked for the same silence, and what each one
      does is written down.
- [x] An integration test proves a page's own geolocation callback runs.

## Solution

Chosen on 2026-09-19, over a record built on the request handler alone and over
one that also covered the device and Bluetooth gates. The first would have been
blind to `clipboard-read`, which the measurement above shows arrives only as a
check. The second would have been written for two handlers no page has been
observed reaching, which this repository has already paid for twice.

Every refusal is recorded on the tab that earned it, in the shape `leftFor`
already has, and an agent reads it back in `status()` — the one answer it is
holding when a scenario has just failed. Nothing is added to `TabDescriptor`,
for the reason written above that type.

**`src/main/permissions.ts`.** The rule for the record joins the rule for the
decision, in the one file that may not import Electron. Two exports beside
`permitted`:

```ts
export interface PermissionAsk {
  readonly permission: string
  /** Whether the page asked outright, or only looked its state up. */
  readonly kind: 'asked' | 'checked'
  readonly url: string
  /** What `media` meant this time, and empty for every other permission. */
  readonly mediaTypes: readonly string[]
  readonly outcome: 'granted' | 'refused'
  /** How many times in a row, so a page that polls is one line. */
  count: number
  /** The most recent of those times. */
  at: number
}

export function recordAsk(log: PermissionAsk[], ask: PermissionAsk): PermissionAsk | null
```

`mediaTypes` is there because `plan-critic` read the measurement above more
carefully than the first draft of this Solution did. Electron sends
`getDisplayMedia` and `getUserMedia` under the one name `media`, from the same
page, a moment apart, and refuses both — so without the types they are one line,
and the test this Solution promises, which names the microphone, could not have
been written. It is part of what tells one ask from another.

`recordAsk` appends, and answers with the entry it appended. When the newest
entry already matches on all five of permission, kind, url, outcome and media
types, nothing is appended: that entry's `count` goes up, its `at` moves, and
the answer is `null`. The measurement is the reason — one
`navigator.permissions.query()` call arrived twice, and a page that polls its
own state would otherwise fill the record on its own. The `null` is also what
keeps the panel quiet: a repeat is not a new line.

The cap is ten **per kind**, not ten over the record. One cap over both was the
first draft and `plan-critic` took it apart: a page may call
`navigator.permissions.query()` as often as it likes, an outright ask is rare
and is what an agent came for, and a shared cap lets the first evict the second
until the record holds nothing but polling. A unit test holds the two apart.

`outcome` carries what the handler actually answered rather than the constant
`refused`, because `permitted` is a function precisely so that a later named
exception can change it, and a record that hard-codes the answer would start
lying on the day it does.

**`src/main/tab.ts`.** `readonly permissionsAsked: PermissionAsk[] = []` beside
`leftFor`, and `onAsk: ((ask: PermissionAsk) => void) | null = null` beside
`onLeft`. One method, `recordAsk`, calls the pure function and fires `onAsk`
only for an entry that was appended.

**`src/main/context.ts`.** Both handlers find the tab and record before they
answer:

- `setPermissionRequestHandler` records `kind: 'asked'`.
- `setPermissionCheckHandler` records `kind: 'checked'`.

The tab is found by `this.#tabs.find((tab) => tab.wc === wc)`, which the
measurement proved matches exactly one open tab on every call. Electron's types
still allow a null `webContents` on the check handler, so a call that names no
tab is answered and not recorded — there is no tab to record it on, and the
alternative would be a fifth log nobody reads.

The two handlers do not agree on what they give for the page. The request
handler passes a whole address in `details.requestingUrl`; the check handler
passes an origin and nothing else. Taken at face value that would make two pages
of one site a single line whose url no longer says which of them asked — and the
url is part of what tells one ask from another. `whoAsked` in `context.ts`
settles it: the address where Electron gives one, the tab's own address where
the origin is the tab's own, and the bare origin only when it is somebody
else's, which is a frame of another site asking from inside the page.

Recording must never change the answer, so the whole record is wrapped the way
`serialize.ts` guards a read: a throw costs the record, never the decision.

`describePermissionAsk` joins `describeHandOff` at the top of the file, and
`tab.onAsk` is wired beside `tab.onLeft` so a refusal becomes one line under the
`BROWSER` actor — the same place an address this browser will not open already
appears. The person watching the panel sees that a page asked for the
microphone, which is worth something in a window that normally sits in the menu
bar.

Only an outright ask draws that line. `plan-critic` pointed out what `log` does
besides broadcasting: it pushes into the tab's hundred-entry command history,
which is where the record of what an agent did in that tab lives. A page looking
its own permission state up is not something the person needs told, and letting
it write there would empty the more useful record.

**`src/main/api.ts`.** `getPermissionsAsked()` beside `getConsoleLogs`, over the
tab the scenario is in. This was missing from the first draft of the Solution
and `plan-critic` found it: the sibling task defines closing its follow-up as a
per-tab log *plus a reader in `api.ts`*, and `status` is not reachable from
inside a scenario — which is exactly where an agent is standing when the thing
it was doing stops working.

**`src/main/hub.ts`.** `case 'status'` gains `permissionsAsked`, assembled from
`context.tabs` exactly as `leftFor` is, each entry carrying its `tabId`.

**`src/main/reference.mjs`.** One line in `MANUAL`, beside the existing sentence
about `leftFor`, saying that a permission a page asked for and was refused is
carried under `permissionsAsked`. `TOOL_DESCRIPTION` is not touched, so the
client's cut is not competed for.

**`documents/requirements.md`.** A new `FR-PERMISSION-5` in §15: an agent can
read what a page asked this browser for and what it was told, per tab, without
having turned anything on beforehand. The last clause is the requirement — the
console and the network logs both need `capture…(true)` in advance, and a
permission is asked once, before an agent has any reason to suspect it.

**`documents/design.md`.** A sentence in §3, where the four handlers are already
described, saying that each refusal is recorded on the tab and read back through
`status`, and why it is not on `TabDescriptor`.

**`documents/tasks/2026/09/nobody-is-asked-before-the-microphone-goes-on.md`.**
Its first `## Follow-ups` entry is the deferral this closes; it is marked closed
there, pointing here, rather than left reading as open work.

**Tests.**

- Unit, `test/unit.test.mjs`: "a page that asks for the same permission twice is
  one line, not two" — `recordAsk` collapses a repeat, raises `count`, moves
  `at` and answers `null`; a different permission, kind or outcome appends.
- Unit: "the record of what a page asked keeps the last ten" — the cap, and that
  the oldest goes first.
- Integration, `test/integration.test.mjs`: "an agent can tell from the tab that
  a page asked and was refused" — drives the existing `permissions.html` fixture
  in a project tab, then reads `status()` and asserts that `permissionsAsked`
  names the microphone as `asked` and refused, names `clipboard-read` as
  `checked` and refused, and that both carry the tab the agent worked in. The
  clipboard assertion is the one that would fail on the rejected variant A.

The existing test for FR-PERMISSION-1 and FR-PERMISSION-2 is left alone: it is
named in the requirements as the acceptance for both, and adding assertions to
it would make one test the evidence for three requirements.

**Verification.**

- `deno task check`
- `node --test --test-concurrency=1 --test-timeout=90000 test/unit.test.mjs`
- `node --test --test-concurrency=1 --test-timeout=90000 --test-name-pattern='an agent can tell from the tab that a page asked' test/integration.test.mjs`
- `node --test --test-concurrency=1 --test-timeout=90000 --test-name-pattern='a page that asks for the microphone is refused' test/integration.test.mjs`

## What the record looks like (2026-09-19)

Taken on the changed build, through the test harness, in a project tab on a page
served over http. The fixture asks for five things on one real click, and this
is the whole of what `api.getPermissionsAsked()` answered — `status()` returned
the same five with a `tabId` on each:

```
media          asked   mediaTypes []         refused  count 1   ← getDisplayMedia
media          asked   mediaTypes ["audio"]  refused  count 1   ← getUserMedia
notifications  asked   mediaTypes []         refused  count 1
clipboard-read checked mediaTypes []         refused  count 2
geolocation    asked   mediaTypes []         refused  count 1
```

Four things that were decisions rather than accidents show in it. The two
`media` lines are two lines and not one. `clipboard-read` is there at all,
which it would not be on a record built from the request handler alone. It reads
`count 2`, because one `navigator.permissions.query()` call reached the handler
twice. And every `url` is `.../permissions.html` rather than the bare origin the
check handler hands over.

## Follow-ups

- **The device and the Bluetooth gates record nothing.**
  `setDevicePermissionHandler` and `setBluetoothPairingHandler` refuse from the
  same rule and are not written down. Deferred at variant selection on
  2026-09-19: neither fired in the measurement, no page has been observed
  reaching them, and this repository has twice paid for designing against a
  guess about Electron. When one is met, the entry shape is already there and
  the work is a third call to `#noteAsk`.
- **A refused permission is still only a record, not a suggestion.** An agent
  reading `permissionsAsked` learns that the page asked and was refused; it is
  not told which refusals a page is likely to be broken by. The list of the
  harmless ones — `clipboard-sanitized-write`, `fullscreen`, `pointerLock`,
  `storage-access` and the rest — is in the second follow-up of [nobody is asked
  before the microphone goes
  on](nobody-is-asked-before-the-microphone-goes-on.md), and it is still the
  place a named exception would go.

## What this Solution replaced

The Solution above answers only the last of the five items. The other four were
answered by the handler [nobody is asked before the microphone goes
on](nobody-is-asked-before-the-microphone-goes-on.md) installed, which is what
this section used to say was still to come:

> Not decided yet, and it should not be settled separately from [nobody is asked
> before the microphone goes on] — both are answered by the same handler, and
> splitting them would mean writing that handler twice.
>
> The likely answer is that geolocation is refused outright, which turns a hang
> into an error the page already knows how to handle. If a location ever has to
> be supplied, it belongs in the project's settings as a fixed pair of
> coordinates rather than as a lookup, because a lookup puts this machine's
> whereabouts in front of every site an agent visits.

Both guesses held. Geolocation is refused outright and the page's own error
callback runs with `PERMISSION_DENIED`, and no coordinates were supplied to
anybody.
