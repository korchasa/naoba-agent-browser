import type { AgentCommand, AgentRow, TabDescriptor } from '../main/protocol.ts'

export type { AgentRow }

/** An agent and the tabs it opened. */
export interface TreeGroup {
  id: string
  label: string
  /** The badge: the agent's IDE. */
  ide: string
  /** Disconnected; its tabs are here until the grace period runs out. */
  gone: boolean
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
 * marked with the borrower's name. The person's own actions land the same way:
 * the person has no branch of their own, because they work alongside an
 * agent, never apart from one.
 *
 * An agent that has gone keeps its row, dimmed, for as long as tabs of its
 * own are open — the main process lists it among the agents until then. A
 * tab whose owner is in no list at all still gets a row to hang under, since
 * a tab in no branch is one nobody can select or close.
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
    gone: agent.gone,
    tabs: [],
  }))
  const byAgent = new Map(groups.map((group) => [group.id, group]))
  for (const tab of [...tabs].sort((a, b) => a.index - b.index)) {
    const entry: TreeTab = { tab, commands: [...(commands.get(tab.id) ?? [])] }
    const ownerId = tab.openedBy ?? 'nobody'
    let owner = byAgent.get(ownerId)
    if (!owner) {
      owner = { id: ownerId, label: tab.openedBy ? 'an agent that left' : 'nobody', ide: 'gone', gone: true, tabs: [] }
      byAgent.set(ownerId, owner)
      groups.push(owner)
    }
    owner.tabs.push(entry)
  }
  return groups
}

export function groupKey(group: TreeGroup): string {
  return `group:${group.id}`
}

export function tabKey(group: TreeGroup, tab: TabDescriptor): string {
  return `tab:${group.id}:${tab.id}`
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
