---
date: 2026-09-12
status: done
implements: []
tags: [interface, macos]
related_tasks: [where-the-application-shows-itself]
---

# What the Dock icon says

The Dock icon arrived with the choice of where the application shows itself,
and it arrived empty. macOS offers three places on it: a badge, a bounce, and
the right-click menu.

## What belongs there

A badge means "this many things want you", not "this many things are running".
The number of connected agents is therefore wrong for it: agents work without
the person, and a red 3 for three working agents reads as three unanswered
requests. What is right for it is `pendingHuman` — the calls that have stopped
and are waiting for the person, which the menu-bar icon already draws as a
hand.

So the two icons split by meaning rather than by mechanism: the menu bar
carries the background (how many agents are connected), the Dock carries the
request (how many are waiting).

## Solution

`dock.ts` is pure, like `login.ts`: `dockSignal` decides the badge and whether
this is news, and `watchDock` holds the previous count. `main.ts` hands in the
real `app.dock` when the Dock icon is on, and stops the watch when it goes.
The right-click menu is `iconMenu`, extracted from `tray.ts` so both icons
offer the same two items rather than two copies that drift.

A bounce is `informational` — one bounce. `critical` keeps bouncing until the
person switches to the application, which is too much for a browser that sits
there all day.

## Definition of Done

- [x] The badge is the number of calls waiting for the person, and nothing
      when none are.
      Evidence: read `AXStatusLabel` of the Dock's own item on the running
      application — empty, `1` while a call waited, empty after the agent left.
- [x] A call already waiting when the Dock icon appears is drawn but not
      announced.
      Evidence: unit test over `watchDock` with a fake Dock.
- [x] The right-click menu carries the same two items as the menu-bar icon.
      Evidence: `AXShowMenu` on the Dock item lists `Open Electron`,
      `Settings…`, then the system's own items.
- [x] `deno task check` is clean and the whole suite passes.

## Not verified

The bounce itself. Nothing readable reports that a Dock icon bounced, so the
decision is held by a unit test and the call is one line.

## Follow-ups

- The badge sits on Electron's own logo until the application has an icon of
  its own — the same follow-up the presence task carries.
