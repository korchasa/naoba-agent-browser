import { connect } from 'node:net'

export const PROTOCOL_VERSION = 1
export const DEFAULT_PORT = 8899
export const PORT_RANGE = 12

/**
 * The agent side of the wire. One TCP connection carrying newline-delimited
 * JSON, with a promise per call — the whole transport, because both ends are
 * Node processes and neither needs a WebSocket to talk to the other.
 */
export class AppClient {
  #socket = null
  #buffer = ''
  #nextId = 1
  #pending = new Map()
  #eventHandlers = new Set()
  #closed = false

  constructor({ onEvent } = {}) {
    if (onEvent) this.#eventHandlers.add(onEvent)
  }

  get connected() {
    return this.#socket !== null && !this.#closed
  }

  /** Try each port in the range and stop at the first that answers our handshake. */
  static async findPort({ from = DEFAULT_PORT, range = PORT_RANGE } = {}) {
    for (let offset = 0; offset < range; offset++) {
      const port = from + offset
      if (await canConnect(port)) return port
    }
    return null
  }

  async connect(port) {
    // `findPort` answers null when nothing is listening, and passing that
    // straight to node gives ERR_INVALID_ARG_TYPE about `options.port` — an
    // error about an argument, when the fact is that the browser is not up.
    if (port === null || port === undefined) {
      throw new Error(
        'Naoba is not running: nothing is listening on its port range. Start the application and try again.',
      )
    }
    await new Promise((resolve, reject) => {
      const socket = connect({ port, host: '127.0.0.1' }, () => {
        socket.setNoDelay(true)
        socket.setEncoding('utf8')
        this.#socket = socket
        resolve()
      })
      socket.once('error', reject)
    })

    this.#socket.on('data', (chunk) => this.#onData(chunk))
    // A connection can end badly as well as politely — the application killed
    // mid-write gives a reset, not a clean close. Without a listener here Node
    // turns that into an uncaught exception and the bridge dies with it, which
    // an IDE reads as "the browser is gone" rather than "reconnect".
    this.#socket.on('error', () => {
      this.#closed = true
    })
    this.#socket.on('close', () => {
      this.#closed = true
      for (const [, pending] of this.#pending) {
        pending.reject(new Error('the browser closed the connection'))
      }
      this.#pending.clear()
    })
  }

  #onData(chunk) {
    this.#buffer += chunk
    for (;;) {
      const at = this.#buffer.indexOf('\n')
      if (at < 0) break
      const line = this.#buffer.slice(0, at).trim()
      this.#buffer = this.#buffer.slice(at + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.#onMessage(message)
    }
  }

  #onMessage(message) {
    if (message.type === 'event') {
      for (const handler of this.#eventHandlers) handler(message.event)
      return
    }
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)
    if (message.type === 'result') pending.resolve(message.value)
    else if (message.type === 'welcome') pending.resolve(message)
    else if (message.type === 'denied') pending.reject(Object.assign(new Error(message.reason), { code: 'denied' }))
    else if (message.type === 'error') pending.reject(Object.assign(new Error(message.error.message), message.error))
  }

  #send(message) {
    if (!this.#socket || this.#closed) throw new Error('not connected to the browser')
    this.#socket.write(JSON.stringify(message) + '\n')
  }

  #request(message) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#send({ ...message, id })
    })
  }

  hello(projectDir, agent) {
    return this.#request({ type: 'hello', protocol: PROTOCOL_VERSION, projectDir, agent })
  }

  call(method, params) {
    return this.#request({ type: 'call', method, params })
  }

  onEvent(handler) {
    this.#eventHandlers.add(handler)
    return () => this.#eventHandlers.delete(handler)
  }

  close() {
    this.#closed = true
    this.#socket?.end()
    this.#socket = null
  }
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.setTimeout(400, () => {
      socket.destroy()
      resolve(false)
    })
  })
}
