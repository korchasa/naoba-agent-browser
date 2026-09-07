import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { identify, normalizeRoot, projectIdFor, resolveProjectRoot } from '../src/main/project.ts'
import { KeyedQueue, QueueTimeout } from '../src/main/queue.ts'
import { LeaseTable } from '../src/main/lease.ts'
import { toTransferable } from '../src/main/serialize.ts'
import { decodeLines } from '../src/main/protocol.ts'
import { CommandLog } from '../src/main/commands.ts'
import { buildTree, expandNew, groupKey, projectKey, sortGroups, tabKey } from '../src/renderer/tree.ts'

test('a project is the repository the agent is working in, not its subdirectory', () => {
  const base = mkdtempSync(join(tmpdir(), 'ab-project-'))
  mkdirSync(join(base, '.git'))
  mkdirSync(join(base, 'src', 'deep'), { recursive: true })

  assert.equal(resolveProjectRoot(join(base, 'src', 'deep')), resolveProjectRoot(base))
  assert.equal(identify(join(base, 'src')).id, identify(base).id)
})

test('a directory outside a repository is its own project', () => {
  const base = mkdtempSync(join(tmpdir(), 'ab-loose-'))
  mkdirSync(join(base, 'inner'))
  assert.notEqual(identify(join(base, 'inner')).id, identify(base).id)
})

test('one directory spelled two ways is one project', () => {
  // The volume is case-insensitive, so these are the same directory and must
  // not end up with two windows and two sets of cookies.
  assert.equal(projectIdFor('/Users/x/WWW/Thing'), projectIdFor('/Users/x/www/thing'))
  assert.equal(normalizeRoot('/Users/x/thing/'), normalizeRoot('/Users/x/thing'))
})

test('a partition name never carries the path', () => {
  const id = projectIdFor('/Users/someone/private/client-work')
  assert.match(id, /^[0-9a-f]{16}$/)
  assert.ok(!id.includes('client'))
})

test('two agents against one tab run one after the other, never interleaved', async () => {
  const queue = new KeyedQueue()
  const order = []
  const slow = queue.run('tab', async () => {
    order.push('a-start')
    await new Promise((resolve) => setTimeout(resolve, 60))
    order.push('a-end')
    return 'a'
  })
  const quick = queue.run('tab', async () => {
    order.push('b-start')
    order.push('b-end')
    return 'b'
  })
  assert.deepEqual(await Promise.all([slow, quick]), ['a', 'b'])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
})

test('one failing task does not poison the tab for the next one', async () => {
  const queue = new KeyedQueue()
  const failed = queue.run('tab', async () => {
    throw new Error('nope')
  })
  await assert.rejects(failed, /nope/)
  assert.equal(await queue.run('tab', async () => 'still works'), 'still works')
})

test('different tabs do not wait for each other', async () => {
  const queue = new KeyedQueue()
  let released
  const blocker = new Promise((resolve) => (released = resolve))
  const held = queue.run('tab-1', () => blocker)
  const other = await queue.run('tab-2', async () => 'free')
  assert.equal(other, 'free')
  released('done')
  await held
})

test('a task that waits too long is told who is holding the tab', async () => {
  let now = 0
  const queue = new KeyedQueue(() => now)
  let release
  const blocker = new Promise((resolve) => (release = resolve))
  const first = queue.run('tab', () => blocker, { label: 'agent-one' })
  const second = queue.run('tab', async () => 'never', { label: 'agent-two', waitMs: 100 })
  now = 500
  release('done')
  await first
  await assert.rejects(second, (error) => error instanceof QueueTimeout && /agent-one/.test(error.message))
})

test('a lease keeps a second agent out and lets the first one back in', () => {
  const table = new LeaseTable()
  const one = { kind: 'agent', id: '1', label: 'one' }
  const two = { kind: 'agent', id: '2', label: 'two' }
  assert.deepEqual(table.claim('tab', one, 1000), { ok: true })
  assert.deepEqual(table.claim('tab', two, 1000), { ok: false, heldBy: one })
  assert.deepEqual(table.claim('tab', one, 1000), { ok: true })
})

test('a crashed agent cannot hold a tab forever', () => {
  let now = 0
  const table = new LeaseTable(() => now)
  table.claim('tab', { kind: 'agent', id: '1', label: 'one' }, 1000)
  now = 999
  assert.ok(table.holderOf('tab'))
  now = 1001
  assert.equal(table.holderOf('tab'), null)
})

test('the person always wins a tab, and the agent is told', () => {
  const table = new LeaseTable()
  const events = []
  table.onChange((event) => events.push(event.type))
  const agent = { kind: 'agent', id: '1', label: 'one' }
  table.claim('tab', agent, 10_000)
  const previous = table.takeOver('tab', { kind: 'human' })
  assert.deepEqual(previous, agent)
  assert.deepEqual(table.holderOf('tab'), { kind: 'human' })
  assert.deepEqual(events, ['claimed', 'taken-over'])
})

test('a disconnect drops every tab that agent was holding', () => {
  const table = new LeaseTable()
  const agent = { kind: 'agent', id: '1', label: 'one' }
  table.claim('tab-1', agent, 10_000)
  table.claim('tab-2', agent, 10_000)
  table.claim('tab-3', { kind: 'agent', id: '2', label: 'two' }, 10_000)
  assert.deepEqual(table.releaseAll(agent).sort(), ['tab-1', 'tab-2'])
  assert.ok(table.holderOf('tab-3'))
})

test('a value that cannot be JSON says what it was instead of vanishing', () => {
  const cyclic = { name: 'root' }
  cyclic.self = cyclic
  assert.deepEqual(toTransferable(cyclic), { name: 'root', self: { $type: 'cycle' } })
  assert.deepEqual(toTransferable(undefined), { $type: 'undefined' })
  assert.deepEqual(toTransferable(() => 1), { $type: 'function', name: '(anonymous)' })
  assert.deepEqual(toTransferable(Number.NaN), { $type: 'number', value: 'NaN' })

  const error = toTransferable(new Error('broken'))
  assert.equal(error.$type, 'error')
  assert.equal(error.message, 'broken')

  const long = toTransferable('x'.repeat(20), { maxDepth: 4, maxStringLength: 5, maxArrayLength: 5, maxKeys: 5 })
  assert.equal(long.$type, 'truncated-string')
  assert.equal(long.length, 20)
})

test('the wire splits on lines and keeps the unfinished tail', () => {
  const first = decodeLines('{"type":"a"}\n{"type":"b"}\n{"ty')
  assert.deepEqual(first.messages, [{ type: 'a' }, { type: 'b' }])
  assert.equal(first.rest, '{"ty')
  const second = decodeLines(first.rest + 'pe":"c"}\n')
  assert.deepEqual(second.messages, [{ type: 'c' }])
})

// ------------------------------------------------------- the panel's own tree

const tabAt = (index, id, openedBy, extra = {}) => ({
  id,
  index,
  title: id,
  url: `https://example.com/${id}`,
  active: false,
  loading: false,
  heldBy: null,
  waitingForHuman: null,
  openedBy,
  ...extra,
})

const said = (agentId, agentLabel, text) => ({ at: 1, agentId, agentLabel, text })
const here = (id, label, ide, tabId = null) => ({ id, label, ide, tabId, gone: false })

test('a tab hangs under the agent that opened it', () => {
  const groups = buildTree(
    [tabAt(0, 'tab-a', 'agent-1')],
    [here('agent-1', 'claude', 'claude', 'tab-a')],
    new Map(),
  )
  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, 'agent-1')
  assert.deepEqual(groups[0].tabs.map((entry) => entry.tab.id), ['tab-a'])
})

test('a borrowed tab stays in one place, and its history keeps every call in order', () => {
  // The point of sharing a window is that an agent can pick up another's tab.
  // The tree answers "where is the tab" once, and the history says who did
  // what in it — the borrower's calls next to the owner's, not in a copy of
  // the tab under a second name.
  const commands = new Map([[
    'tab-a',
    [
      said('agent-2', 'codex', 'click(button.pay)'),
      said('agent-1', 'claude', 'fill(#coupon)'),
      said(null, 'you', 'went to /'),
    ],
  ]])
  const groups = buildTree(
    [tabAt(0, 'tab-a', 'agent-1')],
    [
      here('agent-1', 'claude', 'claude', 'tab-a'),
      here('agent-2', 'codex', 'codex', 'tab-a'),
    ],
    commands,
  )
  assert.deepEqual(groups.map((group) => group.tabs.length), [1, 0])
  assert.deepEqual(groups[0].tabs[0].commands.map((entry) => entry.text), [
    'click(button.pay)',
    'fill(#coupon)',
    'went to /',
  ])
})

test('an agent that has gone keeps its row, marked, while its tabs are still here', () => {
  const groups = buildTree(
    [tabAt(0, 'left-behind', 'agent-gone'), tabAt(1, 'theirs', 'agent-1')],
    [here('agent-1', 'claude', 'claude', 'theirs'), {
      id: 'agent-gone',
      label: 'codex',
      ide: 'codex',
      tabId: null,
      gone: true,
    }],
    new Map(),
  )
  assert.deepEqual(groups.map((group) => [group.id, group.gone]), [['agent-1', false], ['agent-gone', true]])
  assert.deepEqual(groups[1].tabs.map((entry) => entry.tab.id), ['left-behind'])
})

test('a tab whose owner is in no list still gets a row, never falls out of the tree', () => {
  // Otherwise it is in the window and in no branch: nobody can select it and
  // nobody can close it.
  const groups = buildTree([tabAt(0, 'orphan', 'agent-unknown'), tabAt(1, 'stray', null)], [], new Map())
  assert.deepEqual(groups.map((group) => [group.id, group.gone]), [['agent-unknown', true], ['nobody', true]])
  assert.deepEqual(groups[0].tabs.map((entry) => entry.tab.id), ['orphan'])
})

test('an agent with no tab still has a place in the tree', () => {
  const groups = buildTree([], [here('agent-1', 'claude', 'claude')], new Map())
  assert.deepEqual(groups.map((group) => group.id), ['agent-1'])
  assert.deepEqual(groups[0].tabs, [])
})

test('the agents can be ordered by arrival, by latest activity, or by name', () => {
  const at = (when) => ({ at: when, agentId: 'x', agentLabel: 'x', text: 'click(a)' })
  const groups = buildTree(
    [tabAt(0, 'tab-a', 'agent-1'), tabAt(1, 'tab-b', 'agent-2'), tabAt(2, 'tab-c', 'agent-3')],
    [
      here('agent-1', 'cursor', 'cursor', 'tab-a'),
      here('agent-2', 'claude', 'claude', 'tab-b'),
      here('agent-3', 'bob', 'codex', 'tab-c'),
    ],
    new Map([['tab-a', [at(10)]], ['tab-b', [at(5), at(30)]]]),
  )
  const names = (list) => list.map((group) => group.label)
  assert.deepEqual(names(sortGroups(groups, 'arrival')), ['cursor', 'claude', 'bob'])
  // The busiest agent on top; one that has done nothing sinks to the bottom.
  assert.deepEqual(names(sortGroups(groups, 'activity')), ['claude', 'cursor', 'bob'])
  assert.deepEqual(names(sortGroups(groups, 'name')), ['bob', 'claude', 'cursor'])
  assert.deepEqual(names(groups), ['cursor', 'claude', 'bob'], 'the input is left as it was')
})

test('the tree opens on every agent and keeps every tab folded', () => {
  const groups = buildTree(
    [tabAt(0, 'tab-a', 'agent-1', { active: true }), tabAt(1, 'tab-b', 'agent-1')],
    [here('agent-1', 'claude', 'claude', 'tab-a')],
    new Map(),
  )
  const project = { id: 'p1', name: 'checkout', root: '/x', groups }
  const open = new Set()
  expandNew([project], new Set(), open)
  assert.ok(open.has(projectKey(project)))
  assert.ok(open.has(groupKey(project, groups[0])))
  assert.ok(!open.has(tabKey(project, groups[0], groups[0].tabs[0].tab)), 'the tab in front stays folded too')
  assert.ok(!open.has(tabKey(project, groups[0], groups[0].tabs[1].tab)))
})

test('an agent that connects later opens too, and a branch folded by hand stays folded', () => {
  // Agents come and go all day. A group seeded once and never again means every
  // agent but the first is a collapsed row hiding its own work.
  const seen = new Set()
  const open = new Set()
  const within = (groups) => ({ id: 'p1', name: 'checkout', root: '/x', groups })
  const first = within(buildTree([], [here('agent-1', 'claude', 'claude')], new Map()))
  expandNew([first], seen, open)
  open.delete(groupKey(first, first.groups[0]))

  const later = within(buildTree([], [
    here('agent-1', 'claude', 'claude'),
    here('agent-2', 'codex', 'codex'),
  ], new Map()))
  expandNew([later], seen, open)

  assert.ok(!open.has(groupKey(later, later.groups[0])), 'the folded branch stays folded')
  assert.ok(open.has(groupKey(later, later.groups[1])), 'the new agent opens')
})

test('a tab keeps its newest calls and drops the oldest', () => {
  const log = new CommandLog(3)
  for (const text of ['one', 'two', 'three', 'four']) log.add(said('agent-1', 'claude', text))
  assert.deepEqual(log.entries.map((entry) => entry.text), ['four', 'three', 'two'])
})

test('the bridge tries the release copy, then the development copy, then a checkout', async () => {
  const { candidates } = await import('../packages/bridge/launch.mjs')
  const kinds = candidates({ HOME: '/Users/x', NAOBA_DEV_ROOT: '/checkout' }).map((c) => c.kind)
  assert.deepEqual(kinds, [
    'bundle-id',
    'applications',
    'home-applications',
    'dev-bundle-id',
    'dev-applications',
    'dev-home-applications',
    'dev',
  ])
  const paths = candidates({ HOME: '/Users/x' }).map((c) => c.path)
  assert.ok(paths.includes('/Applications/Naoba Dev.app'))
  assert.ok(paths.includes('dev.korchasa.Naoba.dev'))
  // An explicit path wins over everything, and a missing checkout adds nothing.
  assert.equal(candidates({ HOME: '/Users/x', NAOBA_APP: '/x/Naoba.app' })[0].kind, 'explicit')
  assert.ok(!candidates({ HOME: '/Users/x' }).some((c) => c.kind === 'dev'))
})
