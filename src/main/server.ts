import { createServer, type Server, type Socket } from 'node:net'
import { DEFAULT_PORT, PORT_RANGE, decodeLines, encodeMessage, type ClientMessage, type ServerMessage } from './protocol.ts'

export interface Connection {
  readonly id: number
  send(message: ServerMessage): void
  close(): void
  onMessage(handler: (message: ClientMessage) => void): void
  onClose(handler: () => void): void
}

/**
 * The application listens; every agent's bridge dials in. FoxCode had this the
 * other way round — a server per agent session, and a browser holding N
 * connections — which is why it needed a port file, a password file and a
 * reconnect ladder. One listener needs none of that.
 *
 * Loopback only: nothing on the network can reach a browser holding the
 * owner's logged-in sessions.
 */
export class BridgeServer {
  #server: Server | null = null
  #port = 0
  #nextId = 1

  readonly #onConnection: (connection: Connection) => void

  constructor(onConnection: (connection: Connection) => void) {
    this.#onConnection = onConnection
  }

  get port(): number {
    return this.#port
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
      for (const message of messages) onMessage?.(message as ClientMessage)
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => onClose?.())

    this.#onConnection(connection)
  }

  close(): void {
    this.#server?.close()
    this.#server = null
  }
}
