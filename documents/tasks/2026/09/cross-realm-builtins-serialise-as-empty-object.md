---
date: "2026-09-12"
status: done
implements: []
tags: [agent-browser, naoba, serialize, agent-experience]
related_tasks: [naoba-agent-surface-defects, promise-serialises-as-empty-object]
---
# Five builtins a scenario builds itself come back as {}

## Goal

A scenario that returns an Error, a Date, a RegExp, a Map or a Set it built
itself reads back as that value's marker. Never `{}`, which is the one answer
`src/main/serialize.ts` exists to prevent — its own header says an agent
reading `{}` where a DOM node was "cannot tell a bug from an empty result".

## Overview

`runner.ts:1` compiles an agent's script in a `node:vm` context created with
`createContext`, so every value the script builds belongs to another realm.
`walk()` detects Error, Date, RegExp, Map and Set with `instanceof`, and all
five tests answer `false` across that boundary. None of the five carries own
enumerable keys, so each falls through to plain-object key enumeration and
comes out as `{}`.

Measured in this repository's Node on 2026-09-12, with the values built inside
a `vm` context:

- `new Error('boom')` — tag `[object Error]`, own keys `[]`, `instanceof` false
- `new Date(0)` — tag `[object Date]`, own keys `[]`
- `/x/` — tag `[object RegExp]`, own keys `[]`
- `new Map([[1, 2]])` — tag `[object Map]`, own keys `[]`
- `new Set([1])` — tag `[object Set]`, own keys `[]`
- `[1, 2]` — `Array.isArray` is cross-realm by design, so arrays never broke

This is the same defect the Promise branch had, with the same cure: read the
`Object.prototype.toString` tag, which crosses the boundary, instead of
`instanceof`. `AGENTS.md` records the trap (`a05ff2a`).

### The tag alone cannot be acted on

`Symbol.toStringTag` is writable, so
`Object.prototype.toString.call({ [Symbol.toStringTag]: 'Map' })` answers
`[object Map]`. A Map branch that trusts the tag then runs `value.entries()`
and throws `TypeError: fake.entries is not a function` — and a throw inside
`walk()` loses the **whole** result, not one value. That is strictly worse
than the defect being fixed. Set has the same hole; the Promise branch does
not, because it calls no method on the value.

### Constraints

- `toTransferable` stays synchronous: `runner.ts:render()` calls it inside a
  synchronous `console.log` interceptor, and `tab.ts:241` wraps every
  page-side result.
- Same-realm behaviour must not change — every marker keeps its shape.
- Project isolation is untouched; this is one pure function and its tests.

## Definition of Done

- [x] An Error, Date, RegExp, Map or Set built inside the scenario's own vm
      realm comes back with that value's marker, not `{}`.
- [x] Same-realm values keep exactly the markers they had.
- [x] A plain object wearing a borrowed `Symbol.toStringTag` does not make
      `walk()` throw, and keeps its own keys.
- [x] Tests cover all five cross-realm, the spoofed tag, and the Invalid Date.
- [x] `deno task check` and `deno task test` exit 0.

## Solution

### Variants weighed

**A — tag plus a duck check on what the branch uses (chosen).** Each branch
tests `Object.prototype.toString` and then that the members it is about to
read are actually there: `toISOString` for Date, `source` for RegExp,
`entries` + `Symbol.iterator` for Map, `values` + `Symbol.iterator` for Set, a
string `message` for Error. A spoofed tag misses the members and falls through
to key enumeration, which is what such an object is.

- Nothing throws, and nothing silently loses a data object's keys to a
  borrowed tag.
- The probe is exactly the capability the branch consumes, so the two cannot
  drift apart: a branch that starts calling something new has to probe it.
- The cost is one extra term per branch.

**B — wrap each branch in try/catch and fall back to key enumeration.**

- Catches a deeper spoof too (a fake `entries` that returns junk).
- But it hides a real failure in a real builtin behind an empty object — the
  defect this file exists to prevent, re-entered through the back door — and
  `AGENTS.md` asks for failures to be loud. Rejected.

**C — trust the tag alone, the way the Promise branch does.**

- Smallest diff, and correct for Error, Date and RegExp read as properties.
- But Map and Set call a method, so a borrowed tag turns one bad value into a
  lost scenario. Rejected on that alone.

### Decision

**A.** Taken at the plan gate, 2026-09-12 — the parent prompt delegated this
choice ("a duck check alongside the tag, a guarded branch, or something
better"), so the gate is answered here rather than round-tripped.

One extension beyond the stated defect, called out because it is a change in
behaviour and not only in detection: **an Invalid Date no longer throws.**
`new Date('nonsense').toISOString()` raises `RangeError: Invalid time value`,
which loses the whole result exactly the way a spoofed Map tag does. The
branch now reads `getTime()` first and answers `{ $type: 'date', value: null,
invalid: true }` when the time is not finite. It sits in a line this change
rewrites, it is one term, and a test pins it.

### Steps

1. **RED** — add to `test/unit.test.mjs`: the five builtins built in a
   `node:vm` context, the same five built here, a plain object wearing a
   borrowed `Map`/`Set`/`Date`/`RegExp` tag, and an Invalid Date.
2. **GREEN** — rewrite the five branches in `src/main/serialize.ts` around two
   helpers, `tagIs` and `callable`, with a comment recording why the tag and
   why the probe.
3. **REFACTOR** — fold the Promise branch's realm note into the shared comment
   so the file states the trap once.
4. **CHECK** — `deno task check`, `deno task test`, then `deno fmt --check`
   read past the three files `AGENTS.md` names as long unformatted.

Out of scope: the parent task's Phases 2-5, and whether a scenario that throws
should return its partial results.
