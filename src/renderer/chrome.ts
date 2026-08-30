/**
 * The window's own interface. Two roles from one bundle: the tab strip across
 * the top, and the agent panel down the side — a view is a rectangle and the
 * chrome is an L, so it takes two.
 */
interface TabDescriptor {
  id: string
  index: number
  title: string
  url: string
  active: boolean
  loading: boolean
  heldBy: string | null
  waitingForHuman: string | null
}

interface AgentRow {
  id: string
  label: string
  ide: string
  tabId: string | null
}

interface ActivityRow {
  at: number
  agent: string
  text: string
  tabId: string | null
}

declare const ab: {
  state(projectId: string): Promise<{ tabs: TabDescriptor[]; agents: AgentRow[]; activity: ActivityRow[] } | null>
  newTab(projectId: string, url?: string): Promise<unknown>
  selectTab(projectId: string, tabId: string): Promise<boolean>
  closeTab(projectId: string, tabId: string): Promise<boolean>
  navigate(projectId: string, tabId: string, url: string): Promise<boolean>
  takeOver(projectId: string, tabId: string): Promise<boolean>
  release(projectId: string, tabId: string): Promise<boolean>
  humanDone(projectId: string, tabId: string): Promise<boolean>
  on(channel: 'tabs' | 'agents' | 'activity', handler: (payload: unknown) => void): () => void
  chromeHeight(projectId: string, height: number): void
}

const params = new URLSearchParams(location.search)
const projectId = params.get('project') ?? ''
const projectName = params.get('name') ?? 'project'
const part = params.get('part') === 'side' ? 'side' : 'top'
const root = document.getElementById('root')!

let tabs: TabDescriptor[] = []
let agents: AgentRow[] = []
let activity: ActivityRow[] = []

function activeTab(): TabDescriptor | null {
  return tabs.find((tab) => tab.active) ?? null
}

function render(): void {
  root.innerHTML = ''
  root.append(part === 'top' ? renderTop() : renderSide())
  if (part === 'top') {
    watchStrip()
    reportHeight()
  }
}

/**
 * The strip is a view of its own, and a view is a fixed rectangle: whatever the
 * page needs, the main process is the only one that can give it. So the strip
 * measures itself after every render and says how tall it wants to be — at a
 * larger text size it needs more, and without this the address line is cut in
 * half by the page below it.
 */
let lastReported = 0
function reportHeight(): void {
  requestAnimationFrame(() => {
    const strip = root.firstElementChild as HTMLElement | null
    const height = Math.ceil(strip?.scrollHeight ?? 0)
    if (height <= 0 || height === lastReported) return
    lastReported = height
    ab.chromeHeight(projectId, height)
  })
}

// A re-render is not the only thing that changes the strip's height: a larger
// text size does too, and nothing re-renders then. `#root` fills the view, so
// watching it says nothing — the strip inside it is what grows.
const stripWatcher = part === 'top' ? new ResizeObserver(() => reportHeight()) : null
function watchStrip(): void {
  const strip = root.firstElementChild
  if (!stripWatcher || !strip) return
  stripWatcher.disconnect()
  stripWatcher.observe(strip)
}

// ------------------------------------------------------------------ top strip

function renderTop(): HTMLElement {
  const wrap = el('div', 'top')
  const strip = el('div', 'tabs')

  for (const tab of tabs) {
    const item = el('div', 'tab')
    if (tab.active) item.classList.add('active')
    if (tab.heldBy) item.classList.add('held')
    if (tab.waitingForHuman) item.classList.add('waiting')

    if (tab.waitingForHuman) item.append(el('span', 'mark', '✋'))
    else if (tab.heldBy) item.append(el('span', 'mark', '●'))

    const title = el('span', 'title', tab.title || hostOf(tab.url) || 'New tab')
    title.title = tab.heldBy ? `${tab.title}\nheld by ${tab.heldBy}` : tab.title
    item.append(title)

    const close = el('span', 'close', '✕')
    close.onclick = (event) => {
      event.stopPropagation()
      void ab.closeTab(projectId, tab.id)
    }
    item.append(close)
    item.onclick = () => void ab.selectTab(projectId, tab.id)
    strip.append(item)
  }

  const add = el('div', 'tab')
  add.append(el('span', 'title', '+'))
  add.onclick = () => void ab.newTab(projectId)
  strip.append(add)
  wrap.append(strip)

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

  if (current?.waitingForHuman) {
    const state = el('span', 'state warn', `waiting for you: ${current.waitingForHuman}`)
    bar.append(state)
    bar.append(primary('Done', () => void ab.humanDone(projectId, current.id)))
  } else if (current?.heldBy) {
    bar.append(el('span', 'state', `held by ${current.heldBy}`))
    bar.append(button('Take over', () => void ab.takeOver(projectId, current.id)))
  } else if (agents.length > 0) {
    bar.append(el('span', 'state', `${agents.length} agent${agents.length === 1 ? '' : 's'}`))
  }

  wrap.append(bar)
  return wrap
}

// ------------------------------------------------------------------ side panel

function renderSide(): HTMLElement {
  const wrap = el('div', 'side')

  const waiting = tabs.find((tab) => tab.waitingForHuman)
  if (waiting) {
    const callout = el('div', 'callout')
    const heading = el('h3', '', 'An agent needs you')
    const text = el('p', '', waiting.waitingForHuman ?? '')
    const act = primary('I have done it', () => void ab.humanDone(projectId, waiting.id))
    callout.append(heading, text, act)
    wrap.append(callout)
  }

  const agentSection = el('div', 'section')
  agentSection.append(el('h2', '', 'Agents here'))
  if (agents.length === 0) {
    agentSection.append(
      el('div', 'empty', `No agent is connected. Point one at ${projectName} and it will show up here.`),
    )
  } else {
    for (const agent of agents) {
      const row = el('div', 'agent')
      row.append(el('span', 'dot'))
      row.append(el('span', '', agent.label))
      row.append(el('span', 'ide', agent.ide))
      agentSection.append(row)
    }
  }
  wrap.append(agentSection)

  const log = el('div', 'log')
  const heading = el('h2', '', 'What happened')
  heading.style.margin = '0 0 8px'
  heading.style.fontSize = '0.85rem'
  heading.style.letterSpacing = '0.04em'
  heading.style.textTransform = 'uppercase'
  heading.style.color = 'var(--text-dim)'
  log.append(heading)

  if (activity.length === 0) {
    log.append(el('div', 'empty', 'Every action an agent takes is listed here as it happens.'))
  } else {
    for (const entry of activity) {
      const row = el('div', 'entry')
      row.append(el('span', 'who', entry.agent))
      row.append(el('span', 'when', clock(entry.at)))
      row.append(el('span', 'what', entry.text))
      log.append(row)
    }
  }
  wrap.append(log)
  return wrap
}

// ---------------------------------------------------------------------- utils

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
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
  render()
})
ab.on('agents', (payload) => {
  agents = payload as AgentRow[]
  render()
})
ab.on('activity', (payload) => {
  activity = payload as ActivityRow[]
  render()
})

void ab.state(projectId).then((state) => {
  if (!state) return
  tabs = state.tabs
  agents = state.agents
  activity = state.activity
  render()
})

render()
