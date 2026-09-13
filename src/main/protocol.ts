/**
 * The seam between an MCP session and the hub.
 *
 * These messages used to cross a socket: a relay process spoke MCP to the IDE
 * and this protocol to the application. The application answers MCP itself now,
 * so nothing here is serialised and nothing here is a wire — but the shapes
 * stayed, because the hub is written against them and a session is easier to
 * reason about as something that sends messages than as a pile of callbacks.
 *
 * `Connection` is what a session looks like to the hub. Whatever carried it —
 * a socket once, an HTTP request now — the hub cannot tell the difference, and
 * that is what let the transport change without touching the routing.
 */

export interface Connection {
  readonly id: number
  send(message: ServerMessage): void
  close(): void
  onMessage(handler: (message: ClientMessage) => void): void
  onClose(handler: () => void): void
}

export interface AgentDescriptor {
  /** What the person sees in the agent list, e.g. "claude · checkout". */
  label: string
  /** Which IDE the agent is working in, when it says. */
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
  | { type: 'hello'; id: number; projectDir: string; agent: AgentDescriptor }
  | { type: 'call'; id: number; method: string; params?: unknown }
  | { type: 'cancel'; id: number; target: number }
  | { type: 'bye'; id: number }

export type ServerMessage =
  | { type: 'welcome'; id: number; project: ProjectDescriptor; agentId: string; appVersion: string }
  | { type: 'denied'; id: number; reason: string; code?: DenialCode }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; error: WireError }
  | { type: 'event'; event: AppEvent }

/**
 * Why a session was turned away, for a caller that has to decide what to do
 * next rather than print prose.
 */
export type DenialCode = 'unlicensed' | 'project-refused'

export interface WireError {
  message: string
  /** Machine-readable, so a caller can react without parsing prose. */
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
