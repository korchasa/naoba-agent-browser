# How Naoba is built

What this application is made of, and why each seam is where it is. The
contract it has to keep is [`requirements.md`](requirements.md); the traps to
avoid while changing it are in `AGENTS.md`.

Two documents already carry part of this and are not repeated here: the path a
session takes, in sequence diagrams, is
[how a session works](how-a-session-works.md), and why the engine is Chromium
inside the application rather than a driver outside it is
[decision 0001](decisions/0001-chromium-inside-the-application.md).

## 1. Shape

One Electron main process owns everything: the projects, their browsing
sessions, their tabs, the agents connected to them, and the MCP endpoint the
agents call. There is no second process of ours — no relay, no driver, no
sidecar.

The renderer draws the window's own chrome and nothing else: an address bar and
a tree of agents, their tabs and the calls made in them. It holds no state that
matters. Everything it draws arrives from the main process, and everything the
person does in it goes back there as a message.

The pages themselves are ordinary Chromium renderers, one per tab, each in its
project's session, each sandboxed with context isolation and **no preload of
ours**. A page therefore has nothing of this application's to reach for.

```
  IDE / agent                     Naoba (one process)              the web
  ───────────                     ────────────────────             ───────
  MCP client  ──HTTP loopback──▶  mcp-http  ─▶ hub  ─▶ ProjectContext ─▶ Tab ─▶ page
                                                │            │
                                                │            └─ Electron session (per project)
                                                └─ Shell (one window, many views)
                                                          │
                                                          └─ renderer: chrome, settings
```

## 2. The module map

### The main process

- `project.ts` — what a project is: identity from a directory, and
  `partitionFor(id)`, the one place a browsing partition is named.
- `context.ts` — one project: its session, its tabs, its agents, its leases, its
  downloads, its events.
- `tab.ts` — one page: navigation, input, capture, network, dialogs.
- `api.ts` — the object an agent's script runs against.
- `runner.ts` — runs that script in a `node:vm` context, under a deadline.
- `trail.ts` — what a scenario had already done when it failed.
- `serialize.ts` — what survives the trip back as JSON, and what a value that
  cannot is replaced by.
- `render.mjs` — the words an `evalInBrowser` result comes back as. Apart from
  the endpoint on purpose, so a test can assert the text itself.
- `lease.ts`, `queue.ts` — who may act on a tab, and in what order.
- `visits.ts` — what a tab did while the person was holding it.
- `commands.ts` — what has been done in one tab, newest first.
- `files.ts` — what a scenario may hand a website and where it may write.
- `downloads.ts` — every file that comes off the web, and the save path named
  before Electron can open a dialog.
- `urls.ts` — what an agent means when it names a URL to wait for.
- `snapshot.ts` — the accessibility-style tree a scenario reads, and the
  offscreen drawing of the window used for store screenshots and for looking at
  the interface in both appearances.
- `hub.ts` — admission and routing: which project a connection belongs to, which
  context serves it, and which projects the person has answered about.
- `mcp-http.ts` — the MCP endpoint over HTTP on loopback, one `Session` per
  agent.
- `protocol.ts` — the shapes a session and the hub speak in, and `Connection`,
  the seam that let the transport change without touching routing.
- `mcp-address.ts` — where this copy answers, and the line a person pastes.
- `reference.mjs`, `tools.mjs` — the manual an agent reads, in the one place
  both the tool description and `api.help()` are built from.
- `shell.ts` — the window: one `BaseWindow`, a `WebContentsView` per tab and one
  for the panel.
- `main.ts` — start-up, flags, menus, and every Electron call the pure modules
  deliberately do not make.
- `preferences.ts` — what the person sets by hand, described once for both sides
  of the wire.
- `settings.ts`, `settings-window.ts` — where those values are kept, and the one
  window that edits them.
- `tray.ts`, `dock.ts`, `login.ts`, `variant.ts` — where the application
  appears, what its icons say, whether it starts at login, and which copy this
  is.
- `disguise.ts` — what the browser says it is.
- `permissions.ts` — what a page may ask this browser for, and why the answer is
  always no.
- `schemes.ts`, `hand-off.ts` — what becomes of an address this browser cannot
  show: which schemes load, which go to the machine, which are refused — and the
  one call that hands one over.
- `licence.ts`, `licence-store.ts` — the rules a licence is judged by, and the
  files, network and clock that feed them.
- `updates.ts`, `update-rules.ts` — replacing the application with a newer one.
- `faults.ts` — what the application itself got wrong.

### The renderer

- `chrome.ts`, `chrome.html`, `chrome.css` — the window's chrome.
- `tree.ts` — how the tree of agents and tabs is built. The only part of the
  chrome a test can reach.
- `settings.ts`, `settings.html`, `settings.css` — the settings window's page.
- `palette.css` — the colours, in one file, for both appearances.

### Elsewhere

- `compat/relay-gone.mjs` — nothing runs it here. It ships at the two paths the
  relay used to occupy, so a configuration written before 1.0.4 fails with a
  sentence instead of `ERR_MODULE_NOT_FOUND`.
- `scripts/task.ts` — the one entry point behind every `deno task` verb.

## 3. A project becomes a browser

An absolute path arrives in `begin`. `identify()` normalises it — trailing
slash, case, symlink — and hashes it into a project id, so one directory spelled
several ways is one project (**FR-ISOLATION-4**). `partitionFor(id)` turns that
id into a partition name that carries the hash and never the path
(**FR-ISOLATION-3**), and `ProjectContext` builds its Electron session from it:

```ts
this.session = electronSession.fromPartition(partitionFor(identity.id))
```

That single line is the whole isolation boundary. Cookies, storage, cache,
service workers, the user agent and downloads all hang off that session, so a
feature that goes through it is isolated by construction and a feature that goes
around it is not isolated at all. Hence the rule in `AGENTS.md` and
**FR-ISOLATION-2**: nothing may touch `session.defaultSession`, and `grep` is
the check.

The session outlives the context. A project unloaded for being idle and used
again builds a second `ProjectContext` on the same session — which is why the
download handler is removed before it is added, or the project's next download
would be handled twice.

The same session is where a page is told no. Electron installs no permission
handler by default and grants whatever a page requests, so `context.ts` sets
four of them: the permission request handler, the permission check handler that
answers `navigator.permissions.query()`, the device permission handler, and the
Bluetooth pairing handler. All four answer from `permissions.ts`, which takes the
permission's name and ignores it — Electron 44 can pass 46 names and a later
version adds more, so a rule that reads the name has to be revisited every
upgrade while one that does not cannot be overtaken. Unlike the download
listener three lines above, these are setters, so a second context on the same
partition replaces them rather than stacking.

`setDisplayMediaRequestHandler` is deliberately **not** set. Measured 2026-09-19:
with no handler, `getDisplayMedia` fails on its own, so screen capture is already
refused and installing a handler is the only way to open it — which would hand a
page the screen of a browser holding the person's live sessions.

The cost is that a site's own copy button, its full-screen view, a map's pointer
lock and the Storage Access API a third-party sign-in frame uses are refused with
the rest. That was weighed and accepted; when a page is found broken by one of
them, the exception belongs in `permissions.ts` with its reason beside it.

## 4. An agent arrives

`mcp-http.ts` listens on loopback at a port fixed per copy (**FR-ENDPOINT-2**),
so the line in an IDE's configuration keeps working across restarts and the
development copy cannot collide with the downloaded one.

Each MCP session id becomes one `Session`, which implements `Connection` —
`send`, `onMessage`, `onClose`. The hub knows nothing else about it. That
indirection is what let the transport change from a socket and a relay process
to HTTP inside the application without the routing being touched, and it is the
reason `protocol.ts` still reads as messages rather than callbacks.

`begin` carries the project path and the session's name. The hub resolves the
project, asks the person about it if it has not been asked before, records the
answer in `projects.json`, and hands the connection to that project's context as
an `AgentHandle`. One session id that names a second project moves there and
keeps nothing.

The test door in `mcp-http.ts` (`naoba/call`, `naoba/events`, `naoba/fault`) is
gated behind `--admit-everything` **and** an unpackaged build, so it cannot
exist in a copy anybody downloads.

## 5. A scenario runs

`evalInBrowser` arrives as a tool call and goes through five things in order.

1. **The lease** (`lease.ts`) says who is working on the tab. A multi-step
   scenario is not cut in half by another agent, and the person can always take
   the tab back — the person always wins, and the agent is told.
2. **The queue** (`queue.ts`) serialises commands per tab, so two agents in one
   project help each other instead of interleaving a `fill` between a `click`
   and its `waitForLoad`. Different tabs do not wait for each other.
3. **The runner** (`runner.ts`) compiles the script into a `node:vm` context
   with `api` in scope and a deadline around it. Top-level await works.
4. **The api** (`api.ts`) acts on the `Tab`. Every call is wrapped by
   `trail.ts`, which records the call, its named arguments, its answer and its
   throw — without changing the surface the scenario sees, and without ever
   throwing itself.
5. **The result** goes through `serialize.ts` and then `render.mjs`. A value
   that cannot be JSON is replaced by a marker saying what was there, because an
   agent reading `{}` where a DOM node was cannot tell a bug from an empty
   result.

A scenario's own realm is why `urls.ts` reads a pattern's tag rather than
`instanceof RegExp`: a `RegExp` the scenario built belongs to the vm realm, and
`instanceof` answers false for it.

The trail exists because a scenario that throws half way used to come back as
the error and nothing else. What it can recover is bounded by what the runtime
owns: an `api` call is visible, a value the scenario kept in a variable of its
own is not, and the agent is told as much in so many words.

## 6. The window

`Shell` owns one `BaseWindow` for the whole application, not one per project.
Inside it sit `WebContentsView`s: one for the chrome panel, one per tab. Showing
a project is bringing its tab's view to the front and laying the window out
again.

One window, because the alternative is a window per project appearing and
disappearing as agents connect. The application normally lives in the menu bar
and the window comes forward when the person asks or when an agent needs them
(`tray.ts`).

The panel's width is the person's, set by dragging its edge; `preferences.ts`
holds the floor so the grip and the settings window clamp to the same number.

## 7. A window a page opens

A page that calls `window.open` gets a tab in the same project. This is not the
obvious implementation and the obvious one is wrong.

Denying the open and opening a tab ourselves makes `window.open` return `null`
and strips `window.opener`. Sign-in flows built on `response_mode=web_message`
deliver their result by `postMessage` back to the opener, so that arrangement
breaks "Sign in with Apple" and everything shaped like it — the defect this was
written to fix.

So the open is allowed and the window is built by us:

```ts
tab.wc.setWindowOpenHandler(() => ({
  action: 'allow',
  outlivesOpener: true,
  createWindow: (options) => {
    const pending = (options as { webContents?: WebContents }).webContents
    const child = this.#adopt(new Tab(this.session, pending), tab.openedBy)
    ...
    return child.wc
  },
}))
```

Two things in that are non-negotiable. The `WebContentsView` must **adopt**
`options.webContents` rather than create its own, or Electron refuses with
"Invalid webContents. Created window should be connected to webContents passed
with options object" and the real popup escapes into a window outside the
project. And `options` is otherwise **ignored**: it carries whatever the page put
in its `features` string, so passing it to `new BrowserWindow(options)` or
reading `options.icon` would let a page choose what the main process does. It is
read for one field, and that is the whole contract.

`Tab` holds its own `WebContents` in a private field rather than reading
`view.webContents` back, because Electron 44 clears that property once the
renderer is gone and the old code then threw inside `destroy`.

A window opened in an address this browser cannot show is the one case that is
**denied**. Allowing it would leave a tab with no document — nobody closes it,
and an agent can pick it to work in — so the handler reads `details.url`, takes
the same decision `schemes.ts` gives a click and a `navigate`, and hands the
address on or refuses it instead.

## 7a. An address this browser cannot show

Three outcomes, decided by the scheme alone and the same in every project:
loaded, handed to the machine, or refused in words. `schemes.ts` holds the
decision and imports no Electron; `hand-off.ts` holds the one call to
`shell.openExternal`.

It is taken at three entry points, because an address arrives three ways, and
the measurement on 2026-09-19 is what says so: a click raises `will-navigate`
and nothing else (`did-fail-load` never fires); `window.open` reaches the
window-open handler; an agent's own address goes through `Tab.navigate`. The
same measurement is why the decision is taken **before** the load — a failed
load answers `ERR_FAILED (-2)` whether the scheme is unknown or the page is
broken, and `isProtocolHandled` reports only what the application registered, so
neither can be asked which schemes Chromium renders. That list is therefore
written down in `schemes.ts`, and every entry in it was measured by loading it.

`Tab.navigate` throws the sentence, for a hand-off as much as for a refusal:
the page did not move in either case, and a scenario carrying on as though it
had is the defect this answers. The attempt is kept on the tab — `leftFor`, the
last ten — and read out in two places: `status` builds it on demand for the
agents, and the tab's own history carries a line for the person. It does not
ride on `TabDescriptor`, which crosses the wire on every title change.

## 8. The file boundary

The rule that outranks the others is about browsing context, and a file on disk
is not browsing state — so it does not settle this by itself. What settles it is
where the read happens: a scenario runs inside the browser process, nothing in
the agent's own harness sees it, and the text the scenario was written from is
page text, written by whoever controls the page. "Attach your key to continue"
is a real shape of prompt injection.

So `files.ts` bounds every read and every write to the project's own directory,
resolving symlinks before deciding, and refuses anything else by name. Downloads
are the mirror image: `downloads.ts` names the save path **before** Electron can
open a "Save as" panel — the window usually sits off screen, so that panel would
wait where nobody can answer it — and a file the page started rather than the
agent never lands in the project at all.

## 9. What is written down, and where

In the user-data directory of this copy:

- `settings.json` — the panel's width, the disguise, where the application
  appears, whether the login item was offered.
- `projects.json` — the projects the person has admitted or refused.
- the licence record — what the next check needs, and nothing more.
- Chromium's own per-partition state — cookies, storage, cache — flushed on
  `before-quit` through `flushAll`, which is what makes a login survive
  (**FR-PERSIST-1**).

Not written down, deliberately: agent sessions, which are live connections
(**FR-PERSIST-2**).

Not written down, and a defect: the tabs the person opened (**FR-PERSIST-3**).
The list lives in `ProjectContext` in memory and there is no restoring code
anywhere — it was never built, rather than switched off. The design questions it
raises are in
[the tabs the person opened come back](tasks/2026/09/the-tabs-the-person-opened-come-back.md).

## 10. Faults

Electron's default for an uncaught exception in the main process is a modal
dialog reading "A JavaScript error occurred in the main process", which the
person can neither act on nor learn from.

`main.ts` takes `uncaughtException` and `unhandledRejection` instead, and
`faults.ts` — pure, no Electron — decides what happens. Every fault is recorded
whatever was thrown, newest first, in a bounded list. Agents read them through
`status`, which is how a tab that stopped answering can be told from a page that
stopped answering. The person gets at most one system notification per repeating
message per minute, carrying no stack.

## 11. Licence and updates

`licence.ts` holds the rules and no I/O: what makes a stored answer good enough
to go on, and the exact shape of each request. `licence-store.ts` holds the
files, the network and the clock. A check can take a licence away and can never
hand one out, and the three ways the service can say "I do not know who you are"
are not a verdict on the key.

`updates.ts` uses `electron-updater` against the GitHub releases the disk image
came from. macOS only swaps one copy for another when both carry the same
signature, so `updatesItself()` decides up front whether this copy can update at
all, and a copy that cannot says why. Nothing installs behind the person's back:
quitting takes every agent's tabs with it, so the moment is theirs.

## 12. The testing seam

The split that makes this testable is **pure modules versus Electron callers**.

`login.ts`, `dock.ts`, `preferences.ts`, `licence.ts`, `update-rules.ts`,
`faults.ts`, `files.ts`, `urls.ts`, `serialize.ts`, `trail.ts`, `visits.ts`,
`commands.ts`, `queue.ts`, `lease.ts`, `mcp-address.ts`, `project.ts`,
`reference.mjs`, `render.mjs`, `schemes.ts` and the renderer's `tree.ts` import
no `electron`.
The unit suite loads them directly — 94 tests, about a second.

`main.ts` makes the Electron calls those modules decided about. The integration
suite (71 tests, about 20 seconds) drives a real window through the real MCP
endpoint, with `--user-data-dir` always passed so the suite is sealed off from
the state directory the owner is using.

Two surfaces are out of reach of both: the chrome panel and the settings window.
The accessibility API reaches them — `osascript` against System Events — and
`AGENTS.md` records how.

## 13. Build and distribution

Every verb is `deno task <verb>` and every one of them runs `scripts/task.ts`:
`check`, `test`, `dev`, `fmt`, `dist`, `install`.

`variant.ts` decides which copy this is from `productName`. The development copy
is "Naoba Dev", under its own bundle id, with its own state directory and its
own port, so it and the release copy can be installed at once and neither
touches the other.

## 14. Where the seams would move

- **A second window per project** would follow if the tree ever stops being
  enough to tell projects apart. `Shell` is written as one window with many
  views; splitting it is contained, and the isolation boundary would not move,
  because it is the session and not the window.
- **The transport** is already behind `Connection`. A second one — stdio, a
  socket again — would be a second implementation of that interface and nothing
  in the hub.
- **Tab persistence** (**FR-PERSIST-3**) wants a list of addresses per project
  written beside the settings. The open questions are when it is written,
  whether a restored tab loads eagerly, and what an agent sees for a tab with no
  owner.
