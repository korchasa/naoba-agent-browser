---
date: "2026-09-19"
status: to do
implements: [FR-PERMISSION-1]
tags: [agent-browser, naoba, permissions, safety, session]
related_tasks:
  [
    a-permission-that-answers-neither-way,
    a-password-prompt-that-never-appears,
    a-passkey-this-browser-cannot-answer,
    events-in-the-session-nobody-listens-to,
  ]
---
# Nobody is asked before the microphone goes on

## Goal

A page cannot switch on the microphone, the camera, or read the system
clipboard because it asked nicely. Whoever is allowed to decide — the person, or
a rule written down in advance — decides, and a page that is refused is told so
rather than left waiting.

## Overview

Nothing in `src/main` calls `setPermissionRequestHandler` or
`setPermissionCheckHandler`, and with no handler Electron approves every request
a page makes. Measured on 2026-09-19 against a plain page in this application's
own webPreferences:

```
Notification.requestPermission()                → "granted"
navigator.mediaDevices.getUserMedia({audio:1})  → granted
navigator.permissions.query(clipboard-read)     → "granted"
```

Nobody was asked, and nothing was recorded. This matters more here than it would
in an ordinary browser for two reasons. The window normally sits off screen in
the menu bar, so there is nobody watching to notice a microphone indicator. And
this browser is the one that holds the person's real logged-in sessions, driven
by an agent across sites the agent chose — so the page doing the asking is
routinely not a page the person opened.

The clipboard is the sharpest of the three. A system clipboard on a working
machine holds whatever was copied last, and that is often a password or a key.

Geolocation is a fourth request and behaves differently enough to have its own
task; see [a permission that answers neither
way](a-permission-that-answers-neither-way.md).

## Definition of Done

- [ ] Every permission a page can request is measured on the current build, and
      the measurement is written into this file — approved, refused, or hanging.
- [ ] The application answers permission requests itself rather than leaving
      Electron's default in place.
- [ ] The rule for each permission is written down here with its reason, and it
      is the same rule for every project.
- [ ] A page that is refused learns it is refused, promptly. Nothing is left to
      wait on an answer that never comes.
- [ ] An agent can see what a page asked for and what it got, the way it sees
      the console and the network.
- [ ] A unit test covers the decision, and an integration test proves a real
      page is refused.

## Solution

Not decided yet. The shape of the work is one handler in `ProjectContext`,
beside the `will-download` handler that already lives there, because the
decision belongs to the session and every tab of a project shares one.

What has to be settled before the code is written is the policy, and it is the
person's call rather than the agent's:

- Refuse everything by default and let the person turn a permission on for a
  site, the way a browser does. Safest, and it means an agent working
  unattended is stopped by a page that wants the camera.
- Refuse the dangerous ones — microphone, camera, clipboard read, geolocation —
  and allow the harmless ones. Needs a defensible line between the two.
- Ask the person through `requestHuman`, which already exists for exactly this
  kind of handover. Right when somebody is there, useless at three in the
  morning.

Whichever is chosen, the refusal has to reach the page as a refusal. A request
left unanswered is what the geolocation task is about, and it is worse than a
denial: the scenario stops with no error to read.
