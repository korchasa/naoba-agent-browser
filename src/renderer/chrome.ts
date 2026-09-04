/**
 * The window's own interface: one panel down the left edge holding the address
 * bar and a tree of the agents in this project, the tabs each of them has been
 * in, and what each did there.
 */
import type { AgentCommand, TabDescriptor } from '../main/protocol.ts'
import { type AgentRow, buildTree, expandNew, groupKey, tabKey, type TreeGroup, type TreeTab } from './tree.ts'

declare const ab: {
  state(projectId: string): Promise<
    { tabs: TabDescriptor[]; agents: AgentRow[]; commands: Record<string, AgentCommand[]> } | null
  >
  newTab(projectId: string, url?: string): Promise<unknown>
  selectTab(projectId: string, tabId: string): Promise<boolean>
  closeTab(projectId: string, tabId: string): Promise<boolean>
  navigate(projectId: string, tabId: string, url: string): Promise<boolean>
  takeOver(projectId: string, tabId: string): Promise<boolean>
  release(projectId: string, tabId: string): Promise<boolean>
  humanDone(projectId: string, tabId: string): Promise<boolean>
  on(channel: 'tabs' | 'agents' | 'commands', handler: (payload: unknown) => void): () => void
}

const params = new URLSearchParams(location.search)
const projectId = params.get('project') ?? ''
const projectName = params.get('name') ?? 'project'
const root = document.getElementById('root')!

let tabs: TabDescriptor[] = []
let agents: AgentRow[] = []
const commands = new Map<string, AgentCommand[]>()

/**
 * Which branches are open. It lives outside `render` on purpose: the panel is
 * redrawn on every state push from the main process, and a tree that folded
 * itself shut each time an agent clicked something would be unusable.
 */
const expanded = new Set<string>()
/** Every branch key already decided on, so a fold by hand is not undone. */
const seen = new Set<string>()

function activeTab(): TabDescriptor | null {
  return tabs.find((tab) => tab.active) ?? null
}

function render(): void {
  const groups = buildTree(tabs, agents, commands)
  expandNew(groups, seen, expanded)
  root.innerHTML = ''
  root.append(renderPanel(groups))
}

function renderPanel(groups: TreeGroup[]): HTMLElement {
  const wrap = el('div', 'panel')

  // The window buttons sit over the top-left of the content, so the panel keeps
  // that strip empty and hands it to the window as a drag region.
  const strip = el('div', 'drag')
  strip.append(icon('bolt', 'bolt'), el('span', 'brand', 'naoba'), el('span', '', '·'), el('span', '', projectName))
  wrap.append(strip)
  wrap.append(renderBar())

  const current = activeTab()
  if (current?.waitingForHuman) {
    const callout = el('div', 'callout')
    const heading = el('h3')
    heading.append(icon('hand'), el('span', '', `${current.askedBy ?? 'An agent'} needs you`))
    callout.append(heading)
    callout.append(el('p', '', current.waitingForHuman))
    callout.append(primary('I have done it', () => void ab.humanDone(projectId, current.id)))
    wrap.append(callout)
  } else if (current?.heldBy) {
    const held = el('div', 'held-row')
    const state = el('span', 'state held')
    state.append(icon('lock'), el('span', '', `held by ${current.heldBy}`))
    held.append(state)
    held.append(button('Take over', () => void ab.takeOver(projectId, current.id)))
    wrap.append(held)
  }

  wrap.append(renderTree(groups))
  wrap.append(renderFoot())
  return wrap
}

function renderFoot(): HTMLElement {
  const foot = el('div', 'foot')
  foot.append(el('span', agents.length > 0 ? 'dot live' : 'dot'))
  foot.append(el('span', '', `${plural(agents.length, 'agent')} · ${plural(tabs.length, 'tab')}`))
  return foot
}

function renderBar(): HTMLElement {
  const bar = el('div', 'bar')
  const current = activeTab()

  bar.append(iconButton('back', () => history.back(), 'Back'))
  bar.append(iconButton('reload', () => current && void ab.navigate(projectId, current.id, current.url), 'Reload'))

  const url = document.createElement('input')
  url.className = 'url'
  url.value = current?.url ?? ''
  url.placeholder = `Open a page in ${projectName}`
  url.onkeydown = (event) => {
    if (event.key !== 'Enter') return
    const value = url.value.trim()
    if (!value) return
    if (current) void ab.navigate(projectId, current.id, value)
    else void ab.newTab(projectId, value)
  }
  bar.append(url)
  bar.append(iconButton('plus', () => void ab.newTab(projectId), 'New tab'))
  return bar
}

// ------------------------------------------------------------------- the tree

function renderTree(groups: TreeGroup[]): HTMLElement {
  const root = el('div', 'tree')
  // Said whenever no agent is here, not only when the tree is empty: on a first
  // launch the window already has a tab of its own, and without this the panel
  // would explain nothing to the person who has just opened the application.
  if (agents.length === 0) {
    const empty = el('div', 'empty')
    empty.append(icon('bolt', 'bolt'))
    empty.append(el('h3', '', 'No agent is here yet'))
    const hint = el('p')
    hint.append('Point one at ', el('b', '', projectName), ' and it will show up here, with every tab it opens and every call it makes.')
    empty.append(hint)
    empty.append(el('code', '', 'claude mcp add naoba -- node <checkout>/packages/bridge/index.mjs'))
    root.append(empty)
  }

  for (const [at, group] of groups.entries()) {
    const key = groupKey(group)
    const open = expanded.has(key)
    root.append(groupRow(group, open, key, at))
    if (!open) continue

    if (group.tabs.length === 0) {
      root.append(depth(el('div', 'empty note', 'no tab yet'), 1))
      continue
    }
    for (const entry of group.tabs) renderTab(root, group, entry)
  }
  return root
}

function renderTab(into: HTMLElement, group: TreeGroup, entry: TreeTab): void {
  const key = tabKey(group, entry.tab)
  const open = expanded.has(key)
  into.append(tabRow(entry.tab, entry.commands.length, open, key))
  if (!open) return
  if (entry.commands.length === 0) {
    into.append(depth(el('div', 'empty note', 'nothing done here yet'), 2))
    return
  }
  for (const command of entry.commands) into.append(commandRow(command, group.id, 2))
}

function groupRow(group: TreeGroup, open: boolean, key: string, at: number): HTMLElement {
  const row = depth(el('div', group.id === null ? 'row group you' : 'row group'), 0)
  row.append(twist(open))
  // Each agent keeps its colour for as long as it is connected: the dot is
  // how a person tells three agents apart across the whole tree. The person
  // has a colour of their own, outside the agents' run.
  row.style.setProperty('--agent', group.id === null ? 'var(--you)' : `var(--agent-${at % 5})`)
  row.append(el('span', 'dot'))
  row.append(el('span', 'name', group.label))
  if (group.ide) row.append(el('span', 'ide', group.ide))
  row.onclick = () => toggle(key)
  return row
}

function tabRow(tab: TabDescriptor, count: number, open: boolean, key: string): HTMLElement {
  const row = depth(el('div', 'row tab'), 1)
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

/** Stroke icons on a 16-unit grid, drawn inline so they take the text colour. */
const ICONS: Record<string, string> = {
  back: '<path d="M10 3 5 8l5 5"/>',
  reload: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5V6h-3.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  chevron: '<path d="M6 3l5 5-5 5"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  hand:
    '<path d="M5 8V3.5a1 1 0 0 1 2 0V7M7 6.5V2.5a1 1 0 0 1 2 0V7M9 6.5V3.5a1 1 0 0 1 2 0V7M11 7V5a1 1 0 0 1 2 0v4.5c0 2.5-2 4.5-4.5 4.5S4 12 4 9.5V7.5a1 1 0 0 1 1-1"/>',
  bolt: '<path d="M9.5 1 3 9h4l-.5 6L13 7H9l.5-6z" fill="currentColor" stroke="none"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
}
const ICON_SIZE: Record<string, number> = { back: 14, reload: 14, plus: 14, chevron: 10, x: 10, lock: 12, hand: 12, bolt: 14, globe: 14 }

function icon(name: string, className = ''): SVGElement {
  const size = ICON_SIZE[name] ?? 14
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  if (className) svg.setAttribute('class', className)
  svg.innerHTML = ICONS[name] ?? ''
  return svg
}

function iconButton(name: string, onClick: () => void, title: string): HTMLElement {
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

ab.on('tabs', (payload) => {
  tabs = payload as TabDescriptor[]
  // A closed tab's history has no reader left, and a window open all day would
  // otherwise keep every call made in every tab it ever had.
  const alive = new Set(tabs.map((tab) => tab.id))
  for (const tabId of commands.keys()) if (!alive.has(tabId)) commands.delete(tabId)
  render()
})
ab.on('agents', (payload) => {
  agents = payload as AgentRow[]
  render()
})
ab.on('commands', (payload) => {
  const { tabId, commands: list } = payload as { tabId: string; commands: AgentCommand[] }
  commands.set(tabId, list)
  render()
})

void ab.state(projectId).then((state) => {
  if (!state) return
  tabs = state.tabs
  agents = state.agents
  for (const [tabId, list] of Object.entries(state.commands)) commands.set(tabId, list)
  render()
})

render()
