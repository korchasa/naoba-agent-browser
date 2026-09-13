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

    IDE->>HTTP: POST /mcp — tools/call begin { name, url? }<br/>Mcp-Session-Id, X-Project, X-Agent, X-IDE
    HTTP->>HTTP: lastSeen for this session
    HTTP->>HTTP: admitted(): is X-Project there,<br/>and is it a directory on this Mac?
    HTTP->>S: new Session, keyed by session id AND X-Project
    HTTP->>Hub: join(session)
    HTTP->>S: greet(name) — the promise is remembered, not a flag
    S->>Hub: hello { projectDir, agent: { label: name } }
    Hub->>Hub: licensed()?
    Hub->>Hub: identify(projectDir), then ask about<br/>an unknown project once,<br/>naming the agent by what it called itself
    Hub->>Ctx: contextFor(identity).addAgent(agent)
    Hub-->>S: welcome { project, agentId }
    HTTP->>S: call('begin', { url })
    S->>Hub: call
    Hub->>Ctx: tabFor(agent) — the tab exists from here on
    Hub-->>HTTP: { project, you, tab, others }
    HTTP-->>IDE: 200 { the picture, as JSON }

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

Later calls skip the middle: `admitted()` finds the session by its key, `greet()` returns the promise it already has,
and the call goes straight to the hub.

## What decides which browser an agent gets

- **The project comes from `X-Project`**, one header per session, expanded by the IDE from one line of configuration.
  `identify()` walks up to the nearest repository root, resolves symlinks and lowercases the result, so two spellings of
  one directory are one project.
- **A session is keyed by the session id and the project together.** A client that keeps one MCP session while its
  working directory changes gets a second session and a second browser, not the first project's cookies.
- **A client that echoes no session id** is keyed by the project, and by `X-Agent` when it sends one — two agents in one
  repository that name themselves stay two agents.
- **A project directory that is not on this Mac is refused** with a sentence in the agent's own hands. An unexpanded
  `${PWD}` is what that usually means.
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
