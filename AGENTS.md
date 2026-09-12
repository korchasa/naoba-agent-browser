# Working in this repository

## What this is

An Electron application that gives AI coding agents a browser, isolated per
project. The main process owns everything: the projects, their sessions, their
tabs, and the server the agents' bridges connect to. The renderer draws the
window's own chrome and nothing else.

## The rule that outranks the others

**A project's browsing context must never be reachable from another project.**
Not through a tab, a cookie, a storage entry, a download, a cache, or a debug
switch. Every isolation boundary comes from one thing — the Electron `session`
built from `partitionFor(projectId)` — so any new feature that touches browsing
state must go through the project's own session, never through
`session.defaultSession`.

## Layout

- `src/main/project.ts` — what a project is: identity from a directory
- `src/main/context.ts` — one project: session, window, tabs, agents, events
- `src/main/tab.ts` — one page: navigation, input, capture, network
- `src/main/api.ts` — the object an agent's script runs against
- `src/main/files.ts` — what a scenario may hand a website, and why
- `src/main/runner.ts` — runs that script
- `src/main/lease.ts`, `queue.ts` — who may act on a tab, and in what order
- `src/main/hub.ts` — admission and routing
- `src/main/server.ts`, `protocol.ts` — the wire
- `packages/bridge/` — the MCP server an IDE launches, one per agent
- `packages/bridge/reference.mjs` — the manual an agent reads, in the one
  place both sides can reach it
- `src/renderer/chrome.ts` — the window's chrome: the address bar and the tree
  of agents, their tabs and the calls made in them
- `src/renderer/tree.ts` — how that tree is built, and the only part of the
  chrome a test can reach

## Things learned the hard way

- **A tab has one place in the tree, and the person has no branch.** A tab
  hangs under the agent that opened it, and everything done in it, by anyone,
  is one history with a name on the calls made by anybody else. The person
  works alongside an agent, never apart from one: the `+` button opens the
  new tab under the agent whose tab is in front, and is disabled with no
  agent in the window. An agent that disconnects keeps its row, dimmed and
  badged `gone`, for as long as its tabs are open. The earlier tree had a
  "Yours" section that listed a tab under every actor who had touched it, so
  one press of Reload made an agent's tab appear twice (2026-09-05).
- **A departed agent's tabs close after a grace period, not at once.** A
  session that restarts comes back as a new agent and wants the page it was
  on; `--orphan-close-ms` (default five minutes) is how long that page waits.
  A tab another agent has moved into, or the person is holding, is not closed.
- **The tool description is a budget, not a manual.** The client cuts the
  `evalInBrowser` description at about 2040 characters and appends
  `… [truncated]` — nothing in the bridge can see that happen. The whole helper
  reference used to live there, 3922 characters of it, so everything from
  *Moving around* on reached no agent at all: the tabs, the cookies, the
  screenshots, `sleep`, `waitForLoad` and `requestHuman`. One session paid 281 s
  of hand-written pauses for the two missing waits. Both texts now come from
  `packages/bridge/reference.mjs`: `TOOL_DESCRIPTION` is a summary that names
  `api.help()`, `MANUAL` is everything, and a unit test fails at 1800 characters
  — early, because the cap is the client's to move. A new helper gets a line in
  `MANUAL` and a mention in the description only if it earns one. The module
  stays plain `.mjs` with no imports of its own, because the application reads
  it too (`allowJs` in `tsconfig.json`, bundled by esbuild) while the bridge is
  launched standalone by an IDE and can reach nothing outside
  `packages/bridge/`. An integration test compares `Object.keys(api)` with the
  names the manual documents, both ways, so a helper with no line in it fails
  the suite.
- **Icons come from the `lucide` package**, bundled into the panel by esbuild
  and drawn inline so they take the text colour. Add a glyph by importing its
  node into the `ICONS` map in `src/renderer/chrome.ts`; nothing is drawn by
  hand any more, and nothing loads at run time (the CSP would block it).
- **One window for every project, owned by `src/main/shell.ts`.** A
  `ProjectContext` keeps its own session, tabs and agents and nothing else; its
  tab views are attached to the shell, which lays out the panel and whichever
  tab is in front. The panel's tree is project → agent → tab → call, and every
  push to the panel carries the `projectId` it belongs to. Do not give a
  project a window of its own again: the person asked for the projects in one
  list, and the sessions stay apart without separate windows.
- **What the person sets by hand goes through `src/main/settings.ts`** — one
  `settings.json` in the user-data directory, and one settings view in the
  panel (the gear in the foot) that shows every value in it. Today that is the
  panel width, which the person also drags on the panel's right edge, the
  disguise switch, and how long a departed agent's tabs wait; the main process
  owns each value, clamps it, applies it live and writes it down. The renderer
  draws what comes back, never what was asked for.
- **The login item is offered once, and then the OS decides.** An installed
  copy (`app.isPackaged`) registers itself with `app.setLoginItemSettings` on
  its first start and writes `loginItemOffered` — only after
  `getLoginItemSettings().status` says the OS took it (`enabled` or
  `requires-approval`), so a refusal is offered again next start. Nothing ever
  reads that marker for the switch's position: the OS is the source of truth,
  and a person who turned the item off in System Settings must not find it
  back on. A checkout and a test run are never packaged and never register —
  a login item for `node_modules/electron/dist/Electron.app` would start a
  stray Electron at every login. The pure decisions live in
  `src/main/login.ts` so the unit tests reach them without Electron.
- **Every colour lives in `src/renderer/palette.css`.** The panel and the
  snapshot demo page both link it, so a tint changes in one place. A colour
  literal anywhere else in the renderer is a defect: the demo page kept a
  blue button through two accent changes because it carried its own hex.
- **The disguise is one switch, and it flips live.** Pages see plain Chromium
  by default (`src/main/disguise.ts` owns the user agent); the ghost in the
  panel's foot, or `--announce-automation`, puts the Electron user agent back
  and sets `navigator.webdriver` through `Emulation.setAutomationOverride`,
  which changes the document already open. `session.setUserAgent` reaches only
  tabs created afterwards, so a flip walks the open tabs with
  `webContents.setUserAgent` as well — and a loaded page keeps the old string
  until it navigates. Do not pile more spoofing onto the hidden side without
  measuring first: `window.chrome` is an empty object and
  `Notification.permission` is `granted` without a prompt, both of which a
  check can read, and both were left alone on purpose (2026-09-05).
- **`Tab.track` is a queue of one, and a DevTools command needs a document.**
  Each tracked step waits on the one tracked before it, so two steps are two
  `track` calls in order — a single chain that holds the `navigate` waits on
  itself and the tab never loads (cost one red run, 2026-09-05). And a tab
  that has never loaded anything has no renderer to answer the DevTools
  protocol: a command sent before the blank page is up never returns, which
  is why the disguise is tracked after the first navigate, not before it.
- **A scenario's values come from another realm, so `instanceof` lies about
  them.** `runner.ts` compiles an agent's script in a `node:vm` context with
  intrinsics of its own, so anything the script builds itself fails an
  `instanceof` test in the main process — and the builtins it would build carry
  no own enumerable keys, so they serialise as `{}`, the one answer
  `serialize.ts` exists to prevent. Test the `Object.prototype.toString` tag
  instead; `Array.isArray` is cross-realm by design and needs nothing. Error,
  Date, RegExp, Map, Set and Promise all read their tag now — before that,
  a scenario returning one of each came back as
  `{err:{}, when:{}, re:{}, m:{}, s:{}}` (measured 2026-09-12). The tag alone
  is not enough to act on: `Symbol.toStringTag` is writable, so a plain object
  can wear `'Map'` and turn `value.entries()` into a TypeError — and a throw
  while serialising loses the whole result, not the one value. Pair the tag
  with the members the branch is about to read, which is what the `isMap`-style
  tests in `serialize.ts` do — and pair that with a catch, because a member can
  be present and still answer with something unusable. Reading a value is all a
  serialiser does, so every read is guarded and a read that throws returns an
  `unserialisable` marker: one bad value costs its own key, never the result.
  Two of the four reads that used to throw needed no adversary at all — a lazy
  getter that is not ready, and an `Error` whose `stack` the page replaced. The
  boundary reaches the tests as well: a value
  that walked out of `walk()` can still be the other realm's `Array`, and
  `assert.deepStrictEqual` compares prototypes, so it rejects a host `[1, 2]`
  that JSON would render identically. Compare a spread copy, or the JSON.
- **A path boundary compares realpaths, and a path that is not there has to be
  resolved as far as it goes.** `identify()` runs the project root through
  `realpathSync.native`, so a project the agent calls `/tmp/work` is really
  `/private/tmp/work` and `/var/folders/…` is really `/private/var/folders/…`.
  Compare the two spellings as strings and the project's own file is refused as
  an intruder. Compare with `path.relative`, never a prefix — `/a/project-evil`
  starts with `/a/project` and is no part of it — and realpath the file as well
  as the root, or a symlink inside the project quietly leads out of it. The trap
  that is easy to miss: `realpath` refuses a path that does not exist, so the
  answer to "may this be read" must not fall back to the unresolved spelling.
  `src/main/files.ts` resolves through the directories that do exist and leaves
  the missing tail as written; before it did, a missing file inside the project
  was refused for being outside it (caught by its own test, 2026-09-12).
- **A DevTools command that needs a node takes a `Runtime.evaluate` object id.**
  That is how `setFiles` reaches an element the page resolved — `DOM.querySelector`
  cannot, because a `[ref_7]` names an entry in `window.__abRefs` and no CSS
  selector reaches it. `DOM.enable` is not needed on this path, and
  `Runtime.releaseObject` afterwards is. `DOM.setFileInputFiles` is also the only
  way to fill a file input at all: its value is not settable from script, and the
  input these sites use is `display: none`, so nothing on that path may ask for
  size, visibility or focus. Because it is the browser placing the file, the page
  gets `input` and `change` with `isTrusted: true` and reacts as it would to a
  person picking one — measured 2026-09-12, not assumed, because a site that
  listens only for `change` would otherwise ignore the file.
- **Input goes through the DevTools protocol, not `sendInputEvent`.** Both look
  trusted to the page, but `sendInputEvent` is delivered through the window and
  does nothing when that window is hidden.
- **A window that has never been shown does no hit-testing.** No compositor
  means clicks land on nothing, which is why even a headless test run shows its
  windows — parked off-screen.
- **A blank tab needs a real blank page.** A view with no document at all makes
  `executeJavaScript` wait forever.
- **`ERR_ABORTED` is not a failed navigation.** A redirect, a superseded load
  and a download all report it.
- **Response bodies live in the page's buffer.** They are readable until that
  tab navigates, and not one moment longer.
- **Page-side helpers are defined per call.** A single-page application replaces
  the document without reloading, so anything installed once quietly disappears.
- **The window buttons are drawn over the top-left of the content.** With
  `titleBarStyle: 'hiddenInset'` whatever is in that corner sits under them, so
  the chrome has to be the view that owns it — which is why the panel is on the
  left and starts with an empty drag strip.
- **`capturePage` hands back the last committed frame.** The window is shown
  transparent and unfocused while agents work, so its compositor commits
  lazily: two animation frames in the renderer prove nothing about what a
  capture will contain. A snapshot needs several captures with a pause between
  them, or it photographs the interface as it was a step ago — which reads as a
  bug in the interface, not in the camera.
- **A transparent window is a hidden window to Chromium.** The panel's
  renderer is throttled while the window is shown at opacity 0, so it stops
  producing frames: a `requestAnimationFrame` never fires, a theme switch never
  repaints, and every capture agrees with the last one — on a stale frame. The
  panel runs with `backgroundThrottling: false` for that reason, and a snapshot
  accepts a frame only when two captures in a row match byte for byte.
- **The panel sits on the window's sidebar material.** The window is created
  with `vibrancy: 'sidebar'` and the panel view has a transparent background,
  so the stylesheet paints translucent fills over whatever is behind. A capture
  of the panel alone therefore carries alpha; the snapshot blends it onto a
  flat stand-in for the material or the picture comes out black.

## Style

Comments explain why, never what. A comment that restates the code is noise; a
comment that records a constraint, a trap or a decision is the reason the next
person does not repeat a wasted afternoon.

Run `deno task check` before calling anything done, and `deno task test` before
calling it correct. The suite drives a real Electron window and takes about 20
seconds, where a single test by name takes about 1.5, so while a change is
still red, build once with `deno task check` and then loop on the tests by
name — `node --test --test-concurrency=1 --test-timeout=90000
--test-name-pattern='a snapshot ref' test/integration.test.mjs` — and run the
whole thing before the commit.

`deno task fmt` formats everything the project owns, and three of those files
have been unformatted for longer than anyone has looked:
`packages/bridge/index.mjs`, `src/main/snapshot.ts`, and one line of
`test/integration.test.mjs`. Running it to tidy up after an edit therefore
rewrites two files nobody asked about and carries them into the commit. Check
your own work with `deno fmt --check` and read past those three. Checking it
anywhere else does not work: a copy of a file in a scratch directory is
formatted without this project's `deno.json`, so it comes back with every line
wrong about quotes and semicolons. A baseline from before the edits is a
`git worktree` of `HEAD`, not a copy.

## Documents

These are roles, not filenames: a workflow that asks this repository where its
plans belong reads the answer here.

- **`tasks` → `documents/tasks/<YYYY>/<MM>/<slug>.md`.** One file per task. YAML
  frontmatter carries `date`, `status`, `implements`, `tags` and
  `related_tasks`; the body is Goal, Overview, Definition of Done, Solution.
  Write the Definition of Done as top-level checkboxes — that list is what a
  workflow counts to decide whether the task is `to do`, `in progress` or
  `done`, and a numbered list it cannot count leaves the status frozen.
- **`index`, `SRS`, `SDS` — deliberately unbound.** There is no requirement
  register here, so `implements:` stays empty; what this application must do and
  how it does it lives in this file and in the code. A task that needs to record
  a decision records it in its own body, and nothing in a workflow may create a
  document at a conventional path to fill one of these in.
