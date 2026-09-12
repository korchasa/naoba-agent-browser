---
date: "2026-09-12"
status: done
implements: []
tags: [agent-browser, naoba, agent-experience]
related_tasks: [naoba-agent-surface-defects]
---
# What the person did while holding the tab

## Goal

An agent that hands the tab to a person gets back an account of what happened
while they held it — where the page went, in what order, and how long the hold
lasted — instead of only the state it ended in.

## Overview

`api.requestHuman` brings the window forward, hands the tab over, waits, and
returns `{url, title}` (`src/main/api.ts:497-536`). That is the state at the
end with no account of how it got there.

In the session this series comes from (transcript
`~/.claude/projects/-Users-korchasa-second-brain/5e8b36d2-8c7b-481d-8608-9c406ec98d55.jsonl`,
2026-09-11/12) call 124 asked the person to attach photographs to a Bazar.bg
listing and explicitly asked them *not* to publish it. The person attached the
photographs, filled in the rest of the form and published. The agent noticed
only because the URL it read afterwards had changed to
`/ads/promo/56036876?origin=save`, and calls 125 to 131 went into working out
what had happened to its own listing. The photograph half of that story is
closed — `api.setFiles` landed in `4376354` — but `requestHuman` is still how a
person signs in, solves a challenge, or does the thing the agent must not, and
every one of those hands the page to somebody whose steps the agent cannot see.

### What is already here

- Every tab already emits what is needed. `src/main/context.ts:183-189` wires
  `page-title-updated`, `did-navigate`, `did-navigate-in-page` and
  `did-stop-loading` on each tab for the panel's sake. Nothing stores them.
- The hold has exact boundaries inside `requestHuman`:
  `context.leases.takeOver(target.id, {kind: 'human'})` opens it and
  `context.leases.release(target.id, {kind: 'human'})` closes it, with
  `context.pendingHuman` holding the promise in between.
- `did-navigate` is main-frame only; `did-navigate-in-page` is not — its
  listener takes `(event, url, isMainFrame, …)`
  (`node_modules/electron/electron.d.ts:15921`). An advertisement iframe calling
  `pushState` would otherwise land in the person's record, so the flag has to be
  read.

### The three exits, measured

`requestHuman` ends in `done`, `cancelled` or `timeout`, and the last two throw.
They are not equally reachable:

- **`timeout`** is real and the caller is alive to read it: nobody pressed the
  button within `options.timeout` (ten minutes by default). This is the exit
  where the account matters most — the agent has to decide whether to retry,
  and whether the page moved at all while it waited.
- **`cancelled`** has exactly one producer in the whole application:
  `ProjectContext.removeAgent` resolves every pending request of an agent that
  has *disconnected* (`src/main/context.ts:300-305`). So the error is thrown
  into a script whose connection is already gone; nothing reads it. Verified by
  grep — `'cancelled'` appears in `api.ts` and that loop, nowhere else.

What crosses the wire from a thrown error is the message and `code`:
`runner.ts:76-80` rebuilds it as a `ScriptError` carrying only `stack` and
`logs`, and `hub.ts:286` sends that as `details`. A record hung on the error
object therefore reaches a scenario that catches it — property access across the
`node:vm` boundary is ordinary, unlike `instanceof` — but not one that lets it
escape. So the error needs both: the record as properties, and the essentials
folded into the message.

**Left alone on purpose.** A timeout does not release the person's lease
(`api.ts:528-530` throws before the release), so the tab stays theirs. That
reads like a defect until you ask what the alternative is: the timeout means the
person is *still working*, and taking the tab back from under them is the one
thing the lease exists to prevent. The panel already has the person's own way
out (`ab:release`, `src/main/main.ts:411`). Recorded, not changed.

### How this gets tested

The thing under observation is a person, and a test has no hands. Two facts make
it testable anyway:

- The person's side of the hold is already reachable from a test:
  `test:human-done` in `src/main/hub.ts:379` exists for exactly this and is
  refused unless the app was started with `--admit-everything`.
- Nothing else may drive the held tab. Another agent that selects it is refused
  by `#waitForTab` with "the person at the keyboard is using this tab"
  (`hub.ts:398-410`), which is correct and inconvenient. So the navigations must
  come from the page itself: a fixture that walks its own URL on timers is the
  honest emulation of a person clicking through a form, and it produces both
  kinds of event — `history.pushState` for the steps, then a real load.

Determinism comes from the second agent: it polls `api.getTabs()` (allowed while
the person holds the tab — the existing hand-over test already does it) until
the held tab's URL is the last one in the walk, and only then presses the door.

### Constraints

- Nothing here touches the project's session or its isolation.
- The `evalInBrowser` description is a budget (`AGENTS.md`); this change adds no
  helper, so it earns a line in `MANUAL` and nothing in the description. The
  return value reaches the agent by itself, which is the whole point of putting
  the account there rather than in a new helper.
- `documentedNames()` stays at 52: no new name.
- Comments explain why. The reasoning about cancel and about the lease on
  timeout belongs at the code, not only here.

### What the tests answered (2026-09-12)

Both facts below were measured by breaking the code on purpose and watching the
new test fail, because a test that has never been red proves nothing.

- **A sub-frame's `pushState` does reach the tab.** With the `isMainFrame` check
  removed, the walk came back as four steps instead of three, the extra one
  being `in-page /walk-frame.html?frame=moved` — an iframe's move recorded as
  something the person did.
- **Chromium fires `did-navigate-in-page` again for a `pushState` to the very
  same URL.** With the collapse rule removed, `?step=photos` appeared twice.
  So the collapse is load-bearing end to end, not only in the unit test.
- **A timed-out hold poisons the tab for everybody else, and that is the
  decision above showing its cost.** The first full run failed a later,
  unrelated test with "the person at the keyboard is using this tab": an agent
  that closes its own tab inherits the project's last open one
  (`ProjectContext.closeTab`), which was the tab the timeout test had left with
  the person. The test now closes that tab itself. The product behaviour is
  unchanged on purpose — the person is still working, and the panel has their
  own way to hand it back.
- **One failure in the suite is older than this change.** "pressing Enter in a
  field submits the form" went red three times out of ten runs here — once in a
  full suite, once in three runs by name, and once in four runs by name inside a
  `git worktree` of `9bbb1e2`, where the code was untouched. It then went green
  eleven consecutive times when the owner re-measured it, so the "one in three
  or four" this file first claimed was an overstatement drawn from one failure:
  all three reds fall inside this one session, and no rate is quotable from
  that. Nothing in this change touches that path. Not fixed here, and worth its
  own look.

## Definition of Done

- [x] `api.requestHuman` returns, besides `url` and `title`, the navigations the
      held tab made while the person had it and how long the hold lasted.
- [x] An in-page navigation counts, because that is how a single-page form moves
      between steps and is exactly what happened on Bazar.bg. A sub-frame's
      in-page navigation does not.
- [x] A person who did nothing gets an empty list rather than a missing field,
      so "they did not publish it" is a readable answer.
- [x] The list cannot grow without bound, and the agent can tell when it was cut.
- [x] A `timeout` carries the same account: on the thrown error as properties,
      and in its message far enough that an agent that does not catch it still
      learns the page moved.
- [x] Tests prove it: a hold with a full-page and two in-page navigations, a
      hold where nothing moves, a sub-frame navigation that is not recorded, the
      cap, and the timeout record.
- [x] The manual entry in `packages/bridge/reference.mjs` says what comes back.
- [x] `deno task check` and `deno task test` exit 0, and `deno fmt --check`
      reports nothing beyond the three files this repository has never
      formatted.

## Solution

### Decisions taken at the gate (owner, 2026-09-12: A, A, A)

1. **What counts as an event.** *Chosen.* main-frame `did-navigate` and
   main-frame `did-navigate-in-page`, and nothing else. A title change on the
   same URL is rejected as an entry: pages rewrite titles for unread counters
   and clocks, so it is the noisiest signal available, and the one title that
   answers a question — the one the person left behind — is already returned.
   The rejected alternative is to record title changes too, which reads well on
   a wizard that renames its step and floods on a webmail tab.
2. **The three exits.** *Chosen.* keep both throws exactly as they are, and
   attach the record to the error object as well as folding a one-line summary
   into its message. Changing `timeout` into a returned value would break every
   scenario that relies on the throw, for a case the scenario can already handle
   with `catch`. `cancelled` gets the same attachment for one line of code, with
   a comment saying why nothing will read it.
3. **How much to return.** *Chosen.* the most recent 20 entries plus the
   total count, recorded into a ring so a person browsing for an hour costs
   nothing. The tail is the half that matters: the agent already knows where it
   handed the tab over, because it navigated there itself, and what it needs to
   know is where the person ended up and by what route.

### Steps

1. **RED.** A fixture `test/fixtures/human-walk.html` that walks itself:
   `pushState` twice, then a real load of `second.html`, and an iframe whose
   document calls `pushState` too. Integration tests in
   `test/integration.test.mjs`: the walk recorded in order with the right kinds,
   the final URL and title, a hold with no movement, the sub-frame's step
   absent, and a `timeout` whose error carries the record. Unit tests in
   `test/unit.test.mjs` for the recorder alone: the cap, the total, the offsets,
   and the collapse of a repeated identical step.
2. **GREEN, the recorder.** A new `src/main/visits.ts` — pure, no Electron, like
   `files.ts` — holding the ring, the collapse rule and the report it renders.
3. **GREEN, the wiring.** `requestHuman` subscribes to the two events on the
   held tab before the takeover and unsubscribes in a `finally`, so no exit
   leaks a listener, and builds the record for all three outcomes.
4. **GREEN, the manual.** The `requestHuman` entry in `MANUAL` says what the
   return carries.
5. **CHECK.** `deno task check`, the new tests by name, `deno task test`,
   `deno fmt --check`.
