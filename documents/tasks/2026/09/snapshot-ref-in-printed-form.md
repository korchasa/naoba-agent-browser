---
date: "2026-09-12"
status: done
implements: []
tags: [agent-browser, naoba, snapshot, agent-experience]
related_tasks: [naoba-agent-surface-defects]
---
# A snapshot ref works in the form snapshot() prints it

## Goal

An agent copies a ref out of `snapshot()` and passes it straight back to
`click`, `fill` or any other helper, in the form it was printed — `[ref_12]` —
and it resolves. When the ref no longer exists, the agent is told the snapshot
is stale, not that its selector matched nothing.

## Overview

`snapshot()` renders an interactive node as `button "Press me" [ref_7]`
(`src/main/api.ts:592`), and the manual the agent reads says in as many words
that "every clickable node carries a `[ref_N]` you can pass anywhere a selector
is taken" (`packages/bridge/tools.mjs:12`, again at line 29 for `drag`). The
resolver takes only the bare token: `__abQuery` tests `/^ref_\d+$/` and
otherwise hands the string to `document.querySelector`
(`src/main/tab.ts:310`), where `[ref_12]` reads as an attribute selector for an
attribute named `ref_12` — which no page has, so it matches nothing, ever.

So the documented form is the one form that cannot work. The diagnostic written
for exactly this case is lost with it: `#nothingMatched`
(`src/main/tab.ts:582`) gates the "a ref belongs to the snapshot that produced
it" message on the same bare-token test, so the printed form falls through to
the generic "no element matched" and the agent goes hunting through a selector
that was right all along.

Measured cost in one real session (transcript
`~/.claude/projects/-Users-korchasa-second-brain/5e8b36d2-8c7b-481d-8608-9c406ec98d55.jsonl`,
2026-09-11/12): all 4 ref uses were bracketed, all 4 failed, and the agent then
abandoned `snapshot()` — 50 of its 74 browser calls carry a hand-written
`querySelectorAll`.

### Where the two forms can still diverge

Making `__abQuery` accept both is not by itself enough for the two forms to
behave identically. `centerOf` (`src/main/tab.ts:330-350`) counts how many
elements answer to the selector, to explain a match that has no size. It does
that with `document.querySelectorAll(sel)`: a bare `ref_7` throws there and is
swallowed by the `catch`, leaving `matches = 1`, while `[ref_7]` is a valid
selector that matches 0 — so the same dead-size element produces two different
sentences depending on which form was typed. A ref resolves to exactly one
node, and the count should say so for both forms.

### Constraints

- One definition of what a ref looks like. The pattern already exists twice and
  the two copies are what let the diagnostic drift away from the resolver; a
  third copy repeats the defect.
- Page-side helpers are defined per call, never installed once — a single-page
  application replaces the document without reloading.
- Nothing here touches the project session or its isolation.

## Definition of Done

- [x] `api.click('[ref_7]')` and `api.click('ref_7')` behave identically, and
      so does every other helper that takes a selector.
- [x] A ref that no longer exists reports the snapshot-is-stale message, for
      both the bracketed and the bare form.
- [x] Tests cover both forms resolving against the fixture page, and a dead ref
      in both forms.
- [x] `deno task check` and `deno task test` exit 0.

## Solution

1. **RED.** In `test/integration.test.mjs`, widen the two existing ref tests to
   run over both forms: "a snapshot ref can be used wherever a selector can"
   clicks the ref as `ref_N` and as `[ref_N]`, and "a ref from a snapshot the
   page has replaced says so" asserts the stale-ref sentence for both. Both new
   halves fail today.
2. **GREEN.** Put one `REF_SELECTOR` pattern in `src/main/tab.ts`, matching
   either form and capturing the index. Use it main-side in `#nothingMatched`,
   and interpolate its source into the per-call page-side preamble so
   `__abQuery` cannot drift from it.
3. Give the preamble a `__abRefIndex` (the ref's index, or null) and an
   `__abAll` (every node a selector answers to — exactly the one node for a
   ref), and have `centerOf` count through `__abAll`, so the "has no size"
   sentence is the same for both forms.
4. **CHECK.** `deno task check`, then `deno task test`.

Out of scope, and left to the runs scheduled after this one: the Promise
marker in `src/main/serialize.ts`, the truncated `evalInBrowser` description,
file upload, `requestHuman` reporting, and the `fill`/partial-result edges.
