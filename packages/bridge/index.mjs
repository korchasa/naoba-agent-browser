#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { AppClient, DEFAULT_PORT, PORT_RANGE } from './client.mjs'
import { launchApp } from './launch.mjs'
import { TOOLS } from './tools.mjs'

/**
 * The bridge an IDE launches as its MCP server.
 *
 * It holds no browser state of its own: it finds the application, says which
 * project it is speaking for, and forwards calls. Every agent gets its own
 * bridge process; they all reach one application, and the application decides
 * what each of them may see.
 */
const PROTOCOL = '2025-06-18'
const NAME = 'agent-browser'
const VERSION = '0.1.0'

const projectDir = process.env.AGENT_BROWSER_PROJECT_DIR || process.cwd()
const agent = {
  label: process.env.AGENT_BROWSER_LABEL || `${ideName()} · ${basename(projectDir)}`,
  ide: ideName(),
  pid: process.pid,
}

let client = null
let connecting = null

async function ensureConnected() {
  if (client?.connected) return client
  if (connecting) return connecting
  connecting = (async () => {
    let port = await AppClient.findPort()
    if (port === null) {
      await launchApp()
      port = await waitForPort(20_000)
      if (port === null) {
        throw new Error(
          `Agent Browser was started but nothing is listening on ${DEFAULT_PORT}–${
            DEFAULT_PORT + PORT_RANGE - 1
          } yet. ` +
            'Give it a moment and call again.',
        )
      }
    }
    const fresh = new AppClient()
    await fresh.connect(port)
    await fresh.hello(projectDir, agent)
    client = fresh
    return fresh
  })()
  try {
    return await connecting
  } finally {
    connecting = null
  }
}

async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const port = await AppClient.findPort()
    if (port !== null) return port
    await sleep(300)
  }
  return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function ideName() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return 'claude'
  if (process.env.CURSOR_TRACE_ID) return 'cursor'
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME) return 'codex'
  if (process.env.OPENCODE) return 'opencode'
  return process.env.TERM_PROGRAM || 'agent'
}

function basename(path) {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

// ------------------------------------------------------------------ JSON-RPC

const out = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const reply = (id, result) => out({ jsonrpc: '2.0', id, result })
const fail = (id, code, message, data) => out({ jsonrpc: '2.0', id, error: { code, message, data } })

async function handle(request) {
  const { id, method, params } = request

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
      instructions:
        'A browser shared by every agent working in this project, and closed to agents working in any other. ' +
        'Write a whole scenario in one evalInBrowser call rather than one call per action.',
    })
    return
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return
  if (method === 'ping') {
    reply(id, {})
    return
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    await callTool(id, params?.name, params?.arguments ?? {})
    return
  }
  if (method === 'resources/list') {
    reply(id, { resources: [] })
    return
  }
  if (method === 'prompts/list') {
    reply(id, { prompts: [] })
    return
  }
  if (id !== undefined) fail(id, -32601, `unknown method ${method}`)
}

async function callTool(id, name, args) {
  try {
    const connection = await ensureConnected()
    if (name === 'evalInBrowser') {
      const outcome = await connection.call('eval', { code: args.code, timeout: args.timeout })
      reply(id, { content: [{ type: 'text', text: renderOutcome(outcome) }] })
      return
    }
    if (name === 'status') {
      const status = await connection.call('status', {})
      reply(id, { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] })
      return
    }
    fail(id, -32602, `unknown tool ${name}`)
  } catch (error) {
    // A tool error belongs in the result, not in the protocol: the agent has to
    // read it and decide what to do, and a JSON-RPC error would hide it.
    reply(id, {
      isError: true,
      content: [{ type: 'text', text: renderError(error) }],
    })
  }
}

function renderOutcome(outcome) {
  const parts = []
  if (outcome?.logs?.length) parts.push(outcome.logs.join('\n'))
  const value = outcome?.value
  if (value === undefined || (value && value.$type === 'undefined')) parts.push('(the script returned nothing)')
  else parts.push(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  return parts.join('\n\n')
}

function renderError(error) {
  const lines = [error.message ?? String(error)]
  if (error.code) lines.unshift(`[${error.code}]`)
  const stack = error.details?.stack
  if (stack) lines.push('', stack)
  const logs = error.details?.logs
  if (logs?.length) lines.push('', 'console before the failure:', ...logs)
  return lines.join('\n')
}

/**
 * Calls in flight when stdin closes still have to finish: an IDE that stops
 * writing has not necessarily stopped listening, and cutting a scenario off
 * mid-navigation leaves the browser in a state nobody asked for.
 */
let inFlight = 0
let stdinClosed = false

function maybeExit() {
  if (!stdinClosed || inFlight > 0) return
  client?.close()
  process.exit(0)
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let request
  try {
    request = JSON.parse(text)
  } catch {
    return
  }
  inFlight++
  void handle(request)
    .catch((error) => {
      if (request.id !== undefined) fail(request.id, -32603, String(error?.message ?? error))
    })
    .finally(() => {
      inFlight--
      maybeExit()
    })
})
input.on('close', () => {
  stdinClosed = true
  // Give whatever is running a chance to answer before the process goes away.
  setTimeout(maybeExit, 0)
  setTimeout(() => {
    client?.close()
    process.exit(0)
  }, 120_000).unref()
})
