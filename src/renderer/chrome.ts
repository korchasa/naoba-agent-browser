/**
 * The window's own interface: one panel down the left edge holding the address
 * bar and a tree of every project, the agents in each, the tabs each of them
 * has been in, and what each did there.
 */
import type { AgentCommand, ProjectDescriptor, TabDescriptor } from '../main/protocol.ts'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  createElement,
  Folder,
  Globe,
  Hand,
  type IconNode,
  Lock,
  Plus,
  RotateCw,
  Settings,
  SlidersHorizontal,
  X,
  Zap,
} from 'lucide'
import {
  type AgentRow,
  buildForest,
  expandNew,
  groupKey,
  projectKey,
  type ProjectState,
  SORT_MODES,
  type SortMode,
  tabKey,
  type TreeGroup,
  type TreeProject,
  type TreeTab,
} from './tree.ts'

interface ProjectSnapshot extends ProjectDescriptor {
  tabs: TabDescriptor[]
  agents: AgentRow[]
  commands: Record<string, AgentCommand[]>
}

declare const ab: {
  state(): Promise<{
    port: number
    projects: ProjectSnapshot[]
  }>
  openSettings(): Promise<unknown>
  newTab(projectId: string, url?: string): Promise<unknown>
  selectTab(projectId: string, tabId: string): Promise<boolean>
  closeTab(projectId: string, tabId: string): Promise<boolean>
  navigate(projectId: string, tabId: string, url: string): Promise<boolean>
  panelWidth(width: number): Promise<number>
  tabMenu(projectId: string, tabId: string): Promise<void>
  takeOver(projectId: string, tabId: string): Promise<boolean>
  release(projectId: string, tabId: string): Promise<boolean>
  humanDone(projectId: string, tabId: string): Promise<boolean>
  on(channel: 'projects' | 'tabs' | 'agents' | 'commands', handler: (payload: unknown) => void): () => void
}

const root = document.getElementById('root')!

/** Every project the main process has told the panel about, in arrival order. */
const projects = new Map<string, ProjectState>()
/** Where agents connect; shown in the foot once the main process has said. */
let port: number | null = null

/** The project's slot, made on first mention so a push about it never has nowhere to land. */
function project(descriptor: ProjectDescriptor): ProjectState {
  let state = projects.get(descriptor.id)
  if (!state) {
    state = { ...descriptor, tabs: [], agents: [], commands: new Map() }
    projects.set(descriptor.id, state)
  }
  return state
}

function allTabs(): TabDescriptor[] {
  return [...projects.values()].flatMap((state) => state.tabs)
}

function allAgents(): AgentRow[] {
  return [...projects.values()].flatMap((state) => state.agents)
}

/**
 * Which branches are open. It lives outside `render` on purpose: the panel is
 * redrawn on every state push from the main process, and a tree that folded
 * itself shut each time an agent clicked something would be unusable.
 */
const expanded = new Set<string>()

/**
 * How the agents are ordered. Remembered per machine: a person who prefers
 * the busiest agent on top wants that tomorrow too. The store can be absent
 * or refuse — a private window, a cleared profile — and the panel then just
 * starts from the default.
 */
const SORT_KEY = 'naoba.sort'
let sort: SortMode = readSort()
let sortMenuOpen = false

function readSort(): SortMode {
  try {
    const stored = localStorage.getItem(SORT_KEY)
    if (SORT_MODES.some((entry) => entry.mode === stored)) return stored as SortMode
  } catch {
    // No store here; the default is fine.
  }
  return 'arrival'
}

function setSort(mode: SortMode): void {
  sort = mode
  sortMenuOpen = false
  try {
    localStorage.setItem(SORT_KEY, mode)
  } catch {
    // The choice still holds for this window.
  }
  render()
}
/** Every branch key already decided on, so a fold by hand is not undone. */
const seen = new Set<string>()

/** The tab in front, and the project it belongs to. */
function activeTab(): { tab: TabDescriptor; projectId: string } | null {
  for (const state of projects.values()) {
    const tab = state.tabs.find((entry) => entry.active)
    if (tab) return { tab, projectId: state.id }
  }
  return null
}

function render(): void {
  const forest = buildForest(projects.values(), sort)
  expandNew(forest, seen, expanded)
  root.innerHTML = ''
  root.append(renderPanel(forest))
}

function renderPanel(forest: TreeProject[]): HTMLElement {
  const wrap = el('div', 'panel')

  // The window buttons sit over the top-left of the content, so the panel keeps
  // that strip empty and hands it to the window as a drag region.
  const strip = el('div', 'drag')
  strip.append(icon('bolt', 'bolt'), el('span', 'brand', 'naoba'))
  wrap.append(strip)
  wrap.append(grip())
  wrap.append(renderBar())

  const front = activeTab()
  const current = front?.tab
  if (front && current?.waitingForHuman) {
    const callout = el('div', 'callout')
    const heading = el('h3')
    heading.append(icon('hand'), el('span', '', `${current.askedBy ?? 'An agent'} needs you`))
    callout.append(heading)
    callout.append(el('p', '', current.waitingForHuman))
    callout.append(primary('I have done it', () => void ab.humanDone(front.projectId, current.id)))
    wrap.append(callout)
  } else if (front && current?.heldBy) {
    const held = el('div', 'held-row')
    const state = el('span', 'state held')
    state.append(icon('lock'), el('span', '', `held by ${current.heldBy}`))
    held.append(state)
    held.append(button('Take over', () => void ab.takeOver(front.projectId, current.id)))
    wrap.append(held)
  }

  wrap.append(renderTree(forest))
  wrap.append(renderFoot())
  return wrap
}

function renderFoot(): HTMLElement {
  const foot = el('div', 'foot')
  const agents = allAgents().filter((agent) => !agent.gone)
  foot.append(el('span', agents.length > 0 ? 'dot live' : 'dot'))
  const counts = `${plural(agents.length, 'agent')} · ${plural(allTabs().length, 'tab')}`
  // The address an agent connects to sits with the counts: the one line of
  // the panel about the application rather than the project.
  foot.append(el('span', 'status', port === null ? counts : `${counts} · 127.0.0.1:${port}`))
  // Everything the person sets by hand is one window away, including the
  // disguise that used to be a ghost here. The panel is the tree again.
  const gear = iconButton('gear', () => void ab.openSettings(), 'Settings')
  gear.classList.add('quiet')
  foot.append(gear)
  return foot
}

function renderBar(): HTMLElement {
  const bar = el('div', 'bar')
  const front = activeTab()
  const current = front?.tab

  bar.append(iconButton('back', () => history.back(), 'Back'))
  bar.append(
    iconButton('reload', () => front && void ab.navigate(front.projectId, front.tab.id, front.tab.url), 'Reload'),
  )

  const url = document.createElement('input')
  url.className = 'url'
  url.value = current?.url ?? ''
  url.placeholder = front
    ? `Open a page in ${projects.get(front.projectId)?.name ?? 'this project'}`
    : 'No tab in front'
  url.disabled = !front
  url.onkeydown = (event) => {
    if (event.key !== 'Enter' || !front) return
    const value = url.value.trim()
    if (!value) return
    void ab.navigate(front.projectId, front.tab.id, value)
  }
  bar.append(url)
  // A new tab joins the agent whose tab is in front; with no agent here there
  // is nobody to open one for.
  const plus = iconButton('plus', () => front && void ab.newTab(front.projectId), 'New tab beside this agent')
  if (!current?.openedBy) plus.disabled = true
  bar.append(plus)
  bar.append(sortControl())
  return bar
}

/**
 * The panel's right edge, which the person can drag. The panel is its own
 * view, so the pointer leaves it the moment the drag starts; pointer capture
 * keeps the moves coming until the button is released. Each move goes to the
 * main process, which owns the layout and clamps the width.
 */
function grip(): HTMLElement {
  const bar = el('div', 'grip')
  bar.title = 'Drag to resize the panel'
  bar.onpointerdown = (event) => {
    if (event.button !== 0) return
    bar.setPointerCapture(event.pointerId)
    bar.classList.add('dragging')
    let pending: number | null = null
    bar.onpointermove = (move) => {
      // One request per frame: the main process lays the window out on each,
      // and the pointer reports far more often than that.
      pending = move.clientX
      requestAnimationFrame(() => {
        if (pending === null) return
        void ab.panelWidth(Math.round(pending))
        pending = null
      })
    }
    bar.onpointerup = bar.onpointercancel = () => {
      bar.releasePointerCapture(event.pointerId)
      bar.classList.remove('dragging')
      bar.onpointermove = bar.onpointerup = bar.onpointercancel = null
    }
  }
  return bar
}

/** The sliders button and, while it is open, the list of orders under it. */
function sortControl(): HTMLElement {
  const wrap = el('div', 'sort')
  const button = iconButton('sliders', () => {
    sortMenuOpen = !sortMenuOpen
    render()
  }, 'Order of agents')
  if (sortMenuOpen) button.classList.add('open')
  wrap.append(button)
  if (!sortMenuOpen) return wrap

  const menu = el('div', 'menu')
  menu.append(el('h6', '', 'Order agents'))
  for (const entry of SORT_MODES) {
    const item = el('button', entry.mode === sort ? 'item chosen' : 'item')
    item.append(icon('check', 'tick'), el('span', '', entry.label))
    item.onclick = () => setSort(entry.mode)
    menu.append(item)
  }
  wrap.append(menu)
  return wrap
}

// ------------------------------------------------------------------- the tree

function renderTree(forest: TreeProject[]): HTMLElement {
  const root = el('div', 'tree')
  // Said whenever no agent is here, not only when the tree is empty: on a first
  // launch the window already has a tab of its own, and without this the panel
  // would explain nothing to the person who has just opened the application.
  if (allAgents().every((agent) => agent.gone)) {
    const empty = el('div', 'empty')
    empty.append(icon('bolt', 'bolt'))
    empty.append(el('h3', '', 'No agent is here yet'))
    empty.append(
      el('p', '', 'Point one at a project and it will show up here, with every tab it opens and every call it makes.'),
    )
    empty.append(el('code', '', 'claude mcp add naoba -- node <checkout>/packages/bridge/index.mjs'))
    root.append(empty)
  }

  for (const project of forest) {
    const key = projectKey(project)
    const open = expanded.has(key)
    root.append(projectRow(project, open, key))
    if (!open) continue
    if (project.groups.length === 0) {
      root.append(depth(el('div', 'empty note', 'no agent here'), 1))
      continue
    }
    for (const [at, group] of project.groups.entries()) renderGroup(root, project, group, at)
  }
  return root
}

function renderGroup(into: HTMLElement, project: TreeProject, group: TreeGroup, at: number): void {
  const key = groupKey(project, group)
  const open = expanded.has(key)
  into.append(groupRow(group, open, key, at))
  if (!open) return
  if (group.tabs.length === 0) {
    into.append(depth(el('div', 'empty note', 'no tab yet'), 2))
    return
  }
  for (const entry of group.tabs) renderTab(into, project, group, entry)
}

function renderTab(into: HTMLElement, project: TreeProject, group: TreeGroup, entry: TreeTab): void {
  const key = tabKey(project, group, entry.tab)
  const open = expanded.has(key)
  into.append(tabRow(project.id, entry.tab, entry.commands.length, open, key))
  if (!open) return
  if (entry.commands.length === 0) {
    into.append(depth(el('div', 'empty note', 'nothing done here yet'), 3))
    return
  }
  for (const command of entry.commands) into.append(commandRow(command, group.id, 3))
}

/** The top level: a project, named after its folder, with the folder as its tooltip. */
function projectRow(project: TreeProject, open: boolean, key: string): HTMLElement {
  const row = depth(el('div', 'row project'), 0)
  row.append(twist(open))
  row.append(icon('folder', 'folder'))
  row.append(el('span', 'name', project.name))
  const live = project.groups.filter((group) => !group.gone).length
  if (live > 0) row.append(el('span', 'count', String(live)))
  row.title = project.root
  row.onclick = () => toggle(key)
  return row
}

function groupRow(group: TreeGroup, open: boolean, key: string, at: number): HTMLElement {
  const row = depth(el('div', group.gone ? 'row group gone' : 'row group'), 1)
  row.append(twist(open))
  // Each agent keeps its colour for as long as it is connected: the dot is
  // how a person tells three agents apart across the whole tree. One that
  // has gone keeps its place but loses its colour, and says so on its badge.
  row.style.setProperty('--agent', `var(--agent-${at % 5})`)
  row.append(el('span', 'dot'))
  row.append(el('span', 'name', group.label))
  row.append(el('span', 'ide', group.gone ? 'gone' : group.ide))
  if (group.gone) row.title = `${group.label} has disconnected; its tabs close in a while unless somebody picks them up`
  row.onclick = () => toggle(key)
  return row
}

function tabRow(projectId: string, tab: TabDescriptor, count: number, open: boolean, key: string): HTMLElement {
  const row = depth(el('div', 'row tab'), 2)
  if (tab.active) row.classList.add('active')
  if (tab.heldBy) row.classList.add('held')
  if (tab.waitingForHuman) row.classList.add('waiting')

  const arrow = twist(open)
  arrow.onclick = (event) => {
    event.stopPropagation()
    toggle(key)
  }
  row.append(arrow)

  const glyph = el('span', 'icon')
  glyph.append(icon('globe'))
  row.append(glyph)
  const title = el('span', 'name', tab.title || hostOf(tab.url) || 'New tab')
  title.title = tab.heldBy ? `${tab.title}\nheld by ${tab.heldBy}` : tab.title
  row.append(title)

  if (tab.waitingForHuman) {
    const mark = el('span', 'mark')
    mark.append(icon('hand'), el('span', '', 'needs you'))
    row.append(mark)
  } else if (tab.heldBy) {
    const mark = el('span', 'mark')
    mark.title = `held by ${tab.heldBy}`
    mark.append(icon('lock'))
    row.append(mark)
  }
  if (count > 0) row.append(el('span', 'count', String(count)))

  const close = el('span', 'close')
  close.append(icon('x'))
  close.onclick = (event) => {
    event.stopPropagation()
    void ab.closeTab(projectId, tab.id)
  }
  row.append(close)

  // Clicking the tab itself brings the page forward; the triangle is the only
  // part that folds it.
  row.onclick = () => void ab.selectTab(projectId, tab.id)
  // The menu is the system's, built in the main process, so it looks and
  // behaves like every other context menu on the machine.
  row.oncontextmenu = (event) => {
    event.preventDefault()
    void ab.tabMenu(projectId, tab.id)
  }
  return row
}

function commandRow(command: AgentCommand, owner: string | null, level: number): HTMLElement {
  const row = depth(el('div', 'row cmd'), level)
  row.append(el('span', 'when', clock(command.at)))
  // A call by the tab's own agent needs no name; one by anybody else — another
  // agent, or the person — carries theirs, or the history reads as one voice.
  if (command.agentId !== owner) row.append(el('span', 'who', command.agentLabel))
  // A call reads as name(arguments); the name is what the eye scans for, so
  // only it is drawn in full colour.
  const what = el('span', 'what')
  const open = command.text.indexOf('(')
  if (open > 0) {
    what.append(el('span', 'fn', command.text.slice(0, open)), el('span', 'args', command.text.slice(open)))
  } else what.textContent = command.text
  row.append(what)
  return row
}

function toggle(key: string): void {
  if (expanded.has(key)) expanded.delete(key)
  else expanded.add(key)
  render()
}

// ---------------------------------------------------------------------- utils

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

/** Indentation is a custom property so a level is one number, not a stylesheet. */
function depth(node: HTMLElement, level: number): HTMLElement {
  node.style.setProperty('--depth', String(level))
  return node
}

function twist(open: boolean): HTMLElement {
  const node = el('span', open ? 'twist open' : 'twist')
  node.append(icon('chevron'))
  return node
}

/**
 * Icons come from Lucide, bundled in: a consistent stroke set beats a dozen
 * paths drawn by hand, and they keep the text colour like inline SVG does.
 */
const ICONS: Record<string, IconNode> = {
  back: ChevronLeft,
  reload: RotateCw,
  plus: Plus,
  chevron: ChevronRight,
  x: X,
  lock: Lock,
  hand: Hand,
  bolt: Zap,
  globe: Globe,
  folder: Folder,
  sliders: SlidersHorizontal,
  check: Check,
  'chevron-down': ChevronDown,
  gear: Settings,
}

const ICON_SIZE: Record<string, number> = {
  folder: 14,
  chevron: 11,
  'chevron-down': 12,
  x: 11,
  lock: 12,
  hand: 12,
  check: 13,
  gear: 13,
}

function icon(name: string, className = ''): SVGElement {
  const node = ICONS[name]
  if (!node) throw new Error(`no icon named ${name}`)
  const size = ICON_SIZE[name] ?? 15
  const svg = createElement(node, { width: size, height: size, 'stroke-width': 1.75 })
  if (className) svg.setAttribute('class', className)
  return svg
}

function iconButton(name: string, onClick: () => void, title: string): HTMLButtonElement {
  const node = document.createElement('button')
  node.className = 'icon'
  node.title = title
  node.onclick = onClick
  node.append(icon(name))
  return node
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function button(label: string, onClick: () => void, title = ''): HTMLElement {
  const node = document.createElement('button')
  node.textContent = label
  node.title = title
  node.onclick = onClick
  return node
}

function primary(label: string, onClick: () => void): HTMLElement {
  const node = button(label, onClick)
  node.classList.add('primary')
  return node
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// ------------------------------------------------------------------ lifecycle

ab.on('projects', (payload) => {
  const { projects: list } = payload as { projects: ProjectDescriptor[] }
  for (const descriptor of list) project(descriptor)
  render()
})
ab.on('tabs', (payload) => {
  const { projectId, tabs } = payload as { projectId: string; tabs: TabDescriptor[] }
  const state = projects.get(projectId)
  if (!state) return
  state.tabs = tabs
  // A closed tab's history has no reader left, and a window open all day would
  // otherwise keep every call made in every tab it ever had.
  const alive = new Set(tabs.map((tab) => tab.id))
  for (const tabId of state.commands.keys()) if (!alive.has(tabId)) state.commands.delete(tabId)
  render()
})
ab.on('agents', (payload) => {
  const { projectId, agents } = payload as { projectId: string; agents: AgentRow[] }
  const state = projects.get(projectId)
  if (!state) return
  state.agents = agents
  render()
})
ab.on('commands', (payload) => {
  const { projectId, tabId, commands } = payload as { projectId: string; tabId: string; commands: AgentCommand[] }
  projects.get(projectId)?.commands.set(tabId, commands)
  render()
})

void ab.state().then((state) => {
  port = state.port
  for (const snapshot of state.projects) {
    const slot = project(snapshot)
    slot.tabs = snapshot.tabs
    slot.agents = snapshot.agents
    for (const [tabId, list] of Object.entries(snapshot.commands)) slot.commands.set(tabId, list)
  }
  render()
})

render()
