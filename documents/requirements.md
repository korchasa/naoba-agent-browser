# What Naoba has to do

The requirement register. Every entry is numbered so a task can point at it
(`implements: [FR-TAB-4]`) and so a claim that something is built can be
checked rather than believed.

Each requirement carries an **Acceptance** line naming the test that proves it
or the command that shows it. A name in quotation marks is a test name: run it
with

```bash
node --test --test-concurrency=1 --test-timeout=90000 --test-name-pattern='<the name>' test/integration.test.mjs
```

and swap `test/unit.test.mjs` for the ones marked *(unit)*. A requirement whose
acceptance reads **not yet** is a promise this application has not kept; it
names the task that will.

How it does these things is [`design.md`](design.md). The traps to avoid while
changing it are in `AGENTS.md`, which is the rulebook and not a contract.

## 1. Isolation

The rule that outranks every other requirement in this file. Where two
requirements disagree, this one wins.

- **FR-ISOLATION-1.** A project's browsing context is never reachable from
  another project: not through a tab, a cookie, a storage entry, a cache, a
  download or a debug switch.
  *Acceptance:* "two projects share nothing: not cookies, not storage, not tabs".
- **FR-ISOLATION-2.** Every facility that touches browsing state goes through
  the project's own Electron session, built from `partitionFor(projectId)`.
  Nothing uses `session.defaultSession`.
  *Acceptance:* `grep -rn "defaultSession" src/` prints nothing.
- **FR-ISOLATION-3.** A partition name never carries the project's path, so the
  directory somebody works in is not written into a state directory name.
  *Acceptance:* "a partition name never carries the path" *(unit)*.
- **FR-ISOLATION-4.** One directory spelled several ways — trailing slash,
  different case, a symlink — is one project with one browser.
  *Acceptance:* "one directory spelled two ways is one project" *(unit)*,
  "a project is exactly the path the session named, subdirectory or not" *(unit)*.
- **FR-ISOLATION-5.** Two agents naming the same project share that project's
  tabs and logins; two agents in different projects share nothing.
  *Acceptance:* "two agents in one project share the same tabs",
  "one session id that names a second project moves to it, and keeps nothing".

## 2. Projects and admission

- **FR-PROJECT-1.** A project is identified by an absolute path. A relative
  path, or anything a shell would have expanded, is refused with a sentence
  saying what to write instead.
  *Acceptance:* "a project that is not an absolute path is refused, and the
  sentence says why", "an agent that does not say which project it is in is told
  what to add".
- **FR-PROJECT-2.** A directory that is not a repository is still a project.
  *Acceptance:* "a directory outside a repository is its own project" *(unit)*.
- **FR-PROJECT-3.** A project the application has never seen gets a browser of
  its own without the agent having to register it first.
  *Acceptance:* "a project Naoba has never seen is believed, and gets a browser
  of its own".
- **FR-PROJECT-4.** The person can see which projects have been admitted and
  which refused, and that register survives a restart.
  *Acceptance:* "the projects the person has answered about read as allowed or
  refused" *(unit)*.

## 3. The endpoint agents reach

- **FR-ENDPOINT-1.** The application answers MCP itself, over HTTP on loopback.
  No relay process, no file anybody has to read to find the address.
  *Acceptance:* the whole of `test/integration.test.mjs`, which speaks to the
  application over that endpoint and nothing else.
- **FR-ENDPOINT-2.** The port is fixed per copy, so a line pasted into an IDE
  configuration still works after a restart, and the development copy and the
  downloaded copy never collide.
  *Acceptance:* "the development copy and the copy people download answer on
  different ports" *(unit)*.
- **FR-ENDPOINT-3.** What a person pastes into their IDE is an address and
  nothing else — no command, no wrapper, no token.
  *Acceptance:* "the line a person pastes is an address and nothing else" *(unit)*.
- **FR-ENDPOINT-4.** A request carrying no `Authorization` header is answered,
  and one carrying a header left over from an older configuration is answered
  too rather than refused.
  *Acceptance:* "a request carrying no authorization at all is answered",
  "an Authorization header left over from an older configuration is ignored".
- **FR-ENDPOINT-5.** A client that never echoes the session header is told to,
  in a sentence it can act on.
  *Acceptance:* "a request that never echoed the session header is told to".
- **FR-ENDPOINT-6.** Two requests arriving together under one session id
  introduce one agent, and two session ids in one project stay two agents.
  *Acceptance:* "two calls that arrive together introduce one agent, not two",
  "two session ids in one project stay two sessions".

## 4. The three tools

- **FR-TOOL-1.** An agent is offered exactly three tools: `begin`,
  `evalInBrowser`, `status`.
  *Acceptance:* "the tools an agent is offered are the three the manual
  describes".
- **FR-TOOL-2.** `begin` is the first call. Any other tool called before it is
  told to call `begin` and what to put in it.
  *Acceptance:* "a tool called before begin is told to call begin, and what to
  say in it".
- **FR-TOOL-3.** `begin` requires a session name, because that name is what the
  person reads beside the agent's tab.
  *Acceptance:* "begin without a name is refused, because the name is the whole
  point of it".
- **FR-TOOL-4.** `begin` opens the agent's tab, at the address it was given when
  it was given one, and answers with that tab and the other sessions in the
  project under the names they chose.
  *Acceptance:* "begin opens the tab, and takes it to the address it was given",
  "the other sessions in a project are listed under the names they chose".
- **FR-TOOL-5.** Every tool result is prose a model can read, and a failure
  explains itself in the result rather than as a protocol error.
  *Acceptance:* "a tool call comes back as prose the model can read",
  "a failing tool call explains itself in the result rather than in the protocol".
- **FR-TOOL-6.** `status` describes the project's browser now: its tabs and
  their state, the agents connected to it, which of them is the caller, and the
  faults the application itself has had since it started.
  *Acceptance:* "a fault in the browser itself is recorded, not put on screen".

## 5. Tabs

- **FR-TAB-1.** A tab belongs to whoever opened it. A tab an agent opened leaves
  with that agent; a tab the person opened does not.
  *Acceptance:* "a tab an agent opened leaves with the agent".
- **FR-TAB-2.** A window a page opens is a tab in the same project, and the page
  that opened it can still talk to it — `window.open` returns a handle and
  `window.opener` is there. Sign-in flows that deliver their result by
  `postMessage` depend on this.
  *Acceptance:* "a window a page opens is a tab that can still talk to the page
  that opened it".
- **FR-TAB-3.** A page that closes its own window closes the tab with it.
  *Acceptance:* "a window that closes itself takes its tab with it".
- **FR-TAB-4.** An address in a scheme this browser does not handle is answered
  rather than swallowed. `mailto:`, `tel:` and `sms:` go to the machine; every
  other scheme is refused in words naming the address. The tab stays where it
  was, and the attempt is readable afterwards.
  *Acceptance:* "a mail link a page offers is handed to the system and the tab
  stays where it was", "an address in a scheme nobody here handles is refused in
  words, not by a bare error code", "a page opening a mail window gets no blank
  tab", "the scheme rule has three outcomes, and every scheme in the rendered
  list was measured".
- **FR-TAB-5.** Opening a tab without an address says what is missing instead of
  opening something blank.
  *Acceptance:* "opening a tab without an address says what is missing".

## 6. Scenarios

- **FR-SCENARIO-1.** An agent writes a whole scenario — navigate, act, read,
  return — and it runs in one call.
  *Acceptance:* "a FoxCode scenario runs unchanged".
- **FR-SCENARIO-2.** Input reaches the page as a real event, indistinguishable
  from a person's, not as a synthetic one dispatched from script.
  *Acceptance:* "input reaches the page as a real event, not a synthetic one",
  "pressing Enter in a field submits the form, the way a person searching
  would", "a drag is a press, a run of moves, and a release — not a click".
- **FR-SCENARIO-3.** Keys and clicks land correctly whether or not the window is
  the one the person is looking at, and whether or not the page is zoomed.
  *Acceptance:* "keys reach the page even though the window is not the one the
  person is using", "a click lands on the right element when the page is
  zoomed".
- **FR-SCENARIO-4.** A snapshot gives every clickable node a ref usable wherever
  a selector is, in the form `snapshot()` printed it.
  *Acceptance:* "a snapshot ref can be used wherever a selector can, in the form
  snapshot() prints it".
- **FR-SCENARIO-5.** A selector that never matches, or a ref the page has since
  replaced, says so and names the page it was looking at.
  *Acceptance:* "a selector that never matches says which page it was looking
  at", "a ref from a snapshot the page has replaced says so, in either form".
- **FR-SCENARIO-6.** A page's frames are reachable: readable, typable, clickable.
  *Acceptance:* "a frame is reachable: read it, type in it, click in it".
- **FR-SCENARIO-7.** A navigation is waited out so the page it ended at can be
  read immediately; a page already at the address does not wait at all; a page
  that moves without loading is waited for rather than slept through; a frame
  moving on its own is not mistaken for the page arriving.
  *Acceptance:* "a navigation is waited out, so the page it ended at can be read
  straight away", "a page already at the address does not wait at all", "a page
  that moves without loading is waited for, not slept through", "a frame moving
  on its own is not the page arriving, and the wait says so".
- **FR-SCENARIO-8.** A wait that runs out says where the page went instead.
  *Acceptance:* "a wait that runs out says where the page went instead".
- **FR-SCENARIO-9.** A URL to wait for may be a substring or a regular
  expression, including one the scenario built itself inside its own realm.
  *Acceptance:* "a URL pattern is a substring or a regular expression, and
  nothing else" *(unit)*, "a pattern the scenario built itself is still a
  pattern, and a borrowed tag is not" *(unit)*, "a pattern describes itself for a
  message that has room for one line" *(unit)*.
- **FR-SCENARIO-10.** A field behind a rich editor names the editor to write
  into instead of failing silently; a hidden field with no editor over it says
  what it has always said.
  *Acceptance:* "a field behind a rich editor names the editor to write into
  instead", "a hidden field with no editor over it says what it has always
  said".
- **FR-SCENARIO-11.** Dialogs a page raises are answered the way the agent
  asked, and never left on screen.
  *Acceptance:* "dialogs are answered the way the agent asked".
- **FR-SCENARIO-12.** The network log carries requests and their bodies.
  *Acceptance:* "the network log carries requests and their bodies".

## 7. What comes back

- **FR-RESULT-1.** Whatever a scenario returns survives the trip as JSON, and a
  value that cannot make it says what it was instead of vanishing into `{}`.
  *Acceptance:* "a value that cannot be JSON says what it was instead of
  vanishing" *(unit)*, "a value that cannot be read costs its own key, never the
  result" *(unit)*, "a builtin the scenario built itself keeps its marker across
  the realm boundary" *(unit)*, "a borrowed toStringTag is data, not a builtin"
  *(unit)*.
- **FR-RESULT-2.** A promise the scenario forgot to await is named as one.
  *Acceptance:* "a promise the scenario forgot to await is named, not an empty
  object" *(unit)*.
- **FR-RESULT-3.** A scenario that fails hands back what the steps before it
  did, in the order they happened, with the arguments named but not carried
  whole.
  *Acceptance:* "a scenario that fails hands back what the steps before it did",
  "a call names its arguments without carrying them whole" *(unit)*, "a trail
  keeps the calls nearest the failure, and says how many it dropped" *(unit)*,
  "a call that threw is recorded as one, with the reason" *(unit)*, "a call that
  has not come back is in the trail, marked as running" *(unit)*, "a recorded
  answer is a summary, and says when it was cut" *(unit)*, "the text an agent
  reads names the steps and says they already happened" *(unit)*.
- **FR-RESULT-4.** A scenario that runs out of time keeps what it did and names
  what it was doing when the clock ran out.
  *Acceptance:* "a scenario that runs out of time keeps what it did, and names
  what it was doing".
- **FR-RESULT-5.** Recording what a scenario did never changes what the scenario
  sees and never throws, whatever a call answered.
  *Acceptance:* "the wrapper leaves the surface an agent sees exactly as it
  found it" *(unit)*, "recording cannot throw, whatever the call answered"
  *(unit)*, "a scenario that succeeded reads exactly as it did before" *(unit)*,
  "a throw out of a helper is recorded and still reaches the scenario" *(unit)*.
- **FR-RESULT-6.** A failing script explains itself rather than returning
  nothing.
  *Acceptance:* "a failing script explains itself instead of returning nothing".

## 8. Whose turn it is

- **FR-TURNS-1.** Two agents acting on one tab run one after the other, never
  interleaved.
  *Acceptance:* "two agents against one tab run one after the other, never
  interleaved" *(unit)*, "two agents typing into one field produce whole words,
  not interleaved letters".
- **FR-TURNS-2.** Different tabs do not wait for each other, and one failing
  task does not poison the tab for the next one.
  *Acceptance:* "different tabs do not wait for each other" *(unit)*, "one
  failing task does not poison the tab for the next one" *(unit)*.
- **FR-TURNS-3.** A claimed tab keeps another agent out and names who is holding
  it.
  *Acceptance:* "a claimed tab keeps another agent out, and names who is holding
  it", "a lease keeps a second agent out and lets the first one back in"
  *(unit)*, "a task that waits too long is told who is holding the tab" *(unit)*.
- **FR-TURNS-4.** A lease cannot be held forever: an agent that crashes or
  disconnects lets go of the tab.
  *Acceptance:* "a crashed agent cannot hold a tab forever" *(unit)*, "an agent
  that disconnects mid-lease lets go of the tab", "a disconnect drops every tab
  that agent was holding" *(unit)*.
- **FR-TURNS-5.** The person always wins a tab, and the agent holding it is
  told.
  *Acceptance:* "the person always wins a tab, and the agent is told" *(unit)*.

## 9. Handing a tab to the person

- **FR-HUMAN-1.** An agent can hand a tab to the person, wait, and carry on
  afterwards.
  *Acceptance:* "an agent can hand a tab to the person and carry on afterwards".
- **FR-HUMAN-2.** What comes back says where the person went, not only where
  they stopped — every move of the page, in order, timed from the hand-over.
  *Acceptance:* "requestHuman says where the person went, not only where they
  stopped", "a walk is kept in the order it happened, timed from the hand-over"
  *(unit)*, "a step the page takes twice is one move of the page" *(unit)*.
- **FR-HUMAN-3.** A person who touched nothing comes back as an empty walk, not
  a missing one, and a request nobody answers still reports what the page did
  while it waited.
  *Acceptance:* "a person who touched nothing comes back as an empty walk, not a
  missing one", "a request nobody answers still says what the page did while it
  waited".
- **FR-HUMAN-4.** A long walk keeps its tail and says how much it dropped.
  *Acceptance:* "a long walk keeps its tail and says how much it dropped"
  *(unit)*, "a walk describes itself for an error message that has room for one
  line" *(unit)*.

## 10. Files

- **FR-FILES-1.** A scenario may hand a website only files inside the project it
  is working in. A path outside it is refused by name, and so is a symlink that
  leads out.
  *Acceptance:* "a path outside the project is refused by name, and so is a
  symlink out of it", "a file to upload is taken from the project, whatever
  spelling of it the agent used" *(unit)*.
- **FR-FILES-2.** A file reaches a hidden input and the page hears about it;
  several go in at once; a ref may name the input; an element that is not a file
  input says what it is instead.
  *Acceptance:* "a file reaches a hidden input, and the page hears about it",
  "several files go in at once, and a ref names the input", "an element that is
  not a file input says what it is instead".
- **FR-FILES-3.** A screenshot is written inside the project and nowhere else; a
  screenshot with no path becomes a temporary file named after the project.
  *Acceptance:* "a screenshot outside the project is refused, and says where it
  may go", "a screenshot with no path is a temporary file named after the
  project", "a screenshot is written inside the project, and nowhere else"
  *(unit)*.
- **FR-FILES-4.** A screenshot reaches the agent as a file even when no window
  is on screen.
  *Acceptance:* "a screenshot reaches the agent as a file, even with no window
  on screen".
- **FR-FILES-5.** A download the agent asked for arrives with no dialog and
  nothing asked, at a path inside the project; one the page started does not
  reach the project at all, and the page never chooses where a file lands.
  *Acceptance:* "a download the agent asked for arrives with no dialog and
  nothing asked", "a download may be given a path, and only inside the project",
  "a file the page built itself is still a download, and never lands in the
  project", "a file the page named cannot choose where it lands" *(unit)*, "a
  download the agent asked for goes where it said; one the page started does
  not" *(unit)*.
- **FR-FILES-6.** An address that turns out to be a file is a download, not a
  failed navigation, and waiting for a download says what to do when none comes.
  *Acceptance:* "an address that turns out to be a file is a download, not a
  failed navigation", "waiting for a download waits, and says what to do when
  none comes".

## 11. What survives a restart

Three kinds of state answer a quit differently, and two of the three differences
are deliberate.

- **FR-PERSIST-1.** A project's logins survive the application being quit and
  opened again. Cookies and page storage are written on `before-quit`, and
  anything that touches browsing state keeps that promise.
  *Acceptance:* "a login survives the application being restarted, not just the
  tab being closed", "a login made by hand survives the tab being closed".
- **FR-PERSIST-2.** An agent session does not survive, and must not. A session
  is a live connection; the agent reconnects with `begin` and gets a fresh tab.
  Nothing may try to restore one — an agent that comes back is a new agent, and
  treating it as the old one would hand it a tab it never opened.
  *Acceptance:* "a tab an agent opened leaves with the agent".
- **FR-PERSIST-3.** The tabs the person opened survive the application being
  quit and opened again, in the projects they belonged to.
  *Acceptance:* **not yet** —
  [the tabs the person opened come back](tasks/2026/09/the-tabs-the-person-opened-come-back.md).
- **FR-PERSIST-4.** The tabs an agent opened do not come back, for the same
  reason their owner's departure closes them.
  *Acceptance:* **not yet** — same task as FR-PERSIST-3.
- **FR-PERSIST-5.** What the person set by hand — the panel's width, the
  disguise, where the application appears, the admitted projects, the licence —
  is found again tomorrow.
  *Acceptance:* "every preference the window draws is a value the application
  sends, and back" *(unit)*, "a settings file holding anything else starts the
  application in the menu bar" *(unit)*.

## 12. The window

- **FR-WINDOW-1.** The window's chrome is an address bar and a tree of agents,
  their tabs and the calls made in them. A tab hangs under the agent that opened
  it; a borrowed tab stays where it is.
  *Acceptance:* "a tab hangs under the agent that opened it" *(unit)*, "a
  borrowed tab stays in one place, and its history keeps every call in order"
  *(unit)*.
- **FR-WINDOW-2.** Nothing falls out of the tree: an agent that has gone keeps
  its row while its tabs are still here, a tab whose owner is in no list still
  gets a row, and an agent with no tab still has a place.
  *Acceptance:* "an agent that has gone keeps its row, marked, while its tabs
  are still here" *(unit)*, "a tab whose owner is in no list still gets a row,
  never falls out of the tree" *(unit)*, "an agent with no tab still has a place
  in the tree" *(unit)*.
- **FR-WINDOW-3.** The agents can be ordered by arrival, by latest activity or
  by name; the tree opens on every agent and keeps every tab folded; a branch
  folded by hand stays folded when a later agent connects.
  *Acceptance:* "the agents can be ordered by arrival, by latest activity, or by
  name" *(unit)*, "the tree opens on every agent and keeps every tab folded"
  *(unit)*, "an agent that connects later opens too, and a branch folded by hand
  stays folded" *(unit)*.
- **FR-WINDOW-4.** A tab keeps its newest calls and drops the oldest, per tab,
  so a busy tab cannot push a quiet one's history out.
  *Acceptance:* "a tab keeps its newest calls and drops the oldest" *(unit)*.
- **FR-WINDOW-5.** The settings window is one window however often it is asked
  for, and nothing is pushed at a settings window that is not there.
  *Acceptance:* "the settings window is one window, opened again and again"
  *(unit)*, "nothing is pushed at a settings window that is not there" *(unit)*,
  "the settings window is told what happened, not only that something did"
  *(unit)*.

## 13. Where the application appears

- **FR-PRESENCE-1.** The application lives in the menu bar. A window comes to
  the screen when the person clicks for it, or when an agent needs them.
  *Acceptance:* `src/main/tray.ts`, and the accessibility walk described under
  **Style** in `AGENTS.md`.
- **FR-PRESENCE-2.** The person chooses where the application appears — menu
  bar, Dock, or both — and is never left with neither.
  *Acceptance:* "the application is never left with neither icon, whatever the
  choice" *(unit)*, "the choice of where to appear is drawn as the three places,
  the current one marked" *(unit)*.
- **FR-PRESENCE-3.** The Dock icon counts what is waiting for the person and
  nothing else. It bounces when a new call starts waiting, and not while it
  waits; a call already waiting when the icon appears is shown but not
  announced.
  *Acceptance:* "the Dock icon counts what is waiting for the person, and
  nothing else" *(unit)*, "the Dock icon bounces when a new call starts waiting,
  and not while it waits" *(unit)*, "a call already waiting when the Dock icon
  appears is shown but not announced" *(unit)*.
- **FR-PRESENCE-4.** The application offers to start at login once, and only an
  installed copy registers itself — never a checkout and never a test run. The
  OS holds the switch's state, and the application never argues with it.
  *Acceptance:* "the login item is registered once, by an installed copy, and
  never by a test or a checkout" *(unit)*.

## 14. Faults

- **FR-FAULT-1.** A fault in the application itself never reaches the person as
  a dialog they cannot act on.
  *Acceptance:* "a fault in the browser itself is recorded, not put on screen".
- **FR-FAULT-2.** Every fault is recorded whatever was thrown — an error, a
  string, nothing at all — and the newest is read first.
  *Acceptance:* "a fault is recorded whatever was thrown, and the newest is read
  first" *(unit)*.
- **FR-FAULT-3.** Agents can read the faults through `status`, so a tab that
  stopped answering can be told from a page that stopped answering.
  *Acceptance:* "a fault in the browser itself is recorded, not put on screen".
- **FR-FAULT-4.** A repeating fault is announced to the person once, and every
  occurrence is still kept. What the person reads carries no stack and says
  nothing was lost.
  *Acceptance:* "only the first of a repeating fault is announced, and every one
  is kept" *(unit)*, "what the person reads carries no stack, and says nothing
  was lost" *(unit)*.
- **FR-FAULT-5.** The fault list is bounded.
  *Acceptance:* "a fault list does not grow without end" *(unit)*.

## 15. Permissions a page asks for

- **FR-PERMISSION-1.** A page gets no permission it asks for. Every request the
  browser can be given — the microphone, the camera, clipboard read,
  notifications, and every other name Electron passes — is refused by this
  application rather than granted by Electron's default, identically in every
  project, and the refusal reaches the page promptly instead of leaving it
  waiting. Nobody is asked, and no site is remembered: the price is that a
  site's own copy button and its full-screen view are refused with the rest,
  which is recorded under `## Follow-ups` in
  [nobody is asked before the microphone goes on](tasks/2026/09/nobody-is-asked-before-the-microphone-goes-on.md).
  *Acceptance:* "every permission a page can ask for is refused, whatever its
  name" *(unit)*, "a page that asks for the microphone is refused, and hears the
  refusal".
- **FR-PERMISSION-2.** A permission request is answered one way or the other,
  never left hanging. Geolocation was the one measured answering neither way;
  the refusal in **FR-PERMISSION-1** settles it, and the page's own error
  callback now runs with `PERMISSION_DENIED` rather than waiting out its clock.
  *Acceptance:* "a page that asks for the microphone is refused, and hears the
  refusal" — its last assertion is geolocation's.
- **FR-PERMISSION-3.** A site's password prompt reaches somebody who can answer
  it.
  *Acceptance:* **not yet** —
  [a password prompt that never appears](tasks/2026/09/a-password-prompt-that-never-appears.md).
- **FR-PERMISSION-4.** A passkey this browser cannot answer is refused in a way
  the page can act on, not left to time out.
  *Acceptance:* **not yet** —
  [a passkey this browser cannot answer](tasks/2026/09/a-passkey-this-browser-cannot-answer.md).

## 16. The disguise

- **FR-DISGUISE-1.** By default the browser does not announce itself as an
  automated client, because sign-in verification widgets refuse to run for one.
  *Acceptance:* "the browser does not announce itself as an automated client".
- **FR-DISGUISE-2.** The person can turn the disguise off, and then a page sees
  an automated client and says so — the person building such a check needs a
  client that owns up.
  *Acceptance:* "with the disguise off, a page sees an automated client and says
  so".

## 17. The manual

- **FR-MANUAL-1.** The tool description reaches the agent whole, inside the
  client's cut, and names the call that prints the rest.
  *Acceptance:* "the whole tool description reaches the agent, with room to
  spare" *(unit)*, "the description that arrives names the way to read the rest"
  *(unit)*.
- **FR-MANUAL-2.** The manual documents every helper an agent can call, and no
  helper it cannot. Nothing is described in two places.
  *Acceptance:* "the manual documents every helper an agent can call, and no
  helper it cannot", "every helper the description names is one the manual
  documents" *(unit)*, "no helper is described in two places" *(unit)*, "every
  documented name resolves to its own entry" *(unit)*.
- **FR-MANUAL-3.** A helper answers to every spelling an agent would write, and
  a name nobody has says so and says what there is.
  *Acceptance:* "a helper answers to every spelling an agent would write"
  *(unit)*, "the spelling an agent types is not the spelling it is punished for"
  *(unit)*, "a name nobody has says so, and says what there is" *(unit)*.
- **FR-MANUAL-4.** An agent can read the manual from inside a scenario, without
  an await.
  *Acceptance:* "the manual answers without an await", "an agent can read the
  rest of the manual from inside a scenario", "the reference carries the
  sections the description leaves out" *(unit)*.

## 18. Events

- **FR-EVENT-1.** An event a session emits has somebody listening for it, or it
  is not emitted.
  *Acceptance:* **not yet** —
  [events in the session nobody listens to](tasks/2026/09/events-in-the-session-nobody-listens-to.md).

## 19. Licence

Naoba is bought once and runs forever, but the key it was bought with can be
refunded.

- **FR-LICENCE-1.** Only the copy that is sold asks for a key. A copy built from
  a checkout says it needs none, instead of reporting a missing one.
  *Acceptance:* "the copy that is sold asks for a key, and the one built from a
  checkout does not" *(unit)*, "a copy that needs no key says so instead of
  reporting a missing one" *(unit)*.
- **FR-LICENCE-2.** A copy that was never unlocked is not licensed; a licence
  bought once holds without the service confirming it again on every start.
  *Acceptance:* "a copy that was never unlocked is not licensed" *(unit)*, "a
  licence bought once holds without the service saying so again" *(unit)*.
- **FR-LICENCE-3.** A stored answer nobody has confirmed for a month stops being
  enough; a refunded or cancelled key stops working when the service says so; an
  expiry in the past ends the licence and one ahead does not.
  *Acceptance:* "a stored answer nobody confirmed for a month stops being
  enough" *(unit)*, "a refunded key stops working the moment the service says it
  was cancelled" *(unit)*, "an expiry in the past ends the licence and an expiry
  ahead does not" *(unit)*.
- **FR-LICENCE-4.** A check can take a licence away and can never hand one out.
  *Acceptance:* "a check can take a licence away and cannot hand one out"
  *(unit)*.
- **FR-LICENCE-5.** The service being unable to say who you are is not a verdict
  on the key; a refusal the service explains outranks the stored record; an
  answered check clears a refusal.
  *Acceptance:* "the service asking who you are is three complaints meaning one
  thing" *(unit)*, "a refusal the service explains outranks everything else the
  record says" *(unit)*, "an answered check clears a refusal, and an accepted key
  never carries one" *(unit)*, "the service refuses in two shapes, and only one
  of them is a verdict on the key" *(unit)*.
- **FR-LICENCE-6.** Each licence call goes to the address the service documents,
  and the record kept after activation carries what the next check needs.
  *Acceptance:* "each licence call goes to the address the service documents"
  *(unit)*, "the record kept after activation carries what the next check needs"
  *(unit)*, "a key nobody bought carries the person activating it, and a bought
  one does not" *(unit)*.
- **FR-LICENCE-7.** An installation identifier is 32 characters of hexadecimal
  and carries nothing about the machine.
  *Acceptance:* "an installation identifier is 32 characters of hexadecimal"
  *(unit)*.

## 20. Updates

- **FR-UPDATE-1.** Only the downloaded copy replaces itself. A copy that cannot
  — a checkout, a build signed with another certificate — says why, whatever
  stage the updater reports.
  *Acceptance:* "only the downloaded copy replaces itself" *(unit)*, "a copy that
  does not update itself says why, whatever the stage says" *(unit)*.
- **FR-UPDATE-2.** Nothing is installed behind the person's back. Quitting takes
  every agent's tabs with it, so the moment is theirs to choose.
  *Acceptance:* `src/main/updates.ts` — the update is fetched and then waits.
- **FR-UPDATE-3.** Each stage reads as one sentence about this copy, and a
  failed check keeps its reason.
  *Acceptance:* "each stage of an update reads as one sentence about this copy"
  *(unit)*, "a failed check keeps the reason, because the cause is usually not
  the application" *(unit)*.

## 21. Qualities

- **NFR-1 (isolation over everything).** Where a convenience and
  **FR-ISOLATION-1** disagree, the isolation wins and the convenience is not
  built.
- **NFR-2 (an agent is told, never left guessing).** Every refusal names what
  was wrong and what to write instead. A blank answer, an empty object or a bare
  timeout is a defect, not a result.
  *Acceptance:* the "says why" / "says what" / "names who" tests throughout this
  file — twenty-odd of them, by name.
- **NFR-3 (the person is never handed a dialog they cannot act on).** See
  **FR-FAULT-1**.
- **NFR-4 (nothing about the person leaves this machine).** The endpoint is
  loopback; the licence check carries an installation identifier and the key,
  and nothing else.
  *Acceptance:* "an installation identifier is 32 characters of hexadecimal"
  *(unit)*, "each licence call goes to the address the service documents"
  *(unit)*.
- **NFR-5 (the suite is the contract).** `deno task check` compiles and smoke
  launches; `deno task test` drives a real Electron window and takes about 20
  seconds. Both are green before anything is called done.
  *Acceptance:* `deno task check && deno task test`.
- **NFR-6 (a page is never trusted).** Page text is written by whoever controls
  the page, so nothing a page says chooses a path, a file or a destination.
  *Acceptance:* **FR-FILES-1**, **FR-FILES-5**.
