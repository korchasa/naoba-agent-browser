---
date: "2026-09-19"
status: to do
implements: []
tags: [agent-browser, naoba, authentication, session, agent-experience]
related_tasks:
  [
    nobody-is-asked-before-the-microphone-goes-on,
    a-passkey-this-browser-cannot-answer,
    events-in-the-session-nobody-listens-to,
  ]
---
# A password prompt that never appears

## Goal

A site behind HTTP authentication opens. The person types the name and the
password once, the project remembers it the way it remembers a cookie, and the
agent working there never meets the wall.

## Overview

Nothing in `src/main` listens for the `login` event, on the application or on a
session. With no listener Electron cancels the authentication, so the page the
server offered as a challenge is the page that stays on screen. Measured on
2026-09-19 against a local server answering `401` with
`WWW-Authenticate: Basic realm="probe"`: the tab finished loading and its title
was `401`. No window appeared, and nothing was written anywhere.

This is the same complaint as the one that started this line of work — signing
in does not work on a site — arriving through a different door, and it is worse
in one way. A sign-in form at least tells the person what to do. Here there is
no form and no dialog: the agent reads a page that says it is unauthorised and
has no move to make. `requestHuman` does not rescue it either, because the
person handed the tab sees the same wall.

Two kinds of site sit behind this: internal and staging services, which is most
of what an engineer's agent is pointed at, and a proxy that authenticates.
`event: 'login'` covers both — the `authInfo` argument says which, through
`isProxy`.

## Definition of Done

- [ ] A page behind HTTP Basic or Digest can be opened by a person working in
      the window.
- [ ] What the person typed survives the rest of the session, and survives a
      restart of the application, per project — the same promise cookies carry.
- [ ] An agent that meets such a page is told what happened, in words that name
      the next move, instead of reading a page that says 401.
- [ ] A proxy that authenticates is handled too, and told apart from a site
      that does.
- [ ] Nothing that was typed reaches a log, a snapshot, or a command trail.
- [ ] An integration test covers a page behind Basic, against the fixture
      server.

## Solution

Not decided yet. The event is `login` on the `WebContents` or on `app`, and it
is one listener; the work is in what happens after it fires.

The awkward part is that the credentials have to come from a person, and this
window is usually off screen. `requestHuman` already knows how to bring it
forward and wait, so the likely shape is: the challenge arrives, the tab is
handed to the person with the realm named in the reason, and a small window of
this application's own takes the two fields. A page of the site cannot take
them, because the request is the browser's, not the page's.

Where they are kept afterwards needs deciding. The session's own store is the
obvious home, but Electron gives no place for HTTP credentials the way it does
for cookies, so this would be the application's own record, per project, and it
holds a password — which makes the keychain the first thing to look at rather
than a file beside the session.
