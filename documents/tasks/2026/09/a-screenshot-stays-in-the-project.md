---
date: "2026-09-12"
status: done
implements: []
tags: [agent-browser, naoba, screenshot, boundary, agent-experience]
related_tasks: [putting-a-file-into-a-form, naoba-agent-surface-defects]
---
# A screenshot stays in the project

## Goal

`api.screenshot(path)` writes where `api.setFiles` reads, and nowhere else. The
question left open by the upload task is answered rather than carried.

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

Nothing an agent does every day is lost. `screenshot()` with no path already
lands in `userData/screenshots/<projectId>/`, which is inside the boundary, and
that directory is the one `setFiles` may already read from — so taking a picture
and attaching it to a form still needs no copy. A picture that has to leave the
project is copied out by the agent's own tools, where the person is asked.

## Definition of Done

- [x] A path outside the project is refused before anything is written, and the
      refusal says where a picture may go.
- [x] A path inside the project is written, including into a directory that does
      not exist yet — which is where most screenshots go.
- [x] The boundary is the one `setFiles` reads within, from one place in the
      code, so the two cannot drift apart.
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
   Called with no path, nothing changes.
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

- A unit test over `resolveWritePath`: inside, relative-to-the-project, into the
  screenshot directory before it exists, and a root spelled through a symlink —
  then the four refusals (outside, a symlink leading out, a sibling whose name
  merely starts with the project's, and a directory as the target).
- An integration test over the live api: a picture into the project comes back
  at its resolved path and is a real PNG.
- An integration test for the refusal: the message names the boundary and
  `screenshot()` with no path, and nothing was written on the way to it.

Proved red before being trusted: with the boundary check disabled, the
integration test got back a path under `/private/var/folders/…` and the unit
test reported a missing rejection — both for the reason under test, not for a
neighbouring one. 107 tests pass with the boundary in place.
