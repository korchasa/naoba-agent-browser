---
date: "2026-09-12"
status: to do
implements: []
tags: [agent-browser, naoba, agent-experience]
related_tasks: [naoba-agent-surface-defects, putting-a-file-into-a-form]
---
# fill cannot reach a field behind a rich editor

## Goal

An agent filling a description field on a page with a rich editor either gets
the value written, or gets told in one line where to write it. What it must not
get is today's answer, which is the same sentence a page with no editor at all
gives.

## Overview

`fill` focuses, selects all and inserts (`src/main/api.ts:112`). The focus goes
through the click path, which refuses an element with no size
(`src/main/tab.ts:401`). On Bazar.bg the description field `#descr` is a
`textarea` the page hides, with the editor drawn over it in `#redactorIframe`,
so the call failed and the agent wrote into the frame's document by hand and
mirrored the HTML back into the hidden textarea itself (calls 104-106 of the
session this series comes from).

The error message is not the defect. It named the cause, which is why the agent
could act at all, and it must survive whatever is done here.

### Measured 2026-09-12, on a fixture built to the same shape

A page with a hidden `textarea#descr` behind an editor frame, a hidden
`textarea#notes` behind a `contenteditable` in the same document, a hidden
`textarea#story` behind a frame the page's own script built, and a hidden
`input#ghost` with nothing over it:

- `api.fill('#descr', …)` — `element #descr has no size, so it cannot be
  clicked: nothing matching it is visible on the page right now`.
- `api.fill('#ghost', …)` — the same sentence, word for word. The message
  cannot tell the agent whether there is an editor to try, which is the whole
  difference between a dead end and a next step.
- `api.fill('body', …, {frame: 'editor-frame.html'})` — **works today**. The
  editor's document receives the text as an event it reads as `isTrusted: true`,
  and the editor syncs the hidden textarea itself, exactly as it does for a
  person typing.
- The frame a script builds reports `about:blank` and an empty name, so
  `{frame: 'story'}` cannot reach it — `{frame: 1}`, its index in `frames()`,
  can, and writes through the same way. Whatever the error names has to be a
  handle that works: the index always, the address when there is one.
- `api.fill('#notes-editor', …)` already works, because a `contenteditable`
  drawn on the page has size. The defect is only about the hidden field.

So the next step costs the agent exactly one call, and it is a call the surface
already supports.

## Variants weighed

**A — write into the editor for the agent.** `fill` on a zero-size field looks
for the editor surface over it and types there, through the same real input
path. The kinder outcome, and the riskier one: the editor keeps its own model of
the document, and a value written into the wrong layer either does not survive
the page's next redraw or is submitted as something the person never saw. The
risk is not in the typing — typing into the editor's own surface is what a
person does — it is in the guess about which surface belongs to which field. A
form with two hidden fields and two editors, which the fixture above has on
purpose, is decided by proximity and nothing else.

**B — name the candidate in the error.** Recommended. The message gains a line
naming the editor surface it found and the call to reach it, and stays the
message it is today when there is none. Always honest, never writes anywhere
the agent did not ask for, costs one round trip, and the route it names is
measured above as working.

**C — write when the field and the editor are unambiguously paired, name the
candidates otherwise.** A has all its risk in one guess, so C bounds the guess:
write only when exactly one editor surface follows the field inside its form,
and say where the value went. It keeps a silent misfire possible in one shape —
one hidden field and one editor in a form where they are not each other's — and
that shape is common enough that the bound is weaker than it reads.

## Definition of Done

- [ ] `fill` on a zero-size field whose form carries a rich editor either writes
      the value or names, in its error, a frame handle or selector that works.
- [ ] The message a field with no editor produces is the one it produces today.
- [ ] Tests cover an editor in a frame with an address, an editor in a frame
      with none, a `contenteditable` in the page's own document, and a hidden
      field with nothing over it.
- [ ] `deno task check` and `deno task test` exit 0.

## Solution

Settled once the variant is chosen. The fixture the measurements above were
taken on is not in the tree yet; it comes back with the tests.
