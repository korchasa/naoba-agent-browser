import type { AgentCommand } from './protocol.ts'

/**
 * What has been done in one tab, newest first.
 *
 * The history is per tab rather than per project on purpose: a project-wide
 * buffer lets a busy tab push a quiet one's whole history out, and the quiet
 * tab is exactly the one somebody scrolls back to when they want to know what
 * an agent did there half an hour ago.
 */
export class CommandLog {
  readonly #entries: AgentCommand[] = []
  readonly #limit: number

  constructor(limit = 100) {
    this.#limit = Math.max(1, limit)
  }

  get entries(): readonly AgentCommand[] {
    return this.#entries
  }

  add(command: AgentCommand): void {
    this.#entries.unshift(command)
    if (this.#entries.length > this.#limit) this.#entries.length = this.#limit
  }

  clear(): void {
    this.#entries.length = 0
  }
}
