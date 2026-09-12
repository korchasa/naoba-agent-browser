---
date: "2026-09-12"
status: done
implements: []
tags: [agent-browser, naoba, screenshot, boundary, agent-experience]
related_tasks: [putting-a-file-into-a-form, naoba-agent-surface-defects]
---
# A screenshot is written inside the project, or nowhere lasting

## Goal

`api.screenshot(path)` writes where `api.setFiles` reads, and nowhere else, and
a picture nobody named a path for does not pile up. The question left open by
the upload task is answered rather than carried.

## Overview

`putting-a-file-into-a-form` bounded the read and recorded the write as an
observation for the owner to schedule: `screenshot(path)` took any path an agent
named, `Tab.screenshot` ran `mkdir` with `recursive: true` and then `writeFile`,
so a scenario could create directories anywhere this application can reach and
overwrite any file there. The owner chose the symmetric boundary on 2026-09-12.

The two operations are not the same, and the difference was the reason to weigh
them apart: handing a file to a website gives it away, while writing a picture
destroys whatever the path already held. What does not differ is the reason a
boundary is needed at all. The path is chosen by a scenario; a scenario is often
written from page text, which is written by whoever controls the page; and the
write happens in the browser process, where nobody is asked. PNG bytes over
somebody's notes is a loss whatever the intent behind the path was.

Nothing an agent does every day is lost. A picture that has to leave the project
is copied out by the agent's own tools, where the person is asked.

### Where a picture goes when nobody says

The boundary raised the question the old default had been dodging. Pictures used
to land in `userData/screenshots/<projectId>/` — this application's own state
directory, keyed by a hash. It was inside the boundary only because the boundary
was given a second root to make it so, and a person looking for a picture had to
know where an Electron app keeps its state and which hash was theirs.

The first answer was `<project>/.naoba/screenshots/`, and the owner withdrew it
the same day: a directory in everybody's project, and a new split of where files
live, is too much to change for the sake of a convenient path. Recorded because
the reasoning still holds for anything that genuinely is per-project state — it
just was not this.

What replaced it (owner, 2026-09-12): a temporary file, `<temp>/naoba/<project
name>-<timestamp>.png`. A screenshot is working material — an agent takes one,
reads it, and is done — and the path comes back from the call, so nothing has to
be found later. The system clears the directory on its own, which is the point:
the old default's legacy is 30 forgotten pictures in a state directory that
nobody has ever opened. A picture worth keeping is copied out by the agent's own
tools, where the person is asked.

The temporary directory is deliberately **not** in the boundary. Only the
default writes there; a path an agent names still has to be inside the project,
which is where a person would look for it.

## Definition of Done

- [x] A path outside the project is refused before anything is written, and the
      refusal says where a picture may go.
- [x] A path inside the project is written, including into a directory that does
      not exist yet — which is where most screenshots go.
- [x] The boundary is the one `setFiles` reads within, from one place in the
      code, so the two cannot drift apart.
- [x] A screenshot with no path is a temporary file named after the project, and
      nothing accumulates anywhere.
- [x] The manual says the rule where an agent meets the helper.
- [x] `deno task check` and `deno task test` exit 0, and `deno fmt --check`
      reports only the three files `AGENTS.md` already names.

## Solution

1. **`src/main/files.ts`** — `UploadBoundary` becomes `FileBoundary`, since it
   now bounds both directions, and `resolveWritePath(asked, boundary)` sits
   beside `resolveUploadPaths`. The target file is almost never there yet, so
   the judgement runs over the directories that are; a path is resolved before
   it is judged, so a symlink inside the project pointing out of it is out of
   it; an existing directory as the target is refused by name.
2. **`src/main/api.ts`** — `screenshot` resolves a named path through the
   boundary before `guard`, and `uploadBoundary` is renamed `fileBoundary`.
   `defaultShotPath(projectName)` writes under `app.getPath('temp')`, and the
   boundary carries one root instead of two.
3. **`packages/bridge/reference.mjs`** — the `screenshot` entry says where a
   picture may land and names the same boundary `setFiles` reads within.

### What the probe caught

The first implementation refused the project's own files whenever the root was
spelled through a symlink or did not exist yet. `identify()` resolves a root
through `realpathSync.native` but falls back to the unresolved spelling when the
directory is not there, and `canonical()` did the same — while the candidate
beside it was resolved as far as it goes. So a project at `/tmp/naoba-tests/…`
compared `/tmp/…` against `/private/tmp/…` and called its own directory an
intruder. `canonical()` now resolves through the directories that exist, the
same way the candidate does. This is the trap `AGENTS.md` already names, met
from the side it had not been met from: the root, not the file.

### What the tests answered

- A unit test over `resolveWritePath`: inside, relative-to-the-project, into
  `.naoba/screenshots` before that directory exists, and a root spelled through
  a symlink — then the four refusals (outside, a symlink leading out, a sibling
  whose name merely starts with the project's, and a directory as the target).
- An integration test for the default: `screenshot()` with no path comes back
  from `<temp>/naoba/<project name>-<timestamp>.png`, and the file is a PNG.
  Proved red by pointing the default back at the state directory — the test
  reported the path it got, which is the thing under test.
- An integration test over the live api: a picture into the project comes back
  at its resolved path and is a real PNG.
- An integration test for the refusal: the message names the boundary and
  `screenshot()` with no path, and nothing was written on the way to it.

Proved red before being trusted: with the boundary check disabled, the
integration test got back a path under `/private/var/folders/…` and the unit
test reported a missing rejection — both for the reason under test, not for a
neighbouring one. 108 tests pass with the boundary and the new default in place.
