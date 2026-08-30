/**
 * Commands against one tab run one at a time. Two agents in a project are meant
 * to help each other, and interleaving their actions on the same page is the
 * fastest way to make that impossible: agent A's `fill` landing between agent
 * B's `click` and its `waitForLoad` produces a failure neither of them caused.
 */
export interface QueueOptions {
  /** How long a task may wait for its turn before it is rejected. */
  waitMs?: number
  /** How long the task itself may run once started. */
  runMs?: number
  /** Shown in the timeout message so the loser knows who was holding the tab. */
  label?: string
}

interface Waiter {
  readonly label: string
  readonly enqueuedAt: number
}

export class QueueTimeout extends Error {
  readonly kind: 'wait' | 'run'

  constructor(message: string, kind: 'wait' | 'run') {
    super(message)
    this.name = 'QueueTimeout'
    this.kind = kind
  }
}

export class KeyedQueue {
  readonly #tails = new Map<string, Promise<unknown>>()
  readonly #waiting = new Map<string, Waiter[]>()
  #running = new Map<string, string>()
  #lastRunner = new Map<string, string>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** Who is executing against `key` right now, by label. */
  runningLabel(key: string): string | null {
    return this.#running.get(key) ?? null
  }

  depth(key: string): number {
    return this.#waiting.get(key)?.length ?? 0
  }

  run<T>(key: string, task: () => Promise<T>, options: QueueOptions = {}): Promise<T> {
    const label = options.label ?? 'agent'
    const waiter: Waiter = { label, enqueuedAt: this.#now() }
    const queue = this.#waiting.get(key) ?? []
    queue.push(waiter)
    this.#waiting.set(key, queue)

    const previous = this.#tails.get(key) ?? Promise.resolve()
    const result = previous.then(
      () => this.#execute(key, waiter, task, options),
      () => this.#execute(key, waiter, task, options),
    )
    // The tail must never reject, or the next task inherits a rejected promise.
    this.#tails.set(key, result.then(() => undefined, () => undefined))
    return result
  }

  async #execute<T>(key: string, waiter: Waiter, task: () => Promise<T>, options: QueueOptions): Promise<T> {
    const queue = this.#waiting.get(key)
    if (queue) {
      const at = queue.indexOf(waiter)
      if (at >= 0) queue.splice(at, 1)
      if (queue.length === 0) this.#waiting.delete(key)
    }

    const waited = this.#now() - waiter.enqueuedAt
    if (options.waitMs !== undefined && waited > options.waitMs) {
      // Name whoever was in the way even if they have just finished: "the tab
      // was busy" tells the agent nothing it can act on, and by the time a
      // waiter times out the holder has often let go.
      const holder = this.#running.get(key) ?? this.#lastRunner.get(key)
      throw new QueueTimeout(
        `waited ${waited}ms for tab ${key}${holder ? `, held by ${holder}` : ''}`,
        'wait',
      )
    }

    this.#running.set(key, waiter.label)
    this.#lastRunner.set(key, waiter.label)
    try {
      if (options.runMs === undefined) return await task()
      return await withDeadline(task(), options.runMs, `tab ${key} busy for over ${options.runMs}ms`)
    } finally {
      if (this.#running.get(key) === waiter.label) this.#running.delete(key)
    }
  }
}

export function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new QueueTimeout(message, 'run')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
