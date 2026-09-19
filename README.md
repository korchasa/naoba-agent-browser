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

macOS. Nothing else: an agent reaches the application over HTTP, so there is no
second program to install and no Node on your PATH for it to need.

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

The application is the MCP server. There is nothing to install beside it and no
path into its bundle to keep current — an agent reaches it over HTTP on
loopback, at a fixed address.

Its settings window prints the whole line. It reads like this:

```sh
claude mcp add --transport http naoba http://127.0.0.1:8899/mcp
```

Or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "naoba": {
      "type": "http",
      "url": "http://127.0.0.1:8899/mcp"
    }
  }
}
```

An address and nothing else. There used to be a header carrying `${PWD}`, and
it only worked in clients that expand it — Claude Code in a terminal does, the
desktop application does not, and one that does not sends the four characters
and reaches no project at all. Nothing is expanded on the way here any more.

### The first call is `begin`

Everything a header used to carry, the agent now says itself, in the first call
it makes:

```
begin({
  session_name: "rewriting the checkout tests",
  absolute_project_path: "/Users/you/code/thing",
})
```

`absolute_project_path` is the project this session is working in. It decides
whose browser the session gets: sessions naming the same project share a
window, its cookies and its logins, and sessions in different projects share
nothing.

Which project that is, is the session's own business — Naoba takes the path it
is given and does not look for a repository above it or check that anything is
there. Two things are still settled here rather than left to chance. The path
has to be absolute, because nothing expands or resolves it on the way in, so a
relative path and a shell expression are both just text; and it is read as a
path rather than as a string, so a trailing slash, a symlink and a different
letter case are one project and not three. The first time a project appears,
the application asks whether to let it open a browser, and remembers the
answer.

`session_name` is a few words about what this session is doing — "rewriting the
checkout tests", not "agent 2". An agent is a session: one session in Claude or
in another client is one row in the window, with one tab. Two of them in one
repository are told apart by nothing else, and the name is what the person
reads — beside the tab, in the question asking whether to admit a new project,
and in the message another session gets when this one is holding a tab it
wants.

`begin` opens the session's tab at the same time, at a `url` if it was given
one, and answers with that tab and the other sessions working here — so one
round trip does what used to take three. It says nothing back about the project
or about the caller: the session named both a moment ago, and its id is the
header it has been echoing all along. Every other tool waits for `begin`:
called first, they come back asking for it.

A session is known by the `Mcp-Session-Id` the application hands out at
`initialize` and the client echoes from then on. One id is one session in one
project. An id that calls `begin` again naming a different project moves there,
and takes nothing from the first one with it.

What happens between that first call and the moment an agent's tabs are let go,
in four sequence diagrams:
[documents/how-a-session-works.md](documents/how-a-session-works.md).

### The port

The copy people download listens on 8899 and the development copy on 8900, so
both can be installed at once and an agent pointed at one never lands in the
other. The port is fixed rather than found: it sits in a configuration file and
has to mean the same thing after a restart. When it is already taken, the
application says so and stops instead of moving to a port nothing names.

A second copy of the same variant never gets that far: the single-instance lock
lives in the state directory, and each variant has its own. So a taken port is
always somebody else's program — most often a Naoba older than 1.0.4, which
took whatever it found between 8899 and 8910.

### There is no token

The port answers any request that reaches it, and reaching it means already
running on this Mac as you. A program that far in could read whatever a secret
were kept in, so demanding one protected nothing and cost every agent a header
to get wrong. Naoba asked for a token in earlier versions and no longer does;
an `Authorization` header left in an old configuration is ignored.

The browser itself is not open to the network: the endpoint listens on
127.0.0.1 only, so nothing outside this Mac can reach it at all. A web page
cannot either — browsers ask their user before a page may touch a loopback
address.

### Starting the application

An installed copy registers itself as a login item on first start and is
normally running. When it is not, the IDE reports a connection it could not
make; open Naoba and the agent's next call goes through.

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

## Updates

The copy you download replaces itself. It looks for a newer version when it
starts and every six hours after that, fetches it in the background, and then
waits: quitting Naoba takes every agent's tabs with it, so the settings window
says a new version is ready and the moment to install it is yours to pick.

A copy built from this source does not do that — it has no signature matching
the one a release carries, and macOS swaps one copy for another only when they
agree. The settings window says so instead of looking.

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
await api.fill('#search', 'headless chromium')
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

When the page has a file you want:

```js
await api.navigate('https://example.com/reports')
await api.click('#export')
const file = await api.waitForDownload()
```

The file is saved and you get `{path, url, filename, bytes, mimeType}` back. No
save dialog appears and nobody is asked — this window normally sits off screen,
so a dialog there would be a scenario waiting for an answer that never comes.
When the file has an address of its own, `api.download(url)` fetches it from the
tab, with that tab's cookies, and takes a path of your own as a second argument.

Navigating to an address that turns out to be a file downloads it too, and the
tab stays on the page it was showing — Chromium calls that a failed load, and
this browser does not pass the error on.

A file lands in a temporary directory unless you name a path, and a path you
name has to be inside the project — the same boundary `setFiles` reads within. A
download the page started by itself is never written inside the project at all.

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

## What a page is not allowed to do

A page gets nothing it asks for. The microphone, the camera, the screen,
reading the clipboard, notifications, a location — all refused, in every
project, with no way to turn one on. A browser that normally sits off screen in
the menu bar has nobody watching for a microphone indicator, and the page doing
the asking was usually chosen by an agent rather than opened by you.

The refusal is prompt, which matters more than it sounds: a request nobody
answers reads to an agent as a page that will not finish loading, and the cause
is nowhere near the page.

Some ordinary things go with it. A site's own "copy" button, its full-screen
view and a map's drag-to-look are asked for the same way and are refused the
same way. If you find a page that needs one of them, that is worth reporting
rather than working around.

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
