---
date: "2026-09-12"
status: done
implements: []
tags: [agent-browser, naoba, serialize, agent-experience]
related_tasks: [naoba-agent-surface-defects]
---
# A forgotten await comes back named, not as {}

## Goal

An agent that returns a Promise from its scenario — `return { url:
api.getUrl() }` without the `await` — reads back something that names the
mistake and says what to do about it. Never `{}`, which reads as "the browser
had no URL for me".

## Overview

`src/main/serialize.ts` opens by stating the principle it exists for: a value
that cannot make the trip to the agent's IDE is replaced by a marker saying
what was there, "because an agent reading `{}` where a DOM node was cannot tell
a bug from an empty result." `walk()` keeps that promise for `undefined`,
bigint, symbol, function, non-finite numbers, over-long strings, cycles, max
depth, Error, Date, RegExp, Map, Set, Array and ArrayBuffer — and then falls
through to plain-object key enumeration at line 87. A Promise has no own
enumerable keys, so it comes out of that loop as `{}`. There is no Promise
branch.

The cost is measured, not hypothetical. In the session recorded by the parent
task the agent wrote `api.getUrl()` without `await` 18 times and got
`"url": {}` back in 16 results; at call 70 that made it conclude a URL did not
exist when it simply did not know where it was.

### What a correct detection has to catch

`value instanceof Promise` is not enough here, and the reason is structural.
`runner.ts` compiles the scenario inside a `node:vm` context
(`createContext`), which has its own intrinsics — so a Promise the scenario
creates itself is a *different realm's* Promise and fails `instanceof` in the
main realm. Measured in this repository's own Node:

```
const c = createContext({})
const p = new Script('(async()=>1)()').runInContext(c)
p instanceof Promise                      // false
typeof p.then === 'function'              // true
Object.prototype.toString.call(p)         // '[object Promise]'
```

`api.getUrl()` happens to return a main-realm Promise, because `api` is a
main-realm object — so `instanceof` would pass the one test the Definition of
Done names and still miss `return { x: (async () => 1)() }`. Detection is by
`Object.prototype.toString` tag plus a `then` duck-type, which covers both
realms and any thenable. A plain object carrying a `then` method is by
specification a thenable — `await` would unwrap it too — so naming it a promise
is the right answer, not a false positive.

### Where the branch goes

Before the plain-object enumeration and after the cycle and depth guards, next
to the Date and RegExp branches. A Promise reached below `maxDepth` should keep
reporting `max-depth`; nothing about this changes the limits.

### Constraints

- `toTransferable` is called from three places, and one of them cannot wait:
  `runner.ts:render()` serialises console arguments inside a synchronous
  `console.log` interceptor, and `tab.ts:241` wraps every page-side result.
  Any variant that makes serialisation asynchronous has to split that path.
- Project isolation is untouched — this is one pure function and its tests.

## Definition of Done

- [x] Returning a Promise from a scenario comes back as a named marker saying to
      await it, never as `{}`.
- [x] The detection catches a Promise created inside the scenario's own vm
      realm, not only one handed back by `api`.
- [x] A unit test covers `return { url: api.getUrl() }` — the exact shape the
      session got wrong 18 times.
- [x] `deno task check` and `deno task test` exit 0.

## Solution

### Variants weighed

The parent task asks for this choice to be made on purpose. Both options beat
`{}`; they differ in whether the agent is told about its mistake.

**A — a marker (recommended).** `walk()` returns
`{ $type: 'promise', hint: 'not awaited — this helper is async, write await api.…()' }`.

- The agent sees its own mistake in the result, at the key where it was made,
  and fixes the scenario. Matches the principle the file's own header states.
- `toTransferable` stays synchronous, so the console-log path and the page-side
  path at `tab.ts:241` are untouched. The change is one branch and its tests.
- The cost: the agent still loses that call's value and re-runs the scenario
  once. That round-trip is the honest price of the bug, and it is one round
  trip rather than the sixteen wrong answers the session actually got.

**B — await the value.** `toTransferable` becomes async and unwraps a promise
before serialising.

- Kinder in the moment: the scenario works despite the missing `await`.
- Four costs, and they compound. The mistake is hidden, so the agent keeps
  writing it — including in places where it matters more than a URL. The
  scenario's work then happens *after* the run's deadline has been waited on,
  so a pending promise either hangs the result forever or needs a second
  timeout of its own, and a rejected one needs a failure path that today
  belongs to the scenario. `render()` cannot await, so serialisation splits
  into a sync form and an async form that disagree about promises. And a
  helper awaited late may act on a tab whose lease the scenario has already
  let go.

**C — marker plus a run-level warning.** A, and additionally the runner appends
a line to `logs` when any promise was marked, so an agent that does not inspect
the value deeply still sees it.

- Catches the case where the marker is nested somewhere the agent skims past.
- Costs a mutable counter threaded out of the pure `walk()`, and touches
  `runner.ts` as well — more surface than the defect needs, and the marker sits
  at the key the agent is already reading.

### Decision (taken at the plan gate, 2026-09-12)

**A — the marker.** `toTransferable` stays synchronous, so neither the console
path in `runner.ts:render()` nor the page-side path at `tab.ts:241` changes.

Two things the decision pins, because the Definition of Done as the parent task
words it would let a half-fix through:

- **Both realms are tested, not just the named shape.** The named test,
  `return { url: api.getUrl() }`, hands back a *host-realm* promise, because
  `api` is a host-realm object — so an `instanceof Promise` check would pass
  that exact test and still miss `return { x: (async () => 1)() }`, which the
  scenario builds inside its own vm context. The test covers both.
- **A thenable that is not a promise gets the same marker.** `await` unwraps
  anything with a callable `then`, so returning one un-awaited is the same
  mistake and deserves the same answer. The cost is that an object whose
  callable `then` is meant as data reads as a promise; that object is a thenable
  by specification, and the alternative — leaving it to key enumeration — is how
  a prototype-only thenable comes back as `{}` again. A `then` that is not
  callable stays ordinary data, and a test pins both sides.

### Steps (assuming A)

1. **RED** — add to `test/unit.test.mjs`: `toTransferable({ url: promise })`
   for a main-realm promise (the `api.getUrl()` shape), a promise created in a
   `node:vm` context (the cross-realm shape), a bare thenable, and a plain
   object with a `then` *string* property, which must still serialise as data.
2. **GREEN** — in `src/main/serialize.ts`, add the branch beside Date and
   RegExp, with a short comment recording *why* the tag-plus-duck-type test and
   not `instanceof` (the vm realm), since that is exactly the trap a later
   simplification would walk back into.
3. **REFACTOR** — nothing expected; the branch is four lines.
4. **CHECK** — `deno task check`, then the suite, then `deno fmt --check`
   reading past the three files `AGENTS.md` names as long unformatted.

Out of scope: everything else in the parent task's Phases 2-5, and the wider
question of whether a scenario that throws should return its partial results.
