---
date: "2026-09-12"
status: done
implements: []
tags: [agent-browser, naoba, agent-experience]
related_tasks: [naoba-agent-surface-defects]
---
# What ran before the failure

## Goal

A scenario that throws half way through returns the api calls that already ran
and what each of them answered, plus the call that failed, instead of the error
alone.

## Overview

### Current state (verified 2026-09-12)

`runner.ts:69-81` runs the scenario and, on a throw, builds a fresh
`ScriptError` carrying `{ stack, logs }` and `code`. The console output from
before the failure therefore survives; nothing a step *returned* does.
`hub.ts:286` puts that object into the error's `details`, `client.mjs:102`
copies it onto the rejected error, and `packages/bridge/index.mjs:165-172`
prints the stack and the logs. So the channel exists end to end and has room
for one more field.

`buildApi` (`src/main/api.ts:52`) already receives a `log` callback and
`guard` (line 58) calls it with a label for every helper that goes through it —
`fill(#descr)`, `click(#pay) in frame stripe`. That is the panel's channel, and
it is not the trail this needs, for two reasons: `log` fires only *after* the
helper returns, so the failing call is exactly the one it never records, and
eleven helpers call `log` directly while six (`getCookies`, `getTabs`,
`currentTab`, `agents`, `project`, `help`) call neither it nor `guard`.

Where it came from: in the founding session (transcript
`~/.claude/projects/-Users-korchasa-second-brain/5e8b36d2-8c7b-481d-8608-9c406ec98d55.jsonl`)
call 75 clicked one ref and then failed on the next. The click that had already
happened, and the reads before it, came back as nothing, and the scenario was
rebuilt from the start.

### What a step can be

A scenario is arbitrary JavaScript compiled in a `node:vm` context. The runtime
cannot see the value of an expression the scenario never returned — `const rows
= [...]` inside the scenario is invisible, and no trail can recover it. An `api`
call is the one thing the runtime does see: it owns the function object, so it
sees the arguments, the return value and the throw. That is the whole of what is
recoverable without the scenario's cooperation.

This is worth saying to the agent as plainly as it is said here. The trail is a
record of **calls made through `api`**, not of the scenario's own variables.

### How big a trail gets, measured

Across the 74 `evalInBrowser` calls of the founding session, counting `api.<name>(`
occurrences in the scenario source: median 3, mean 2.8, maximum 7; the
distribution is `{0:2, 1:12, 2:20, 3:15, 4:16, 5:7, 6:1, 7:1}`. That is a static
count, so a loop around an api call would run more than it shows; 15 of the 74
scenarios contain a `for`/`while`, and in the ten where an api call follows the
loop keyword at all the names are `navigate`, `eval`, `getText` and `screenshot`
reading as sequential steps after a page-side loop inside an `api.eval` string,
not as loop bodies. Treat 7 as the observed ceiling and not as a guarantee: a
ring is still needed, because a scenario *may* call in a loop and an error
message may not grow without bound.

### Constraints

- The error message an agent reads is charged to its context on every failure.
  Whatever is added has to be bounded, and bounded tightly enough that a
  pathological scenario cannot spend the agent's budget.
- `Object.keys(api)` is compared against the manual by a test in both
  directions, so nothing may add or remove a key. `api.help()` is synchronous
  and must stay synchronous.
- A recorded value has to be serialised when it is recorded, not at the end: a
  DOM-derived object read at step 2 can be different by step 40.

### What this cannot fix

The steps in the trail already happened. A click that submitted a form is not
undone by being listed, and an agent re-running the scenario from the top runs
them a second time. The trail is a record of what was done, never a checkpoint
to resume from, and the text the agent reads has to say so in those words.

## Definition of Done

- [x] A scenario that throws comes back with the api calls that ran before it,
      each with what it answered, plus the call that failed and its reason.
- [x] The record is proved against the page, not against the source: a scenario
      whose earlier steps change the page fails at a known step, and a second
      scenario reads the page back and finds the values the trail recorded —
      including one value the scenario source cannot predict.
- [x] Removing the recording turns that test red.
- [x] The trail is bounded: at most 20 calls listed, the total number of calls
      reported alongside, and every recorded value passed through
      `serialize.ts` with tighter limits, so a value that was cut says it was cut.
- [x] The text an agent reads says the listed calls already happened.
- [x] A scenario that succeeds returns exactly what it returns today.
- [x] `Object.keys(api)` is unchanged and `api.help()` still answers without an
      `await`.
- [x] `deno task check` and `deno task test` are clean, and `deno fmt --check`
      is clean for every file this task touches.

## Solution

### Where the recording sits — three ways, one chosen

- **A. One wrapper around the finished `api` object, inside `runner.ts`.**
  `runner.ts` owns the scenario's outcome, so it owns the record of what the
  scenario did. A new `src/main/trail.ts` holds a `CallTrail` (a ring plus a
  total, the shape `visits.ts` already uses) and a `recordCalls(api, trail)`
  that returns an object with the same keys in the same order, each function
  wrapped to record name, arguments, and outcome. The wrapper calls the helper
  and inspects the result: a thenable is chained, anything else is recorded and
  returned as it is, so `help()` stays synchronous. `api.ts` is untouched, every
  one of the 51 helpers is covered, and a helper added next month is covered
  without a second edit.
- **B. Record inside `api.ts`.** `guard` gains a try/catch that records the
  outcome, and the eleven direct `log` callers each gain a line. Labels stay the
  hand-tuned ones the panel shows (`drag(a → b)`, `screenshot() to path`), which
  is the one thing A gives up. Against it: the six helpers that go through
  neither path stay invisible, every future helper needs the line, and the
  labels then exist in two shapes for two readers — the split that `REF_SELECTOR`
  was created to end.
- **C. The agent opts in** with `api.note(label, value)`. Honest about what a
  runtime can see, and it can capture a scenario's own variables, which neither
  A nor B can. Against it: an agent has to know the helper exists *before* it
  writes the scenario that fails, which is the illness Phase 2 spent a whole run
  curing, and it costs a line of the description budget for a helper that does
  nothing for the agent that never learned it.

**Chosen: A** (the gate, 2026-09-12). C is not a smaller version of A — it recovers nothing at all for
the failure this task is about, because the session that lost call 75 had never
heard of `note`. It could be added later on top of A if a scenario's own
variables ever turn out to be what is missed — but not without that sentence
being said out loud again, because an opt-in helper has to be learned before the
scenario that needs it is written.

Two findings ruled B out rather than one. `log(...)` sits on the line after
`await target.withFrame(...)` in `guard`, so a helper that throws never reaches
it: the failing call is precisely the one that channel can never record. And
`getTabs`, `currentTab` and `getCookies` return directly with no `guard` in
sight.

### The shape that reaches the agent

`ScriptError.detail` gains `trail: { calls, callCount }`, mirroring
`VisitReport`'s `{ visited, visitedCount }`:

- `calls` — the most recent 20, oldest first, each
  `{ step, call, ok, value? , error? }`. `call` is the helper name with its
  arguments rendered short; `value` is the serialised answer of a call that
  returned; `error` is the message of one that threw.
- `callCount` — how many api calls the scenario made in total, so a trail that
  dropped its head says so.

A call that threw and was caught by the scenario is recorded as failed like any
other: that is information the agent has no other channel for. The failing call
is simply the last entry, and it is marked.

`packages/bridge/index.mjs:renderError` prints it under the stack and the
console lines, introduced by a sentence that says the calls already ran.

### Size

Per-value limits of their own — `{ maxDepth: 4, maxStringLength: 1000,
maxArrayLength: 20, maxKeys: 20 }` against `serialize.ts`'s defaults of 8 /
200_000 / 1_000 / 200. A `snapshot()` or a `getText()` in the trail is a
summary, and `toTransferable` already marks a cut string with its full length,
so an agent can tell a truncated read from a short one and ask again. The ring
is 20 against an observed ceiling of 7.

### Whether a successful scenario gets the trail

**No** (the gate, 2026-09-12). A scenario that succeeded returned the value it wanted; the trail would
be charged to every single call for a case where nothing was lost. The argument
for always sending it is that one shape is easier for an agent to learn than
two — but the agent reads the trail in an error, where it is introduced by its
own sentence, and there is nothing to learn in advance. There is a second
reason: a trail that appears only on failure makes its own presence
informative, so an agent learns one rule instead of a shape it has to filter out
of every successful result. Silence on success also keeps `renderOutcome`
exactly as it is.

### What the implementation changed about the plan

- **A call is written down when it starts, not when it comes back.** The plan
  assumed recording on settle. Writing the timeout test showed what that costs:
  a scenario that runs out of time dies *inside* a call, that call never settles,
  and a trail written on settle therefore ends one step early and leaves the
  agent to work out which step was hung. An entry is now created by `begin()` and
  filled in by `returned()`/`failed()`, so a hung call is listed as
  `… still running when the scenario ended`. Numbering at the start is a second
  gain: two calls a scenario ran together are listed in the order it wrote them
  rather than the order they finished in.
- **The scenario's `api` is the function's argument, not the sandbox's global.**
  `runner.ts` compiles the scenario into `(async (api) => {…})` and then calls
  `factory(api)`, so the parameter shadows the global of the same name. Putting
  the recording copy in the sandbox alone changed nothing at all, and the first
  green build was silently a no-op — caught by the integration test in one cycle.
  Both places take it now, with a comment at the call site.
- **The renderer moved to `packages/bridge/render.mjs`.** The sentence an agent
  reads at the moment of failure is the load-bearing part of this change, and
  inside `index.mjs` nothing could assert it. `renderOutcome` and `renderError`
  moved across unchanged; the bridge still parses and still exits cleanly on a
  closed stdin.
- **The helper is called on the original object** (`helper.call(api, …)`).
  No helper uses `this` today, and a wrapper is the wrong place for that to start
  mattering.

### Tests

1. **Integration, the one that matters.** A scenario navigates to the fixture
   page, reads a value out of the page that its own source cannot predict
   (`api.eval` returning a stamp built in the page), fills `#field` with it,
   checks `#check`, and then fails on a selector that matches nothing. The
   assertions: the trail lists those calls with their answers, the last entry is
   the failing one and is marked; then a **second** scenario reads `#field`'s
   value and `#check`'s state off the live page and both equal what the trail
   recorded. That is the trail read back against the effects, not against the
   source.
2. **The reds, and they are two.** With `recordCalls` returning its argument
   untouched, test 1 fails on a missing trail — which proves only that the trail
   exists. The one that matters: with the wrapper recording a plausible `true`
   for a `check()` it never performed, the trail is coherent and the test still
   fails, at `after.value.checked !== check.value` — the page disagreeing with
   the record. A third probe put the recording back on settle, and the timeout
   test went red while the mid-way test stayed green, so the two tests hold two
   different properties. All three taken by copying the file first and restoring
   from the copy, never from git.
3. **Unit.** 25 calls keep the last 20 with `callCount` 25; a value longer than
   the limit comes back marked as cut; a call that threw is recorded with its
   message.
4. **Unchanged surface.** The existing `Object.keys(api)` test and the manual
   comparison already cover the wrapper's key list; add an assertion that
   `api.help()` answers without an `await`.
