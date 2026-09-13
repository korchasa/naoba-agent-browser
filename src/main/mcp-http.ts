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
  #greeted = false
  #nextId = 1
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  #onMessage: ((message: ClientMessage) => void) | null = null
  #onClose: (() => void) | null = null

  constructor(
    id: number,
    readonly key: string,
    readonly projectDir: string,
    readonly ide: string,
    readonly label: string,
    readonly keepEvents: boolean,
  ) {
    this.id = id
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
    sessions.delete(this.key)
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
   * Say who this agent is, once, the first time it wants a browser.
   *
   * There is no token here: the hub is being handed a session the endpoint
   * already admitted, and admitting it is what the token did.
   */
  async greet(): Promise<void> {
    if (this.#greeted) return
    await this.#ask((id) => ({
      type: 'hello',
      id,
      projectDir: this.projectDir,
      agent: { label: this.label, ide: this.ide, pid: 0 },
    }))
    this.#greeted = true
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
  token: string
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
    listener.on('error', reject)
    // Loopback only. The token is what keeps the other programs on this machine
    // out; the address is what keeps the network out.
    listener.listen(options.port, '127.0.0.1', () => {
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
    session.close()
  }
}

async function answer(request: IncomingMessage, response: ServerResponse, options: McpOptions): Promise<void> {
  if (!presents(request, options.token)) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'this request did not carry the token this copy of Naoba was started with' }))
    return
  }
  // The client saying it is done. The specification's own way to end a session,
  // and the only one that closes an agent's tabs without a ten-minute wait.
  if (request.method === 'DELETE') {
    const key = header(request, 'mcp-session-id')
    if (key) sessions.get(key)?.close()
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
  if (options.testDoor && (method === 'naoba/call' || method === 'naoba/events')) {
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
  const session = admitted(request, response, id, options)
  if (!session) return

  try {
    await session.greet()
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
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
  const session = admitted(request, response, id, options)
  if (!session) return
  if (message.method === 'naoba/events') {
    // Drained, not read: the caller is polling, and leaving them behind would
    // hand the same event back on every poll.
    const events = session.events.splice(0, session.events.length)
    return void reply(response, id, { events })
  }
  try {
    await session.greet()
    const value = await session.call(String(message.params?.method), message.params?.params)
    reply(response, id, { value })
  } catch (error) {
    const known = error as { message?: string; code?: string; details?: unknown }
    fail(response, id, -32000, String(known.message ?? error), { code: known.code, details: known.details })
  }
}

/**
 * The session this request belongs to, or an answer saying why there is none.
 *
 * Keyed by the session header the client echoes back, and by the project when
 * there is none — a client that ignores the header still gets one browser per
 * project rather than a new agent on every call.
 */
function admitted(
  request: IncomingMessage,
  response: ServerResponse,
  id: number | string,
  options: McpOptions,
): Session | null {
  const projectDir = header(request, 'x-project')
  if (!projectDir) {
    // Not a protocol error: the person has to read this and change a file, so
    // it goes where they will see it — in the agent's own hands.
    reply(response, id, {
      isError: true,
      content: [{
        type: 'text',
        text: 'Naoba does not know which project this agent is working in. The MCP entry for naoba needs a ' +
          'header: "headers": { "X-Project": "${PWD}" }. Naoba\'s settings window prints the whole line to paste.',
      }],
    })
    return null
  }

  const key = header(request, 'mcp-session-id') ?? `project:${projectDir}`
  const known = sessions.get(key)
  if (known) {
    known.lastSeen = Date.now()
    return known
  }
  const ide = header(request, 'x-ide') ?? 'agent'
  const fresh = new Session(
    nextConnectionId++,
    key,
    projectDir,
    ide,
    // `X-Agent` is for somebody running two agents in one project who wants to
    // tell them apart in the panel. Most clients send nothing, and the project
    // they are working in is the useful half of the name anyway.
    header(request, 'x-agent') ?? `${ide} · ${basename(projectDir)}`,
    options.testDoor === true,
  )
  sessions.set(key, fresh)
  options.join(fresh)
  return fresh
}

function presents(request: IncomingMessage, token: string): boolean {
  const shown = header(request, 'authorization')?.replace(/^Bearer\s+/i, '')
  return shown === token
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
