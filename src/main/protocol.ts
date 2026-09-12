/**
 * The wire between an agent's bridge and the application.
 *
 * Both ends are Node processes, so there is no WebSocket here: a plain TCP
 * connection on the loopback interface carrying newline-delimited JSON does the
 * same job with no dependency and no handshake to get wrong. FoxCode needed a
 * WebSocket only because its client was a browser extension.
 *
 * The first message of a connection carries the token the application wrote
 * into its state directory at startup; a connection that shows anything else is
 * closed before the hub ever hears of it.
 */
export const PROTOCOL_VERSION = 1

/** First port tried; the app walks up this range when one is taken. */
export const DEFAULT_PORT = 8899
export const PORT_RANGE = 12

export interface AgentDescriptor {
  /** What the person sees in the agent list, e.g. "claude · checkout". */
  label: string
  /** Which IDE launched the bridge, when it says. */
  ide: string
  pid: number
}

export interface ProjectDescriptor {
  id: string
  name: string
  root: string
}

export interface TabDescriptor {
  id: string
  index: number
  title: string
  url: string
  active: boolean
  loading: boolean
  /** Who holds this tab right now, if anybody. */
  heldBy: string | null
  /** Set while the tab is waiting for the person to finish something. */
  waitingForHuman: string | null
  /** The label of the agent doing the waiting, so the panel can say who asks. */
  askedBy: string | null
  /** The agent that opened the tab, or `null` when the person did. */
  openedBy: string | null
}

/**
 * One thing an actor did in a tab.
 *
 * This never rides on `TabDescriptor`: that type goes to every agent on
 * `tab-opened` and `tab-navigated`, and the tab list is re-sent on every title
 * change, so a history hung off it would cross the wire dozens of times a
 * minute to readers with no use for it. The panel gets it on its own channel.
 */
/** An agent as the panel draws it. */
export interface AgentRow {
  id: string
  label: string
  ide: string
  tabId: string | null
  /** Disconnected, but tabs of its own are still open under its name. */
  gone: boolean
}

export interface AgentCommand {
  at: number
  /** The agent that made the call, or `null` when the person did. */
  agentId: string | null
  agentLabel: string
  text: string
}

export type ClientMessage =
  | { type: 'hello'; id: number; protocol: number; projectDir: string; agent: AgentDescriptor; token: string }
  | { type: 'call'; id: number; method: string; params?: unknown }
  | { type: 'cancel'; id: number; target: number }
  | { type: 'bye'; id: number }

export type ServerMessage =
  | { type: 'welcome'; id: number; project: ProjectDescriptor; agentId: string; appVersion: string }
  | { type: 'denied'; id: number; reason: string }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; error: WireError }
  | { type: 'event'; event: AppEvent }

export interface WireError {
  message: string
  /** Machine-readable so a bridge can react without parsing prose. */
  code: ErrorCode
  details?: unknown
}

export type ErrorCode =
  | 'denied'
  | 'no-tab'
  | 'tab-held'
  | 'taken-over'
  | 'timeout'
  | 'script-error'
  | 'unknown-method'
  | 'bad-params'
  | 'project-gone'
  | 'internal'

export type AppEvent =
  | { type: 'tab-opened'; tab: TabDescriptor }
  | { type: 'tab-closed'; tabId: string }
  | { type: 'tab-navigated'; tab: TabDescriptor }
  | { type: 'tab-claimed'; tabId: string; holder: string }
  | { type: 'tab-released'; tabId: string; holder: string }
  | { type: 'tab-taken-over'; tabId: string; by: string }
  | { type: 'human-requested'; tabId: string; reason: string }
  | { type: 'human-done'; tabId: string }
  | { type: 'agent-joined'; agentId: string; label: string }
  | { type: 'agent-left'; agentId: string }

/** Split a byte stream into JSON lines. Returns parsed messages plus the unfinished tail. */
export function decodeLines(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = []
  let rest = buffer
  for (;;) {
    const at = rest.indexOf('\n')
    if (at < 0) break
    const line = rest.slice(0, at).trim()
    rest = rest.slice(at + 1)
    if (!line) continue
    try {
      messages.push(JSON.parse(line))
    } catch {
      messages.push({ type: 'malformed', line })
    }
  }
  return { messages, rest }
}

export function encodeMessage(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message) + '\n'
}
