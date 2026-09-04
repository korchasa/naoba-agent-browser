import type { AgentCommand, TabDescriptor } from '../main/protocol.ts'

/** An agent as the panel knows it. */
export interface AgentRow {
  id: string
  label: string
  ide: string
  tabId: string | null
}

/** An agent and the tabs it opened. */
export interface TreeGroup {
  id: string
  label: string
  ide: string
  tabs: TreeTab[]
}

export interface TreeTab {
  tab: TabDescriptor
  /** Everything done in this tab, by anyone: the agent, another agent, the person. */
  commands: AgentCommand[]
}

export interface Tree {
  groups: TreeGroup[]
  /**
   * Tabs with no agent to hang under: opened by the person, or left behind by
   * an agent that has gone. They stand at the top level with no heading —
   * a heading would make an actor out of a section.
   */
  loose: TreeTab[]
}

/**
 * Turn the window's state into the levels the panel draws.
 *
 * A tab belongs to the agent that opened it, and its history holds every call
 * made in it, whoever made it. So a tab borrowed with `selectTab` stays in
 * one place, and the borrower's calls read in order next to the owner's,
 * marked with the borrower's name. The person's own actions land the same way.
 */
export function buildTree(
  tabs: readonly TabDescriptor[],
  agents: readonly AgentRow[],
  commands: ReadonlyMap<string, readonly AgentCommand[]>,
): Tree {
  const groups: TreeGroup[] = agents.map((agent) => ({
    id: agent.id,
    label: agent.label,
    ide: agent.ide,
    tabs: [],
  }))
  const byAgent = new Map(groups.map((group) => [group.id, group]))
  const loose: TreeTab[] = []
  for (const tab of [...tabs].sort((a, b) => a.index - b.index)) {
    const entry: TreeTab = { tab, commands: [...(commands.get(tab.id) ?? [])] }
    const owner = tab.openedBy ? byAgent.get(tab.openedBy) : undefined
    if (owner) owner.tabs.push(entry)
    else loose.push(entry)
  }
  return { groups, loose }
}

export function groupKey(group: TreeGroup): string {
  return `group:${group.id}`
}

export function tabKey(group: TreeGroup | null, tab: TabDescriptor): string {
  return `tab:${group?.id ?? 'loose'}:${tab.id}`
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
export function expandNew(tree: Tree, seen: Set<string>, open: Set<string>): void {
  const tabs: [TreeGroup | null, TreeTab][] = tree.loose.map((entry) => [null, entry])
  for (const group of tree.groups) {
    const key = groupKey(group)
    if (!seen.has(key)) {
      seen.add(key)
      open.add(key)
    }
    for (const entry of group.tabs) tabs.push([group, entry])
  }
  for (const [group, entry] of tabs) {
    const tab = tabKey(group, entry.tab)
    if (seen.has(tab)) continue
    seen.add(tab)
    if (entry.tab.active) open.add(tab)
  }
}
