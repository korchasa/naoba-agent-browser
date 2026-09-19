---
date: "2026-09-19"
status: to do
implements: [FR-EVENT-1]
tags: [agent-browser, naoba, session, reliability, agent-experience]
related_tasks:
  [
    nobody-is-asked-before-the-microphone-goes-on,
    a-password-prompt-that-never-appears,
    an-address-in-a-scheme-nobody-here-handles,
  ]
---
# Events in the session nobody listens to

## Goal

Know which of the events this application ignores actually cost something, and
close those. The two below are named because nothing listens for them; what they
do here has not been measured, and measuring comes first.

## Overview

Sitting beside the permission, authentication and scheme gaps — each of which
has its own task — are two more events with no listener anywhere in `src/main`.
Both were found by reading the code on 2026-09-19, and neither was put to a
probe, so what follows is a description of what is absent, not of what breaks.

**A certificate this machine does not trust.** Nothing listens for
`certificate-error` and nothing calls `setCertificateVerifyProc`. Electron's
default refuses such a certificate, which would mean a local service over https
with a self-signed certificate, and any internal service behind a private
authority, cannot be opened at all. That is the same population of sites as [a
password prompt that never appears](a-password-prompt-that-never-appears.md) —
staging and internal tooling, which is most of what an engineer's agent is
pointed at. If it does refuse, the useful part is not a blanket exception but a
decision that belongs to the person, once per site.

**A page whose renderer stops answering.** Nothing listens for
`render-process-gone` or for `unresponsive`. A renderer that dies outright
destroys its `WebContents`, and since the popup work of 2026-09-19 the tab goes
with it — `ProjectContext` watches `destroyed` for exactly that. A renderer that
merely stops answering is the uncovered half: the tab stays, it looks ordinary
in the panel, and every call an agent makes against it waits out its own
timeout. An agent has no way to tell that from a slow page.

## Definition of Done

- [ ] Both are measured on the current build, and the measurement is written
      into this file: what a self-signed certificate does, and what a hung
      renderer does to a call.
- [ ] Anything the measurement shows to be harmless is struck from this file
      with the evidence, rather than carried forward as a worry.
- [ ] What the measurement shows to hurt is closed, or split into a task of its
      own if it turns out to be larger than it looks here.
- [ ] Whatever is closed is covered by a test.
- [ ] The rest of the session and application events are read through once, so
      this list is known to be complete rather than merely the part noticed
      while chasing something else.

## Solution

Not decided yet, and deliberately so: writing a handler for an event whose
effect has not been measured is how this application would collect fallbacks
nobody asked for.

The order of work is the Definition of Done's own order. A probe for the
certificate is a local https server with a self-signed certificate and one
`loadURL`. A probe for the hung renderer is a page in a tight infinite loop and
one `api.eval` against it, watching whether the call comes back and what the
panel shows meanwhile.
