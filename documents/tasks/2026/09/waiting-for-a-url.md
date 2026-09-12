---
date: "2026-09-12"
status: done
implements: []
tags: [agent-browser, naoba, agent-experience]
related_tasks: [naoba-agent-surface-defects, what-the-person-did]
---
# Waiting for the URL a form ends at

## Goal

An agent that submits a form waits for the address the submit ends at, instead
of guessing how long it takes. Nothing here waited for a URL, so every such
wait was a `setTimeout` the agent made up.

## Overview

The session this series comes from ran 74 `evalInBrowser` calls and spent 586 s
of machine time in them. 281 s of that — 48% — was hand-written pauses: 79 of
them across 59 calls, in 19 different lengths from 500 ms to 9 s. Most sat after
a click that submitted something, waiting for the next page.

What the surface offers instead:

- `api.waitFor(selector)` — waits for a node, not for where the page is. Usable
  only once the agent knows a selector unique to the page it is waiting for.
- `api.waitForLoad()` — waits for a load, and a single-page form never loads
  again. On Bazar.bg the form moved through its steps with `pushState`, and the
  publish that ended it was recorded as an in-page move
  (`test/fixtures/human-walk.html` reproduces exactly that shape).
- `api.navigate(url)` already waits and returns the final URL, so the gap is
  only for a move the page makes by itself.

### What a pattern is

A substring, or a regular expression. Both, because each answers a question the
other cannot:

- A substring is what the house already means by matching a URL:
  `getNetworkLog({url})` and `{frame: 'stripe'}` both use `includes`. An agent
  waiting for `/ads/promo/` knows the shape of the address and not the id in it.
- A regular expression is the only way to anchor one. `/second\.html$/` says
  "ends there"; a substring cannot, and a page whose every step carries the same
  prefix needs it.

A glob was rejected: it buys nothing a substring does not already give, and it
would need a third matching vocabulary in a surface that has one.

An empty string is refused rather than matched. It matches every page, so it
would return at once and read as "the page arrived" — and the usual way to
write one is by accident, from a variable that held nothing.

A regular expression built by the scenario belongs to the `node:vm` realm and
fails `instanceof` in the main process, the trap this repository has already
paid for twice (`31bdbec`, `85c427d`). The matcher reads the
`Object.prototype.toString` tag and pairs it with the member it is about to
call, the same way `serialize.ts` does.

### Whether an in-page move counts

It does, and it is the case the helper exists for. `did-navigate` is the main
frame's alone; `did-navigate-in-page` fires for sub-frames too and says which in
its third argument, so the flag is read rather than trusted — an advertisement
calling `pushState` is not the form arriving. That is the same rule `visits.ts`
already follows, and this helper watches the same two events.

### What it returns

The URL the page ended up at, as a string — the shape `api.navigate` already
returns, so the two waits read alike and neither needs a `getUrl()` after it.
The session called `getUrl()` 18 times, and 16 of those came back as `{}`.

## Definition of Done

- [x] `api.waitForUrl(pattern, {timeout})` returns the page's URL once the page
      is at an address the pattern matches.
- [x] A substring and a regular expression are both patterns, including one the
      scenario built itself, which fails `instanceof` across the realm boundary.
      Anything else, an empty string included, is refused by name.
- [x] An in-page move satisfies the wait, because that is how a single-page form
      ends. A sub-frame's move does not.
- [x] A page already at a matching address returns at once.
- [x] A full-page navigation is waited out: when the call returns, the document
      behind the address is readable, not merely committed.
- [x] A timeout says what was waited for, where the page actually is, and
      whether it moved at all — in the message, because that is the only part
      that survives an uncaught throw, and on the error for a scenario that
      catches.
- [x] The manual in `packages/bridge/reference.mjs` documents it; the
      description names it only if the line it joins does not grow.
- [x] `deno task check` and `deno task test` exit 0, and `deno fmt --check`
      reports nothing beyond the three files this repository has never
      formatted.

## Solution

- `src/main/urls.ts` — the pure part: `matcherFor(pattern)` and
  `describePattern(pattern)`. Its own module because the unit tests reach it
  without Electron, the way `login.ts` and `visits.ts` are reached.
- `src/main/tab.ts` — `waitForUrl(pattern, timeoutMs)` next to `waitForLoad`.
  Listeners go on before the current URL is tested, so an arrival between the
  two is not missed by both. A `VisitLog` records what the page did while the
  wait lasted, and `describeVisits` writes the one line the timeout message
  carries.
- After a match, the document is waited for within whatever is left of the
  caller's budget. A page that never stops loading — a long poll, a tracker —
  must not turn an address that did arrive into a failure, so the budget running
  out returns the URL rather than throwing.
- `src/main/api.ts` — `waitForUrl` wired through `guard`, default timeout
  30 s, the same as `waitForLoad`.
- Tests: an in-page move on `human-walk.html`, a full navigation matched by a
  regular expression with the arrived document read straight afterwards, a page
  already there, a sub-frame move that does not count, and a timeout message.
  Unit tests for the matcher, including a pattern built inside a `vm` context.

### What the tests ended up proving

- `test/fixtures/server.mjs` gained `/drip.html`, a page that commits its
  address with the first byte and writes the paragraph a scenario reads 400 ms
  later. Without it the fixtures are too quick to have a gap between the address
  arriving and the document being readable, so the test would have passed
  whether or not the load was waited out.
- Measured by removing the load wait and running that test: `#where` comes back
  empty instead of `arrived`. The probe fails for the reason under test, not
  before it.
- The full suite is 90 tests and green, the flaky
  "pressing Enter in a field submits the form" included, on the run this work
  was committed from.
