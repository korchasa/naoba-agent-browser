import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import {
  type ClientMessage,
  decodeLines,
  DEFAULT_PORT,
  encodeMessage,
  PORT_RANGE,
  type ServerMessage,
} from './protocol.ts'

export interface Connection {
  readonly id: number
  send(message: ServerMessage): void
  close(): void
  onMessage(handler: (message: ClientMessage) => void): void
  onClose(handler: () => void): void
}

/** How long a connection that has not shown the token may stay open. */
const HANDSHAKE_DEADLINE_MS = 10_000

/**
 * The application listens; every agent's bridge dials in. FoxCode had this the
 * other way round — a server per agent session, and a browser holding N
 * connections — which is why it needed a port file and a reconnect ladder. One
 * listener needs neither.
 *
 * Loopback only, and a token on top of it: nothing on the network can reach a
 * browser holding the owner's logged-in sessions, and nothing on this machine
 * can either unless it can read the token out of the state directory. The token
 * is new on every start, so a copy of it from a previous run is worth nothing.
 */
export class BridgeServer {
  #server: Server | null = null
  #port = 0
  #nextId = 1
  readonly #token = randomBytes(32).toString('hex')

  readonly #onConnection: (connection: Connection) => void

  constructor(onConnection: (connection: Connection) => void) {
    this.#onConnection = onConnection
  }

  get port(): number {
    return this.#port
  }

  /** What a bridge must present on its first message. Written to disk once the port is known. */
  get token(): string {
    return this.#token
  }

  async listen(preferred = DEFAULT_PORT): Promise<number> {
    for (let offset = 0; offset < PORT_RANGE; offset++) {
      const port = preferred + offset
      try {
        this.#port = await this.#bind(port)
        return this.#port
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      }
    }
    throw new Error(`no free port in ${preferred}–${preferred + PORT_RANGE - 1}; another copy may already be listening`)
  }

  #bind(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.#accept(socket))
      server.once('error', (error) => {
        server.close()
        reject(error)
      })
      server.listen(port, '127.0.0.1', () => {
        this.#server = server
        resolve(port)
      })
    })
  }

  #accept(socket: Socket): void {
    socket.setNoDelay(true)
    socket.setEncoding('utf8')

    const id = this.#nextId++
    let buffer = ''
    let onMessage: ((message: ClientMessage) => void) | null = null
    let onClose: (() => void) | null = null

    // Nothing above this line knows the connection exists: the hub is told
    // about it only once the token has been shown, so an unadmitted peer
    // cannot reach a project, a tab or a cookie.
    let admitted = false
    const deadline = setTimeout(() => socket.destroy(), HANDSHAKE_DEADLINE_MS)
    deadline.unref?.()

    const connection: Connection = {
      id,
      send(message) {
        if (socket.destroyed) return
        socket.write(encodeMessage(message))
      },
      close() {
        socket.end()
      },
      onMessage(handler) {
        onMessage = handler
      },
      onClose(handler) {
        onClose = handler
      },
    }

    socket.on('data', (chunk: string) => {
      buffer += chunk
      const { messages, rest } = decodeLines(buffer)
      buffer = rest
      for (const message of messages) {
        if (!admitted) {
          if (!this.#presentsToken(message)) {
            socket.write(encodeMessage({
              type: 'denied',
              id: idOf(message),
              code: 'bad-token',
              // Not a word about the bridge's version, which is what this used
              // to say: a bridge of the right version reaches this line every
              // time it picks the wrong copy's token, and several copies of the
              // application can be installed at once.
              reason: 'this token is not this copy of Naoba; it may belong to a copy that is no longer running',
            }))
            socket.end()
            return
          }
          admitted = true
          clearTimeout(deadline)
          this.#onConnection(connection)
        }
        onMessage?.(message as ClientMessage)
      }
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(deadline)
      if (admitted) onClose?.()
    })
  }

  /** Constant-time, and never compares buffers of different length — `timingSafeEqual` throws on that. */
  #presentsToken(message: unknown): boolean {
    const shown = (message as { token?: unknown } | null)?.token
    if (typeof shown !== 'string') return false
    const a = Buffer.from(shown)
    const b = Buffer.from(this.#token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  close(): void {
    this.#server?.close()
    this.#server = null
  }
}

function idOf(message: unknown): number {
  const id = (message as { id?: unknown } | null)?.id
  return typeof id === 'number' ? id : 0
}
