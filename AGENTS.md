# Working in this repository

## What this is

An Electron application that gives AI coding agents a browser, isolated per
project. The main process owns everything: the projects, their sessions, their
tabs, and the MCP endpoint the agents call. The renderer draws the window's own
chrome and nothing else.

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
- `src/main/files.ts` — what a scenario may hand a website and where it may
  write, and why both are the project's own directory
- `src/main/preferences.ts` — what the person sets by hand, described once for
  the main process and the settings window alike
- `src/main/settings-window.ts` — one settings window, however often it is asked
  for; the Electron call that makes it stays in `main.ts`
- `src/main/runner.ts` — runs that script
- `src/main/trail.ts` — what a scenario had already done when it failed
- `src/main/lease.ts`, `queue.ts` — who may act on a tab, and in what order
- `src/main/hub.ts` — admission and routing
- `src/main/mcp-http.ts` — the MCP endpoint: the application answers agents
  itself, over HTTP on loopback, and hands the hub a session per agent
- `src/main/protocol.ts` — the shapes a session and the hub speak in, and
  `Connection`, the seam that let the transport change without touching routing
- `src/main/mcp-address.ts` — where this copy answers, and the line a person
  pastes into their IDE
- `src/main/reference.mjs` — the manual an agent reads, in the one place both
  the tool description and `api.help()` are built from
- `src/renderer/chrome.ts` — the window's chrome: the address bar and the tree
  of agents, their tabs and the calls made in them
- `src/renderer/settings.ts` — the settings window's page: the preferences, and
  the register of projects the person has been asked about
- `src/renderer/tree.ts` — how that tree is built, and the only part of the
  chrome a test can reach
- `documents/how-a-session-works.md` — the path a session takes, in sequence
  diagrams: connecting, staying alive, being let go, quitting, and a port that
  is already taken
- `compat/relay-gone.mjs` — nothing runs it here. It ships at the two paths the
  relay used to occupy, so a configuration written before 1.0.4 fails with a
  sentence instead of `ERR_MODULE_NOT_FOUND`

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
  on. How long the page waits is the row in the settings window, kept in
  `settings.json` and five minutes until somebody changes it;
  `--orphan-close-ms` overrides it for one launch. A tab another agent has
  moved into, or the person is holding, is not closed.
- **The tool description is a budget, not a manual.** The client cuts the
  `evalInBrowser` description at about 2040 characters and appends
  `… [truncated]` — nothing here can see that happen. The whole helper
  reference used to live there, 3922 characters of it, so everything from
  *Moving around* on reached no agent at all: the tabs, the cookies, the
  screenshots, `sleep`, `waitForLoad` and `requestHuman`. One session paid 281 s
  of hand-written pauses for the two missing waits. Both texts now come from
  `src/main/reference.mjs`: `TOOL_DESCRIPTION` is a summary that names
  `api.help()`, `MANUAL` is everything, and a unit test fails at 1800 characters
  — early, because the cap is the client's to move. A new helper gets a line in
  `MANUAL` and a mention in the description only if it earns one. The module
  stays plain `.mjs` (`allowJs` in `tsconfig.json`, bundled by esbuild) because
  it was written to be read from a standalone package as well as from the
  application; the package is gone and the file stayed as it was. An
  integration test compares `Object.keys(api)` with the
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
  `settings.json` in the user-data directory — and is shown in one window of its
  own, opened by ⌘, in the application menu, the gear in the panel's foot, or the
  menu-bar icon. The main process owns each value: it clamps it, applies it live
  and writes it down, and the window draws what came back, never what it asked
  for. A number typed under its floor comes back as the floor rather than being
  refused: a field that refused would make the person find the floor by trial.

  Not everything the application remembers belongs in that window. The panel's
  width is kept in the same `settings.json` and has no row, because the grip on
  the panel's edge sets it directly and a number typed in points says nothing
  the drag does not say better; it was drawn as a row once and taken out on
  2026-09-12. The test is whether the person could do the thing more directly
  somewhere else.

  The preferences themselves are described in `src/main/preferences.ts`, which
  both sides read, and `PREFERENCES` there is mapped over `keyof
  PreferenceValues`: a value the main process starts sending with no row for it
  does not compile. That is the only place the promise can be made — `Settings`
  is an interface and is gone by run time, so no test in this repository could
  make it.

  It is a window rather than a view in the panel because it is about the
  application and not about any project, and because reading it must not cost
  the person the tree they were looking at. The settings window is also where
  the register of admitted projects is shown and forgotten; the panel keeps only
  what is about the window in front of you — the grip, and the order of the
  agents.
- **Where the application shows itself is the person's choice, and the menu bar
  is the default.** macOS has one knob for it, `NSApplicationActivationPolicy`
  — Electron spells it `app.dock.show()`/`hide()` — and it says only whether
  there is a Dock icon; the menu-bar icon is a `Tray` object that exists or does
  not. The two are drawn as one row of three (`Presence` and `presenceOf` in
  `preferences.ts`), not as two switches: the fourth combination leaves the
  person no icon to reach the window by, and refusing to turn the second switch
  off would contradict the rule above about a value under its floor.
  `showApplication` in `main.ts` applies the answer at start-up and again on
  every change, so nothing in it may assume it runs once. Proved on the running
  application (2026-09-12): `background only` of the process and `number of menu
  bars` in System Events follow each of the three, a restart comes back where it
  was left, and a hand-edited value in `settings.json` starts in the menu bar.
- **The application's face is one figure in four media.** The Dock icon is a
  world with a command prompt on it — the browser, and the fact that a program
  is what walks it — and the same circle and prompt is drawn as a line in the
  menu bar (`WORLD` in `tray.ts`; the hand still replaces it while an agent
  waits), beside the wordmark in the panel, and on the tile the empty panel
  shows (`MARK` in `chrome.ts`). The three line drawings share their
  coordinates on purpose; change one and change the others.
  `build-resources/icon.icns` is what electron-builder picks up, and it is
  generated from three drawings that share one geometry and differ only in
  detail, because an `.icns` holds a picture per size and what reads at 512 is
  mud at 16: `icon.svg` for 128 points and up carries the meridians,
  `icon-small.svg` for 32 and 64 drops them and cuts the prompt heavier, and
  `icon-tiny.svg` for 16 keeps the chevron alone, because the underscore
  closes up with it in ten pixels. The commands are in the comment at the top
  of `icon.svg`. Two things about the
  menu bar are not a matter of taste: a template image is black plus alpha and
  nothing else, so white is a hole rather than paint — a filled glyph with a
  lighter mark cut into it arrives as a solid blob — and the stroke is 2.1
  rather than lucide's 2.4, because at eighteen points the chevron and the
  underscore close up at the heavier weight.
- **The two icons carry different things, and the Dock badge is not a
  counter.** A badge on macOS means "this many things want you", so it holds
  the number of calls waiting for the person (`waitingForPerson`), and nothing
  when none are; the number of connected agents is ambient status and stays on
  the menu-bar icon, which is what a menu bar is for. The icon bounces
  `informational` once when that number goes up and never while a call waits —
  `dockSignal` in `dock.ts` makes both decisions without Electron, and the
  first look after the icon appears draws the badge without bouncing, because
  turning the Dock icon on is not the moment an agent started asking. Both
  icons offer the same right-click menu, built once in `iconMenu`. Proved on
  the running application (2026-09-12) by reading `AXStatusLabel` of the Dock's
  own item: empty, then `1` while a call waited, then empty again.
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
- **The window is dressed as an instrument, and the orange is rationed.** The
  language is Teenage Engineering's: an off-white shell, white
  panels, hairline rules, corners of one or three points, no shadow on
  anything that sits on a surface, and legends set in the monospaced face —
  small capitals, tracked `--legend-track` — wherever a label names a control
  rather than speaking a sentence. `#FF4B12` belongs to four things and no
  others: the way forward (the primary key, the chosen segment), the mark
  itself, the row the person is looking at, and a call that is waiting for
  them. Everything else is told apart by grey, the agent dots included, which
  is why `--agent-1` through `--agent-4` walk an ink ramp instead of picking up
  a second hue. Dark is a second finish rather than an inversion — the black
  case Teenage Engineering also builds — so the shell darkens, the panels stay
  a step above it, and the orange is unchanged.
- **The disguise is one switch, and it flips live.** Pages see plain Chromium
  by default (`src/main/disguise.ts` owns the user agent); the switch in the
  settings window, or `--announce-automation`, puts the Electron user agent back
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
- **A preload is not private to the view that uses it.** `contextIsolation`
  keeps the preload's own world apart from the page's; `contextBridge
  .exposeInMainWorld` crosses that line on purpose, which is the whole point of
  it. So a preload handed to a tab is handed to every site that tab visits.
  Every tab was built with the panel's preload until 2026-09-12, and a page on
  example.com could therefore read the register of admitted projects — names and
  absolute paths — and call `openAtLogin`, `forgetProject`, `newTab` and
  `takeOver`. Measured on the installed copy, not read out of the code; the
  comment at the top of `preload.ts` had claimed the opposite for months, which
  is why nobody looked. A tab is built with no preload at all now, and an
  integration test holds it there by asking a page for `typeof window.ab`.
  Nothing a page needs comes from a preload anyway: the `__abRefs` helpers are
  installed per call, because a single-page application drops anything installed
  once.

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
  was refused for being outside it (caught by its own test, 2026-09-12). The
  root needs the same treatment, which is the side this was met from second:
  `identify()` falls back to the unresolved spelling when the directory is not
  there, so a root of `/tmp/work` compared against a candidate already resolved
  to `/private/tmp/work` refused the project's own directory. Resolve both sides
  the same way, or neither.
- **A fixture that answers instantly cannot prove a wait.** The test server
  hands a whole page back in one write, so an address commits and its document
  is readable in the same breath — and a test that waits for a page and then
  reads it passes whether or not the code waited at all. `/drip.html` is the
  cure: it commits with its first byte and writes the paragraph a scenario reads
  400 ms later, which is the gap a real page has between `did-navigate` and
  anything worth reading. Measured 2026-09-12 while adding `Tab.waitForUrl`:
  against `second.html` the test was green with the load wait removed, against
  the drip page it reads an empty string instead of the text. Any wait tested
  here needs a fixture that is slow where the real page is slow, and a red taken
  by removing the wait — the green on its own says nothing.
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
- **A scenario's `api` is the argument it was compiled with, not the global of
  the same name.** `runner.ts` wraps the script in `(async (api) => {…})` and
  then calls `factory(api)`, so the parameter shadows `sandbox.api` — the
  sandbox entry is reached only by a scenario that renames or never names its
  own argument. Anything that replaces or wraps the object an agent calls has
  to go to both places, and changing only the sandbox is silently a no-op: it
  compiles, it runs, and every test that asserts the old behaviour still
  passes. Cost one build-and-test cycle on 2026-09-12, caught because the test
  read the new behaviour back out of the page rather than asserting it existed.

- **A thrown error reaches the agent as a rebuild.** `runner.ts` catches whatever
  a helper threw and constructs a fresh `ScriptError` carrying the message, the
  stack, the logs and `code` — nothing else. So anything hung on an error
  reaches a scenario that catches it, where reading a property across the
  `node:vm` boundary is ordinary (unlike `instanceof`), and reaches nobody
  otherwise. Put what an uncaught failure has to say in the message, and the
  structured form on the object for the scenario that catches; `requestHuman`'s
  timeout does both, and its message is the reason an agent that never catches
  still learns the page moved.
- **A tab's events talk about its frames as well as its page.** `did-navigate`
  is the main frame's alone, but `did-navigate-in-page` fires for sub-frames too
  and says which in its third argument, `isMainFrame`. Without that check an
  advertisement calling `pushState` is recorded as something the person did —
  measured 2026-09-12 by removing it, and the walk came back four steps instead
  of three. Chromium also fires the event again for a `pushState` to the very
  same URL, so anything counting moves of the page collapses a repeat itself.
- **A `requestHuman` timeout leaves the tab with the person, and somebody else
  inherits it.** The throw comes before the release on purpose: a timeout means
  the person is still working, and the panel has their own way to hand the tab
  back (`ab:release`). The cost lands somewhere else entirely — an agent that
  closes its own tab inherits the project's last open one
  (`ProjectContext.closeTab`), so a tab left held answers it with "the person at
  the keyboard is using this tab". That is how a test that times a hold out
  failed an unrelated test two hundred lines below it; a test that does this
  closes the tab itself.
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

A red that proves nothing is the cheapest mistake to make here, and it has been
made twice: a test written against a module that does not exist yet fails with
`ERR_MODULE_NOT_FOUND`, which says the import is wrong and says nothing about the
behaviour under test (2026-09-12, twice in two sessions — `resolveWritePath`, and
then the whole of `preferences.ts`). Write the module, watch the test go green,
and only then take the red: copy the file to a scratch directory, break exactly
the decision the test is about, run it, read the numbers in the failure, and
restore from the copy. `actual: null, expected: 240` is a proof; a missing module
is a typo.

Some of what this application does is out of reach of both suites — the panel is
a view no test drives, and the settings window is another. The accessibility API
reaches what the code cannot: `osascript -e 'tell application "System Events" to
tell process "Naoba Dev" to ...'` lists `name of menu bar items of menu bar 1`,
reads `name of menu items of menu 1 of menu bar item 2` with the `AXMenuItemCmdChar`
of any one of them, clicks one, and answers `get name of windows`. That is how
"⌘, opens a window called Settings, and a second press does not open another" was
evidenced rather than left for the owner (2026-09-12). Two limits: the process
has to be running and installed, and a menu Electron pops up itself — the tray's
— is not attached to its status item, so `AXShowMenu` cannot reach it.

**A copy started by hand writes to a real state directory.** `test/helpers/app.mjs`
always passes `--user-data-dir`, so the suite is sealed off; `node_modules/.bin/
electron dist/main.js` is not, and a bare run keeps its state in
`~/Library/Application Support/Electron` — the checkout's own, with the projects
the owner has admitted from it. A probe that called `hub.forget()` there deleted
one of those records and had to be put back by hand (2026-09-12). Pass
`--user-data-dir` to anything that writes, `--snapshot` runs included.

One test in the suite has been seen red with nobody having changed it:
"pressing Enter in a field submits the form". On 2026-09-12 it failed three
times out of ten runs — once in a full suite, once in three runs by name, and
once in four runs by name inside a `git worktree` of `9bbb1e2`, where the code
was untouched. It then went green eleven consecutive times, four full suites and
six by name. All three reds fall inside the one session, which ran Electron
suites back to back for an hour; whether load is the cause is a guess, and no
rate is worth quoting from this. What the evidence does support: a single red on
that name is not proof that your change caused it, so run it again before
hunting for one.

`deno task fmt` formats everything the project owns, and three of those files
have been unformatted for longer than anyone has looked:
`src/main/snapshot.ts` and one line of `test/integration.test.mjs`. Running it
to tidy up after an edit therefore rewrites files nobody asked about and carries
them into the commit. Check
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
