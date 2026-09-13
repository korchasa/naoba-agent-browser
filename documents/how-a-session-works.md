# How a session works

What happens between an agent's first call and the moment its tabs are let go. Written 2026-09-13, for the endpoint that
replaced the relay: the application answers MCP itself, over HTTP on loopback, and every agent is a session inside this
one process.

The files: `src/main/mcp-http.ts` is the endpoint and the sessions, `src/main/hub.ts` admits agents and routes their
calls, `src/main/context.ts` is one project — its window, its tabs, its agents — and `src/main/tab.ts` is one page.

## Connecting, and the first call

A session id is minted at `initialize` and nothing else happens there. The `Session` object appears on the first call
that names a project, and that is also when the hub first hears of the agent.

```mermaid
sequenceDiagram
    autonumber
    participant IDE as Claude Code
    participant HTTP as mcp-http.ts
    participant S as Session
    participant Hub as hub.ts
    participant Ctx as ProjectContext
    participant Tab as tab.ts

    IDE->>HTTP: POST /mcp — initialize
    HTTP-->>IDE: 200, header Mcp-Session-Id
    Note over IDE,HTTP: No Session yet. The id is the name<br/>the client echoes back from now on.

    IDE->>HTTP: POST /mcp — tools/call begin { session_name,<br/>absolute_project_path, url? }<br/>Mcp-Session-Id, X-IDE
    HTTP->>HTTP: lastSeen for this session
    HTTP->>HTTP: opened(): is the session id there,<br/>and is the path absolute?
    HTTP->>S: new Session, keyed by the session id
    HTTP->>Hub: join(session)
    HTTP->>S: greet(session_name) — the promise is remembered, not a flag
    S->>Hub: hello { project, agent: { label: session_name } }
    Hub->>Hub: licensed()?
    Hub->>Hub: identify(projectDir), then ask about<br/>an unknown project once,<br/>naming the agent by what it called itself
    Hub->>Ctx: contextFor(identity).addAgent(agent)
    Hub-->>S: welcome { project, agentId }
    HTTP->>S: call('begin', { url })
    S->>Hub: call
    Hub->>Ctx: tabFor(agent) — the tab exists from here on
    Hub-->>HTTP: { tab, others }
    HTTP-->>IDE: 200 { the tab and the others, as JSON }

    Note over IDE,HTTP: Every later call is the same,<br/>minus the introduction.

    IDE->>HTTP: POST /mcp — tools/call evalInBrowser
    HTTP->>S: call('eval', { code, timeout })
    S->>Hub: call
    Hub->>Ctx: queue.run on this agent's tab
    Ctx->>Tab: runScript(code, api)
    Tab-->>Ctx: outcome
    Ctx-->>Hub: outcome
    Hub-->>S: result
    S-->>HTTP: value
    HTTP->>HTTP: lastSeen again, on the way out
    HTTP-->>IDE: 200 { content: prose the model reads }
```

Later calls skip the middle: `sessionOf()` finds the session by the echoed id, `greet()` returns the promise it already
has, and the call goes straight to the hub.

## What decides which browser an agent gets

- **The project comes from `absolute_project_path`, an argument of `begin`** — the path the session says it works in,
  taken as given. Naoba no longer walks up to the nearest repository root, and does not check that the directory is
  there: which project this is, is the session's business. `identify()` only settles spelling — it resolves symlinks
  and lowercases the result, so a trailing slash, a symlink and a different letter case are one project.
  It used to be a header carrying `${PWD}`, which only worked in clients that expand it.
- **A session is keyed by the `Mcp-Session-Id` alone.** It is minted at `initialize` and echoed from then on, so one id
  is one agent, and two agents in one repository are two ids and two rows.
- **An id that calls `begin` again naming a different project moves to it**, and the session it had in the first
  project is closed — never the first project's cookies under the second project's name.
- **A path that is not absolute is refused** with a sentence in the session's own hands. Nothing expands or resolves
  it on the way in, so a relative path and an unexpanded `${PWD}` are both text that would key a browser of their own.
- **An unknown project is asked about once**, and the answer is kept in `projects.json`. The dialogs are serialised, so
  five agents starting at once in one checkout produce one question.

## Staying alive, and being let go

Nothing is pushed over HTTP and a closing client says nothing, so silence is the only signal there is. Every request
refreshes the session, and a session with a call still running is never swept — asking the person to sign in takes as
long as it takes.

```mermaid
sequenceDiagram
    autonumber
    participant IDE as Claude Code
    participant HTTP as mcp-http.ts
    participant S as Session
    participant Hub as hub.ts
    participant Ctx as ProjectContext

    IDE->>HTTP: any request at all — ping, tools/list, tools/call
    HTTP->>S: lastSeen = now

    loop every 60 seconds
        HTTP->>HTTP: forgetTheQuiet()
        alt a call of this session is still running
            HTTP->>HTTP: not quiet — leave it
        else nothing heard for 10 minutes
            HTTP->>S: close()
            S->>S: reject every pending call
            S->>Hub: onClose
            Hub->>Ctx: removeAgent(agentId)
            Ctx->>Ctx: release its leases, dim the row,<br/>arm the orphan timer
        end
    end

    IDE->>HTTP: DELETE /mcp + Mcp-Session-Id
    HTTP->>S: close() — the same path, without the wait
    HTTP-->>IDE: 204
```

The orphan timer is the settings row "Close a departed agent's tabs after". Its clock starts when Naoba notices the
agent is gone, which for a client that vanished is up to 11 minutes after it did.

## Quitting, and updating

Installing an update quits the application, so quitting is the update's first half. An agent mid-scenario gets a
readable error rather than a hang.

```mermaid
sequenceDiagram
    autonumber
    participant OS as macOS or a signal
    participant Main as main.ts
    participant HTTP as mcp-http.ts
    participant S as Session
    participant Hub as hub.ts

    OS->>Main: quit, SIGTERM, or "Restart and update"
    Main->>Hub: stop()
    Main->>HTTP: stopMcpServer()
    HTTP->>S: close() for every session
    S-->>Main: every pending call rejected
    Note over S,Main: callTool turns that into a 200 carrying<br/>isError, so the agent reads a sentence.
    Main->>Hub: flushAll() — cookies and local storage
    alt written, or 5 seconds have passed
        Main->>OS: app.exit(0)
    end
```

The five seconds are a limit, not a wait: a flush that never settles used to hold the process open, and Squirrel cannot
put the new bundle in place until this process is gone.

## When the port is taken

The port is fixed — 8899 for the copy people download, 8900 for the development copy — because it sits in an IDE's
configuration and has to mean the same thing tomorrow. A second copy of one variant never reaches this code: the
single-instance lock stops it first. So a taken port is somebody else's program.

```mermaid
sequenceDiagram
    autonumber
    participant Main as main.ts
    participant HTTP as mcp-http.ts
    participant OS as macOS

    Main->>Main: register SIGTERM and SIGINT first
    Main->>HTTP: startMcpServer({ port })
    HTTP-->>Main: EADDRINUSE
    Main->>OS: the reason, and the lsof line, to standard error
    Main->>OS: a notification — never a modal dialog
    Main->>OS: app.exit(1), about 2 seconds later
```

A modal message box is what this used to do, and it stopped the event loop: the quit underneath it was unreachable and
so was `SIGTERM`, so the only way out of a copy that could not start was to kill it. The asynchronous message box
behaves the same way, which was measured rather than assumed.
