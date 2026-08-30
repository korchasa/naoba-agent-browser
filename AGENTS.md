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
- `src/renderer/` — the window's chrome

## Things learned the hard way

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

## Style

Comments explain why, never what. A comment that restates the code is noise; a
comment that records a constraint, a trap or a decision is the reason the next
person does not repeat a wasted afternoon.

Run `deno task check` before calling anything done, and `deno task test` before
calling it correct.
