import type { AgentCommand, TabDescriptor } from '../main/protocol.ts'

/** An agent as the panel knows it. */
export interface AgentRow {
  id: string
  label: string
  ide: string
  tabId: string | null
}

/** One actor and the tabs it has been in: an agent, or the person. */
export interface TreeGroup {
  /** The agent's id, or `null` for the person. */
  id: string | null
  label: string
  ide: string
  tabs: TreeTab[]
}

export interface TreeTab {
  tab: TabDescriptor
  /** Only this actor's calls in this tab. */
  commands: AgentCommand[]
}

/**
 * Turn the window's state into the three levels the panel draws.
 *
 * A tab belongs to an actor when that actor opened it or has done something in
 * it. Both halves matter: an agent that picks up another's tab with
 * `selectTab` has to appear against that tab, or the panel answers "whose tab
 * is this" with one name when the honest answer is two.
 */
export function buildTree(
  tabs: readonly TabDescriptor[],
  agents: readonly AgentRow[],
  commands: ReadonlyMap<string, readonly AgentCommand[]>,
): TreeGroup[] {
  const groups: TreeGroup[] = agents.map((agent) => ({
    id: agent.id,
    label: agent.label,
    ide: agent.ide,
    tabs: [],
  }))
  // The person comes last: an agent's work is what the panel is watched for,
  // and the tabs somebody opened by hand are the quiet end of the list.
  const mine: TreeGroup = { id: null, label: 'You', ide: '', tabs: [] }

  const ordered = [...tabs].sort((a, b) => a.index - b.index)
  const claimed = new Set<string>()
  for (const group of [...groups, mine]) {
    for (const tab of ordered) {
      const theirs = (commands.get(tab.id) ?? []).filter((command) => command.agentId === group.id)
      if (tab.openedBy !== group.id && theirs.length === 0) continue
      group.tabs.push({ tab, commands: theirs })
      claimed.add(tab.id)
    }
  }

  // A tab whose agent has disconnected belongs to nobody, and a tab in no
  // branch is a tab in the window that cannot be selected or closed. It falls
  // to the person, who is the one left to deal with it.
  for (const tab of ordered) {
    if (claimed.has(tab.id)) continue
    mine.tabs.push({ tab, commands: (commands.get(tab.id) ?? []).filter((command) => command.agentId === null) })
  }
  mine.tabs.sort((a, b) => a.tab.index - b.tab.index)

  return mine.tabs.length > 0 ? [...groups, mine] : groups
}

export function groupKey(group: TreeGroup): string {
  return `group:${group.id ?? 'you'}`
}

export function tabKey(group: TreeGroup, tab: TabDescriptor): string {
  return `tab:${group.id ?? 'you'}:${tab.id}`
}

/**
 * Open a branch the first time it is seen: an actor when it appears, and the
 * tab in front of it.
 *
 * `seen` is what makes this safe to call on every render. Seeding once at
 * startup would leave every agent that connects later as a collapsed row
 * hiding its own work, and re-seeding every time would spring open a branch
 * the person had just folded shut. So each key is decided once, when it first
 * turns up, and never again.
 */
export function expandNew(groups: readonly TreeGroup[], seen: Set<string>, open: Set<string>): void {
  for (const group of groups) {
    const key = groupKey(group)
    if (!seen.has(key)) {
      seen.add(key)
      open.add(key)
    }
    for (const entry of group.tabs) {
      const tab = tabKey(group, entry.tab)
      if (seen.has(tab)) continue
      seen.add(tab)
      if (entry.tab.active) open.add(tab)
    }
  }
}
