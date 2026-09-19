import { app, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildApi } from './api.ts'
import { type AgentHandle, ProjectContext } from './context.ts'
import { Shell, type ShellPaths } from './shell.ts'
import { identify, normalizeRoot, type ProjectIdentity } from './project.ts'
import type { AdmissionRecord } from './preferences.ts'
import { recent as recentFaults } from './faults.ts'
import {
  type ClientMessage,
  type Connection,
  type ErrorCode,
  type ProjectDescriptor,
  type ServerMessage,
} from './protocol.ts'
import { runScript, ScriptError } from './runner.ts'
import { pause } from './tab.ts'

export interface HubOptions extends ShellPaths {
  /** The port agents reach this copy on. Told, not discovered: the hub no longer listens itself. */
  port: number
  /** How long a project may sit with no agent and no interaction before its renderers are freed. */
  idleUnloadMs: number
  /** How long a departed agent's tabs stay open, in case its session comes back. */
  orphanCloseMs: number
  /** How long a call waits for a tab another agent is holding. */
  contentionWaitMs: number
  /** Ceiling on a single script's run time unless the caller asks for more. */
  defaultScriptTimeoutMs: number
  /** Skips the admission dialog. Used by the test harness, never in a shipped build. */
  admitEverything?: boolean
  /** Whether pages are told that a program drives the browser, at the start. */
  announceAutomation?: boolean
  /**
   * Whether this copy has been unlocked. An agent is refused while it has not
   * been: the browser is the product, and it is sold rather than given away.
   * Absent means yes, which is what the tests and the snapshot run want.
   */
  licensed?: () => boolean
}

/** How long the sessions get to reach disk before the quit stops waiting for them. */
const FLUSH_LIMIT_MS = 5_000

type Decision = 'allowed' | 'denied'

/**
 * Holds every project, admits the agents that ask to join one, and routes their
 * calls. This is where the product's central promise is enforced: a connection
 * announces a directory, that directory decides which context it gets, and
 * there is no call that reaches across contexts.
 */
export class Hub {
  readonly contexts = new Map<string, ProjectContext>()
  /** The one window, shared by every project. */
  readonly shell: Shell
  readonly #admissions = new Map<string, AdmissionRecord>()
  /** Told whenever the register changes, so an open settings window redraws it. */
  #onAdmissions: (() => void) | null = null
  readonly #agentsByConnection = new Map<number, { agentId: string; projectId: string }>()
  #idleTimer: NodeJS.Timeout | null = null
  #admissionInFlight: Promise<unknown> = Promise.resolve()
  #announceAutomation: boolean

  #options: HubOptions

  constructor(options: HubOptions) {
    this.#options = options
    this.#announceAutomation = options.announceAutomation ?? false
    this.shell = new Shell(options)
    // The tab in front changed: every project's rows say whether theirs is
    // the one, so every project is told to redraw.
    this.shell.onFrontChange(() => {
      for (const context of this.contexts.values()) context.notifyTabs()
    })
    this.#loadAdmissions()
  }

  /** Where agents reach this copy. The `status` call reports it back to them. */
  get port(): number {
    return this.#options.port
  }

  /** Whether pages are told that a program drives the browser. One switch for every project. */
  get announceAutomation(): boolean {
    return this.#announceAutomation
  }

  async setAnnounceAutomation(on: boolean): Promise<void> {
    this.#announceAutomation = on
    await Promise.all([...this.contexts.values()].map((context) => context.setAnnounceAutomation(on)))
  }

  get orphanCloseMs(): number {
    return this.#options.orphanCloseMs
  }

  /** One value for every project, the open ones included. */
  setOrphanCloseMs(ms: number): void {
    this.#options.orphanCloseMs = ms
    for (const context of this.contexts.values()) context.setOrphanCloseMs(ms)
  }

  /**
   * Take a session the MCP endpoint has already admitted.
   *
   * The hub does not care what carried it. A socket used to; an HTTP session
   * does now, and it wears the same shape.
   */
  join(connection: Connection): void {
    this.#onConnection(connection)
  }

  start(): void {
    this.#idleTimer = setInterval(() => this.#sweepIdle(), 60_000)
    this.#idleTimer.unref?.()
  }

  /** Write every project's session to disk, and never fail the shutdown for it. */
  async flushAll(): Promise<void> {
    const written = Promise.allSettled([...this.contexts.values()].map((context) => context.flush()))
    // Bounded, because the quit waits for this and an update waits for the
    // quit: Squirrel cannot put the new bundle in place while this process is
    // alive, so one flush that never settles would leave the application
    // neither updated nor complaining.
    await Promise.race([written, pause(FLUSH_LIMIT_MS)])
  }

  stop(): void {
    if (this.#idleTimer) clearInterval(this.#idleTimer)
  }

  /** The projects the panel lists, in the order they first connected. */
  projectRows(): ProjectDescriptor[] {
    return [...this.contexts.values()].map(({ identity }) => ({
      id: identity.id,
      name: identity.name,
      root: identity.root,
    }))
  }

  // -------------------------------------------------------------- admissions

  #admissionsFile(): string {
    return join(app.getPath('userData'), 'projects.json')
  }

  #loadAdmissions(): void {
    try {
      const raw = JSON.parse(readFileSync(this.#admissionsFile(), 'utf8')) as Record<string, AdmissionRecord>
      for (const [key, record] of Object.entries(raw)) this.#admissions.set(key, record)
    } catch {
      // First run, or a file we cannot read; either way there is nothing admitted yet.
    }
  }

  #saveAdmissions(): void {
    this.#onAdmissions?.()
    const out: Record<string, AdmissionRecord> = {}
    for (const [key, record] of this.#admissions) out[key] = record
    try {
      writeFileSync(this.#admissionsFile(), JSON.stringify(out, null, 2))
    } catch (error) {
      console.error('could not save the list of admitted projects:', error)
    }
  }

  admissions(): AdmissionRecord[] {
    return [...this.#admissions.values()]
  }

  /** The settings window lists this register; a new answer has to reach it. */
  onAdmissions(handler: () => void): void {
    this.#onAdmissions = handler
  }

  /**
   * Drop the answer, not the browser. A project already open keeps its tabs and
   * its session; what goes is the record, so the next agent working in that
   * directory is asked about again.
   */
  forget(root: string): void {
    this.#admissions.delete(normalizeRoot(root))
    this.#saveAdmissions()
  }

  /**
   * Ask about an unknown folder once, and remember the answer. Dialogs are
   * serialised: five agents starting at once in a fresh checkout must not
   * produce five stacked prompts about the same directory.
   */
  async #admit(identity: ProjectIdentity, agentLabel: string): Promise<Decision> {
    const key = normalizeRoot(identity.root)
    const known = this.#admissions.get(key)
    if (known) return known.decision
    if (this.#options.admitEverything) {
      this.#admissions.set(key, { decision: 'allowed', name: identity.name, root: identity.root, at: Date.now() })
      return 'allowed'
    }

    const ask = this.#admissionInFlight.then(async () => {
      const again = this.#admissions.get(key)
      if (again) return again.decision
      const answer = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Allow', 'Refuse'],
        defaultId: 0,
        cancelId: 1,
        title: 'A new project wants a browser',
        message: `Let agents working in “${identity.name}” open a browser?`,
        detail: `${agentLabel} is asking on behalf of:\n${identity.root}\n\n` +
          `This project gets its own cookies and its own logins. ` +
          `Nothing in it is visible to agents working in any other project.`,
      })
      const decision: Decision = answer.response === 0 ? 'allowed' : 'denied'
      this.#admissions.set(key, { decision, name: identity.name, root: identity.root, at: Date.now() })
      this.#saveAdmissions()
      return decision
    })
    this.#admissionInFlight = ask.catch(() => undefined)
    return ask
  }

  // ---------------------------------------------------------------- contexts

  contextFor(identity: ProjectIdentity): ProjectContext {
    const existing = this.contexts.get(identity.id)
    if (existing) return existing
    const created = new ProjectContext(identity, {
      shell: this.shell,
      orphanCloseMs: this.#options.orphanCloseMs,
      announceAutomation: this.#announceAutomation,
    })
    this.contexts.set(identity.id, created)
    this.shell.toChrome('projects', { projects: this.projectRows() })
    return created
  }

  #sweepIdle(): void {
    const now = Date.now()
    for (const context of this.contexts.values()) {
      if (!context.loaded) continue
      if (context.agents.size > 0) continue
      if (context.pendingHuman.size > 0) continue
      // A window the person is looking at is not idle, whatever the clock says.
      if (this.shell.onScreen) continue
      if (now - context.lastTouched < this.#options.idleUnloadMs) continue
      // The session stays on disk: a login done by hand outlives the window.
      context.unload()
    }
  }

  // -------------------------------------------------------------- connections

  #onConnection(connection: Connection): void {
    let agent: AgentHandle | null = null
    let context: ProjectContext | null = null

    connection.onMessage((message) => {
      void this.#dispatch(connection, message, {
        get agent() {
          return agent
        },
        get context() {
          return context
        },
        attach(nextAgent, nextContext) {
          agent = nextAgent
          context = nextContext
        },
      })
    })

    connection.onClose(() => {
      const known = this.#agentsByConnection.get(connection.id)
      if (!known) return
      this.#agentsByConnection.delete(connection.id)
      this.contexts.get(known.projectId)?.removeAgent(known.agentId)
    })
  }

  async #dispatch(
    connection: Connection,
    message: ClientMessage,
    slot: {
      readonly agent: AgentHandle | null
      readonly context: ProjectContext | null
      attach(agent: AgentHandle, context: ProjectContext): void
    },
  ): Promise<void> {
    if (message?.type === 'hello') {
      await this.#onHello(connection, message, slot)
      return
    }
    if (message?.type === 'bye') {
      connection.close()
      return
    }
    if (message?.type !== 'call') return

    const agent = slot.agent
    const context = slot.context
    if (!agent || !context) {
      this.#fail(connection, message.id, 'denied', 'say hello before calling anything')
      return
    }
    try {
      const value = await this.#call(context, agent, message.method, message.params)
      connection.send({ type: 'result', id: message.id, value })
    } catch (error) {
      const code = ((error as { code?: ErrorCode }).code ?? 'internal') as ErrorCode
      const detail = error instanceof ScriptError ? error.detail : undefined
      this.#fail(connection, message.id, code, error instanceof Error ? error.message : String(error), detail)
    }
  }

  async #onHello(
    connection: Connection,
    message: Extract<ClientMessage, { type: 'hello' }>,
    slot: { attach(agent: AgentHandle, context: ProjectContext): void },
  ): Promise<void> {
    const licensed = this.#options.licensed?.() ?? true
    if (!licensed) {
      connection.send({
        type: 'denied',
        id: message.id,
        code: 'unlicensed',
        reason: 'Naoba is not unlocked on this Mac. Open it and enter your licence key in the settings window.',
      })
      connection.close()
      return
    }

    const identity = identify(message.project)
    const decision = await this.#admit(identity, message.agent.label)
    if (decision === 'denied') {
      connection.send({
        type: 'denied',
        id: message.id,
        code: 'project-refused',
        reason:
          `“${identity.name}” is not allowed to open a browser here; clear the decision in the app's settings to be asked again`,
      })
      connection.close()
      return
    }

    const context = this.contextFor(identity)
    const agentId = randomUUID()
    const agent: AgentHandle = {
      id: agentId,
      label: message.agent.label,
      descriptor: message.agent,
      currentTabId: null,
      send: (outgoing: ServerMessage) => connection.send(outgoing),
    }
    context.addAgent(agent)
    context.show()
    slot.attach(agent, context)
    this.#agentsByConnection.set(connection.id, { agentId, projectId: identity.id })

    connection.send({
      type: 'welcome',
      id: message.id,
      project: { id: identity.id, name: identity.name, root: identity.root },
      agentId,
      appVersion: app.getVersion(),
    })
  }

  #fail(connection: Connection, id: number, code: ErrorCode, message: string, details?: unknown): void {
    connection.send({ type: 'error', id, error: { code, message, details } })
  }

  // ------------------------------------------------------------------- calls

  async #call(context: ProjectContext, agent: AgentHandle, method: string, params: unknown): Promise<unknown> {
    const args = (params ?? {}) as Record<string, unknown>
    context.touch()

    switch (method) {
      case 'status':
        return {
          port: this.port,
          appVersion: app.getVersion(),
          project: { id: context.identity.id, name: context.identity.name, root: context.identity.root },
          agents: [...context.agents.values()].map((other) => ({
            id: other.id,
            label: other.label,
            ide: other.descriptor.ide,
            self: other.id === agent.id,
          })),
          tabs: context.describeTabs(),
          // What the browser itself got wrong since it started. An agent
          // reading a tab that stopped answering has no other way to learn
          // that the fault was the browser's rather than the page's — the
          // modal window Electron used to put on screen was addressed to
          // whoever wrote the code, and on this machine that is the agent.
          faults: recentFaults().map((fault) => ({
            kind: fault.kind,
            message: fault.message,
            stack: fault.stack,
            at: fault.at,
          })),
        }

      /**
       * The first call an agent makes: it has just said who it is, and this
       * gives it the tab to work in.
       *
       * A tab of its own is what an agent gets anyway on its first scenario —
       * doing it here means the agent has somewhere to look before it writes
       * one, and the answer carries the picture it would otherwise ask
       * `status` for.
       */
      case 'begin': {
        const url = args.url === undefined ? null : String(args.url)
        const tab = context.tabFor(agent)
        if (url) await this.#runEval(context, agent, `return await api.navigate(${JSON.stringify(url)})`, 60_000)
        return {
          // Nothing about the project comes back: the session named it, and
          // this application does not turn it into something else any more.
          tab: context.describeTab(context.tab(tab.id) ?? tab),
          // No entry for the caller: an agent is a session, so it already
          // knows its own name — it chose it a moment ago — and its id is the
          // session header it has been echoing since `initialize`.
          others: [...context.agents.values()]
            .filter((other) => other.id !== agent.id)
            .map((other) => ({ session_name: other.label, ide: other.descriptor.ide })),
        }
      }

      case 'eval': {
        const code = String(args.code ?? '')
        if (!code.trim()) throw badParams('there is no code to run')
        const timeout = Number(args.timeout ?? this.#options.defaultScriptTimeoutMs)
        return await this.#runEval(context, agent, code, timeout)
      }

      // Only reachable in a test run. The person's side of `requestHuman` is a
      // button in the window, and no agent may press it for them — but a test
      // has no hands, so the test harness gets this one door and a shipped
      // build has no door at all.
      case 'test:human-done': {
        if (!this.#options.admitEverything) {
          throw Object.assign(new Error(`unknown method ${method}`), { code: 'unknown-method' as ErrorCode })
        }
        const tabId = String(args.tabId ?? '')
        const pending = context.pendingHuman.get(tabId)
        if (!pending) return false
        pending.resolve('done')
        return true
      }

      default:
        throw Object.assign(new Error(`unknown method ${method}`), { code: 'unknown-method' as ErrorCode })
    }
  }

  async #runEval(context: ProjectContext, agent: AgentHandle, code: string, timeoutMs: number): Promise<unknown> {
    const target = context.tabFor(agent)
    // The tab a call belongs to is not always the one the agent is holding:
    // `setCookie`, `deleteCookie` and `clearStorage` never touch a tab, and
    // `closeTab` names the one it has just destroyed.
    const place = (): string | null => {
      const held = agent.currentTabId ? context.tab(agent.currentTabId) : null
      return held?.id ?? context.activeTab()?.id ?? null
    }
    // The lease is checked per action, not once for the whole script: a script
    // that only lists tabs, or works on a different tab, has no business
    // waiting for somebody else's page.
    const api = buildApi(context, agent, (text) => context.log({ id: agent.id, label: agent.label }, text, place()), {
      waitForTab: (tabId) => this.#waitForTab(context, agent, tabId),
    })
    const outcome = await context.queue.run(
      target.id,
      () => runScript(code, api, timeoutMs),
      { label: agent.label, waitMs: this.#options.contentionWaitMs, runMs: timeoutMs + 5_000 },
    )
    return outcome
  }

  /**
   * Wait out another agent's lease, but not the person's. An agent that has
   * claimed a tab is mid-scenario and will be done shortly; a person holding a
   * tab may be reading it for ten minutes, and the honest answer to the caller
   * is an error, not a hang.
   */
  async #waitForTab(context: ProjectContext, agent: AgentHandle, tabId: string): Promise<void> {
    const deadline = Date.now() + this.#options.contentionWaitMs
    for (;;) {
      const holder = context.leases.holderOf(tabId)
      if (!holder) return
      if (holder.kind === 'agent' && holder.id === agent.id) return
      if (holder.kind === 'human') {
        throw Object.assign(new Error('the person at the keyboard is using this tab'), {
          code: 'taken-over' as ErrorCode,
        })
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`tab is held by ${holder.label}`), { code: 'tab-held' as ErrorCode })
      }
      await pause(100)
    }
  }
}

function badParams(message: string): Error {
  return Object.assign(new Error(message), { code: 'bad-params' as ErrorCode })
}
