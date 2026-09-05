import type { AgentCommand, AgentRow, TabDescriptor } from '../main/protocol.ts'

export type { AgentRow }

/** A project as the panel holds it: what the main process has said about it so far. */
export interface ProjectState {
  id: string
  name: string
  root: string
  tabs: TabDescriptor[]
  agents: AgentRow[]
  commands: Map<string, AgentCommand[]>
}

/** The top of the tree: a project, and the agents working in it. */
export interface TreeProject {
  id: string
  name: string
  root: string
  groups: TreeGroup[]
}

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

/** Every project, its agents in the chosen order, and under them the tabs and calls. */
export function buildForest(projects: Iterable<ProjectState>, mode: SortMode): TreeProject[] {
  return [...projects].map((project) => ({
    id: project.id,
    name: project.name,
    root: project.root,
    groups: sortGroups(buildTree(project.tabs, project.agents, project.commands), mode),
  }))
}

/**
 * Turn a project's state into the levels the panel draws under it.
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

/** The order the agents' groups are drawn in. */
export type SortMode = 'arrival' | 'activity' | 'name'

export const SORT_MODES: readonly { mode: SortMode; label: string }[] = [
  { mode: 'arrival', label: 'In order of arrival' },
  { mode: 'activity', label: 'Most recent activity first' },
  { mode: 'name', label: 'By name' },
]

/**
 * Put the groups in the chosen order. `arrival` is the order the main process
 * lists agents in — connection order, the departed ones last. `activity` puts
 * the agent with the newest call first, so the one working right now is at
 * the top; an agent that has done nothing yet sinks. Ties keep arrival order.
 */
export function sortGroups(groups: readonly TreeGroup[], mode: SortMode): TreeGroup[] {
  const arrival = new Map(groups.map((group, at) => [group, at]))
  const latest = (group: TreeGroup): number =>
    Math.max(0, ...group.tabs.flatMap((entry) => entry.commands.map((command) => command.at)))
  const sorted = [...groups]
  if (mode === 'activity') {
    sorted.sort((a, b) => latest(b) - latest(a) || arrival.get(a)! - arrival.get(b)!)
  } else if (mode === 'name') {
    sorted.sort((a, b) => a.label.localeCompare(b.label) || arrival.get(a)! - arrival.get(b)!)
  }
  return sorted
}

export function projectKey(project: TreeProject): string {
  return `project:${project.id}`
}

export function groupKey(project: TreeProject, group: TreeGroup): string {
  return `group:${project.id}:${group.id}`
}

export function tabKey(project: TreeProject, group: TreeGroup, tab: TabDescriptor): string {
  return `tab:${project.id}:${group.id}:${tab.id}`
}

/**
 * Open a branch the first time it is seen: a project and an agent when they
 * appear. A tab stays folded — its calls are there for when the person wants
 * them, and a tree that unrolls every call of every agent is a log, not a tree.
 *
 * `seen` is what makes this safe to call on every render. Seeding once at
 * startup would leave every agent that connects later as a collapsed row
 * hiding its own work, and re-seeding every time would spring open a branch
 * the person had just folded shut. So each key is decided once, when it first
 * turns up, and never again.
 */
export function expandNew(projects: readonly TreeProject[], seen: Set<string>, open: Set<string>): void {
  const first = (key: string): boolean => {
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
  for (const project of projects) {
    if (first(projectKey(project))) open.add(projectKey(project))
    for (const group of project.groups) {
      if (first(groupKey(project, group))) open.add(groupKey(project, group))
      for (const entry of group.tabs) first(tabKey(project, group, entry.tab))
    }
  }
}
