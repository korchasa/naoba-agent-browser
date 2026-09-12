---
date: 2026-09-12
status: done
implements: []
tags: [interface, settings, window]
related_tasks: []
---

# The settings leave the panel and get a window

## Goal

Everything the person sets by hand lives in one window of its own, opened
deliberately, and nowhere else in the interface. What is about the window a
person is looking at right now — the order of the agents, the width they drag
the panel to — stays where it is.

## Overview

### Context

The preferences arrived one at a time, each landing where it was easiest to
put: the disguise as a ghost in the panel's foot, the panel width as a handle
on the panel's edge, and then a settings view that took the tree's place and
drew all four values again. So two of them can be set in two places, and
reading the settings costs the person the tree they were looking at.

### Current State

- `src/renderer/chrome.ts` holds `view: 'tree' | 'settings'`, `openSettings`,
  `renderSettings`, `settingRow`, `switchControl` and `numberField`; the gear
  in the foot flips the panel between the tree and the settings.
- Four preferences live in `settings.json`: `loginItemOffered` (a marker, not a
  control), `announceAutomation`, `panelWidth`, `orphanCloseMs`.
- The disguise is a second control for `announceAutomation`: the ghost in the
  foot flips the same value the settings switch does.
- The panel width is also draggable, by the grip on the panel's right edge.
- The order of the agents is kept in the window's own `localStorage`
  (`naoba.sort`), not in `settings.json`. It is the example the request names
  as belonging to the window.
- `ipcMain` answers `ab:projects` and `ab:forget-project`; nothing in the
  renderer calls either, so the register of admitted projects has no interface.
- The panel is a `WebContentsView` in a `BaseWindow` owned by
  `src/main/shell.ts`; there is no second window in the application.

### Constraints

- Every colour comes from `src/renderer/palette.css`; a literal anywhere else
  in the renderer is a defect.
- A renderer page declares its own content security policy and may load only
  `self`.
- The main process owns each value: it clamps it, applies it live and writes it
  down; the renderer draws what came back, never what it asked for.
- The login item's state is the OS's answer, read fresh every time the window
  opens.
- The rule about one window per project is about projects. A settings window is
  the application's, holds no browsing context and must not carry one.
- Tests reach the pure modules and the agent-facing API; a second renderer is
  only testable to the extent its decisions live in a module without a DOM.

### Affected Surface

The scout's report, verbatim. Its headline verdict is mistaken — it read the
settings *view* inside the panel as the settings *window* the request asks for
— but its enumeration is the record this list is held against.

```
Confirmed: this is already fully implemented and committed on `main` (HEAD is `d77cf2b`, five commits ahead of `a1abd47`, tree clean). The user's request matches exactly what commit `a1abd47` did. No further work is needed unless the user wants something beyond that commit; the enumeration below documents what a fresh implementation would touch, in case it needs revisiting or extending.

## Surface

- `/Users/korchasa/www/factory/projects/agent-browser/src/renderer/chrome.ts` (lines 48-88, 236-311, `renderFoot` 201-231) — already holds the settings view (`renderSettings`), the gear button that opens it, and the `SettingsSnapshot` type feeding it — matches the request. Evidence: commit `a1abd47`.
- `/Users/korchasa/www/factory/projects/agent-browser/src/main/settings.ts` (lines 1-44) — persistence layer (`Settings` interface, `readSettings`/`writeSettings`) backing every setting shown in the window: `panelWidth`, `announceAutomation`, `loginItemOffered`, `orphanCloseMs`.
- `/Users/korchasa/www/factory/projects/agent-browser/src/main/main.ts` (lines 56-62, 180-230, 370-398) — wires IPC handlers (`ab:panel-width`, `ab:announce-automation`, `ab:open-at-login`, `ab:orphan-close-ms`) and builds the `SettingsSnapshot` sent to the renderer; already covers every setting moved into the window.
- `/Users/korchasa/www/factory/projects/agent-browser/src/preload/preload.ts` (lines 15-19) — exposes the four setting mutators to the renderer; consistent with the settings view's calls.
- `/Users/korchasa/www/factory/projects/agent-browser/src/main/hub.ts`, `src/main/context.ts`, `src/main/shell.ts`, `src/main/tab.ts` — producers/consumers of the settings values (`announceAutomation`, `orphanCloseMs`, `panelWidth`); not affected further — they already read from the same `Settings`-backed state the window edits.
- The disguise (ghost/bot) icon-button in `renderFoot` (chrome.ts lines 209-229) — a duplicate quick-access control for `announceAutomation` left in the main toolbar alongside the same setting inside the settings view. Not a scattered setting to remove: the commit message explicitly kept it as a one-click toggle in addition to the settings-window entry, so both exist by design.
- Sort control (`sortControl`, chrome.ts lines 417-438, backed by `tree.ts` `SORT_MODES`/`SortMode`) — correctly excluded from the settings window, since it only makes sense in the context of the tree view, matching the user's explicit exception ("sortировки списков").
- `/Users/korchasa/www/factory/projects/agent-browser/src/main/tray.ts` — the menu-bar tray; checked for any settings-like menu items (quit, preferences) that should have moved into the window. None found: the tray only opens/focuses the window, and quit lives in a native `dialog` (`shell.ts` lines 248-256), not a persisted preference, so it is out of scope for a settings window.
- `/Users/korchasa/www/factory/projects/agent-browser/src/main/login.ts` — `decideLoginItem`/`describeLoginItem`, the login-item sentence/state shown by the "Open at login" row; consumer of the OS's `getLoginItemSettings`, feeding the settings view's first row.

## Queries used

- Directory survey: `find . -maxdepth 3 -type d` (excluding node_modules/.git).
- `find ./src -type f` to see the whole source tree.
- `grep -rn "announceAutomation|orphanCloseMs|loginItemOffered|panelWidth|setLoginItemSettings|openAtLogin" src test` to find every producer/consumer of each setting.
- Full read of `src/renderer/chrome.ts` (749 lines) and `src/main/settings.ts`.
- `git log --oneline -15 -- src/renderer/chrome.ts src/main/settings.ts src/main/tray.ts documents/requirements.md documents/design.md` to find when the settings view was introduced.
- `git show --stat a1abd47` and its commit message to confirm scope.
- `grep -n "Quit|quit" -r src`, `ls documents/tasks/2026/*/`, `grep -rn "settings|Settings" documents/requirements.md documents/design.md` to check for other scattered settings or process documentation mentioning settings.
- Read of `src/main/tray.ts` in full and the top of `src/main/main.ts`.

## Not examined (budget)

- `documents/requirements.md` and `documents/design.md` full contents (only grepped, not opened) — did not confirm whether the SRS/SDS mention a settings-window requirement that should be marked done or updated.
- `test/` directory contents — did not check whether there is a test exercising the settings view/IPC handlers that a "reimplementation" request would need to keep green.
- `src/main/commands.ts`, `src/main/queue.ts`, `src/main/runner.ts`, `src/main/api.ts`, `src/main/protocol.ts`, `src/main/urls.ts`, `src/main/lease.ts`, `src/main/trail.ts`, `src/main/visits.ts`, `src/main/files.ts`, `src/main/project.ts`, `src/main/server.ts` — not opened; based on names these are unlikely to hold UI-facing settings, but not verified line by line.
- `src/renderer/palette.css` / `chrome.css` — not inspected for settings-view styling completeness.
- `packages/bridge` — not inspected; unlikely to hold interface settings (it's the MCP bridge).

## Could not rule out

- Whether the user's request is about a *different* or *newer* set of scattered settings than what `a1abd47` already consolidated (i.e., something added to the interface after that commit that isn't yet in the settings window). `git log` between `a1abd47` and `HEAD` (`d77cf2b`) was not reviewed commit-by-commit; the file-scoped log only showed commits touching `chrome.ts`/`settings.ts`/`tray.ts`, but a new toggle could have been added inline elsewhere without touching those three files.
```

Every row above, and every row of my own enumeration, with what happens to it:

- `src/renderer/chrome.ts` — the settings view, the gear, the ghost and
  `SettingsSnapshot` — covered-by Solution step 5 ("Strip the panel") and the
  fifth item of the Definition of Done.
- `src/main/settings.ts` — not affected — the four keys it persists do not
  change; `preferences.ts` describes them, it does not store them
  (`settings.ts:10-25`).
- `src/main/main.ts` — the handlers, the snapshot shape, the menu — covered-by
  Solution step 4.
- `src/preload/preload.ts` — covered-by Solution step 4 (`openSettings` and the
  `settings` channel).
- `src/main/hub.ts` — covered-by Solution step 4 (`onAdmissions`, so a project
  admitted while the window is open appears in it).
- `src/main/context.ts`, `src/main/tab.ts` — not affected — they consume
  `announceAutomation` and `orphanCloseMs`, whose shape does not change
  (`hub.ts:85-98`).
- `src/main/shell.ts` — covered-by Solution step 2: it imports the two width
  constants from `preferences.ts` instead of defining them
  (`shell.ts:8-10, 138-146`).
- The disguise ghost in `renderFoot` — covered-by Solution step 5. The scout
  reads it as deliberate, and it was; the request asks for exactly this kind of
  duplicate to be collected into one place.
- The sort control (`chrome.ts` `sortControl`, `tree.ts` `SORT_MODES`) — not
  affected — the request names it as the example of what stays
  (`chrome.ts:417-438`).
- `src/main/tray.ts` — covered-by Solution step 4: the right click answers with
  Open, Settings…, Quit.
- `src/main/login.ts` — not affected — the decision and the sentence are already
  pure and already what the row draws (`login.ts:59-66`).
- `documents/requirements.md`, `documents/design.md` — not affected — neither
  exists, and `AGENTS.md` binds `SRS` and `SDS` to nothing on purpose
  (`AGENTS.md`, "Documents").
- `test/unit.test.mjs` — covered-by Solution step 1 and the first four items of
  the Definition of Done.
- `test/integration.test.mjs` — not affected — the harness drives the
  application as an agent, and no agent-facing helper opens a window of the
  person's (`test/helpers/app.mjs:20-48`).
- `packages/bridge`, `src/main/api.ts` and the rest of the agent-facing modules
  — not affected — no preference reaches an agent; nothing there reads
  `settings.json`.
- `src/renderer/chrome.css` — covered-by Solution step 3: the settings rules move
  out into `settings.css`.
- `src/renderer/palette.css` — not affected — the new page links it and spells no
  colour of its own.
- `scripts/build.mjs` — covered-by Solution step 3 (the entry point and the two
  copies).
- `src/main/snapshot.ts` — covered-by Solution step 6 and the seventh item of the
  Definition of Done.
- `README.md` "Settings" and `AGENTS.md` "What the person sets by hand" —
  covered-by Solution step 7.
- `ab:projects` / `ab:forget-project` — covered-by Solution step 4 and the fourth
  item of the Definition of Done: the register these two handlers have answered
  to nobody since they were written gets its interface here.

## Definition of Done

- [x] Asking for the settings window twice brings the open one forward instead
      of making a second, and a window that was closed is made again. Test:
      `test/unit.test.mjs` — "the settings window is one window, opened again
      and again" (a fake window handed to the policy; the Electron calls stay in
      `main.ts`, the way `login.ts` already splits them). Evidence: `node --test
      --test-concurrency=1 --test-name-pattern='the settings window is one
      window' test/unit.test.mjs`.
- [x] The three ways in are wired: `Settings…` with ⌘, in the application menu,
      the gear in the panel's foot, and the menu-bar icon. Evidence: the menu
      was driven on the installed copy through the accessibility API — the
      application menu reads `About · Settings… (⌘,) · Services · Hide · Hide
      Others · Show All · Quit`, so nothing `role: 'appMenu'` used to supply was
      lost; clicking Settings… opened a window titled `Settings`, and clicking
      it again left exactly one. The other two call the same `ab:open-settings`
      and are the owner's to try.
- [x] Every preference the person sets by hand is drawn from one list that the
      main process and the window both read. The guarantee is the type
      checker's, not a test's: `PREFERENCES` is a mapped type over
      `keyof PreferenceValues`, so a value the main process starts sending with
      no row for it does not compile. Evidence: a red probe — add a field to
      `PreferenceValues`, `deno task check` fails naming it; put it back. A
      runtime backstop rides along in `test/unit.test.mjs` — "every preference
      the window draws is a value the application sends, and back".
- [x] Minutes typed in the window reach the main process as milliseconds, and a
      width typed below the floor comes back clamped to it — the same answer the
      grip on the panel's edge gives, from the same floor, because a preference
      with two behaviours is the defect this task exists to remove. Test:
      `test/unit.test.mjs` — "a preference is written in the person's unit and
      kept in the application's". Evidence: `node --test --test-concurrency=1
      --test-name-pattern='in the person.s unit' test/unit.test.mjs`.
- [x] The window lists the projects the person has answered about — allowed and
      refused alike — and a Forget button calls the handler that already exists.
      What is tested is the reading: `test/unit.test.mjs` — "the projects the
      person has answered about read as allowed or refused". `Hub.forget` and
      the re-ask that follows it are existing code behind an `electron` import
      (`hub.ts:1`), unreachable from a unit test and not driven by the agent
      harness; they are evidenced by hand. Evidence: `node --test
      --test-concurrency=1 --test-name-pattern='the projects the person has
      answered about' test/unit.test.mjs`, plus manual — the owner.
- [x] The panel holds no preference control any more: the settings view, the
      ghost in the foot and the `view` switch are gone, and the gear opens the
      window. The grip on the panel's edge and the order of the agents stay
      where they are. Evidence: `grep -n "renderSettings\|view === 'settings'\|
      announceAutomation" src/renderer/chrome.ts` returns nothing.
- [x] A value changed anywhere else while the window is open is redrawn in it —
      the panel width dragged on the grip, a project admitted through the new
      `Hub.onAdmissions` hook, the login item turned off in System Settings (on
      the window's next focus). The half that can be tested is tested: a push
      before the window is open, and a push after it is closed, reach nothing
      and throw nothing. Test: `test/unit.test.mjs` — "nothing is pushed at a
      settings window that is not there". The push itself was probed live in a
      snapshot run: with the window open, the panel width set elsewhere moved
      356 → 501 in its field and a forgotten project took the register from four
      rows to three. The login item read on focus is the owner's to try.
- [x] The snapshot run photographs the settings window in both appearances and
      at the accessibility text size, so the screen is looked at before it
      ships. It goes through the same settling the rest of the camera does —
      `invalidate`, two animation frames, and captures repeated until two agree
      byte for byte — because a freshly opened, unfocused window is exactly the
      case `AGENTS.md` records `capturePage` getting wrong. Evidence: `deno task
      check && node_modules/.bin/electron dist/main.js --snapshot <dir>
      --admit-everything` writes `05-settings-light.png`, `05-settings-dark.png`,
      `06-settings-large-text-light.png` and `06-settings-large-text-dark.png`,
      and the pictures are looked at.
- [x] A page an agent visits cannot reach the window's own controls: `window.ab`
      is not there. Test: `test/integration.test.mjs` — "a page an agent visits
      cannot reach the window's own controls". Evidence: `node --test
      --test-concurrency=1 --test-timeout=90000 --test-name-pattern='cannot
      reach the window' test/integration.test.mjs`.
- [x] `deno task check` exits 0 and `deno task test` passes, the known flaky
      name excepted.
- [x] `AGENTS.md` and `README.md` describe the window rather than the view in
      the panel.

There is no requirement register in this repository — `AGENTS.md` binds `SRS`,
`SDS` and `index` to nothing on purpose — so these items carry a test name and a
command instead of an FR id.

## Solution

### What moves where

A new window, a renderer of its own, and a list of preferences both sides read.
The main process keeps owning every value: it clamps it, applies it live and
writes it down, and the window draws what came back.

**`src/main/preferences.ts` (new, pure — no `electron` import).** The shape of
the settings, in one place:

- `PANEL_WIDTH` and `PANEL_MIN_WIDTH` move here from `shell.ts`, which imports
  them back. The window needs the floor to clamp a width, and `shell.ts` cannot
  be loaded without Electron. One floor, one behaviour: typing a width under it
  and dragging under it both answer with the floor.
- `PreferenceValues` — what the main process sends: `loginItem`,
  `announceAutomation`, `panelWidth`, `orphanCloseMs`.
- `PREFERENCES` — one entry per row: `label`, `kind` (`switch` or `number`), the
  unit the person types in, the floor, and the factor between the person's unit
  and the application's (60000 for minutes). It is a mapped type over
  `keyof PreferenceValues`, so a value the main process starts sending with no
  row for it does not compile — which is a stronger promise than any test in
  this repository could make about it, because `Settings` is an interface and is
  gone by run time.
- `rowsFor(values)` — the rows the window draws, each with its label, its
  sentence and its current value in the person's unit.
- `toStored(key, typed)` — the person's number in the application's unit,
  clamped to the floor. Never a refusal: the main process owns the value and
  answers with what it kept, and the window redraws that.
- `projectRows(admissions)` — the register: name, root, whether it was allowed
  or refused, and when.

**`src/main/settings-window.ts` (new, pure — the Electron calls stay in
`main.ts`, the way `login.ts` already does it).** A `SettingsWindow` over an
injected factory: `open()` makes the window on the first call, brings the
existing one forward afterwards, and forgets it when it closes. A fake window in
the unit test is what proves "one window, however often it is asked for".

**`src/renderer/settings.html`, `settings.ts`, `settings.css` (new).** The page:
the preference rows from `rowsFor`, then the projects register. It links
`palette.css` — no colour is spelled anywhere else — and `settings.css`, into
which the `.settings`, `.setting`, `.switch` and `input.number` rules move out
of `chrome.css`. Its content security policy is `'self'`, like the panel's.

**`scripts/build.mjs`** gains the `settings.ts` entry point and copies
`settings.html` and `settings.css`.

**`src/preload/preload.ts`** gains `openSettings()` and the `settings` channel
for the push; the four mutators it already exposes are what the new window
calls.

**`src/main/main.ts`:**

- `settingsFor(hub)` returns `PreferenceValues` plus the projects register.
- `ipcMain.handle('ab:open-settings')`, and a push of the whole snapshot to the
  settings window after every write (`ab:panel-width`, `ab:announce-automation`,
  `ab:orphan-close-ms`, `ab:open-at-login`, `ab:forget-project`) and on the
  window's `focus` — which is where the login item the OS may have changed is
  read again.
- The application menu stops being the bare `role: 'appMenu'`: it is built by
  hand so `Settings…` with ⌘, sits under About, where macOS puts it. The roles
  that the bare one supplied have to be re-listed — About, Services, Hide, Hide
  Others, Show All, Quit — or they are lost; and `buildMenu` re-installs the
  whole menu every five seconds (`main.ts:246-260`), so the hand-built submenu
  is rebuilt on that timer too and must not allocate anything it cannot repeat.

**`src/main/hub.ts`** gets `onAdmissions(handler)`, called after the register is
saved, so a project admitted while the window is open appears in it.

**`src/main/tray.ts`** keeps the left click as it is — it brings the browser
forward — and rebinds the right click, which today does the same thing, to a
menu of two items: Open, and Settings…. Quitting is deliberately not there: the
window's close button asks the Hide-or-Quit question for a reason
(`shell.ts:243-258`), and a second, quieter way out would answer it for the
person. The note in `AGENTS.md` that the tray does one thing is rewritten with
it.

**`src/renderer/chrome.ts`** loses `view`, `openSettings`, `renderSettings`,
`settingRow`, `switchControl`, `numberField`, the `SettingsSnapshot` type and
the ghost in the foot. The gear calls `ab.openSettings()`.

**`src/main/snapshot.ts`** opens the settings window at the end of the run and
photographs it in both appearances and at the accessibility text size. A
`BrowserWindow` is one `webContents`, so no pixels have to be laid out by hand —
but the settling does not come free with that: a freshly opened, unfocused
window is the case `AGENTS.md` records `capturePage` getting wrong, so the shot
reuses the same `invalidate`, two animation frames, and capture-until-two-agree
loop the composed picture uses.

### The preload every page was given

Found while planning this, measured on the installed copy rather than read out
of the code: `window.ab` is reachable from every site an agent visits. A page on
`example.com` called `window.ab.projects()` and got the register back — six
records, names, absolute roots and decisions — and `openAtLogin`,
`forgetProject`, `navigate`, `newTab` and `takeOver` are all next to it.

`src/main/tab.ts:128-137` builds every tab's view with the same preload as the
panel, and `src/preload/preload.ts:33` exposes `ab` into the page's own world.
The comment at the top of that file says pages never see it; `contextIsolation`
keeps the preload's world apart from the page's, which is not the same promise —
`exposeInMainWorld` is what crosses that line, on purpose.

It belongs in this task rather than beside it: this task adds `openSettings` to
that preload and puts the very register that leaks into the new window.

The cure is that a tab needs no preload at all. Nothing in a page's world comes
from it — `__abRefs` and the rest are installed per call by `executeJavaScript`,
because a single-page application would otherwise lose them (`tab.ts:60-90`).
So `Tab` stops taking one, and the file stays what its comment always claimed:
the window's own interface talking to the main process.

### Order of work

0. RED: the integration test that a page cannot reach `window.ab`; GREEN by
   taking the preload off the tabs.
1. RED: the four unit tests above, against modules that do not exist yet.
2. GREEN: `preferences.ts`, then `settings-window.ts`.
3. The renderer page and its stylesheet; the build entry point.
4. The main process: the snapshot shape, the push, the menu, the tray, the hub
   hook.
5. Strip the panel.
6. The snapshot run, and look at the pictures in both appearances.
7. `AGENTS.md`, `README.md`.

### What this does not do

The window is not reachable from the integration harness: those tests drive the
application as an agent, and no agent-facing helper opens a window of the
person's. Its decisions are therefore tested through the pure modules, and the
screen itself through the snapshot pictures.

## Follow-ups

- The settings window loads the panel's whole preload, so its page can reach
  `newTab`, `navigate` and `takeOver` that it never uses. Nothing remote can
  reach that page — its content security policy is `'self'` and it loads one
  local file — so this is a boundary worth tidying, not a hole. A preload of its
  own, carrying the four writes and `forgetProject`, would be the tidy form.
- `README.md` still says the tabs you opened yourself "sit in a group of your
  own at the bottom". There has been no such group since 2026-09-05 — the person
  has no branch, and a tab they open joins the agent whose tab is in front. That
  drift predates this task and was left alone rather than widening its diff.
- With the ghost gone from the foot, the panel no longer shows whether pages
  are being told a program drives the browser. If that turns out to be missed,
  the answer is an indicator in the foot, not a second control.
- Forgetting a project does not close the browsing context it already has; the
  record is what goes, and the next agent from that directory is asked again.
