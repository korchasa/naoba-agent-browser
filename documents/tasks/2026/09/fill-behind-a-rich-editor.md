---
date: "2026-09-12"
status: done
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

**B — name the candidate in the error. Chosen by the owner, 2026-09-12.** The message gains a line
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

- [x] `fill` on a zero-size field whose form carries a rich editor either writes
      the value or names, in its error, a frame handle or selector that works.
- [x] The message a field with no editor produces is the one it produces today.
- [x] Tests cover an editor in a frame with an address, an editor in a frame
      with none, a `contenteditable` in the page's own document, and a hidden
      field with nothing over it.
- [x] `deno task check` and `deno task test` exit 0.

## Solution

B, and what decided it beyond the argument above: the route the error names is
not merely measured, it is covered by a green test older than this series —
`test/integration.test.mjs` types into a field inside a frame with
`{frame: 'inner.html'}` and asserts the value landed. So the message hands the
agent a path the suite already proves, not a suggestion.

What settles it against A is the shape of the failure rather than its
likelihood. A `fill` that writes into the wrong layer does not fail loudly: the
value either vanishes at the next redraw or is submitted as something nobody
saw. That is the failure this whole series keeps finding — an answer that looks
like success — and an error message cannot fail that way. C narrows A's guess
and keeps its silent miss in exactly the shape a real form has.

### How it is built

- The lookup hangs off `Tab.focus`, not off `centerOf`. `centerOf` answers for
  every click as well, and its sentence is the one that must not change; `focus`
  is the path `fill` and `type` take, which is where writing a value is the
  question.
- The candidate has to **follow** the field. An editor replaces the field it is
  built from and is inserted after it, and the fixture proves why the rule is
  needed: `#ghost` sits last in a form holding three editors, and without it the
  nearest one is offered for a field nothing is drawn over.
- A candidate must be drawn — it has a size — and a frame must be one this
  browser can look into. A frame from another site answers nothing, and an
  editor nobody can inspect is not a route worth naming.
- The frame is named by its address when it has one, and by its index in
  `frames()` when it does not. A frame inside a frame is in `frames()` and not
  in the page's own count of iframes, so the two orders can part company: an
  index is only named when the frame it lands on is the addressless one the page
  reported, and otherwise the message says to read `frames()`.
- The lookup cannot throw its way over the failure it was improving. It runs
  behind a catch that returns the original error, because the message it was
  about to improve is the one the agent needs.

### What the messages say

- `#descr`, behind a frame with an address: the sentence it gave before, then
  `A rich editor is drawn over it: write into that instead, with fill('body',
  value, {frame: '<the frame's URL>'}). It is the editor that keeps #descr in
  step, so read #descr back afterwards to be sure it did.`
- `#story`, behind a frame a script built: the same, with `{frame: 1}`.
- `#notes`, behind a `contenteditable` in the page's own document:
  `fill('#notes-editor', value)`, with no frame at all.
- `#ghost`, with nothing over it: word for word what it said before, asserted by
  string equality so it cannot drift.

The tests walk each named route afterwards and read the hidden field back, so
the message is only green while what it names actually writes the value.
