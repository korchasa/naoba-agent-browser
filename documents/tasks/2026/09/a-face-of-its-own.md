---
date: 2026-09-12
status: done
implements: []
tags: [interface, macos, icon]
related_tasks: [where-the-application-shows-itself, what-the-dock-icon-says]
---

# A face of its own

The bundle shipped Electron's own `electron.icns`, so the Dock showed the
Electron logo to anybody who turned the Dock icon on, and the menu bar showed a
globe borrowed from lucide. Both are now the application's own mark.

## What macOS gives an icon

An `.icns` holds a set: 16, 32, 64, 128, 256, 512 and 1024 points, the small
ones in single and double resolution. 1024 is the ceiling and the master. The
useful part is that each size is a **separate picture** — the small ones do not
have to be the large one shrunk.

macOS 26 adds layered icons in a format of its own, `.icon`, with light, dark,
tinted and clear appearances and per-layer blur. They are made in Icon
Composer, which ships with Xcode 26 and is not on this machine, and
electron-builder takes `.icns` regardless. So `.icns` it is; it works on every
version.

The menu bar is a different medium by rule, not by taste. It takes a template
image: black plus alpha, about 18 points tall, at double and triple resolution.
The system throws the colour away and paints the shape itself — black on the
light bar, white on the dark one. White inside such a glyph is therefore a hole
and not paint, which is what ruled out a filled disc with the prompt cut into
it: on the dark bar it came back as a white blob.

## The mark

A world with a command prompt on it. The prompt is the one sign everybody reads
the same way — a program is working here — which is what the application is
for, and it is the only one of the six candidates that still says so at 32
points.

Two drawings, one figure:

- `build-resources/icon.svg` — 128 points and up. A clay world with a grid, a
  specular highlight and a contact shadow, on a cream tile. The tile is the
  macOS grid (1024 canvas, 824 body) and its outline is a superellipse, which
  is the shape macOS rounds a corner with.
- `build-resources/icon-small.svg` — 16 and 32. The world is bigger, the grid
  is gone and the prompt is heavier. Compared against the shrunk version at
  both sizes before it was kept.
- `WORLD` in `src/main/tray.ts` — the same circle and prompt as a line, stroke
  2.1.

## Definition of Done

- [x] The bundle carries the application's own icon.
      Evidence: `Naoba.app/Contents/Resources/icon.icns`, 1024 at its largest;
      unpacked back to an iconset and looked at from 1024 down to 16.
- [x] The small sizes carry their own drawing.
      Evidence: the same unpack — 128 and up hold the grid, 64 and below hold
      the plain world.
- [x] The menu bar shows the new glyph.
      Evidence: `screencapture` of the status item's own rectangle on the
      running application, read from System Events.
- [x] `deno task check` is clean and the whole suite passes.

## Follow-ups

- The development copy shares the icon. A " Dev" copy that looked different
  would be easier to tell apart in the Dock.
