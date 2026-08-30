# Agent Browser

A browser that several AI coding agents drive at once — and that keeps the
projects they work on apart.

Agents working in the same project share one window: its tabs, its cookies, its
logged-in sessions. Agents working in different projects share nothing at all —
not a tab, not a cookie, not a login. That boundary is the point of the
application.

## Why it exists

Tools that give an agent a browser usually hand it *your* browser, with every
session you are signed into. That is convenient until two agents work on two
different things: a login belonging to one project is then visible to an agent
working on another, and nothing prevents it.

This is a browser of its own. It starts empty, you sign into what you need
inside it, and each project keeps what it was given.

The rest follows from being an application rather than a browser extension:

- **Input the page cannot tell from a person's.** Clicks and typing are
  delivered as real events (`isTrusted: true`), so pages that reject synthetic
  events work normally.
- **A network log, and response bodies.** The DevTools protocol is available,
  not approximated.
- **A whole scenario per call.** An agent writes JavaScript, not one call per
  click.
- **Somewhere to ask for help.** When an agent meets a login or a payment, it
  hands the tab over and waits for you.

## Requirements

macOS, and Node 20 or newer for the bridge.

## Install

```sh
npm install
npm run build
```

Start it:

```sh
npm start
```

## Connect an agent

The bridge is an MCP server. Point your IDE at `packages/bridge/index.mjs`.

Claude Code:

```sh
claude mcp add agent-browser -- node /absolute/path/to/packages/bridge/index.mjs
```

Or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-browser": {
      "command": "node",
      "args": ["/absolute/path/to/packages/bridge/index.mjs"]
    }
  }
}
```

The bridge takes the agent's working directory, walks up to the repository root,
and that is the project. The first time a folder appears, the application asks
whether to let it open a browser; the answer is remembered.

While developing the application itself there is no installed bundle to launch,
so tell the bridge where the checkout is:

```sh
export AGENT_BROWSER_DEV_ROOT=/absolute/path/to/this/checkout
```

## What an agent writes

One call carries the whole flow:

```js
await api.navigate('https://example.com')
await api.fill('#search', 'agent browser')
await api.press('Enter')
await api.waitFor('.results', { timeout: 5000 })
return await api.snapshot()
```

`api.snapshot()` returns a readable tree where every clickable element carries a
`ref_N`, and any helper takes a `ref_N` where it takes a selector — which is how
you work with a page whose class names are generated.

When a site wants an account:

```js
await api.navigate('https://example.com/dashboard')
if (await api.getText('h1') === 'Sign in') {
  await api.requestHuman('sign in to the dashboard')
}
return await api.getText('.balance')
```

The window comes forward with that sentence on it. Your call resumes when the
person marks it done.

When the thing you need is inside a frame:

```js
await api.navigate('https://example.com/checkout')
await api.type('#card', '4242…', { frame: 'payments.example' })
return await api.getText('#result', { frame: 'payments.example' })
```

A payment form, an embedded editor and a documentation sandbox each live in a
frame of their own, and a selector run against the page never sees inside one.
`api.frames()` lists them; every helper takes `{ frame }` — an index, or any
part of the frame's address or name.

When you want to look at the page yourself:

```js
const path = await api.screenshot()
```

The picture is written to a file and you get its path — a PNG of a real page is
a couple of hundred kilobytes of base64, which is more than the wire carries in
one value and more than any agent wants to read as text. Pass a path of your own
if you care where it lands.

The full list of helpers is in the tool description the bridge publishes, so an
agent has it without being told.

## Several agents, one project

Every agent gets a tab of its own, so two agents doing unrelated work never
queue behind each other. They can see each other's tabs and take one over
deliberately with `selectTab`; commands against a shared tab then run one after
another rather than interleaving. `claimTab` holds a tab across several calls
for a scenario that must not be interrupted, and the person can always take it
back.

## Commands

- `deno task check` — types and build
- `deno task test` — the whole suite
- `deno task dev` — build and (re)start the app
- `deno task dist` — an unsigned application bundle

Signing, packaging and distribution happen outside this repository.
