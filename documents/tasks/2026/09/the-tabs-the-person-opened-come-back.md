---
date: "2026-09-19"
status: to do
implements: [FR-PERSIST-3, FR-PERSIST-4]
tags: [agent-browser, naoba, session, restart, person]
related_tasks: [events-in-the-session-nobody-listens-to]
---
# The tabs the person opened come back

## Goal

Quitting the application and opening it again leaves the person where they
were. The pages they had open are open, in the projects they belonged to, and
nobody has to remember an address to get back to work.

## Overview

Three kinds of state cross a restart differently, and only one of them is
broken.

**Logins survive, and that already works.** `before-quit` calls `flushAll`,
which writes each project's cookies and page storage to disk:

```
await this.session.cookies.flushStore()
await this.session.flushStorageData()
```

Measured on 2026-09-19: an account signed in at praktiker.bg was still signed in
after the application was rebuilt on a different major version of Electron and
reinstalled over itself.

**Agent sessions do not survive, and should not.** A session is a live
connection. The application stops, the connections stop, and each agent
reconnects with `begin` and gets a fresh tab. There is nothing to restore.

**Tabs do not survive, and that is the defect.** The list lives in
`ProjectContext` in memory and is never written anywhere. The settings file
holds presence, the disguise switch, the admitted projects and the licence —
no tabs. There is no restoring code in the repository at all. So this is not a
setting somebody switched off; it was never built.

The part that needs deciding rather than coding is which tabs come back. Every
tab records the agent that opened it, and the tabs of an agent that has gone are
closed on a timer on purpose — without that the window fills with pages nobody
is reading. Restoring everything would bring those back and undo that rule, so
the tabs worth restoring are the ones the person opened, where `openedBy` is
null.

## Definition of Done

- [ ] The tabs a person opened come back when the application starts, in the
      projects they belonged to.
- [ ] A tab an agent opened does not come back, and the reason is written down
      beside the code.
- [ ] A project whose window the person never opens is not woken by the restore
      — a browser that loads fifteen projects' pages at login is worse than one
      that forgets.
- [ ] What is written to disk carries an address and nothing else: no page
      contents, no form state, nothing that would put a page's data in a file
      the session store does not protect.
- [ ] A tab whose page cannot be reached at start, or whose address has since
      been refused, does not stop the rest from coming back.
- [ ] An integration test restarts the application against the same state
      directory and proves both halves: the person's tab is back, the agent's
      tab is not.

## Solution

Not decided yet. The mechanics are a list of addresses per project written
beside the settings, and a read of it at start.

Three questions have to be answered first, and the second is the person's call:

- **When is it written.** At quit alone loses everything to a crash or a kill,
  and `flushAll` already shows where that hook is. On every navigation is
  cheap but writes the person's browsing history to disk far more often.
- **Whether a restored tab loads.** A tab that comes back loaded reopens fifteen
  pages at once; a tab that comes back as an address and loads when looked at is
  what a browser usually does, and it needs a placeholder the agents will also
  see.
- **What an agent sees.** A restored tab has no owner, so `tabFor` will not
  hand it to anybody, which is right. Whether it should appear in `status` as an
  ordinary tab, or carry something saying it is from last time, follows from
  what the panel draws.
