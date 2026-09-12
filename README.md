# Naoba — blazing-fast browser for agents

A browser that several AI coding agents drive at once — and that keeps the
projects they work on apart.

Agents working in the same project share its tabs, its cookies, its logged-in
sessions. Agents working in different projects share nothing at all — not a
tab, not a cookie, not a login. That boundary is the point of the application.
There is one window, and its panel lists every project, the agents in each,
their tabs and what they did there; the projects meet only in that list.

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

## The window

There is no row of tabs across the top. Down the left side is a tree: every
agent working in this project, under each agent the tabs it has been in, and
under each tab the calls it made there. A tab two agents share appears under
both of them, each seeing its own calls; the tabs you opened yourself, and any
left behind by an agent that has gone, sit in a group of your own at the
bottom. The address bar for whichever tab is in front is above the tree, and
a strip along the bottom says how many agents and tabs the project has.

Pages see an ordinary Chromium: the user agent does not mention Electron or
Naoba, and `navigator.webdriver` is false. **Announce automation**, in the
settings window, switches this off for the whole browser — the Electron user
agent comes back and `navigator.webdriver` turns true — so a bot check you are
building can be watched firing. The choice is kept across restarts;
`--announce-automation` starts the browser that way.

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

The bridge is an MCP server. An installed application carries it, so point your
IDE at `/Applications/Naoba.app/Contents/Resources/bridge/index.mjs`; working
from this checkout, point it at `packages/bridge/index.mjs` instead. Either way
it is one file and needs nothing installed beyond Node.

Claude Code:

```sh
claude mcp add naoba -- node /absolute/path/to/packages/bridge/index.mjs
```

Or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "naoba": {
      "command": "node",
      "args": ["/absolute/path/to/packages/bridge/index.mjs"]
    }
  }
}
```

The bridge takes the agent's working directory, walks up to the repository root,
and that is the project. The first time a folder appears, the application asks
whether to let it open a browser; the answer is remembered.

When nothing is listening, the bridge starts the application itself. It looks
for the release copy first (bundle id `dev.korchasa.Naoba`, then
`/Applications/Naoba.app` and `~/Applications/Naoba.app`), then for the
development copy (`dev.korchasa.Naoba.dev`, `Naoba Dev.app` in the same two
places), and last at a bare checkout named by `NAOBA_DEV_ROOT`:

```sh
export NAOBA_DEV_ROOT=/absolute/path/to/this/checkout
```

`NAOBA_APP=/path/to/Some.app` names one bundle explicitly and wins over all of
them.

### The token

Loopback is not a boundary between the programs running on one machine, and the
browser on the other side of that port holds your logged-in sessions. So the
application admits only something that can read a file of its own: at every
start it writes `bridge.json` into its state directory — the port it listens on
and a token for this run, readable by the owner alone — and it closes any
connection whose first message does not carry that token. A token from an
earlier run is worth nothing.

The bridge reads that file itself, so there is nothing to set up. When the
application runs with a state directory of its own, `NAOBA_STATE_DIR` names it.

## The development copy

The application can be installed twice: the release copy, and a development
copy under its own bundle id and name — **Naoba Dev**, the way the other
applications keep a " Dev" copy next to the release one. Each keeps its own
state under `~/Library/Application Support/<name>`, so trying a build never
touches the sessions the release copy holds.

```sh
deno task install dev
```

builds the development copy, quits the one that is running (its sessions reach
disk on quit), replaces it in `/Applications` and starts it. `deno task install`
without the argument does the same for the release copy. Neither signs
anything.

The first start of the development copy on a machine that has been running the
checkout copies that state — the logins above all — into its own directory, so
it is useful from day one; the checkout keeps working on the original.

## Settings

Everything you set by hand is in one window, and the window itself says what
each setting does. It opens with ⌘, from the application menu, from the gear in
the panel's foot, or from the menu-bar icon — and asking for it twice brings the
one that is open forward. Every setting applies at once and is kept across
restarts. Under them is the register of projects you have been asked about,
allowed and refused alike.

An installed copy registers itself as a login item on its first start, once. The
switch in the settings reads the OS's answer, and so does System Settings ›
Login Items — turn it off in either place and the application does not turn it
back on. A checkout never registers anything; `deno task install` says at the
end whether the copy it just started is a login item.

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

The tool description carries the shape of a scenario and the few helpers that
save a round trip. `api.help()` prints the rest — every helper with its
arguments — and `api.help('click')` prints one of them. The description is kept
short on purpose: a client cuts a long one, and the half it cuts used to be the
half with the tabs, the cookies and the waits in it.

## Several agents, one project

Every agent gets a tab of its own, so two agents doing unrelated work never
queue behind each other. They can see each other's tabs and take one over
deliberately with `selectTab`; commands against a shared tab then run one after
another rather than interleaving. `claimTab` holds a tab across several calls
for a scenario that must not be interrupted, and the person can always take it
back.

An agent's tabs belong to it and close when it disconnects, so a day of sessions
starting and finishing does not leave a window full of pages nobody is reading.
Tabs the person opened stay. That also means a tab you take over from an agent
goes away when that agent's session ends — copy the address out if you want to
keep it.

## Commands

- `deno task check` — types and build
- `deno task test` — the whole suite
- `deno task dev` — build and (re)start the app
- `deno task dist [dev]` — an unsigned application bundle, the development copy with `dev`
- `deno task install [dev]` — build, replace in `/Applications` and start

Signing, packaging and distribution happen outside this repository.

## Licence

The source is under the PolyForm Noncommercial License 1.0.0: read it, build
it, change it, use it for anything that is not commercial. The built
application sold as Naoba is a separate thing — buying it licenses you to run
that binary, under the terms in [EULA.md](EULA.md), and nothing in this
repository grants or withholds that.

### The key

The application you buy is unlocked with a key, once per Mac. Until it is
unlocked it refuses every agent and says so, and the settings window opens by
itself with the field to type the key into. Deactivating frees the key for a
different Mac.

The key is checked against the licensing service now and then, and the answer
is kept: a month without the service confirming it again changes nothing, so
the application works on a train, on a plane and on a network that is down. A
key that is refunded or cancelled stops working at the next check.

The check is part of the application, so a copy you build from this source and
install as Naoba asks for a key too. The one exception is the development copy
— `deno task install dev`, which installs "Naoba Dev" under its own bundle id
and its own state — and it admits agents without a key, because it exists for
working on the application rather than using it. What the source licence above
gives you is the right to read the code, change it and build on it — including
changing any of that.
