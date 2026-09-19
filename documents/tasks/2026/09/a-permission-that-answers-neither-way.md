---
date: "2026-09-19"
status: to do
implements: []
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

It reads to the agent as a page that will not finish loading, and the cause is
nowhere near the page. The same shape hides in every permission this application
does not answer — see [nobody is asked before the microphone goes
on](nobody-is-asked-before-the-microphone-goes-on.md) — but geolocation is the
one measured hanging, so it is written down on its own.

A refusal is a real answer here, and probably the right one. This browser drives
somebody else's sessions from a machine in one place; a site that wants a
location can have a denial promptly and fall back to asking.

## Definition of Done

- [ ] The cause is pinned rather than assumed: the request is traced far enough
      to say whether it is the missing location service or something above it.
- [ ] A page asking for a location gets a settled answer within a second or two,
      whatever that answer is.
- [ ] An agent can tell from the tab that a page asked and was refused.
- [ ] Every other permission is checked for the same silence, and what each one
      does is written down.
- [ ] An integration test proves a page's own geolocation callback runs.

## Solution

Not decided yet, and it should not be settled separately from [nobody is asked
before the microphone goes on](nobody-is-asked-before-the-microphone-goes-on.md)
— both are answered by the same handler, and splitting them would mean writing
that handler twice.

The likely answer is that geolocation is refused outright, which turns a hang
into an error the page already knows how to handle. If a location ever has to be
supplied, it belongs in the project's settings as a fixed pair of coordinates
rather than as a lookup, because a lookup puts this machine's whereabouts in
front of every site an agent visits.
