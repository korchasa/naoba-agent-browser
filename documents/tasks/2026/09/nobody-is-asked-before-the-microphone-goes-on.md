---
date: "2026-09-19"
status: done
implements: [FR-PERMISSION-1]
tags: [agent-browser, naoba, permissions, safety, session]
related_tasks:
  [
    a-permission-that-answers-neither-way,
    a-password-prompt-that-never-appears,
    a-passkey-this-browser-cannot-answer,
    events-in-the-session-nobody-listens-to,
  ]
---
# Nobody is asked before the microphone goes on

## Goal

A page cannot switch on the microphone, the camera, the screen, or read the
system clipboard because it asked nicely. One rule written down in advance
decides, identically in every project: the answer is no. Nobody is asked, and a
page that is refused hears the refusal rather than waiting on silence.

## Overview

Nothing in `src/main` calls `setPermissionRequestHandler` or
`setPermissionCheckHandler`, and with no handler Electron approves every request
a page makes. Measured on 2026-09-19 against a plain page in this application's
own webPreferences:

```
Notification.requestPermission()                → "granted"
navigator.mediaDevices.getUserMedia({audio:1})  → granted
navigator.permissions.query(clipboard-read)     → "granted"
```

Nobody was asked, and nothing was recorded. This matters more here than it would
in an ordinary browser for two reasons. The window normally sits off screen in
the menu bar, so there is nobody watching to notice a microphone indicator. And
this browser is the one that holds the person's real logged-in sessions, driven
by an agent across sites the agent chose — so the page doing the asking is
routinely not a page the person opened.

The clipboard is the sharpest of the three. A system clipboard on a working
machine holds whatever was copied last, and that is often a password or a key.

Geolocation is a fourth request and behaves differently enough to have its own
task; see [a permission that answers neither
way](a-permission-that-answers-neither-way.md).

### Affected Surface

The independent pass (`surface-scout`, dispatched 2026-09-19 from the Goal and
the Definition of Done alone), verbatim:

```
## Surface

- `src/main/main.ts` — this is the main Electron process entry point where app/window/webContents setup happens; currently has no `setPermissionRequestHandler`/`setPermissionCheckHandler`, confirming DoD item 2 ("Electron's default is in place") — evidence: `grep` for permission/media/microphone/clipboard/camera hits only unrelated `clipboard.writeText` calls at lines 593-594, 657.
- `src/main/context.ts` — `ProjectContext` constructor (lines 68-101) creates the per-project Electron `Session` via `electronSession.fromPartition(...)` and attaches session-level listeners (`will-download`, user agent). A permission handler belongs on `this.session` (`setPermissionRequestHandler`/`setPermissionCheckHandler` are session-scoped in Electron), making this the natural home for the decision logic — evidence: `src/main/context.ts:73-90`.
- `src/main/tab.ts` — `class Tab` (line 105+) already holds the pattern for a per-tab captured log fed from `webContents`/`debugger` events: `console: ConsoleEntry[]` with `captureConsole`/`recordConsole` (lines 988-1000) and `network: Map<string, NetworkEntry>` with `captureNetwork`/CDP event handling (lines 1031-1145). A permission log ("what a page asked for and what it got", DoD item 5) is structurally a third log of the same shape and would likely live here.
- `src/main/api.ts` — the agent-facing API surface (807 lines). `getConsoleLogs()` (line 485), `captureNetwork()`/`getNetworkLog()`/`getResponseBody()` (lines 499-533) are the existing precedent for exposing captured data to agents "the way it sees the console and the network" (DoD item 5); a `getPermissionLog()`-shaped addition is expected here.
- `src/main/reference.mjs` — agent-facing documentation text (244 lines) that documents `captureConsole`/`getConsoleLogs`, `captureNetwork`/`getNetworkLog` (line 139-140) inside the ~2040-character tool description budget mentioned in `src/main/tools.mjs`. A new permission-visibility helper needs a documentation line here too, competing for that fixed budget.
- `src/main/tools.mjs` — the MCP `TOOLS` list/schema (69 lines) that is the client-visible surface; not directly touched by console/network helpers (they ride the generic `eval` tool via `api`), but worth checking that no permission-specific tool entry is needed.
- `src/main/settings.ts` — application-wide `Settings` interface (JSON file in userData dir) holding flags like `announceAutomation`. DoD item 3 says "the rule for each permission is written down here with its reason, and it is the same rule for every project" — this is the natural place for a fixed, non-per-project rule table (or the rule may instead be hardcoded, not user-configurable — ambiguous from the goal text alone).
- `src/main/hub.ts` — `#admit()` (lines 194-221) is an existing precedent for "ask the person once, remember the answer, serialize concurrent dialogs" via `dialog.showMessageBox`, for the *project admission* decision. DoD's "Whoever is allowed to decide — the person, or a rule written down in advance — decides" parallels this exact mechanism; a permission prompt to the person (if the rule allows asking rather than auto-refusing) would likely reuse or mirror this pattern.
- `src/main/main.ts:201-246` and `src/main/shell.ts:240` — existing uses of `dialog.showMessageBox`/`Notification` for reaching "the person" outside a per-tab window (modal-with-no-window pattern), relevant if a permission prompt needs to reach the person rather than auto-decide.
- `test/unit.test.mjs` (98 existing `test(...)` blocks, single monolithic file) — DoD item 6 "a unit test covers the decision" — a new decision function (e.g. `permissionDecisionFor` or similar) would need pure-function unit tests added to this file, following the existing pattern of importing named exports from `src/main/*.ts`.
- `test/integration.test.mjs` (72 existing `test(...)` blocks, single monolithic file) + `test/helpers/app.mjs` + `test/fixtures/server.mjs` — DoD item 6 "an integration test proves a real page is refused" needs a real page requesting a permission (e.g. `getUserMedia`) served by the fixture server and driven through `startApp`.
- `test/fixtures/*.html` — no existing fixture requests microphone/camera/clipboard; a new fixture page (or an addition to an existing one like `page.html`) is needed to exercise `getUserMedia`/clipboard-read for the integration test.
- `documents/requirements.md` §15 "Permissions a page asks for" (lines 423-437) — holds `FR-PERMISSION-1` through `FR-PERMISSION-4`, each currently marked "**not yet**" and linking to a task file. This task implements `FR-PERMISSION-1` (microphone/camera) but the same handler is explicitly meant to cover all permissions (see below), so `FR-PERMISSION-2` and `FR-PERMISSION-4`'s "not yet" / acceptance links are directly affected by whatever handler this task builds.
- `documents/tasks/2026/09/a-permission-that-answers-neither-way.md` (implements FR-PERMISSION-2, geolocation) — its own Solution section states explicitly: "it should not be settled separately from [nobody is asked before the microphone goes on] — both are answered by the same handler, and splitting them would mean writing that handler twice." This is a direct, named parallel implementation sharing the same fix site.
- `documents/tasks/2026/09/a-passkey-this-browser-cannot-answer.md` (implements FR-PERMISSION-4) — `related_tasks` lists this task; references "a passkey from another device over the camera or Bluetooth" (line 53), touching the same permission-handling machinery (Bluetooth/camera device permission).
- `documents/tasks/2026/09/a-password-prompt-that-never-appears.md` (implements FR-PERMISSION-3) — `related_tasks` lists this task; a sibling "answer promptly rather than hang" problem in the same permission family, using the same `login`-event-on-session pattern location (`context.ts`/session level).
- `documents/tasks/2026/09/events-in-the-session-nobody-listens-to.md` (implements FR-EVENT-1) — explicitly groups itself "beside the permission, authentication and scheme gaps" and lists this task in `related_tasks`; about unhandled session-level Electron events generally, same investigative method (measure what's currently silent).
- `documents/tasks/2026/09/settings-in-a-window-of-their-own.md` — line 219 mentions "It goes through the same settling the rest of the camera does" — an existing settings-window task text that already assumes/references camera-permission settling behavior, suggesting the settings UI may be a place this rule/state surfaces to the person.
- `documents/tasks/2026/09/what-ran-before-the-failure.md` and `documents/tasks/2026/09/putting-a-file-into-a-form.md` — flagged by the permission/media keyword search; need checking for incidental permission-related content (not yet opened in detail).
- `documents/decisions/0001-chromium-inside-the-application.md` — flagged by the same keyword search; an ADR about embedding Chromium, plausibly discussing the security/permission model at a higher level.
- `documents/design.md` — SDS; no permission section currently found by heading search, but per project doc-hierarchy convention (`AGENTS.md` "Documentation Hierarchy"), a new decision mechanism (session-level permission handler + log) is architecture-level and would normally get a design.md entry alongside the requirements.md entries.

## Not examined (budget)

- `documents/tasks/2026/09/what-ran-before-the-failure.md` and `documents/tasks/2026/09/putting-a-file-into-a-form.md` — found by keyword grep, not opened to see what the permission/media/clipboard mention actually is.
- `documents/decisions/0001-chromium-inside-the-application.md` — found by keyword grep, not opened.
- `documents/how-a-session-works.md` — not checked for permission-related content.
- `src/main/settings-window.ts` and `src/renderer/settings.ts`/`settings.html` — not checked in detail for whether a permission rule/log needs a UI surface there (only inferred from a stray mention in another task file).
- `src/main/snapshot.ts` (demo/offscreen snapshot mode) — not checked for whether it touches permission handling (it does register a custom protocol handler on a session, structurally adjacent).
- `src/main/mcp-http.ts` events/`session.events` mechanism — not checked whether permission-refusal events should be pushed through the same event channel used for tab-claimed/tab-released broadcasts.
- Full read of `documents/design.md` and `documents/requirements.md` beyond the permissions section and headings grep.
- `package.json`/`electron-builder.yml` — not checked for Electron version-specific permission API availability or entitlements (macOS `NSMicrophoneUsageDescription`/`NSCameraUsageDescription` Info.plist keys, which Electron/macOS requires even before `setPermissionRequestHandler` fires).

## Could not rule out

- macOS Info.plist / `electron-builder.yml` usage-description entitlements (`NSMicrophoneUsageDescription`, `NSCameraUsageDescription`) may be required for microphone/camera prompts to work at all on this platform, independent of the Electron-level handler — not verified whether these are already present or missing.
- `src/renderer/settings.ts`/`settings.html` and `src/main/settings-window.ts` as a possible UI location for showing/editing the permission rule table to the person, suggested by the stray "same settling the rest of the camera does" line in `settings-in-a-window-of-their-own.md` but not confirmed by reading that file's own Goal/DoD.
- Whether `src/main/mcp-http.ts`'s session `events` broadcast channel is the intended mechanism for "an agent can see what a page asked for and what it got" (DoD item 5), versus the polling-style `getConsoleLogs`/`getNetworkLog` pattern in `api.ts` — both are plausible fix sites and were not distinguished.
```

The dispositions below are mine. Every row of the block above has one, including
the rows the scout itself set aside.

- `src/main/context.ts` — covered-by the handler step: the decision is installed
  on `this.session`, beside `will-download`.
- A pure decision module (new file) — covered-by the handler step: the rule
  itself imports no Electron, the way `files.ts` and `dock.ts` do not.
- `src/main/main.ts` — not affected — the handler is session-scoped, and
  `main.ts` holds no session; its only permission-adjacent lines are
  `clipboard.writeText` at 593-594 and 657, which write the person's own
  clipboard from the chrome, not a page's read of it.
- `src/main/tab.ts` — deferred — human choice: the chosen variant records
  nothing, so no per-tab log is added. See the first entry under
  `## Follow-ups`.
- `src/main/api.ts` — deferred — human choice: no reader is added, for the same
  reason.
- `src/main/reference.mjs` — not affected — no helper is added, so the manual
  gains no line and the tool description's budget is untouched.
- `src/main/tools.mjs` — not affected — the three tools do not change; a helper
  rides `evalInBrowser` the way `getConsoleLogs` does.
- `src/main/settings.ts` — not affected — settled at variant selection: the rule
  is fixed in code, identical for every project, and the person edits nothing.
- `src/main/hub.ts` — not affected — settled at variant selection: nobody is
  asked, so `#admit` is not reused and the file does not change.
- `src/main/shell.ts:240`, `src/main/main.ts:201-246` — not affected — both are
  the application talking to the person about itself, not about a page.
- `test/unit.test.mjs` — covered-by the DoD's unit test.
- `test/integration.test.mjs`, `test/helpers/app.mjs`, `test/fixtures/` —
  covered-by the DoD's integration test and its new fixture page.
- `documents/requirements.md` §15 — covered-by the documentation step:
  FR-PERMISSION-1 stops reading **not yet**, and FR-PERMISSION-2 follows if the
  chosen variant answers geolocation.
- `documents/design.md` — covered-by the documentation step in the Solution: a
  session-level decision belongs in the module map and beside the file
  boundary.
- `a-permission-that-answers-neither-way.md` (FR-PERMISSION-2) — covered-by the
  geolocation measurement in the Definition of Done: the same handler answers
  it, and the measurement says whether that closes it.
- `a-passkey-this-browser-cannot-answer.md` (FR-PERMISSION-4) — not affected —
  a passkey fails in WebAuthn before any permission is requested; the camera it
  mentions is a transport for a cross-device passkey, not a `media` request from
  a page.
- `a-password-prompt-that-never-appears.md` (FR-PERMISSION-3) — not affected —
  HTTP authentication arrives as the session's `login` event, which is not a
  permission and does not reach `setPermissionRequestHandler`.
- `events-in-the-session-nobody-listens-to.md` (FR-EVENT-1) — not affected —
  `certificate-error` and `render-process-gone` are separate session events; it
  shares only the method of measuring first.
- `settings-in-a-window-of-their-own.md` — not affected — read at line 219: the
  "camera" there is the snapshot run photographing a window, and the sentence is
  about letting a window settle before the capture. No device camera is
  involved.
- `what-ran-before-the-failure.md`, `putting-a-file-into-a-form.md` — not
  affected — grepped both: the first matches on "median" and "mean" at line 57,
  statistics about a scenario's api calls. The second says "the person's
  permission system" at lines 68 and 100, meaning the operating system's file
  permissions, not a permission a page requests.
- `documents/decisions/0001-chromium-inside-the-application.md` — not affected —
  it argues for Chromium in-process against a driver outside it, and says
  nothing about what a page may ask for.
- `documents/how-a-session-works.md` — not affected — sequence diagrams of
  connecting, keeping alive, letting go and quitting; no permission crosses
  them.
- `src/main/snapshot.ts` — not affected — it registers a protocol handler for
  the demo's own pages and requests no permission.
- `src/main/mcp-http.ts` events channel — not affected — settled at variant
  selection: no refusal is published, by event or by log.
- `electron-builder.yml` and the macOS usage descriptions — not affected —
  checked: neither `NSMicrophoneUsageDescription` nor `NSCameraUsageDescription`
  appears in `package.json` or `electron-builder.yml`, and the chosen rule
  refuses `media` rather than granting it, so no macOS prompt is ever reached. A
  later rule that grants the microphone to anything would need them, and that is
  written down here so the next session does not rediscover it.
- The 46 permission names Electron 44 can pass — covered-by the handler step.
  The union at `electron.d.ts:13502` runs from `ar` to `window-management`, and
  a new Electron version adds to it. The chosen rule answers by returning no
  without reading the name at all, which is the one shape that stays correct
  when the list grows.
- `session.setDisplayMediaRequestHandler`, `setDevicePermissionHandler`,
  `setBluetoothPairingHandler` — covered-by the handler step. These are separate
  gates that neither permission handler answers: screen capture through
  `getDisplayMedia`, and HID, serial, USB and Bluetooth devices. Checked
  2026-09-19: `electron.d.ts:13476`, `:13455` and `:13414` declare them, and
  `grep` over `src/` finds none of them set. Leaving them out would let a page
  capture the screen of a browser holding the person's live sessions, which is
  the hole this task exists to close.

## Definition of Done

- [x] The application answers permission requests itself, on every project's
      session. Electron's default — which grants — is never what decides.
- [x] The gates beside the two permission handlers are closed too: screen
      capture through `getDisplayMedia`, and HID, serial, USB and Bluetooth
      devices. Each has its own setter on the session and neither permission
      handler answers it.
- [x] Every request is refused, whatever the permission is called and whatever
      project it came from, and the refusal reaches the page promptly instead of
      leaving it waiting.
- [x] The rule is one function that imports no Electron, the way `files.ts` and
      `dock.ts` do not, so it is read and tested without a window.
- [x] The measurement is taken **in a project tab**, not on a window of the
      application's own, and says so. The panel, the settings window and the
      tray run on `defaultSession`, which this change does not touch, so a
      measurement taken there would print "granted" and prove nothing.
- [x] The three requests measured on 2026-09-19 — notifications, the microphone,
      clipboard read — plus `getDisplayMedia`, are measured again on the changed
      build and come back refused. The measurement is written into this file.
- [x] Geolocation is measured on the changed build and the answer is written
      into this file and into [a permission that answers neither
      way](a-permission-that-answers-neither-way.md): whether a refusal settles
      the page's own callback, or whether it still hangs.
- [x] Two tests exist and carry exactly the names `FR-PERMISSION-1` already
      cites: "every permission a page can ask for is refused, whatever its name"
      in the unit suite, and "a page that asks for the microphone is refused, and
      hears the refusal" in the integration suite. Until they do, the
      requirements file overclaims.
- [x] `documents/design.md` describes the decision: `permissions.ts` in the
      module map, and a paragraph saying a page is refused everything and why
      that sits on the project's session.

## Solution

Refuse every permission, always, for every project. No allow-list, nobody asked,
no per-site memory. The person chose this on 2026-09-19 over a rule that lets
some requests through and over asking them at the moment of the request.

**`src/main/permissions.ts` (new).** One exported function and nothing else:

```ts
export function permitted(_permission: string): boolean {
  return false
}
```

It takes the name and ignores it. That is deliberate and it is what keeps the
rule correct as Electron grows: the union at `electron.d.ts:13502` already
carries 46 names, a new version adds more, and a rule that answers without
reading the name cannot be overtaken by the list. It is a function rather than a
constant because the decision is the thing under test, and because a later rule
that does distinguish changes this body without moving anything around it. The
file imports no Electron, so `test/unit.test.mjs` loads it directly.

**`src/main/context.ts`.** Install five things in the constructor, beside the
`will-download` handler, on `this.session`. The first two answer permissions:

- `setPermissionRequestHandler((_wc, permission, callback) => callback(permitted(permission)))`
  — answers a request. Calling the callback is what makes the refusal prompt; an
  unanswered request is the failure the geolocation task describes.
- `setPermissionCheckHandler((_wc, permission) => permitted(permission))` —
  answers `navigator.permissions.query()`, a separate path that would otherwise
  keep reporting `granted` for a permission the request handler refuses.

The other three are separate gates that neither of those two ever sees, each
with its own setter (`electron.d.ts:13476`, `:13455`, `:13414`), none of them set
anywhere in `src/` today:

- `setDisplayMediaRequestHandler` — **not set, and that is the refusal.** The
  plan said to install one here. The measurement below says the opposite:
  without a handler, `getDisplayMedia` fails on its own, so installing one is
  the only way to open screen capture. A comment in `context.ts` says so, because
  the next reader will see four setters and wonder why the fifth is missing.
- `setDevicePermissionHandler(() => false)` — HID, serial and USB devices,
  including permissions Electron would otherwise keep in memory once granted.
- `setBluetoothPairingHandler` — the pairing prompt.

The exact refusal shape of the three differs from a boolean callback and is read
from the running Electron rather than guessed: the first hands back a stream set,
the third a pairing response. Confirm each against `electron.d.ts` and a probe
before writing the final form.

All five are setters rather than listeners, so a second `ProjectContext` built on
the same partition replaces them instead of stacking — unlike `will-download`,
which is why that one is removed before it is added. Say so in a comment there,
because the two sit a few lines apart and look alike.

**`documents/design.md`.** Add `permissions.ts` to the module map in §2, and a
short paragraph — in §3, where the project's session is described — saying that
the session refuses every permission and every device, that the rule ignores the
name on purpose, and what that costs. The module map is how this repository
answers "which file holds this", and a decision absent from it is a decision the
next session rediscovers.

**What is deliberately not touched.** The panel, the settings window and the tray
are views of the shell with no session of their own, so they run on
`defaultSession` and this handler never sees them. `snapshot.ts` registers a
protocol handler on a session and requests no permission.

**Tests.** The unit test walks the full name union from `electron.d.ts` and
asserts every one of them is refused. On its own it is weak — `permitted` is
`return false`, and the test would still pass if `context.ts` never installed
anything — so it is not the evidence that the fix works. It guards the one thing
worth guarding at that level: a later edit that quietly lets a name through
without a test to say so. The evidence that the handlers are wired is the
integration test, which drives a real page in a real project tab.

**Verification.**

- `deno task check`
- `node --test --test-concurrency=1 --test-timeout=90000 --test-name-pattern='every permission a page can ask for is refused' test/unit.test.mjs`
- `node --test --test-concurrency=1 --test-timeout=90000 --test-name-pattern='a page that asks for the microphone is refused' test/integration.test.mjs`
- The measurement for the DoD's two measurement items runs against a fixture
  page in a project tab, and its output is pasted into this file.

## What the change did

Both measurements were taken through the integration test, in a project tab, on
a page served over http — not on a window of the application's own, which runs
on `defaultSession` and is not touched by this.

Before, on the unchanged build:

```
{"clipboardRead":"granted","geolocation":"refused: 3","microphone":"granted",
 "notifications":"granted","screen":"refused: NotSupportedError"}
```

After:

```
{"clipboardRead":"denied","geolocation":"refused: 1","microphone":"refused: NotAllowedError",
 "notifications":"denied","screen":"refused: NotAllowedError"}
```

Three of the five read as expected. The other two corrected something that had
been written down as fact:

- **Screen capture was never open.** The unchanged build answered
  `NotSupportedError`, because Electron does not support `getDisplayMedia` until
  a handler is installed. So the hole the plan set out to close did not exist,
  and the right move was the opposite of the plan's: install nothing there, and
  write down that installing a handler is what would open it. It now answers
  `NotAllowedError`, because `display-capture` is one of the names the
  permission handler refuses first.
- **Geolocation does not hang.** [A permission that answers neither
  way](a-permission-that-answers-neither-way.md) recorded it as unsettled after
  6 seconds. Measured here on the unchanged build it came back `refused: 3`,
  which is the page's own `TIMEOUT` — an answer, but from the clock rather than
  from the browser, and 2 seconds late. After the change it is `refused: 1`,
  `PERMISSION_DENIED`, promptly. That is what FR-PERMISSION-2 asked for.

The test also runs in 1.9 s where it took 6.5 s before, because nothing waits on
a decision that never comes.

## Follow-ups

- **An agent cannot see what a page asked for.** Deliberately dropped at variant
  selection on 2026-09-19. Every permission request now fails, and nothing
  records it, so a scenario that breaks because of a refusal gives the agent
  nothing to read. Closing it means a per-tab log in the shape `console` already
  has, plus a reader in `api.ts` and a line in `reference.mjs`.
- **Harmless permissions are refused with the rest, and the list is longer than
  it looked.** Beyond `clipboard-sanitized-write` (a site's own copy button),
  `fullscreen`, `pointerLock` and `persistent-storage`, the union also carries
  `storage-access` and `top-level-storage-access` — the Storage Access API that
  a third-party sign-in frame uses. Refusing those in the one browser that
  exists to hold real logged-in sessions is the breakage most likely to be met
  first, and it was not on the table when the choice was made. Also refused:
  `fileSystem`, `openExternal`, `idle-detection`, `screen-wake-lock`,
  `web-printing`, `local-network-access`. When a page is found broken by one of
  them, the fix is a named allow-list inside `permitted()`, which is why the
  decision is a function and not a constant.
- **`FR-PERMISSION-2` may close as a side effect.** Geolocation hangs today
  because nothing answers it. A refusal should make the page's own error
  callback run. The measurement above settles it; if it does close, that task is
  marked done with the evidence rather than left open.
