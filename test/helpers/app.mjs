import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/**
 * Start a copy of the application the tests own outright: its own port and its
 * own state directory, so a test run never touches the browser the owner is
 * actually using, and never inherits its admitted projects.
 */
export async function startApp(
  { port = 8951, extraArgs = [], userDataDir = null, keepState = false, headless = true } = {},
) {
  // A caller that passes a directory it already owns is restarting the app on
  // purpose — that is the only way to prove a login outlives the application.
  const userData = userDataDir ?? (await mkdtemp(join(tmpdir(), 'naoba-test-')))
  const child = spawn(
    join(root, 'node_modules/.bin/electron'),
    [
      join(root, 'dist/main.js'),
      '--admit-everything',
      // Tests drive a browser; they must not put windows on the owner's screen.
      // A test that needs the real windowing path passes headless: false — the
      // window is still invisible, but Chromium treats input the way it does
      // for the person's own machine, which is where key events go missing.
      ...(headless ? ['--headless'] : []),
      '--port',
      String(port),
      '--user-data-dir',
      userData,
      '--idle-unload-ms',
      '2000',
      // Short enough for the test that watches a departed agent's tab go, long
      // enough that a disconnect in any other test does not pull the tab from
      // under the agent that stayed.
      '--orphan-close-ms',
      '1500',
      '--contention-wait-ms',
      // Long enough that a slow machine does not read a queued command as a
      // deadlock, short enough that the contention test still finishes.
      '6000',
      ...extraArgs,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))

  const listening = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the app did not start in 30s\n${stderr.join('')}`)), 30_000)
    child.stdout.on('data', (chunk) => {
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(String(chunk))
      if (!match) return
      clearTimeout(timer)
      resolve(Number(match[1]))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the app exited with ${code}\n${stderr.join('')}`))
    })
  })

  const open = []

  return {
    port: listening,
    userData,
    url: `http://127.0.0.1:${listening}/mcp`,
    /** Connect as one agent working in `projectDir`, `begin` and all. */
    async agent(projectDir, label = 'test-agent') {
      const session = await connect(listening, label)
      open.push(session)
      await session.tool('begin', { session_name: label, absolute_project_path: projectDir })
      const status = await session.call('status', {})
      return {
        session,
        project: status.project,
        agentId: status.agents.find((agent) => agent.self)?.id ?? null,
        /** Every event this session has been sent, oldest first. */
        get events() {
          return session.events
        },
        run: (code, timeout = 20_000) => session.call('eval', { code, timeout }),
        fault: (message, kind) => session.fault(message, kind),
        status: () => session.call('status', {}),
        close: () => void session.close(),
      }
    },
    async stop() {
      for (const session of open) await session.close()
      child.kill('SIGTERM')
      await new Promise((resolve) => child.on('exit', resolve))
      if (!keepState) await rm(userData, { recursive: true, force: true })
    },
  }
}

/**
 * One agent's session, over the endpoint a real IDE uses.
 *
 * `naoba/call` and `naoba/events` are the test door the application opens only
 * under `--admit-everything`: a tool call comes back as prose for a model to
 * read, and an assertion needs the value the browser produced. Everything else
 * here — the address and the session header — is exactly what Claude Code
 * sends.
 */
export async function connect(port, label = 'test-agent') {
  const url = `http://127.0.0.1:${port}/mcp`
  const events = []
  let id = 1
  let sessionKey = null

  async function rpc(method, params, headers = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(label ? { 'x-ide': 'test' } : {}),
        ...(sessionKey ? { 'mcp-session-id': sessionKey } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
    })
    if (!response.ok) {
      throw Object.assign(new Error(`the browser answered ${response.status}`), { status: response.status })
    }
    const answer = await response.json()
    if (answer.error) {
      const { code, details } = answer.error.data ?? {}
      throw Object.assign(new Error(answer.error.message), { code, details })
    }
    return { result: answer.result, sessionKey: response.headers.get('mcp-session-id') }
  }

  const start = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  sessionKey = start.sessionKey

  // Nothing is pushed over HTTP, so the events a socket used to deliver are
  // collected by asking. Often enough that a test waiting on one does not
  // notice, and only in a test run — the door is shut in a shipped build.
  let closed = false
  const poller = setInterval(() => void collect(), 100)
  poller.unref?.()

  async function collect() {
    if (closed) return
    try {
      const { result } = await rpc('naoba/events', {})
      events.push(...result.events)
    } catch {
      // The application is going away, or this session already has. Either way
      // there are no more events to read and nothing here to report.
    }
  }

  return {
    /** Every event this session has been sent, oldest first. */
    get events() {
      return events
    },
    get sessionKey() {
      return sessionKey
    },
    /**
     * Make the main process throw where nothing catches it. Only a test run can
     * reach this door, and it is how a test proves a fault is recorded rather
     * than put on screen.
     */
    async fault(message, kind = 'exception') {
      const { result } = await rpc('naoba/fault', { message, kind })
      return result
    },
    /** The hub's own call, with the value it produced rather than prose about it. */
    async call(method, params) {
      const { result } = await rpc('naoba/call', { method, params })
      return result.value
    },
    /** A tool call as an agent makes it, prose and all. */
    async tool(name, args) {
      const { result } = await rpc('tools/call', { name, arguments: args })
      return result
    },
    list: () => rpc('tools/list', {}).then(({ result }) => result),
    async close() {
      closed = true
      clearInterval(poller)
      await fetch(url, {
        method: 'DELETE',
        headers: sessionKey ? { 'mcp-session-id': sessionKey } : {},
      }).catch(() => undefined)
    },
  }
}

// Well clear of the port the shared test app holds, so a test that starts its
// own copy cannot end up talking to that one instead.
export const nextPort = (() => {
  let next = 8960
  return () => next++
})()
