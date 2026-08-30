import { createContext, Script } from 'node:vm'
import type { AgentApi } from './api.ts'
import { withDeadline } from './queue.ts'
import { toTransferable } from './serialize.ts'

export interface ScriptOutcome {
  value: unknown
  logs: string[]
}

export class ScriptError extends Error {
  readonly detail: { stack: string | null; logs: string[] }

  constructor(message: string, detail: { stack: string | null; logs: string[] }) {
    super(message)
    this.name = 'ScriptError'
    this.detail = detail
  }
}

/**
 * Run an agent's script.
 *
 * The script gets `api` and little else. This is not a security boundary — the
 * agent already runs on this machine — but a clarity one: a script that reaches
 * for `require` or `process` is doing something the browser cannot do for it,
 * and failing loudly beats half-working.
 */
export async function runScript(code: string, api: AgentApi, timeoutMs: number): Promise<ScriptOutcome> {
  const logs: string[] = []
  const record = (level: string) => (...args: unknown[]) => {
    logs.push(`${level}: ${args.map(render).join(' ')}`)
    if (logs.length > 500) logs.splice(0, logs.length - 500)
  }

  const sandbox = {
    api,
    console: {
      log: record('log'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    atob,
    btoa,
  }

  const context = createContext(sandbox, { name: 'agent-script' })
  let factory: (api: AgentApi) => Promise<unknown>
  try {
    const script = new Script(`(async (api) => {\n${code}\n})`, { filename: 'agent-script.js' })
    factory = script.runInContext(context) as typeof factory
  } catch (error) {
    throw new ScriptError(`the script did not compile: ${messageOf(error)}`, { stack: stackOf(error), logs })
  }

  try {
    const value = await withDeadline(
      Promise.resolve(factory(api)),
      timeoutMs,
      `the script ran longer than ${timeoutMs}ms`,
    )
    return { value: toTransferable(value), logs }
  } catch (error) {
    const err = error as { code?: string; message?: string }
    const failure = new ScriptError(messageOf(error), { stack: stackOf(error), logs })
    if (err.code) Object.assign(failure, { code: err.code })
    throw failure
  }
}

function render(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(toTransferable(value))
  } catch {
    return String(value)
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function stackOf(error: unknown): string | null {
  if (!(error instanceof Error) || !error.stack) return null
  // The agent cares about its own script, not about this file's frames.
  return error.stack.split('\n').slice(0, 6).join('\n')
}
