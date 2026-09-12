---
date: "2026-09-12"
status: done
implements: []
tags: [agent-browser, naoba, mcp, agent-experience]
related_tasks: [naoba-agent-surface-defects, snapshot-ref-in-printed-form]
---
# Half the manual never reaches the agent

## Goal

The `evalInBrowser` description arrives whole, and the part that arrives names
the way to read the rest. An agent should never have to guess a helper name, and
never have to learn the real surface by running `Object.keys(api)` after the
work is done.

## Overview

`packages/bridge/tools.mjs` builds the whole helper reference into the
`evalInBrowser` description, on the bet stated in its own header: an agent that
guesses helper names round-trips once per guess. The client truncates the
description at about 2040 characters and appends `… [truncated]`, so the bet
does not pay.

Measured here on 2026-09-12, on the file as it stands: the assembled description
is 3922 characters, and the cut lands inside the *Frames* paragraph. What never
arrives is *Moving around* (`navigate`, `goBack`, `goForward`, `reload`,
`waitForLoad`, the tab helpers), *State* (cookies, storage, `screenshot`,
`resize`), *Watching* (console, network, dialogs), *Working next to other agents
and next to the person* (`claimTab`, `requestHuman`, `agents`, `project`,
`sleep`) and the closing notes.

The cost, from the session in the parent task: 74 browser calls, 281 s of
hand-written `setTimeout` pauses — 48% of machine time — with `api.sleep` and
`api.waitForLoad` used zero times, because neither ever reached the agent.

### The architectural fact this runs into

The bridge and the application share no code. `packages/bridge/` is a standalone
Node package of plain `.mjs` files that an IDE launches; it reaches the app over
a socket, and `electron-builder.yml` deliberately keeps it out of the app
bundle. `api.help()` would run in the main process (`src/main/api.ts`), which
today cannot read `tools.mjs` at all. So "one source" and "`api.help()` returns
the full reference" pull against each other, and settling that is the decision
this task turns on.

### Variant 1 — where the reference text lives — chosen: A

- **A. A shared data module both sides import** (`packages/bridge/reference.mjs`).
  The bridge imports it directly; the main process imports it too and esbuild
  bundles it into `dist/main.js`. Probed here on 2026-09-12: `tsc` rejects the
  import with TS7016 until `allowJs` is on, and with `"allowJs": true` the
  whole typecheck is clean, so the cost is one line of `tsconfig.json` and no
  parallel declaration file. Drift inside one checkout is impossible. Across
  versions — an installed app older than the bridge in the checkout — each side
  answers from its own build, which is the honest answer: `api.help()` then
  describes the helpers the running app actually has, while the description is
  only a pointer.
- **B. The app owns the text and the bridge asks for it over the socket.** The
  bridge answers `tools/list` at startup, before it has ever connected;
  fetching the text there would make listing tools launch the browser. An IDE
  lists tools on every start.
- **C. Duplicate the text on both sides.** The defect this task exists to
  prevent, in a new place.

The direction of the dependency settles it as much as the drift does: the IDE
launches the bridge on its own, so whatever the bridge needs has to ship inside
`packages/bridge/`. The application is the side that can reach out — esbuild
bundles the module into `dist/main.js` — and `electron-builder.yml` never has to
carry the bridge.

### Variant 2 — what survives in the description — chosen: A

- **A. A pointer plus the handful an agent needs before it can ask for more**
  (~1300 characters): the shape of a scenario, `api.help()` and
  `Object.keys(api)`, `navigate`/`snapshot`/`getText`/`click`/`fill`/`type`,
  `waitFor`, `sleep`, `requestHuman`, the `{frame}` option, and the `[ref_N]`
  form. The three helpers that would have removed 281 s of guessed pauses are
  in it.
- **B. A bare pointer** (~400 characters): the shape of a scenario and
  `api.help()`, nothing else. Cheapest against the cap, but an agent that never
  calls `help()` is left worse off than today, since today at least three
  sections arrive.

### Variant 3 — an MCP resource as well — decided: no

A resource earns its place only if the client fetches it without being told.
Checked on 2026-09-12: Claude Code calls `resources/list` for discovery and puts
what comes back in the `@` autocomplete, and reads a resource only when someone
mentions it by hand. Nothing pulls a resource into the context at session start.
So a resource here would be reachable only through an affordance an agent cannot
discover — the very problem this task is about — and it would be a second copy of
the text to keep honest. `resources/list` in `index.mjs` keeps answering with an
empty array.

The same check reports the description cap as 2048 characters with nothing
appended, which disagrees with what we see: the cut lands near 2040 and the
client writes `… [truncated]` after it. The sources behind the 2048 figure are
second-hand, so the number is treated as approximate — which is the reason the
test allows itself only 1800.

## Definition of Done

- [x] The assembled `evalInBrowser` description fits the client's cap with room
      to spare, and a test fails at 1800 characters — well before the cut — so
      the next helper is caught while there is still room to fix it.
- [x] The text that arrives names `api.help()` and `Object.keys(api)`, and keeps
      the bracketed `[ref_N]` form that `53c7bb1` made true.
- [x] `api.help()` returns the whole reference; `api.help('click')` returns that
      helper's entry; an unknown name answers with the list of names rather than
      an error.
- [x] The description and the reference are rendered from one module, and a test
      proves every helper on `api` is documented and every documented name is a
      real helper.
- [x] `deno task check` and `deno task test` exit 0.

## Solution

1. **`packages/bridge/reference.mjs`** — the manual as one readable block of
   text, laid out as it is today, plus the short description. A small parser
   over that text (a section is a line at column 0, an entry a line indented by
   two, a continuation anything deeper) gives `fullReference()`, `helpFor(name)`
   and `documentedNames()`. The text stays prose an editor can read; nothing is
   restated in a data structure that could disagree with it.
2. **`tools.mjs`** imports the short description and nothing else.
3. **`api.help(name?)`** in `src/main/api.ts`, returning the rendered text.
   `help('api.click')`, `help('click()')` and `help('click')` all answer the
   same; an unknown name lists what there is.
4. **`tsconfig.json`**: `allowJs` so the main process may import the module.
5. **Tests.** A unit test on the assembled description: under the cap, no
   `[truncated]`, names `api.help`, carries `[ref_`. Unit tests on `helpFor`:
   the three spellings, an unknown name, and every documented name resolving.
   An integration test comparing `Object.keys(api)` from a real scenario with
   `documentedNames()`, both ways, so a helper added without a line in the
   manual fails the suite.

### What it came to

Measured after the change, on 2026-09-12:

- The `evalInBrowser` description is 1663 characters, from 3922. Nothing is cut,
  and there are 377 characters of room before the test's own 1800 limit, which
  itself sits well under the client's ~2040.
- The full reference is 4272 characters and reaches the agent through
  `api.help()`. `api.help('waitForLoad')` returns that entry alone.
- The manual documents 51 helpers; a scenario's `Object.keys(api)` returns the
  same 51, and the integration test compares the two lists both ways.
- `deno task check` exits 0; `deno task test` runs 66 tests, all passing;
  `deno fmt --check` reports only the three files `AGENTS.md` already names.

Both new tests were proved red before being trusted: 200 characters added to the
description failed the cap test with the length in the message, and a helper
added to `api.ts` without a line in the manual failed the drift test naming it.

`api.sleep` and `api.waitForLoad` — the two helpers whose absence cost the
session in the parent task 281 s of guessed pauses — are both in the part that
arrives.

### What the review changed

An independent read of the diff found nothing blocking and eight things worth
doing. Four are in the commit:

- `helpFor('frames')` used to answer with one line. A section's closing
  paragraphs name no helper — the `{frame}` rule is one, and it is the whole
  point of the section — so an entry now carries the name-less paragraphs that
  follow it.
- An empty name is no name: `api.help('')` answers with the whole manual rather
  than "there is no api.".
- Three tests the suite was missing: no helper described in two places, an
  entry carrying the lines indented under it (the only test of the
  continuation rule — break it and everything else stays green), and the
  spellings ` Click ` and `click` answering alike.
- Two assertions that only restated the code were replaced by ones that can
  fail: the reference still opens with its preamble, and one helper's entry does
  not drag another section in with it.

Two were considered and left alone, with the reason:

- **`// @ts-check` on `reference.mjs`.** It reports 7 implicit-`any` errors and
  would need JSDoc types through the whole module. Nothing else in
  `packages/bridge/` is annotated, so the file would be the odd one out, and its
  whole surface is already exercised by the unit tests.
- **`exclude: ["test/fixtures"]` in `tsconfig.json`.** `allowJs` pulls
  `test/fixtures/foxcode-reference.js` into the program. Without `checkJs`
  nothing is checked there semantically and `deno task check` is clean, so the
  exclusion would be a guard against a problem that does not exist yet.
