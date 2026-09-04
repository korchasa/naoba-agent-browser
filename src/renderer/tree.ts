import type { AgentCommand, TabDescriptor } from '../main/protocol.ts'

/** An agent as the panel knows it. */
export interface AgentRow {
  id: string
  label: string
  ide: string
  tabId: string | null
}

/** One actor and the tabs it opened: an agent, or the person. */
export interface TreeGroup {
  /** The agent's id, or `null` for the person. */
  id: string | null
  label: string
  /** The badge: the agent's IDE, or `you`. */
  ide: string
  tabs: TreeTab[]
}

export interface TreeTab {
  tab: TabDescriptor
  /** Everything done in this tab, by anyone: the agent, another agent, the person. */
  commands: AgentCommand[]
}

/**
 * Turn the window's state into the levels the panel draws.
 *
 * A tab belongs to the agent that opened it, and its history holds every call
 * made in it, whoever made it. So a tab borrowed with `selectTab` stays in
 * one place, and the borrower's calls read in order next to the owner's,
 * marked with the borrower's name. The person's own actions land the same way.
 *
 * The person is an actor like the others, drawn last: their group holds the
 * tabs they opened by hand and any tab whose agent has gone — a tab in no
 * branch would be one nobody can select or close. The group is left out
 * while it is empty.
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
  const byAgent = new Map(groups.map((group) => [group.id, group]))
  const mine: TreeGroup = { id: null, label: 'you', ide: 'you', tabs: [] }
  for (const tab of [...tabs].sort((a, b) => a.index - b.index)) {
    const entry: TreeTab = { tab, commands: [...(commands.get(tab.id) ?? [])] }
    const owner = tab.openedBy ? byAgent.get(tab.openedBy) : undefined
    ;(owner ?? mine).tabs.push(entry)
  }
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
