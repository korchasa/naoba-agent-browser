/**
 * The window's own interface: one panel down the left edge holding the address
 * bar and a tree of the agents in this project, the tabs each of them has been
 * in, and what each did there.
 */
import type { AgentCommand, TabDescriptor } from '../main/protocol.ts'
import { type AgentRow, buildTree, expandNew, groupKey, tabKey, type TreeGroup } from './tree.ts'

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
  wrap.append(el('div', 'drag'))
  wrap.append(renderBar())

  const current = activeTab()
  if (current?.waitingForHuman) {
    const callout = el('div', 'callout')
    callout.append(el('h3', '', 'An agent needs you'))
    callout.append(el('p', '', current.waitingForHuman))
    callout.append(primary('I have done it', () => void ab.humanDone(projectId, current.id)))
    wrap.append(callout)
  } else if (current?.heldBy) {
    const held = el('div', 'held-row')
    held.append(el('span', 'state', `held by ${current.heldBy}`))
    held.append(button('Take over', () => void ab.takeOver(projectId, current.id)))
    wrap.append(held)
  }

  wrap.append(renderTree(groups))
  return wrap
}

function renderBar(): HTMLElement {
  const bar = el('div', 'bar')
  const current = activeTab()

  bar.append(button('‹', () => history.back(), 'Back'))
  bar.append(button('⟳', () => current && void ab.navigate(projectId, current.id, current.url), 'Reload'))

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
  bar.append(button('+', () => void ab.newTab(projectId), 'New tab'))
  return bar
}

// ------------------------------------------------------------------- the tree

function renderTree(groups: TreeGroup[]): HTMLElement {
  const tree = el('div', 'tree')
  // Said whenever no agent is here, not only when the tree is empty: on a first
  // launch the window already has a tab of its own, and without this the panel
  // would explain nothing to the person who has just opened the application.
  if (agents.length === 0) {
    tree.append(el('div', 'empty', `No agent is connected. Point one at ${projectName} and it will show up here.`))
  }

  for (const group of groups) {
    const key = groupKey(group)
    const open = expanded.has(key)
    tree.append(groupRow(group, open, key))
    if (!open) continue

    if (group.tabs.length === 0) {
      tree.append(depth(el('div', 'empty note', 'no tab yet'), 1))
      continue
    }
    for (const entry of group.tabs) {
      const tabId = tabKey(group, entry.tab)
      const tabOpen = expanded.has(tabId)
      tree.append(tabRow(entry.tab, entry.commands.length, tabOpen, tabId))
      if (!tabOpen) continue
      if (entry.commands.length === 0) {
        tree.append(depth(el('div', 'empty note', 'nothing done here yet'), 2))
        continue
      }
      for (const command of entry.commands) tree.append(commandRow(command))
    }
  }
  return tree
}

function groupRow(group: TreeGroup, open: boolean, key: string): HTMLElement {
  const row = depth(el('div', 'row group'), 0)
  row.append(twist(open))
  if (group.id !== null) row.append(el('span', 'dot'))
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

  if (tab.waitingForHuman) row.append(el('span', 'mark', '✋'))
  else if (tab.heldBy) row.append(el('span', 'mark', '●'))

  const title = el('span', 'name', tab.title || hostOf(tab.url) || 'New tab')
  title.title = tab.heldBy ? `${tab.title}\nheld by ${tab.heldBy}` : tab.title
  row.append(title)
  if (count > 0) row.append(el('span', 'count', String(count)))

  const close = el('span', 'close', '✕')
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

function commandRow(command: AgentCommand): HTMLElement {
  const row = depth(el('div', 'row cmd'), 2)
  row.append(el('span', 'when', clock(command.at)))
  row.append(el('span', 'what', command.text))
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
  return el('span', open ? 'twist open' : 'twist', '▸')
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
