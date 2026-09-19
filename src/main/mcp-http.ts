import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AppEvent, ClientMessage, Connection, ServerMessage } from './protocol.ts'
import { TOOLS } from './tools.mjs'
import { renderError, renderOutcome } from './render.mjs'

/**
 * The application answers MCP itself.
 *
 * There used to be a relay: a process an IDE launched per session, speaking MCP
 * on one side and the application's own protocol on the other. It existed for
 * one reason — MCP over standard input needs a process to launch — and it cost
 * more than it was worth. Its code froze at the moment a session began, so an
 * application that replaces itself left every running session on the old code,
 * and nine of them broke at once the day a file was renamed.
 *
 * What made the relay look necessary was the project. An agent belongs to the
 * repository it is working in, and the relay knew which one because the IDE
 * launched it there. Over HTTP the client sends it instead: `X-Project` carries
 * the working directory of the session, expanded per session from one
 * configuration shared by all of them.
 *
 * Everything else is smaller than the relay was. Plain JSON answers, no event
 * stream; a session is a header the client echoes back; and a tool's failure
 * comes back as a result the agent can read rather than a protocol error that
 * hides it.
 */
const NAME = 'naoba'

/** The version of MCP this endpoint answers for. */
const MCP_VERSION = '2025-06-18'

/** What the agent is told before it has asked anything. */
const INSTRUCTIONS = 'A browser shared by every agent working in this project, and closed to agents working in ' +
  'any other. Write a whole scenario in one evalInBrowser call rather than one call per action. api.help() inside ' +
  'a scenario prints every helper there is; the tool description carries only a summary.'

/** How long a session may go unheard from before its tabs are somebody else's problem. */
const FORGET_AFTER_MS = 10 * 60 * 1000

/** Enough of a backlog for a test to find what it is waiting for, and small enough to forget. */
const EVENT_BACKLOG = 200

interface Rpc {
  id?: number | string
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown>; method?: string; params?: unknown }
}

/**
 * One IDE session, wearing the shape the hub already understands.
 *
 * The hub was written against a socket: something that delivers messages and
 * closes. A session delivers them from POST bodies and closes when the client
 * says so or when it has been quiet for long enough, and the hub cannot tell
 * the difference.
 */
class Session implements Connection {
  readonly id: number
  lastSeen = Date.now()
  /** Kept only for the test door; nothing over HTTP can be pushed an event. */
  readonly events: AppEvent[] = []
  #greeting: Promise<void> | null = null
  #nextId = 1
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  #onMessage: ((message: ClientMessage) => void) | null = null
  #onClose: (() => void) | null = null

  constructor(
    id: number,
    /** The header the client echoes back on every request. It is also the key. */
    readonly sessionId: string,
    readonly project: string,
    readonly ide: string,
    /** What the agent is called until `begin` gives it a name of its own. */
    public label: string,
    readonly keepEvents: boolean,
  ) {
    this.id = id
  }

  /** Whether `begin` has run. Every other tool waits for it. */
  get started(): boolean {
    return this.#greeting !== null
  }

  /** Whether a call of this session's is still running, so the sweeper leaves it alone. */
  get busy(): boolean {
    return this.#pending.size > 0
  }

  send(message: ServerMessage): void {
    if (message.type === 'event') {
      if (!this.keepEvents) return
      this.events.push(message.event)
      if (this.events.length > EVENT_BACKLOG) this.events.shift()
      return
    }
    const waiting = this.#pending.get(message.id)
    if (!waiting) return
    this.#pending.delete(message.id)
    if (message.type === 'result') waiting.resolve(message.value)
    else if (message.type === 'welcome') waiting.resolve(message)
    else if (message.type === 'denied') waiting.reject(Object.assign(new Error(message.reason), { code: 'denied' }))
    else waiting.reject(Object.assign(new Error(message.error.message), message.error))
  }

  close(): void {
    sessions.delete(this.sessionId)
    for (const [, waiting] of this.#pending) waiting.reject(new Error('the browser closed this session'))
    this.#pending.clear()
    this.#onClose?.()
  }

  onMessage(handler: (message: ClientMessage) => void): void {
    this.#onMessage = handler
  }

  onClose(handler: () => void): void {
    this.#onClose = handler
  }

  /**
   * Say who this agent is, once, with the name it chose in `begin`.
   *
   * The name has to arrive here rather than later: the window asks the person
   * whether to let this agent into the project, and what it asks with is the
   * label. A row saying `claude-code · naoba` twice is the thing `begin` exists
   * to prevent.
   */
  greet(label: string): Promise<void> {
    // The promise is what is remembered, not a flag set after the await: a
    // client that makes two tool calls in one turn — Claude Code does — would
    // otherwise pass the flag twice and introduce itself twice, and the hub
    // would hold an agent nobody can ever remove.
    if (!this.#greeting) {
      this.label = label
      this.#greeting = this.#ask((id) => ({
        type: 'hello',
        id,
        project: this.project,
        agent: { label, ide: this.ide, pid: 0 },
      })).then(() => undefined)
    }
    return this.#greeting
  }

  call(method: string, params: unknown): Promise<unknown> {
    return this.#ask((id) => ({ type: 'call', id, method, params }))
  }

  #ask(build: (id: number) => ClientMessage): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      if (!this.#onMessage) {
        reject(new Error('the browser is not listening yet'))
        return
      }
      this.#onMessage(build(id))
    })
  }
}

let server: Server | null = null
let sweeper: NodeJS.Timeout | null = null
const sessions = new Map<string, Session>()
let nextConnectionId = 1

export interface McpOptions {
  port: number
  /** Reported in `serverInfo`, so an agent can say which copy answered it. */
  version: string
  /** Hands a new session to the hub, exactly as a socket used to be handed over. */
  join(session: Connection): void
  /**
   * Opens `naoba/call` and `naoba/events`, which reach the hub directly.
   *
   * The tests drive the browser through them: MCP renders an outcome into
   * prose for a model to read, and an assertion needs the value itself. Never
   * on in a shipped build — the same rule the hub's own test method follows.
   */
  testDoor?: boolean
}

export function startMcpServer(options: McpOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer((request, response) => void answer(request, response, options))
    const refuse = (error: Error) => reject(error)
    listener.once('error', refuse)
    // Loopback only: the address is what keeps the network out. Nothing on
    // this Mac is kept out, because nothing here could be — a program running
    // as this person reads whatever a secret would be kept in.
    listener.listen(options.port, '127.0.0.1', () => {
      listener.off('error', refuse)
      // Past this point there is no promise left to reject, so a failure that
      // would otherwise be swallowed by a settled callback is printed instead.
      listener.on('error', (error) => console.error('the MCP endpoint failed:', error))
      server = listener
      sweeper = setInterval(forgetTheQuiet, 60_000)
      sweeper.unref?.()
      resolve(options.port)
    })
  })
}

export function stopMcpServer(): void {
  if (sweeper) clearInterval(sweeper)
  sweeper = null
  for (const session of [...sessions.values()]) session.close()
  sessions.clear()
  server?.close()
  server = null
}

/**
 * A session nobody has spoken for in ten minutes is gone.
 *
 * A client that says it is leaving is answered at once; one that is simply shut
 * down says nothing at all, and then looks exactly like an agent that is
 * thinking. Silence is the only signal left, so tabs wait ten minutes rather
 * than the instant a closing socket used to give us.
 */
function forgetTheQuiet(): void {
  const now = Date.now()
  for (const session of [...sessions.values()]) {
    if (now - session.lastSeen < FORGET_AFTER_MS) continue
    // A scenario that waits for the person to sign in runs for ten minutes by
    // default, exactly as long as this sweep waits. Sweeping it would release
    // every lease it holds and schedule its tab for closing while the person
    // is still typing, so a session with a call in flight is not quiet.
    if (session.busy) continue
    session.close()
  }
}

async function answer(request: IncomingMessage, response: ServerResponse, options: McpOptions): Promise<void> {
  // Any request at all says the client is still there. Only `tools/call` used to
  // say it, so a client doing exactly what the specification suggests for
  // liveness — a `ping` every minute — was swept anyway.
  for (const session of ours(request)) session.lastSeen = Date.now()
  // The client saying it is done. The specification's own way to end a session,
  // and the only one that closes an agent's tabs without a ten-minute wait.
  if (request.method === 'DELETE') {
    for (const session of ours(request)) session.close()
    response.writeHead(204).end()
    return
  }
  if (request.method !== 'POST') {
    // The specification allows a server to offer an event stream on GET and
    // this one does not, so the honest answer is that the method is not here.
    response.writeHead(405, { allow: 'POST, DELETE' }).end()
    return
  }

  const message = await read(request)
  if (!message) {
    response.writeHead(400).end()
    return
  }
  const { id, method } = message
  if (id === undefined) {
    // A notification. Nothing to answer, and nothing to say about it.
    response.writeHead(202).end()
    return
  }

  if (method === 'initialize') {
    reply(response, id, {
      protocolVersion: MCP_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: options.version },
      instructions: INSTRUCTIONS,
    }, randomUUID())
    return
  }
  if (method === 'ping') return void reply(response, id, {})
  if (method === 'tools/list') return void reply(response, id, { tools: TOOLS })
  if (method === 'resources/list') return void reply(response, id, { resources: [] })
  if (method === 'prompts/list') return void reply(response, id, { prompts: [] })
  if (method === 'tools/call') return void (await callTool(request, response, message, options))
  if (options.testDoor && (method === 'naoba/call' || method === 'naoba/events' || method === 'naoba/fault')) {
    return void (await testDoor(request, response, message, options))
  }

  fail(response, id, -32601, `unknown method ${method}`)
}

async function callTool(
  request: IncomingMessage,
  response: ServerResponse,
  message: Rpc,
  options: McpOptions,
): Promise<void> {
  const id = message.id as number | string
  const name = message.params?.name
  const args = message.params?.arguments ?? {}

  if (name === 'begin') {
    const chosen = typeof args.session_name === 'string' ? args.session_name.trim() : ''
    if (!chosen) {
      return void reply(response, id, {
        isError: true,
        content: [{
          type: 'text',
          text: 'begin needs a session_name — a few words about what this session is doing, as in ' +
            'begin({ session_name: "rewriting the checkout tests", dir: "/Users/you/code/thing" }). The other ' +
            'sessions in this project are listed under theirs, and so will this one be.',
        }],
      })
    }
    const project = typeof args.absolute_project_path === 'string' ? args.absolute_project_path.trim() : ''
    if (!project) {
      return void reply(response, id, {
        isError: true,
        content: [{
          type: 'text',
          text: 'begin needs the project this session is working in: absolute_project_path, as in ' +
            'begin({ session_name: "...", absolute_project_path: "/Users/you/code/thing" }). It is what ' +
            'decides whose browser you get, so sessions in two projects never share one.',
        }],
      })
    }
    // A client that keeps one MCP session while its working directory changes,
    // or shares one client across two workspaces, says a different `dir` the
    // second time. It gets the other project's browser, never the first one's
    // under the second one's name — that is the one promise this application
    // makes, and it outranks keeping a session alive.
    const carried = sessionOf(request)
    if (carried && carried.project !== project) carried.close()
    const started = carried && carried.project === project
      ? carried
      : opened(request, response, id, project, options)
    if (!started) return
    try {
      await started.greet(chosen)
      const picture = await started.call('begin', { url: args.url })
      return void reply(response, id, { content: [{ type: 'text', text: JSON.stringify(picture, null, 2) }] })
    } catch (error) {
      return void reply(response, id, { isError: true, content: [{ type: 'text', text: renderError(error) }] })
    } finally {
      started.lastSeen = Date.now()
    }
  }

  const session = sessionOf(request)
  if (!session) {
    return void reply(response, id, {
      isError: true,
      content: [{
        type: 'text',
        text: 'begin has not been called yet, so this project\'s window does not know who you are. Call ' +
          'begin({ session_name: "...", absolute_project_path: "..." }) first — a few words about what this ' +
          'session is doing, and the absolute path of the project it works in. It opens your tab and answers ' +
          'with that tab and the other sessions working here.',
      }],
    })
  }

  try {
    if (name === 'evalInBrowser') {
      const outcome = await session.call('eval', { code: args.code, timeout: args.timeout })
      return void reply(response, id, { content: [{ type: 'text', text: renderOutcome(outcome) }] })
    }
    if (name === 'status') {
      const status = await session.call('status', {})
      return void reply(response, id, { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] })
    }
    fail(response, id, -32602, `unknown tool ${name}`)
  } catch (error) {
    // A tool's failure belongs in the result, not in the protocol: the agent
    // has to read it and decide what to do next, and a JSON-RPC error would
    // hide it from the model that has to act on it.
    reply(response, id, { isError: true, content: [{ type: 'text', text: renderError(error) }] })
  } finally {
    // Stamped again on the way out: a scenario that ran for a quarter of an
    // hour would otherwise be swept the moment it stopped being busy.
    session.lastSeen = Date.now()
  }
}

/** The tests' way in: the hub's own calls, and the events nothing else can be sent. */
async function testDoor(
  request: IncomingMessage,
  response: ServerResponse,
  message: Rpc,
  options: McpOptions,
): Promise<void> {
  const id = message.id as number | string
  const session = sessionOf(request)
  if (!session) return void fail(response, id, -32002, 'this session has not called begin')
  if (message.method === 'naoba/fault') {
    // Make the main process throw where nothing can catch it, so a test can
    // prove that a fault is recorded rather than put on screen. Only a test run
    // reaches this — the whole door is shut in a shipped build — and the throw
    // is deliberately out of this call stack, because an exception a caller
    // could catch is not the case being tested.
    const asked = (message.params ?? {}) as Record<string, unknown>
    const said = String(asked.message ?? 'a fault nobody asked for')
    const kind = asked.kind === 'rejection' ? 'rejection' : 'exception'
    setTimeout(() => {
      if (kind === 'rejection') void Promise.reject(new Error(said))
      else throw new Error(said)
    }, 0)
    return void reply(response, id, { thrown: said, kind })
  }
  if (message.method === 'naoba/events') {
    // Drained, not read: the caller is polling, and leaving them behind would
    // hand the same event back on every poll.
    const events = session.events.splice(0, session.events.length)
    return void reply(response, id, { events })
  }
  try {
    const value = await session.call(String(message.params?.method), message.params?.params)
    reply(response, id, { value })
  } catch (error) {
    const known = error as { message?: string; code?: string; details?: unknown }
    fail(response, id, -32000, String(known.message ?? error), { code: known.code, details: known.details })
  } finally {
    session.lastSeen = Date.now()
  }
}

/**
 * The session this request belongs to, or an answer saying why there is none.
 *
 * Keyed by the session header the client echoes back, and by the project when
 * there is none — a client that ignores the header still gets one browser per
 * project rather than a new agent on every call.
 */
/**
 * The session this request speaks for, if `begin` has already made one.
 *
 * `initialize` mints the session id and the specification has the client echo
 * it on every request after that. It is the whole identity of an agent here:
 * one id, one agent, one project, and nothing a second agent in the same
 * repository can be confused with.
 */
function sessionOf(request: IncomingMessage): Session | null {
  const sessionId = header(request, 'mcp-session-id')
  if (!sessionId) return null
  const known = sessions.get(sessionId)
  if (known) known.lastSeen = Date.now()
  return known ?? null
}

/**
 * The session `begin` is asking for, or an answer saying why there is none.
 *
 * The project arrives here as an argument rather than in a header. A header
 * would have to be written once and be right for every project afterwards,
 * which is what `${PWD}` was for — and a client that does not expand it sends
 * the four characters instead, which no check can repair. The session knows
 * which project it is in, so it says so, and nothing here second-guesses it.
 */
function opened(
  request: IncomingMessage,
  response: ServerResponse,
  id: number | string,
  project: string,
  options: McpOptions,
): Session | null {
  const sessionId = header(request, 'mcp-session-id')
  if (!sessionId) {
    reply(response, id, {
      isError: true,
      content: [{
        type: 'text',
        text: 'This request carried no Mcp-Session-Id. Naoba hands one out in its answer to initialize, and ' +
          'every request after that has to echo it — it is what tells two agents in one repository apart.',
      }],
    })
    return null
  }
  const complaint = unusable(project)
  if (complaint) {
    reply(response, id, { isError: true, content: [{ type: 'text', text: complaint }] })
    return null
  }
  const ide = header(request, 'x-ide') ?? 'agent'
  const fresh = new Session(
    nextConnectionId++,
    sessionId,
    project,
    ide,
    `${ide} · ${basename(project)}`,
    options.testDoor === true,
  )
  sessions.set(sessionId, fresh)
  options.join(fresh)
  return fresh
}

/** The sessions this request speaks for — none before `begin`, one after it. */
function ours(request: IncomingMessage): Session[] {
  const known = sessionOf(request)
  return known ? [known] : []
}

/**
 * Why this cannot be a project, if it cannot.
 *
 * Whether the project is the right one is the session's business, not ours —
 * it says where it is working and is believed. What is checked is the one
 * thing the rest of the application cannot work around: the path has to be
 * absolute. It is the directory a file an agent hands to a page is read from,
 * and a relative path there would be resolved against the browser's own
 * working directory, which means nothing to anybody.
 */
function unusable(project: string): string | null {
  if (project.startsWith('/')) return null
  return `Naoba was told this session works in “${project}”, which is not an absolute path. Nothing expands or ` +
    'resolves it on the way here, so a relative path and a shell expression are both just text: pass the full ' +
    'path from the root, as in begin({ absolute_project_path: "/Users/you/code/thing" }).'
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function read(request: IncomingMessage): Promise<Rpc | null> {
  return new Promise((resolve) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (body += chunk))
    request.on('end', () => {
      try {
        resolve(JSON.parse(body) as Rpc)
      } catch {
        resolve(null)
      }
    })
    request.on('error', () => resolve(null))
  })
}

function reply(response: ServerResponse, id: number | string, result: unknown, sessionKey?: string): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (sessionKey) headers['mcp-session-id'] = sessionKey
  response.writeHead(200, headers)
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

function fail(response: ServerResponse, id: number | string, code: number, message: string, data?: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } }))
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}
