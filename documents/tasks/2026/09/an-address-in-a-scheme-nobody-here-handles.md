---
date: "2026-09-19"
status: to do
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

## Definition of Done

- [ ] `mailto:` and `tel:` from a page do what a person clicking them expects.
- [ ] A scheme this browser cannot open never ends as a bare load failure: it is
      either handed on or refused with a message naming the address.
- [ ] Who decides is written down — which schemes go straight through, which
      ask, and which are refused — and the rule is the same for every project.
- [ ] An agent can read from the tab that a link tried to leave for another
      application, and where it was going.
- [ ] `api.navigate` to such an address answers with that same explanation
      instead of throwing `ERR_FAILED`.
- [ ] An integration test covers a page whose link leaves for another scheme.

## Solution

Not decided yet. The mechanics are small — `will-navigate` and the window-open
handler already see the address, and `shell.openExternal` is the handover — and
the whole of the work is in the policy above it.

The one thing that should not be built is a quiet pass-through. A page choosing
which application opens on this machine is a bigger move than a page opening a
window, and this application refuses bigger moves elsewhere. Sending a person's
click to their mail client is uncontroversial; sending an agent's click into an
arbitrary registered scheme is not the same thing, and the rule should be able
to tell the two apart.
