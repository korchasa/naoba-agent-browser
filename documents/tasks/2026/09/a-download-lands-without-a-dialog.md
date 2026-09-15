---
date: "2026-09-15"
status: done
implements: []
tags: [agent-browser, naoba, download, boundary, agent-experience]
related_tasks: [putting-a-file-into-a-form, a-screenshot-stays-in-the-project]
---
# A download lands without a dialog, and without asking anybody

## Goal

An agent can take a file off a page — the report behind a button, the export a
form produces — and gets its path back from the call. Nothing asks the person,
and no window has to be on screen.

## Overview

Until now this browser could not download anything at all. Electron with no
`will-download` handler shows the system's "Save as" panel, and this application
spends most of its life in the menu bar with its window parked off screen: the
panel would be waiting somewhere nobody is looking, and the scenario would sit
there until it timed out. So the first half of the work is simply owning the
event.

The second half is that a page starts a download by more than a link. A blob
built in script, a POST that answers with `Content-Disposition`, a button that
assembles the file client-side — none of them has an address a `GET` could
fetch, and the cookies are the session's anyway. So there are two helpers, not
one:

- `api.download(url, path?)` — the agent names the address, and the browser
  fetches it from the tab, with that tab's cookies.
- `api.waitForDownload({timeout})` — the agent clicks, and this answers with
  whatever the click produced.

### Where a downloaded file goes

Same answer as `screenshot`, and for the same reasons (owner, 2026-09-15):

- With no path, into `<temp>/naoba/downloads/<project>-<timestamp>-<name>`. The
  path comes back from the call, so nothing has to be found later, and the
  system clears the directory itself. The site's own filename is kept whole at
  the end, because the extension is half of what the file is.
- A path an agent names has to be inside the project, the same boundary
  `setFiles` reads within and `screenshot` writes within. `resolveWritePath`
  already decides that; it took an argument so its refusal can say `download`
  rather than `screenshot`.

### A download nobody asked for

A page can start a download on its own, and `~/Downloads` being the one
directory a page can write to unassisted was the argument that rejected the
handoff directories in `putting-a-file-into-a-form`. The same loop is the risk
here: a drive-by download, and then `setFiles` handing that same file to a
website, inside one scenario with nobody asked at any point.

So the boundary is asymmetric on purpose (owner, 2026-09-15): a file the agent
did not ask for **never** lands in the project. It is saved into the temporary
directory and recorded, so `waitForDownload()` after a click still finds it —
which is the ordinary case, since the click is what started it. Only the path
of `download(url, path)`, where an agent named the address and named the path,
may be inside the project.

Cancelling an unrequested download instead was weighed and rejected: the
motivating case — click a button, get the file — is indistinguishable from a
drive-by at the moment the event fires, so cancelling would refuse the feature
in order to protect against it.

### A navigation that turns out to be a file

Found on 2026-09-15 by running the built copy against real sites rather than
fixtures: `api.download` and `api.waitForDownload` both behaved, and
`api.navigate` pointed straight at GitHub's archive link threw `ERR_FAILED
(-2)` while the file came down perfectly. `Tab.navigate` forgave only
`ERR_ABORTED (-3)`, which is what a redirect and a superseded load raise — a
download raises the other one, so following a link to a file needed a
`try/catch` around every navigate.

The error code cannot tell the two apart, so the fix does not try to: for the
length of the call `navigate` listens for `will-download` on its own
webContents, and a rejection is only believed once a short wait has passed
without one. The wait exists because the event can arrive after the rejection;
it is paid only by a navigation that failed anyway.

## Definition of Done

- [x] A click that starts a download completes with no dialog and no window on
      screen.
- [x] `api.download(url)` returns `{path, url, filename, bytes, mimeType}` and
      the bytes on disk are the file the server sent.
- [x] `api.download(url, path)` writes inside the project, and is refused for a
      path outside it with a message naming `download`.
- [x] `api.waitForDownload()` answers a download a click started, whether it is
      already finished or still to come.
- [x] A download the agent did not ask for is never written inside the project.
- [x] `reference.mjs` documents both helpers, so the drift test passes.
- [x] Navigating straight to a file downloads it, leaves the tab where it was,
      and throws nothing.
- [x] `deno task check` and `deno task test` are green.

## Solution

- `src/main/downloads.ts` — the log: a claim per `download()` call, a queue of
  arrivals for `waitForDownload()`, and the one function that decides a
  temporary path. No Electron API beyond the `DownloadItem` it is handed, so the
  decisions are unit-testable.
- `src/main/context.ts` — one `will-download` listener per project session,
  attached in the constructor. The session outlives the context (it comes from
  `fromPartition`), so the old listener is removed before the new one goes on,
  or a project unloaded and loaded again would save every file twice.
- `src/main/api.ts` — `download` and `waitForDownload`, both through `guard`, so
  they wait for the tab's lease and appear in the panel's call list.
- `src/main/files.ts` — `resolveWritePath` takes the operation it is deciding
  for, so its refusal names the call the agent made.
- `src/main/tab.ts` — `navigate` tells a download apart from a failed load by
  listening for the event rather than by reading the error code.
