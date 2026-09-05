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
- `src/main/runner.ts` — runs that script
- `src/main/lease.ts`, `queue.ts` — who may act on a tab, and in what order
- `src/main/hub.ts` — admission and routing
- `src/main/server.ts`, `protocol.ts` — the wire
- `packages/bridge/` — the MCP server an IDE launches, one per agent
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
  `settings.json` in the user-data directory. Today that is the panel width,
  which the person drags on the panel's right edge; the main process owns the
  layout, clamps the width, applies it to every window and writes it down.
- **Every colour lives in `src/renderer/palette.css`.** The panel and the
  snapshot demo page both link it, so a tint changes in one place. A colour
  literal anywhere else in the renderer is a defect: the demo page kept a
  blue button through two accent changes because it carried its own hex.
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
calling it correct.
