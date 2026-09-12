---
date: 2026-09-12
status: done
implements: []
tags: [interface, settings, macos]
related_tasks: [settings-in-a-window-of-their-own]
---

# Where the application shows itself

The application has always been a menu-bar application and nothing else:
`main.ts` called `app.dock.hide()` on every start, with no way to ask for
anything different. The person asked for a switch: the menu bar, the Dock, or
both.

## Affected Surface

- `src/main/preferences.ts` — the row list. It knows two kinds of row, `switch`
  and `number`; a choice of three is a third kind.
- `src/renderer/settings.ts`, `settings.css` — drawing that row, and sending
  the change.
- `src/preload/preload.ts` — one more method on `window.ab`.
- `src/main/main.ts` — `settingsFor`, the new handler, and the start-up block
  that hides the Dock and installs the tray.
- `src/main/settings.ts` — one more field in `settings.json`.
- `test/unit.test.mjs` — the sample values, and the new behaviour.
- `AGENTS.md` — the rule that the application is a menu-bar application is now
  a rule about a default.

Untouched on purpose: `tray.ts`. `installTray` already returns the `Tray`, and
`destroy()` is all the removal needs.

## What macOS gives us

One knob, `NSApplicationActivationPolicy`, with two positions — `regular` (a
Dock icon, and a place in the app switcher) and `accessory` (neither). Electron
spells them `app.dock.show()` and `app.dock.hide()`. The menu-bar icon is not
part of that knob at all: it is a `Tray` object that exists or does not.

So the three choices are two independent facts, and the reason to draw them as
one row of three rather than two switches is that "neither" must be
unreachable. A pair of switches would have to refuse the second one off, and
this window already holds the opposite rule: a number under its floor comes
back as the floor, never refused.

## Solution

`Presence` is `'menu-bar' | 'dock' | 'both'`, kept in `settings.json` and
defaulting to `menu-bar`, which is what the application did before. Two pure
functions carry the meaning, so the tests reach them without Electron:
`asPresence` turns anything the file holds into one of the three, and
`presenceOf` says which of the two icons that choice wants. `main.ts` applies
the answer — `dock.show()`/`dock.hide()`, and `installTray`/`destroy` — at
start-up and again whenever the row is touched.

## Definition of Done

- [x] The row is drawn with three segments, the current one marked.
      Evidence: looked at in the snapshot, both appearances and at an accessibility text size.
- [x] Picking a segment applies at once: the Dock icon and the menu-bar icon
      Evidence: clicked on the running application: `background only` went false and `number of menu bars` 2 → 1 for Dock, and back.
      appear and go without a restart.
- [x] The choice survives a restart.
      Evidence: left on Both, restarted: Dock icon and status item both came back.
- [x] A `settings.json` holding junk in that field starts in the menu bar.
      Evidence: `"presence": "tray"` written by hand, restarted: the menu bar alone.
- [x] No choice leaves the application with neither icon.
      Evidence: held by a unit test over all three values, and by the type — there is no fourth.
- [x] The default is the menu bar alone, as before.
      Evidence: `asPresence` answers `menu-bar` for a missing field; the first start shows it.
- [x] `deno task check` is clean and the whole suite passes.
      Evidence: 117 tests, all passing.
- [x] The settings window is looked at in both appearances and at an
      Evidence: `05-settings-*.png` and `06-settings-large-text-*.png`.
      accessibility text size.

## Follow-ups

- The bundle ships Electron's own `electron.icns`, so the Dock shows the
  Electron logo to whoever turns it on. An icon of its own is a task of its
  own.
- `LSUIElement` is not set in the bundle's `Info.plist`, so a start in
  menu-bar mode still flashes a Dock icon for a moment before `dock.hide()`
  runs.
