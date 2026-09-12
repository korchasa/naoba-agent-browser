---
date: 2026-09-12
status: done
implements: []
tags: [interface, design, icon, settings]
related_tasks: [a-face-of-its-own, settings-in-a-window-of-their-own, where-the-application-shows-itself]
---

# Dressed as an instrument

The window had no dress of its own. It was a pastel green (`#6dbf94`) on
rounded ten-point corners with a shadow under every surface — the default look
of a web page written in a hurry, and nothing in it said what the application
is. The panel, the settings window and the icons now speak one language, the
one Teenage Engineering prints on its hardware and Efferent uses on its
screens.

## The language

- An off-white shell (`#f5f4f1`) with white panels on it. The panel is told
  from the shell by its colour, so it needs no frame.
- Hairline rules, and only where a rule does something.
- Corners of one point where an edge needs softening, three where a whole
  panel does. Nothing is rounder than that, and nothing casts a shadow onto a
  surface it lies on.
- Legends — the wordmark, a section heading, a tag, the unit beside a field —
  set in the monospaced face as small tracked capitals, the way lettering is
  printed on a case. Two tokens carry it: `--legend-size`, `--legend-track`.
- One orange, `#ff4b12`, and it is rationed: the way forward, the mark, the
  row being looked at, and a call waiting for the person. Every other
  distinction is carried by grey, the agent dots included.
- Dark is a second finish, not an inversion — the black case the same makers
  build. The shell darkens, the panels stay a step above it, and the orange is
  unchanged, because it is the one thing printed in ink.

Every one of these lives in `src/renderer/palette.css`; a colour literal
anywhere else in the renderer is a defect.

## The icons

Redrawn on the same face: an off-white case, a dark dial, the world's
meridians on it, and the prompt cut in orange. The `.icns` takes **three**
drawings sharing one geometry, because the two it had were not enough — the
chevron and the underscore close up at 16 points:

- `icon.svg` — 128 and up, with the meridians.
- `icon-small.svg` — 32 and 64, the dial plain, the prompt heavier.
- `icon-tiny.svg` — 16, the chevron alone.

The window shows the same figure the Dock and the menu bar show. The bolt it
used to carry belonged to nothing else in the application.

## Two rounds of taking things off

The first dress still drew a box around things that read as themselves.

1. **A frame only where the frame does something.** The tool's name beside an
   agent, the agent's name beside a call, the mark on a waiting tab — letters
   printed on the case, not tags in a frame. The keys along the address bar
   lose their frames too, so the address field is the one box in the row and
   it is the one thing you type into. The card that calls for the person keeps
   its orange rule and drops the frame, because the rule already said which
   one is live.
2. **The case stops competing with what is printed on it.** The scale of sixty
   marks and the pointer come off the icon — detail for its own sake, and mud
   below 64 points. In the settings the rules between rows go as well, and the
   number sits on a rule instead of in a box.

## What live data showed that test data hid

Photographed on the installed copy with the real register, every allowed
project carried an orange lamp, so a dozen directories were a column of orange
down the side of the window — the accent spent on the ordinary state. The
state moved onto the row: an allowed directory keeps its lamp, a refused one
goes pale with a grey one. The refusal stays on the list, because it is why an
agent working there gets nothing, and the Forget button keeps its full
strength, because forgetting is the one thing to do with that row.

## The panel width left the settings

The row asked for a number in points to do what the grip on the panel's edge
does directly, while the person watches. It is gone, and with it the whole
path behind it: `panelWidth` left `PreferenceValues`, the snapshot no longer
carries it, and the handler behind the grip no longer pushes at a window with
nothing to redraw. The width itself is unchanged — kept in `settings.json`,
clamped by the shell, restored at start-up.

The two unit tests that went red on the way through are the ones that were
supposed to: `PREFERENCES` is mapped over `keyof PreferenceValues`, so a value
with no row does not compile, and the both-ways check caught the sample still
carrying a width.

## Claude Design was tried and not kept

Two complete variants were built from the owner's own Claude Design systems —
Modernist (flat architectural, red, zero radius, Archivo) and Industry
(steel-blue blueprint with registration marks, Barlow Condensed) — rendered as
copy-backed probes beside the hand-made one and looked at together. The
hand-made instrument was the one kept. Recorded so the detour is not repeated
on the assumption that it was never taken.

## Definition of Done

- [x] The panel, the settings window and the icons share one language.
      Evidence: `palette.css` rewritten as the single source of every colour;
      `chrome.css` and `settings.css` carry no literal.
- [x] The orange is rationed and grey carries the rest.
      Evidence: the agent ramp is orange then four greys; the allowed lamp is
      the only orange on a quiet register.
- [x] Dark is a finish of its own, not an inversion.
      Evidence: the `prefers-color-scheme: dark` block redefines the shell and
      the panels and leaves the accent standing.
- [x] The icon reads at every size it is drawn at.
      Evidence: `icon.icns` rebuilt from three drawings and unpacked back to an
      iconset, looked at from 1024 down to 16.
- [x] The real window was photographed, not only the snapshot mode.
      Evidence: the installed copy with two tabs open through the bridge, and
      the settings window opened from the Dock item's menu, captured by window
      id with `screencapture -l`.
- [x] `deno task check` is clean and the whole suite passes.
      Evidence: 120 tests. `deno fmt --check` flags only the three files it
      flagged before this work.

## Follow-ups

- ~~Closed 2026-09-12.~~ The wording at `AGENTS.md:57` says "departed agent"
  where the window says "An agent that reconnects". One of the two should give
  way. — It was the window's: a session does not reconnect, it comes back as a
  new agent, which is what the rule and the code both say. The hint now says
  so. The rule gained the one thing it was missing, that the grace period is a
  row in the settings window and the flag only overrides it for a launch.
