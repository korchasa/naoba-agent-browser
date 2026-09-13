import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createContext, Script } from 'node:vm'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { identify, normalizeRoot, projectIdFor, resolveProjectRoot } from '../src/main/project.ts'
import { resolveUploadPaths, resolveWritePath, within } from '../src/main/files.ts'
import { KeyedQueue, QueueTimeout } from '../src/main/queue.ts'
import { LeaseTable } from '../src/main/lease.ts'
import { toTransferable } from '../src/main/serialize.ts'
import { decodeLines } from '../src/main/protocol.ts'
import { CommandLog } from '../src/main/commands.ts'
import { describeVisits, VISIT_LIMIT, VisitLog } from '../src/main/visits.ts'
import { CallTrail, recordCalls, TRAIL_LIMIT, TRAIL_LIMITS } from '../src/main/trail.ts'
import { renderError, renderOutcome } from '../packages/mcp-server/render.mjs'
import { describePattern, matcherFor } from '../src/main/urls.ts'
import { buildTree, expandNew, groupKey, projectKey, sortGroups, tabKey } from '../src/renderer/tree.ts'
import { documentedNames, fullReference, helpFor, namesIn, TOOL_DESCRIPTION } from '../packages/mcp-server/reference.mjs'
import { TOOLS } from '../packages/mcp-server/tools.mjs'
import { noTokenFound, stateDirs, tokensForPort } from '../packages/mcp-server/handshake.mjs'
import { candidates, owningBundle } from '../packages/mcp-server/launch.mjs'
import { mcpServerCommand, mcpServerEntry } from '../src/main/mcp-server-path.ts'
import {
  activateRequest,
  admitsWithoutKey,
  asksWhoYouAre,
  describeFreeCopy,
  checkRequest,
  deactivateRequest,
  describe,
  GRACE_DAYS,
  newUid,
  recordFrom,
  refreshed,
  verdict,
} from '../src/main/licence.ts'
import { describeUpdate, updatesItself } from '../src/main/update-rules.ts'

test('a project is the repository the agent is working in, not its subdirectory', () => {
  const base = mkdtempSync(join(tmpdir(), 'ab-project-'))
  mkdirSync(join(base, '.git'))
  mkdirSync(join(base, 'src', 'deep'), { recursive: true })

  assert.equal(resolveProjectRoot(join(base, 'src', 'deep')), resolveProjectRoot(base))
  assert.equal(identify(join(base, 'src')).id, identify(base).id)
})

test("a sibling whose name starts with the project's is not inside it", () => {
  // `startsWith` would admit it, which is why the check is `relative`.
  assert.equal(within('/a/project', '/a/project/photo.jpg'), true)
  assert.equal(within('/a/project', '/a/project'), true)
  assert.equal(within('/a/project', '/a/project-evil/photo.jpg'), false)
  assert.equal(within('/a/project', '/a'), false)
  assert.equal(within('/a/project', '/elsewhere/photo.jpg'), false)
})

test('a file to upload is taken from the project, whatever spelling of it the agent used', async () => {
  // On macOS `mkdtemp` hands back a path under /var, which is a symlink to
  // /private/var — and `identify()` resolves the project root through realpath.
  // So the two sides of this check are spelled differently for the same
  // directory, which is exactly the case a string comparison gets wrong.
  const project = mkdtempSync(join(tmpdir(), 'ab-upload-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'ab-elsewhere-'))
  writeFileSync(join(project, 'photo.jpg'), 'bytes')
  writeFileSync(join(elsewhere, 'secret'), 'not yours')
  symlinkSync(join(elsewhere, 'secret'), join(project, 'link-out'))
  const boundary = { roots: [realpathSync(project)], describe: 'the project' }

  assert.deepEqual(
    await resolveUploadPaths([join(project, 'photo.jpg')], boundary),
    [join(realpathSync(project), 'photo.jpg')],
  )
  // A path with no root of its own belongs to the project, not to whatever
  // directory this process happens to be started in.
  assert.deepEqual(await resolveUploadPaths(['photo.jpg'], boundary), [join(realpathSync(project), 'photo.jpg')])

  await assert.rejects(
    () => resolveUploadPaths([join(elsewhere, 'secret')], boundary),
    /outside this project/,
  )
  // Inside the project until it is followed.
  await assert.rejects(() => resolveUploadPaths([join(project, 'link-out')], boundary), /outside this project/)
  // A neighbour whose name merely begins with the project's.
  await assert.rejects(() => resolveUploadPaths([`${project}-evil/photo.jpg`], boundary), /outside this project/)
  // The project's own missing file is missing, not an intruder.
  await assert.rejects(() => resolveUploadPaths([join(project, 'nope.jpg')], boundary), /no file at/)
  await assert.rejects(() => resolveUploadPaths([project], boundary), /directory/)
})

test('a screenshot is written inside the project, and nowhere else', async () => {
  const project = mkdtempSync(join(tmpdir(), 'ab-write-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'ab-elsewhere-write-'))
  symlinkSync(elsewhere, join(project, 'out'))
  const boundary = { roots: [realpathSync(project)], describe: 'the project' }

  assert.equal(await resolveWritePath(join(project, 'page.png'), boundary), join(realpathSync(project), 'page.png'))
  // A path with no root of its own belongs to the project, and the directory it
  // names need not exist — a picture usually lands in one that does not.
  assert.equal(
    await resolveWritePath('pictures/page.png', boundary),
    join(realpathSync(project), 'pictures', 'page.png'),
  )
  // A root spelled through a symlink — `/tmp` is `/private/tmp`, and a root that
  // does not exist yet is left unresolved by `identify()` — still owns its own
  // files, because both sides are resolved as far as the directories that exist.
  const unresolved = { roots: [project], describe: 'the project' }
  assert.equal(
    await resolveWritePath('page.png', unresolved),
    join(realpathSync(project), 'page.png'),
  )

  await assert.rejects(() => resolveWritePath(join(elsewhere, 'page.png'), boundary), /outside this project/)
  // Inside the project until the symlink is followed.
  await assert.rejects(() => resolveWritePath(join(project, 'out', 'page.png'), boundary), /outside this project/)
  await assert.rejects(() => resolveWritePath(`${project}-evil/page.png`, boundary), /outside this project/)
  await assert.rejects(() => resolveWritePath(project, boundary), /directory/)
  await assert.rejects(() => resolveWritePath('', boundary), /takes a path/)
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

test('a promise the scenario forgot to await is named, not an empty object', () => {
  // The shape a recorded session got wrong 18 times: a helper's promise,
  // returned without `await`, read back as `{}` and taken for "there was no URL".
  const fromHelper = toTransferable({ url: Promise.resolve('https://example.test') })
  assert.equal(fromHelper.url.$type, 'promise')
  assert.match(fromHelper.url.hint, /await/)

  // A scenario runs in a vm context with its own intrinsics, so a promise it
  // builds itself is not this realm's Promise — and has no own keys either.
  const ownRealm = new Script('(async () => 1)()').runInContext(createContext({}))
  assert.equal(ownRealm instanceof Promise, false)
  assert.equal(toTransferable(ownRealm).$type, 'promise')

  // `await` unwraps anything with a callable `then`, so a thenable is the same
  // mistake and gets the same answer.
  const thenable = {
    then(resolve) {
      resolve(1)
    },
  }
  assert.equal(toTransferable(thenable).$type, 'promise')
  // A `then` that is not callable is ordinary data and stays that way.
  assert.deepEqual(toTransferable({ then: 'later' }), { then: 'later' })
})

test('a builtin the scenario built itself keeps its marker across the realm boundary', () => {
  // Everything a scenario builds comes from its own vm realm, where `instanceof`
  // answers false — and none of these five carries own enumerable keys, so each
  // used to fall out of key enumeration as `{}`.
  const source = `({
    err: new Error('boom'),
    when: new Date(0),
    re: /x/g,
    map: new Map([['k', 1]]),
    set: new Set([1, 2]),
    list: [1, 2],
  })`
  const built = new Script(source).runInContext(createContext({}))
  assert.equal(built.err instanceof Error, false)
  assert.equal(built.map instanceof Map, false)

  const there = toTransferable(built)
  assert.equal(there.err.$type, 'error')
  assert.equal(there.err.message, 'boom')
  assert.equal(there.when.$type, 'date')
  assert.equal(there.when.value, '1970-01-01T00:00:00.000Z')
  assert.deepEqual(there.re, { $type: 'regexp', value: '/x/g' })
  assert.deepEqual(there.map, { $type: 'map', entries: [['k', 1]] })
  assert.deepEqual(there.set, { $type: 'set', values: [1, 2] })
  // `Array.isArray` crosses realms by design, so arrays were never affected.
  // The walked copy is still that realm's Array, which `deepStrictEqual` counts
  // as a different type and `JSON.stringify` does not care about at all.
  assert.equal(Array.isArray(there.list), true)
  assert.deepEqual([...there.list], [1, 2])

  // The same five built here answer exactly as they always did.
  const here = toTransferable({
    err: new Error('boom'),
    when: new Date(0),
    re: /x/g,
    map: new Map([['k', 1]]),
    set: new Set([1, 2]),
  })
  assert.equal(here.err.$type, 'error')
  assert.equal(here.when.value, there.when.value)
  assert.deepEqual(here.re, there.re)
  assert.deepEqual(here.map, there.map)
  assert.deepEqual(here.set, there.set)
})

test('a borrowed toStringTag is data, not a builtin', () => {
  // `Symbol.toStringTag` is writable, so the tag alone cannot be acted on: a
  // Map branch that trusted it would call `entries()` on this and throw, and a
  // throw in `walk` costs the whole result rather than one value.
  const borrowed = toTransferable({
    map: { [Symbol.toStringTag]: 'Map', size: 3 },
    set: { [Symbol.toStringTag]: 'Set', size: 3 },
    when: { [Symbol.toStringTag]: 'Date', at: 'noon' },
    re: { [Symbol.toStringTag]: 'RegExp', pattern: 'x' },
  })
  assert.deepEqual(borrowed.map, { size: 3 })
  assert.deepEqual(borrowed.set, { size: 3 })
  assert.deepEqual(borrowed.when, { at: 'noon' })
  assert.deepEqual(borrowed.re, { pattern: 'x' })

  // An Invalid Date is the same hazard from the other side: `toISOString`
  // answers it with a RangeError.
  assert.deepEqual(toTransferable(new Date('nonsense')), { $type: 'date', value: null, invalid: true })
})

test('a value that cannot be read costs its own key, never the result', () => {
  // Reading a value is the one thing this file does, and it must not be the
  // thing that destroys the answer. Four reads can throw; each is marked, and
  // every sibling in the same result survives.
  const halfWay = {
    [Symbol.toStringTag]: 'Set',
    values() {
      let sent = 0
      return {
        [Symbol.iterator]() {
          return this
        },
        next() {
          if (sent++) throw new Error('half way')
          return { value: 1, done: false }
        },
      }
    },
  }
  const out = toTransferable({
    // Tag and members all present, and the iteration still yields something the
    // map branch cannot destructure.
    map: {
      [Symbol.toStringTag]: 'Map',
      entries() {},
      *[Symbol.iterator]() {
        yield 1
      },
    },
    set: halfWay,
    // Not adversarial at all: an ordinary lazy getter that is not ready.
    lazy: {
      ok: 1,
      get bad() {
        throw new Error('boom')
      },
    },
    error: Object.defineProperty(new Error('x'), 'stack', {
      get() {
        throw new Error('no stack')
      },
    }),
    survivor: 'still here',
  })

  assert.equal(out.map.$type, 'unserialisable')
  assert.equal(out.map.tag, 'Map')
  assert.match(out.map.reason, /iterable/)
  assert.equal(out.set.$type, 'unserialisable')
  assert.equal(out.set.reason, 'half way')
  assert.deepEqual(out.lazy, { ok: 1, bad: { $type: 'unserialisable', reason: 'boom' } })
  assert.equal(out.error.$type, 'unserialisable')
  assert.equal(out.error.reason, 'no stack')
  assert.equal(out.survivor, 'still here')

  // Even the tag can be a getter that throws. Nothing may be read unguarded.
  assert.deepEqual(
    toTransferable({
      get [Symbol.toStringTag]() {
        throw new Error('nope')
      },
    }),
    {},
  )

  // And the thrown value itself usually comes from the scenario's realm, where
  // `instanceof Error` is false — the reason is the message, not `Error: boom`.
  const source = `({ ok: 1, get bad() { throw new Error('boom') } })`
  const fromScenario = toTransferable(new Script(source).runInContext(createContext({})))
  assert.deepEqual(fromScenario, { ok: 1, bad: { $type: 'unserialisable', reason: 'boom' } })
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

test('the MCP server tries the release copy, then the development copy, then a checkout', async () => {
  const { candidates } = await import('../packages/mcp-server/launch.mjs')
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

test('the login item is registered once, by an installed copy, and never by a test or a checkout', async () => {
  const { accepted, decideLoginItem } = await import('../src/main/login.ts')
  // A checkout runs node_modules' Electron.app; registering that would start a
  // stray Electron at every login.
  assert.equal(decideLoginItem({ packaged: false, offered: undefined }), 'leave')
  assert.equal(decideLoginItem({ packaged: false, offered: true }), 'leave')
  // The installed copy registers on its first start and then leaves the OS
  // alone: a person who turns the item off in System Settings is not overruled.
  assert.equal(decideLoginItem({ packaged: true, offered: undefined }), 'register')
  assert.equal(decideLoginItem({ packaged: true, offered: true }), 'leave')
  // A registration the OS took is either live or waiting for approval; anything
  // else is a refusal, and the marker stays unwritten so the next start tries again.
  assert.equal(accepted('enabled'), true)
  assert.equal(accepted('requires-approval'), true)
  assert.equal(accepted('not-registered'), false)
  assert.equal(accepted('not-found'), false)
})

test("the settings window describes the login item in the person's terms", async () => {
  const { describeLoginItem } = await import('../src/main/login.ts')
  assert.equal(describeLoginItem({ packaged: true, status: 'enabled' }), 'Starts when you log in.')
  // What to do about it, not what state it is in: a person who reads "waiting
  // for approval" still has to work out where to go and approve it.
  assert.equal(
    describeLoginItem({ packaged: true, status: 'requires-approval' }),
    'Approve it in System Settings › Login Items.',
  )
  // The switch beside it already says "off"; the sentence says what off means.
  assert.equal(
    describeLoginItem({ packaged: true, status: 'not-registered' }),
    'Starts only when you open it yourself.',
  )
  assert.equal(
    describeLoginItem({ packaged: true, status: 'not-found' }),
    'Starts only when you open it yourself.',
  )
  assert.equal(
    describeLoginItem({ packaged: false, status: 'not-registered' }),
    'Only an installed copy can start at login. Install the application first.',
  )
})

/**
 * What the person sets by hand: one sample of what the main process sends, so
 * the both-ways check below has something real to compare the rows against.
 */
const SAMPLE_VALUES = {
  loginItem: { on: false, status: 'not-registered', sentence: 'Starts only when you open it yourself.' },
  presence: 'menu-bar',
  announceAutomation: false,
  orphanCloseMs: 5 * 60_000,
}

test('every preference the window draws is a value the application sends, and back', async () => {
  const { rowsFor } = await import('../src/main/preferences.ts')
  const rows = rowsFor(SAMPLE_VALUES)
  // Both ways. A value the main process starts sending with no row for it does
  // not compile — `PREFERENCES` is mapped over the keys — and this is the same
  // promise at run time, for the half a type cannot hold: that the window
  // actually draws each one.
  assert.deepEqual([...rows.map((row) => row.key)].sort(), Object.keys(SAMPLE_VALUES).sort())
  for (const row of rows) {
    assert.ok(row.label.length > 0, `${row.key} has no label`)
    assert.ok(row.hint.length > 0, `${row.key} has no sentence under it`)
  }
  // The login item's sentence is the OS's answer, passed through rather than
  // written here: the window must not say "Off." while System Settings says on.
  const login = rows.find((row) => row.key === 'loginItem')
  assert.equal(login.hint, 'Starts only when you open it yourself.')
})

test('the Dock icon counts what is waiting for the person, and nothing else', async () => {
  const { dockSignal } = await import('../src/main/dock.ts')
  // A badge on macOS says "this many things want you". The number of connected
  // agents is not that: agents work without the person, and a red 3 for three
  // working agents reads as three unanswered requests.
  assert.equal(dockSignal(0, 0).badge, '')
  assert.equal(dockSignal(1, 0).badge, '1')
  assert.equal(dockSignal(12, 12).badge, '12')
})

test('the Dock icon bounces when a new call starts waiting, and not while it waits', async () => {
  const { dockSignal } = await import('../src/main/dock.ts')
  assert.equal(dockSignal(1, 0).bounce, true)
  assert.equal(dockSignal(2, 1).bounce, true)
  // Still waiting is not news; answering one of two is not news either.
  assert.equal(dockSignal(1, 1).bounce, false)
  assert.equal(dockSignal(1, 2).bounce, false)
  assert.equal(dockSignal(0, 1).bounce, false)
})

test('a call already waiting when the Dock icon appears is shown but not announced', async () => {
  const { watchDock } = await import('../src/main/dock.ts')
  const done = []
  const dock = { setBadge: (text) => done.push(`badge:${text}`), bounce: (type) => done.push(`bounce:${type}`) }
  let waiting = 2
  // Turning the Dock icon on is not the moment two agents started asking.
  const watch = watchDock(dock, () => waiting)
  assert.deepEqual(done, ['badge:2'])
  waiting = 3
  watch.look()
  assert.deepEqual(done, ['badge:2', 'badge:3', 'bounce:informational'])
  waiting = 0
  watch.look()
  assert.deepEqual(done, ['badge:2', 'badge:3', 'bounce:informational', 'badge:'])
  // Sent to the menu bar, the icon must not leave a badge behind on the Dock.
  watch.stop()
  assert.equal(done.at(-1), 'badge:')
})

test('the application is never left with neither icon, whatever the choice', async () => {
  const { presenceOf } = await import('../src/main/preferences.ts')
  // The reason this is one row of three rather than two switches: a pair of
  // switches has a fourth state, and in it the person cannot reach the window
  // at all.
  for (const presence of ['menu-bar', 'dock', 'both']) {
    const wanted = presenceOf(presence)
    assert.ok(wanted.menuBar || wanted.dock, `${presence} asks for no icon at all`)
  }
  assert.deepEqual(presenceOf('menu-bar'), { menuBar: true, dock: false })
  assert.deepEqual(presenceOf('dock'), { menuBar: false, dock: true })
  assert.deepEqual(presenceOf('both'), { menuBar: true, dock: true })
})

test('a settings file holding anything else starts the application in the menu bar', async () => {
  const { asPresence } = await import('../src/main/preferences.ts')
  assert.equal(asPresence('dock'), 'dock')
  assert.equal(asPresence('both'), 'both')
  assert.equal(asPresence('menu-bar'), 'menu-bar')
  // Hand-edited, written by an older version, or missing: the answer is what
  // the application did before the choice existed.
  for (const junk of [undefined, null, '', 'Dock', 'tray', 7, {}]) {
    assert.equal(asPresence(junk), 'menu-bar', `${JSON.stringify(junk) ?? 'undefined'} is not menu-bar`)
  }
})

test('the choice of where to appear is drawn as the three places, the current one marked', async () => {
  const { rowsFor } = await import('../src/main/preferences.ts')
  const row = rowsFor({ ...SAMPLE_VALUES, presence: 'both' }).find((row) => row.key === 'presence')
  assert.equal(row.kind, 'choice')
  assert.equal(row.value, 'both')
  assert.deepEqual(row.options.map((option) => option.value), ['menu-bar', 'dock', 'both'])
  for (const option of row.options) assert.ok(option.label.length > 0, `${option.value} has no label`)
  // The sentence under the row says what the choice gets you, so it cannot be
  // the same sentence for all three.
  const said = new Set(
    ['menu-bar', 'dock', 'both'].map((presence) =>
      rowsFor({ ...SAMPLE_VALUES, presence }).find((row) => row.key === 'presence').hint
    ),
  )
  assert.equal(said.size, 3)
})

test("a preference is written in the person's unit and kept in the application's", async () => {
  const { asKept, asShown, rowsFor } = await import('../src/main/preferences.ts')
  // Minutes are what a person thinks in; milliseconds are what the application
  // counts in.
  assert.equal(asKept('orphanCloseMs', 5), 5 * 60_000)
  assert.equal(asShown('orphanCloseMs', 5 * 60_000), 5)
  assert.equal(asKept('orphanCloseMs', 0), 0)

  // Clamped, never refused: a field that refused would make the person work
  // out the floor by trial, and one that clamps shows it.
  assert.equal(asKept('orphanCloseMs', -3), 0)
  // An empty field is not a value at all, which is a different answer from a
  // value out of range.
  assert.equal(asKept('orphanCloseMs', Number.NaN), null)

  // The floor the window shows is the floor the conversion holds to.
  const wait = rowsFor(SAMPLE_VALUES).find((row) => row.key === 'orphanCloseMs')
  assert.equal(wait.floor, 0)
})

test('the projects the person has answered about read as allowed or refused', async () => {
  const { projectRows } = await import('../src/main/preferences.ts')
  const rows = projectRows([
    { name: 'factory', root: '/Users/someone/www/factory', decision: 'allowed', at: 10 },
    { name: 'blogs', root: '/Users/someone/www/blogs', decision: 'denied', at: 20 },
    // A record written before the name was kept: the directory still names it.
    { name: '', root: '/Users/someone/www/homelab', decision: 'allowed', at: 30 },
  ])
  // By name, because that is what the person scans for — not by when they
  // happened to be asked.
  assert.deepEqual(rows.map((row) => row.name), ['blogs', 'factory', 'homelab'])
  assert.deepEqual(rows.map((row) => row.allowed), [false, true, true])
  // A refusal is why an agent in that directory gets nothing, and forgetting
  // the record is the cure — so the row has to say which it is.
  assert.match(rows[0].hint, /refused/i)
  assert.match(rows[1].hint, /allowed/i)
  // The root is what `forgetProject` is called with, so it is carried whole.
  assert.equal(rows[2].root, '/Users/someone/www/homelab')
})

/** A window that records what was done to it, in place of an Electron one. */
function fakeWindow() {
  const window = {
    focused: 0,
    shown: 0,
    sent: [],
    destroyed: false,
    isDestroyed: () => window.destroyed,
    focus: () => window.focused++,
    show: () => window.shown++,
    send: (channel, payload) => window.sent.push([channel, payload]),
    onClosed: (handler) => (window.close = () => {
      window.destroyed = true
      handler()
    }),
  }
  return window
}

test('the settings window is one window, opened again and again', async () => {
  const { SettingsWindow } = await import('../src/main/settings-window.ts')
  const made = []
  const settings = new SettingsWindow(() => {
    const window = fakeWindow()
    made.push(window)
    return window
  })

  const first = settings.open()
  assert.equal(made.length, 1)
  // Asking again brings the one that is open forward. A second window would be
  // two answers to one question, and the person would edit whichever they
  // happened to be looking at.
  const again = settings.open()
  assert.equal(made.length, 1)
  assert.equal(again, first)
  assert.equal(first.focused, 1)

  // Closed and asked for again, it is made afresh — the window is not kept
  // alive in the background for the next time.
  first.close()
  settings.open()
  assert.equal(made.length, 2)
})

test('nothing is pushed at a settings window that is not there', async () => {
  const { SettingsWindow } = await import('../src/main/settings-window.ts')
  let made = null
  const settings = new SettingsWindow(() => (made = fakeWindow()))

  // A value changes while nobody is looking at the settings: the push has
  // nowhere to land, and that is ordinary, not a failure.
  settings.push({ orphanCloseMs: 340 })
  assert.equal(made, null)

  const window = settings.open()
  settings.push({ orphanCloseMs: 420 })
  assert.deepEqual(window.sent, [['settings', { orphanCloseMs: 420 }]])

  // The window a person closed is gone, and Electron throws at a destroyed
  // one — so a push after the close reaches nothing and says nothing.
  window.close()
  settings.push({ orphanCloseMs: 500 })
  assert.equal(window.sent.length, 1)
})

/**
 * The client cuts a tool description at about 2040 characters and appends
 * "… [truncated]". The limit here is deliberately well under that: a test that
 * only fails at the real cap fails when the text is already unreadable, and the
 * cap is the client's to change without telling us.
 */
const DESCRIPTION_LIMIT = 1800

test('the whole tool description reaches the agent, with room to spare', () => {
  const description = TOOLS.find((tool) => tool.name === 'evalInBrowser').description
  assert.ok(
    description.length <= DESCRIPTION_LIMIT,
    `the evalInBrowser description is ${description.length} characters, past the ${DESCRIPTION_LIMIT} this repository ` +
      'allows itself; the client cuts at about 2040 and what is past the cut reaches nobody. New helpers go into the ' +
      'reference, not into the description.',
  )
})

test('the description that arrives names the way to read the rest', () => {
  const description = TOOLS.find((tool) => tool.name === 'evalInBrowser').description
  // Both, on purpose: an application older than this MCP server has no help().
  assert.match(description, /api\.help\(\)/)
  assert.match(description, /Object\.keys\(api\)/)
  // The form snapshot() prints, and — since 53c7bb1 — the form that resolves.
  assert.match(description, /\[ref_N\]/)
  assert.ok(!description.includes('[truncated]'))
})

test('every helper the description names is one the manual documents', () => {
  const description = TOOLS.find((tool) => tool.name === 'evalInBrowser').description
  // The module's own extractor, so the rule cannot be copied into this test wrong.
  const named = [...new Set(description.split('\n').flatMap(namesIn))]
  const documented = new Set(documentedNames())
  assert.deepEqual(named.filter((name) => !documented.has(name)), [])
})

test('no helper is described in two places', () => {
  const seen = new Map()
  for (const line of fullReference().split('\n')) {
    if (!/^ {2}\S/.test(line)) continue
    for (const name of namesIn(line)) seen.set(name, (seen.get(name) ?? 0) + 1)
  }
  assert.deepEqual([...seen].filter(([, count]) => count > 1), [])
})

test('a helper answers to every spelling an agent would write', () => {
  const bare = helpFor('click')
  assert.match(bare, /api\.click/)
  assert.equal(helpFor('api.click'), bare)
  assert.equal(helpFor('click()'), bare)
  assert.equal(helpFor('api.click(sel)'), bare)
  // The entry arrives under its section, so the reader learns what neighbours it.
  assert.match(bare, /^Acting/)
})

test("a helper's entry carries the lines under it, not just its first line", () => {
  // The only test of the rule that anything indented deeper belongs to the
  // entry above it: break it, and every other test here stays green.
  const entry = helpFor('snapshot')
  assert.match(entry, /\[ref_N\]/)
  assert.match(entry, /generated class names/)
  assert.equal(entry.split('\n').length, 5)
})

test('the spelling an agent types is not the spelling it is punished for', () => {
  assert.equal(helpFor('  Click '), helpFor('click'))
  // An empty name is no name at all, and the whole manual is the better answer.
  assert.ok(helpFor('').startsWith('Write JavaScript'))
  assert.equal(helpFor(''), fullReference())
})

test('a name nobody has says so, and says what there is', () => {
  const answer = helpFor('typeText')
  assert.match(answer, /typeText/)
  assert.match(answer, /\btype\b/)
  assert.match(answer, /\bfill\b/)
})

test('every documented name resolves to its own entry', () => {
  const missing = documentedNames().filter((name) => !helpFor(name).includes(`api.${name}`))
  assert.deepEqual(missing, [])
})

test('the reference carries the sections the description leaves out', () => {
  const reference = fullReference()
  for (const section of ['Finding things', 'Acting', 'Frames', 'Moving around', 'State', 'Watching', 'Notes']) {
    assert.ok(reference.includes(section), `the reference lost the ${section} section`)
  }
  // The opening paragraph is the one part the sections above cannot vouch for.
  assert.ok(reference.startsWith('Write JavaScript'))
  assert.ok(reference.length > TOOL_DESCRIPTION.length)
})

test('a walk is kept in the order it happened, timed from the hand-over', () => {
  const walk = new VisitLog(1_000)
  walk.add('in-page', 'https://shop/form?step=photos', 1_400)
  walk.add('in-page', 'https://shop/form?step=review', 1_900)
  walk.add('navigate', 'https://shop/ads/promo/56036876?origin=save', 3_500)

  const report = walk.report(4_000)
  assert.deepEqual(report.visited.map((visit) => [visit.at, visit.kind]), [
    [400, 'in-page'],
    [900, 'in-page'],
    [2500, 'navigate'],
  ])
  assert.equal(report.visitedCount, 3)
  assert.equal(report.seconds, 3)
})

test('a step the page takes twice is one move of the page', () => {
  const walk = new VisitLog(0)
  walk.add('in-page', 'https://shop/form?step=photos', 100)
  walk.add('in-page', 'https://shop/form?step=photos', 200)
  // The same address reached the other way is not the same move: a reload after
  // a pushState is a real thing the page did.
  walk.add('navigate', 'https://shop/form?step=photos', 300)

  const report = walk.report(400)
  assert.equal(report.visitedCount, 2)
  assert.deepEqual(report.visited.map((visit) => visit.kind), ['in-page', 'navigate'])
})

test('a long walk keeps its tail and says how much it dropped', () => {
  const walk = new VisitLog(0)
  for (let step = 0; step < VISIT_LIMIT + 5; step++) walk.add('in-page', `https://shop/form?step=${step}`, step * 10)

  const report = walk.report(1_000)
  // The agent knows where it handed the tab over — it navigated there itself —
  // so the end of the walk is the half worth keeping.
  assert.equal(report.visited.length, VISIT_LIMIT)
  assert.equal(report.visitedCount, VISIT_LIMIT + 5)
  assert.equal(report.visited[0].url, 'https://shop/form?step=5')
  assert.equal(report.visited.at(-1).url, `https://shop/form?step=${VISIT_LIMIT + 4}`)
})

test('a walk describes itself for an error message that has room for one line', () => {
  const still = new VisitLog(0)
  assert.match(describeVisits(still.report(5_000), 'https://shop/form'), /did not move in 5s/)

  const once = new VisitLog(0)
  once.add('navigate', 'https://shop/done', 1_000)
  const line = describeVisits(once.report(2_000), 'https://shop/done')
  assert.match(line, /moved once/)
  assert.match(line, /https:\/\/shop\/done/)

  const thrice = new VisitLog(0)
  for (const step of [1, 2, 3]) thrice.add('in-page', `https://shop/form?step=${step}`, step * 100)
  assert.match(describeVisits(thrice.report(1_000), 'https://shop/form?step=3'), /moved 3 times/)
})

test('a URL pattern is a substring or a regular expression, and nothing else', () => {
  const contains = matcherFor('/ads/promo/')
  assert.equal(contains('https://shop.example/ads/promo/56036876?origin=save'), true)
  assert.equal(contains('https://shop.example/ads/new'), false)

  // The thing a substring cannot say: that the address ends there.
  const anchored = matcherFor(/second\.html$/)
  assert.equal(anchored('http://x/second.html'), true)
  assert.equal(anchored('http://x/second.html?q=1'), false)

  // An empty string matches every page, so it would return at once and read as
  // "the page arrived". The usual way to write one is from a variable that
  // held nothing, which is exactly when a false arrival is worst.
  assert.throws(() => matcherFor(''), /something to match/)
  assert.throws(() => matcherFor(undefined), /substring or a regular expression/)
  assert.throws(() => matcherFor(7), /substring or a regular expression/)
})

test('a pattern the scenario built itself is still a pattern, and a borrowed tag is not', () => {
  const theirs = new Script('/step=review/').runInContext(createContext({}))
  // The boundary this test is about: a scenario's own values come from the vm's
  // realm and fail instanceof in the main process.
  assert.equal(theirs instanceof RegExp, false)
  assert.equal(matcherFor(theirs)('http://x/form?step=review'), true)

  // Symbol.toStringTag is writable, so the tag alone is not something to act
  // on: pair it with the member the branch is about to call.
  assert.throws(() => matcherFor({ [Symbol.toStringTag]: 'RegExp' }), /substring or a regular expression/)
})

test('a pattern describes itself for a message that has room for one line', () => {
  assert.match(describePattern('/ads/promo/'), /containing/)
  assert.match(describePattern('/ads/promo/'), /\/ads\/promo\//)
  assert.match(describePattern(/second\.html$/), /matching/)
  assert.match(describePattern(/second\.html$/), /second/)
})

test('a trail keeps the calls nearest the failure, and says how many it dropped', () => {
  const trail = new CallTrail()
  for (let i = 1; i <= 25; i++) trail.returned(trail.begin(`click(#b${i})`), true)
  const report = trail.report()

  assert.equal(report.callCount, 25)
  assert.equal(report.calls.length, TRAIL_LIMIT)
  // The tail is the half worth keeping: the failure is at the end, and the
  // steps nearest it are the ones whose answers the agent has just lost.
  assert.equal(report.calls[0].step, 6)
  assert.equal(report.calls.at(-1).step, 25)
  assert.equal(report.callCount - report.calls.length, 5)
})

test('a recorded answer is a summary, and says when it was cut', () => {
  const trail = new CallTrail()
  trail.returned(trail.begin('getText(body)'), 'x'.repeat(5_000))
  const [call] = trail.report().calls

  assert.equal(call.value.$type, 'truncated-string')
  assert.equal(call.value.length, 5_000)
  assert.equal(call.value.value.length, TRAIL_LIMITS.maxStringLength)
})

test('a call that threw is recorded as one, with the reason', () => {
  const trail = new CallTrail()
  trail.returned(trail.begin('fill(#a)'), true)
  trail.failed(trail.begin('click(#gone)'), new Error('no element matched #gone'))
  const report = trail.report()

  assert.equal(report.calls[0].ok, true)
  assert.equal(report.calls[1].ok, false)
  assert.equal(report.calls[1].error, 'no element matched #gone')
  assert.equal(report.calls[1].value, undefined)
})

test('recording cannot throw, whatever the call answered', () => {
  const trail = new CallTrail()
  const hostile = {
    get boom() {
      throw new Error('this getter is not ready')
    },
  }
  // The lesson from `fbb746b`, one layer up: a failure inside the machinery
  // that reports a failure would replace the message the agent needed.
  assert.doesNotThrow(() => trail.returned(trail.begin('eval()'), hostile))
  assert.doesNotThrow(() =>
    trail.failed(trail.begin('eval()'), {
      get message() {
        throw new Error('nor this')
      },
    })
  )
  assert.equal(trail.report().callCount, 2)
})

test('the wrapper leaves the surface an agent sees exactly as it found it', async () => {
  const trail = new CallTrail()
  const api = {
    // `help` is synchronous, and a wrapper that awaits everything would hand
    // back a Promise to a scenario that never writes `await`.
    help: () => 'the manual',
    click: async (selector) => `clicked ${selector}`,
    sleep: (ms) => Promise.resolve(ms),
  }
  const recorded = recordCalls(api, trail)

  assert.deepEqual(Object.keys(recorded), Object.keys(api))
  assert.equal(recorded.help(), 'the manual')
  assert.equal(await recorded.click('#pay'), 'clicked #pay')

  const report = trail.report()
  assert.equal(report.callCount, 2)
  assert.equal(report.calls[0].call, 'help()')
  assert.equal(report.calls[0].value, 'the manual')
  assert.equal(report.calls[1].call, "click('#pay')")
  assert.equal(report.calls[1].value, 'clicked #pay')
})

test('a throw out of a helper is recorded and still reaches the scenario', async () => {
  const trail = new CallTrail()
  const recorded = recordCalls({
    click: async () => {
      throw Object.assign(new Error('no element matched #gone'), { code: 'not-found' })
    },
  }, trail)

  await assert.rejects(() => recorded.click('#gone'), (error) => {
    assert.equal(error.code, 'not-found')
    return true
  })
  const [call] = trail.report().calls
  assert.equal(call.ok, false)
  assert.equal(call.call, "click('#gone')")
  assert.equal(call.error, 'no element matched #gone')
})

test('a call names its arguments without carrying them whole', () => {
  const trail = new CallTrail()
  const recorded = recordCalls({
    eval: (expression) => expression.length,
    setFiles: (selector, paths, options) => [selector, paths, options].length,
  }, trail)

  recorded.eval('x'.repeat(400))
  recorded.setFiles('#hidden-file', ['a.png', 'b.png'], { timeout: 300 })
  const [first, second] = trail.report().calls

  assert.ok(first.call.length < 200, first.call)
  assert.match(first.call, /^eval\('x+…'\)$/)
  assert.equal(second.call, "setFiles('#hidden-file', ['a.png','b.png'], {timeout:300})")
})

test('the text an agent reads names the steps and says they already happened', () => {
  const text = renderError({
    message: 'no element matched #gone',
    code: 'not-found',
    details: {
      stack: 'Error: no element matched #gone',
      logs: ['log: halfway'],
      trail: {
        callCount: 25,
        calls: [
          { step: 24, call: "fill('#field', 'sk3j2h')", ok: true, value: true },
          { step: 25, call: "click('#gone')", ok: false, error: 'no element matched #gone' },
        ],
      },
    },
  })

  // The warning sits where the trail is read, not in a manual nobody re-reads
  // at the moment of failure: a step that bought something is not un-bought by
  // being listed, and an agent re-running from the top buys it twice.
  assert.match(text, /already happened/)
  assert.match(text, /not a checkpoint/)
  assert.match(text, /the first 23 are not listed/)
  assert.match(text, /24 fill\('#field', 'sk3j2h'\) → true/)
  assert.match(text, /25 click\('#gone'\) ✗ no element matched #gone/)
})

test('a scenario that succeeded reads exactly as it did before', () => {
  assert.equal(renderOutcome({ value: 'the page says hello', logs: [] }), 'the page says hello')
  assert.equal(renderOutcome({ value: { $type: 'undefined' }, logs: [] }), '(the script returned nothing)')
  // Silence on success is the whole point: nothing was lost, so nothing is said.
  assert.equal(renderError({ message: 'timed out', details: { logs: [] } }).includes('api call'), false)
})

test('a call that has not come back is in the trail, marked as running', () => {
  const trail = new CallTrail()
  trail.returned(trail.begin('fill(#a)'), true)
  trail.begin('sleep(5000)')
  const [done, running] = trail.report().calls

  // A scenario killed by its deadline dies inside a call. Writing the call down
  // when it starts is what puts the hung one in the list at all: it never
  // settles, so a trail written on settle would end one step early and leave the
  // agent to guess which step it was.
  assert.equal(done.pending, undefined)
  assert.equal(running.pending, true)
  assert.equal(running.ok, false)
})

test('the MCP server takes the token from the copy listening on that port', () => {
  const dir = mkdtempSync(join(tmpdir(), 'naoba-state-'))
  writeFileSync(join(dir, 'mcp-server.json'), JSON.stringify({ port: 8899, token: 'a'.repeat(64), pid: process.pid }))
  const env = { NAOBA_STATE_DIR: dir }
  assert.deepEqual(tokensForPort(8899, env).candidates.map((c) => c.token), ['a'.repeat(64)])
  // A file naming a different port belongs to a different copy, whatever else
  // it holds.
  assert.deepEqual(tokensForPort(8900, env).candidates, [])
})

test('a file left behind by a killed copy does not shadow the copy that answers', () => {
  // The failure this fixes. A copy is killed rather than quit, so its file
  // stays and keeps naming a port; another copy starts and takes that port. The
  // release directory is read first, so the dead copy's token used to be the
  // one presented — and the application, rightly, refused it.
  const home = mkdtempSync(join(tmpdir(), 'naoba-home-'))
  const dead = join(home, 'Library', 'Application Support', 'Naoba')
  const live = join(home, 'Library', 'Application Support', 'Naoba Dev')
  mkdirSync(dead, { recursive: true })
  mkdirSync(live, { recursive: true })
  // A process id nothing is using: the highest macOS hands out is 99998.
  writeFileSync(join(dead, 'mcp-server.json'), JSON.stringify({ port: 8899, token: 'dead'.repeat(16), pid: 99999 }))
  writeFileSync(join(live, 'mcp-server.json'), JSON.stringify({ port: 8899, token: 'live'.repeat(16), pid: process.pid }))

  const { candidates } = tokensForPort(8899, { HOME: home })
  assert.equal(candidates[0].token, 'live'.repeat(16), 'the running copy goes first')
  // The dead one is kept rather than dropped: a process id can be reused, and
  // the MCP server tries the whole list before giving up.
  assert.equal(candidates[1].token, 'dead'.repeat(16))
})

test('a file from a copy that wrote no process id is tried, after the living', () => {
  const home = mkdtempSync(join(tmpdir(), 'naoba-home-'))
  const older = join(home, 'Library', 'Application Support', 'Naoba')
  const live = join(home, 'Library', 'Application Support', 'Naoba Dev')
  mkdirSync(older, { recursive: true })
  mkdirSync(live, { recursive: true })
  // Written by a version before the process id existed.
  writeFileSync(join(older, 'mcp-server.json'), JSON.stringify({ port: 8899, token: 'old0'.repeat(16) }))
  writeFileSync(join(live, 'mcp-server.json'), JSON.stringify({ port: 8899, token: 'live'.repeat(16), pid: process.pid }))

  const tokens = tokensForPort(8899, { HOME: home }).candidates.map((c) => c.token)
  assert.deepEqual(tokens, ['live'.repeat(16), 'old0'.repeat(16)])
})

test('an MCP server that cannot find the token says where it looked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'naoba-state-'))
  const { candidates, looked } = tokensForPort(8899, { NAOBA_STATE_DIR: dir })
  assert.deepEqual(candidates, [])
  const error = noTokenFound(8899, looked)
  assert.equal(error.code, 'token-not-found')
  assert.match(error.message, new RegExp(dir))
})

test('the copies the MCP server knows to look in are the three a person can have', () => {
  const dirs = stateDirs({ HOME: '/home/someone' })
  assert.deepEqual(dirs, [
    '/home/someone/Library/Application Support/Naoba',
    '/home/someone/Library/Application Support/Naoba Dev',
    '/home/someone/Library/Application Support/Electron',
  ])
})

// ------------------------------------------------------------------- licence

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-12T12:00:00Z')

/** A stored answer that is good at `NOW`, with whatever the test wants changed. */
function stored(changes = {}) {
  return {
    key: 'sk_abcdefgh1234',
    uid: 'f'.repeat(32),
    installId: '55',
    plan: 'Naoba',
    expiration: null,
    cancelled: false,
    checkedAt: NOW,
    ...changes,
  }
}

test('a copy that was never unlocked is not licensed', () => {
  const answer = verdict(null, NOW)
  assert.equal(answer.state, 'unlicensed')
  assert.match(answer.reason, /has not been unlocked/)
})

test('a licence bought once holds without the service saying so again', () => {
  // The whole point of the grace: a fortnight off the network must not take the
  // application away from someone who paid for it.
  assert.equal(verdict(stored({ checkedAt: NOW - 14 * DAY }), NOW).state, 'licensed')
  assert.equal(verdict(stored({ checkedAt: NOW - (GRACE_DAYS - 1) * DAY }), NOW).state, 'licensed')
})

test('a stored answer nobody confirmed for a month stops being enough', () => {
  const answer = verdict(stored({ checkedAt: NOW - (GRACE_DAYS + 2) * DAY }), NOW)
  assert.equal(answer.state, 'unlicensed')
  // The sentence has to say what to do about it, not only that something is wrong.
  assert.match(answer.reason, /32 days/)
  assert.match(answer.reason, /Connect to the internet/)
})

test('a refunded key stops working the moment the service says it was cancelled', () => {
  // Cancellation beats the grace: it is the answer the service gave, not silence.
  const answer = verdict(stored({ cancelled: true }), NOW)
  assert.equal(answer.state, 'unlicensed')
  assert.match(answer.reason, /cancelled or refunded/)
})

test('an expiry in the past ends the licence and an expiry ahead does not', () => {
  assert.equal(verdict(stored({ expiration: '2026-09-11 09:00:00' }), NOW).state, 'unlicensed')
  const good = verdict(stored({ expiration: '2027-01-01 09:00:00' }), NOW)
  assert.equal(good.state, 'licensed')
  assert.equal(good.until, '2027-01-01 09:00:00')
})

test('the record kept after activation carries what the next check needs', () => {
  const record = recordFrom(
    { install_id: 4711, license_plan_name: 'Naoba', expiration: null, is_cancelled: false },
    'sk_key',
    'a'.repeat(32),
    NOW,
  )
  assert.equal(record.installId, '4711')
  assert.equal(record.plan, 'Naoba')
  assert.equal(record.cancelled, false)
  assert.equal(record.checkedAt, NOW)
  // Without an installation there is nothing to ask about later, so accepting
  // the answer would leave a copy that can never be re-checked.
  assert.throws(
    () => recordFrom({ license_plan_name: 'Naoba' }, 'sk_key', 'a'.repeat(32), NOW),
    /named no installation/,
  )
})

test('a check can take a licence away and cannot hand one out', () => {
  const before = stored({ checkedAt: NOW - 3 * DAY })
  const after = refreshed(before, { is_cancelled: true, plan_name: 'Naoba' }, NOW)
  assert.equal(after.cancelled, true)
  assert.equal(after.checkedAt, NOW)
  assert.equal(after.key, before.key)
  assert.equal(after.installId, before.installId)
  assert.equal(verdict(after, NOW).state, 'unlicensed')
})

test('each licence call goes to the address the service documents', () => {
  const record = stored()
  const activate = activateRequest('sk_key', 'a'.repeat(32), 'somebodys-mac')
  assert.equal(activate.method, 'POST')
  assert.match(activate.url, /\/v1\/products\/39376\/licenses\/activate\.json$/)
  assert.deepEqual(activate.body, { uid: 'a'.repeat(32), license_key: 'sk_key', title: 'somebodys-mac' })

  const check = checkRequest(record)
  assert.equal(check.method, 'GET')
  assert.match(check.url, /\/installs\/55\/license\.json\?uid=f{32}&license_key=sk_abcdefgh1234$/)

  assert.match(deactivateRequest(record).url, /\/licenses\/deactivate\.json$/)
})

test('a key nobody bought carries the person activating it, and a bought one does not', () => {
  const bare = activateRequest('sk_key', 'a'.repeat(32), 'somebodys-mac')
  assert.equal('first_name' in bare.body, false)
  assert.equal('user_email' in bare.body, false)

  const named = activateRequest('sk_key', 'a'.repeat(32), 'somebodys-mac', {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
  })
  assert.deepEqual(named.body, {
    uid: 'a'.repeat(32),
    license_key: 'sk_key',
    title: 'somebodys-mac',
    first_name: 'Ada',
    last_name: 'Lovelace',
    user_email: 'ada@example.com',
  })
})

test('the copy that is sold asks for a key, and the one built from a checkout does not', () => {
  // What a buyer downloads.
  assert.equal(admitsWithoutKey(false, false), false)
  // The maintainer's own copy, installed from this repository under its own name.
  assert.equal(admitsWithoutKey(false, true), true)
  // A test run and the run that photographs the window.
  assert.equal(admitsWithoutKey(true, false), true)
})

test('a copy that needs no key says so instead of reporting a missing one', () => {
  const free = describeFreeCopy()
  assert.equal(free.needsNoKey, true)
  assert.equal(free.licensed, true)
  assert.match(free.sentence, /without a key/)
  // The row draws a button off `needsNoKey`, so the ordinary states must not set it.
  assert.equal(describe(null).needsNoKey, false)
  assert.equal(describe(stored()).needsNoKey, false)
})

test('the service asking who you are is three complaints meaning one thing', () => {
  assert.equal(asksWhoYouAre('first_name_required'), true)
  assert.equal(asksWhoYouAre('last_name_required'), true)
  assert.equal(asksWhoYouAre('user_email_required'), true)
  // Everything else is a real refusal and must reach the person as written.
  assert.equal(asksWhoYouAre('invalid_license_key'), false)
  assert.equal(asksWhoYouAre(undefined), false)
  assert.equal(asksWhoYouAre(null), false)
})

test('only the downloaded copy replaces itself', () => {
  // Packaged, and not the maintainer's own build: the one people buy.
  assert.equal(updatesItself(true, false), true)
  // The development copy is usually ahead of any release.
  assert.equal(updatesItself(true, true), false)
  // A run straight from the checkout has no signature to match.
  assert.equal(updatesItself(false, false), false)
})

test('a copy that does not update itself says why, whatever the stage says', () => {
  const summary = describeUpdate('ready', '1.2.0', null, false)
  assert.equal(summary.watches, false)
  assert.equal(summary.stage, 'quiet')
  // No version is offered, so the row cannot draw a button to install one.
  assert.equal(summary.version, null)
  assert.match(summary.sentence, /built rather than downloaded/)
})

test('each stage of an update reads as one sentence about this copy', () => {
  assert.match(describeUpdate('quiet', null, null, true).sentence, /up to date/)
  assert.match(describeUpdate('checking', null, null, true).sentence, /Looking for/)
  assert.match(describeUpdate('downloading', '1.2.0', null, true).sentence, /1\.2\.0 is downloading/)
  const ready = describeUpdate('ready', '1.2.0', null, true)
  assert.equal(ready.stage, 'ready')
  assert.equal(ready.version, '1.2.0')
  assert.match(ready.sentence, /ready/)
  // Pressing the button quits the application, so the row says what that costs.
  assert.match(ready.sentence, /closes every agent's tabs/)
})

test('a failed check keeps the reason, because the cause is usually not the application', () => {
  const failed = describeUpdate('failed', null, 'net::ERR_INTERNET_DISCONNECTED', true)
  assert.match(failed.sentence, /did not finish/)
  assert.match(failed.sentence, /ERR_INTERNET_DISCONNECTED/)
  // A failure with nothing to say must not leave a dangling space.
  assert.equal(describeUpdate('failed', null, null, true).sentence.endsWith('finish.'), true)
})

test('an installation identifier is 32 characters of hexadecimal', () => {
  const uid = newUid((count) => new Uint8Array(count).fill(0xab))
  assert.equal(uid.length, 32)
  assert.equal(uid, 'ab'.repeat(16))
})

test('the settings window is told what happened, not only that something did', () => {
  const good = describe(stored(), NOW)
  assert.equal(good.licensed, true)
  assert.match(good.sentence, /does not expire/)
  assert.equal(good.tail, '1234')
  assert.equal(good.checkedOn, '2026-09-12')

  const none = describe(null, NOW)
  assert.equal(none.licensed, false)
  assert.equal(none.tail, null)
  // A key the person can still recognise stays on the row even once it is no
  // good, so they can tell the dead key from one they have not tried yet.
  assert.equal(describe(stored({ cancelled: true }), NOW).tail, '1234')
})

test('an MCP server shipped inside the application starts that application', () => {
  // The path a bought copy carries. Somebody who downloaded the DMG points
  // their IDE at this file and has nothing else to install, so the MCP server must
  // recognise the bundle it is sitting in rather than asking the system which
  // Naoba it prefers.
  const inside = 'file:///Applications/Naoba.app/Contents/Resources/mcp-server/launch.mjs'
  assert.equal(owningBundle(inside), '/Applications/Naoba.app')

  const kinds = candidates({}, owningBundle(inside)).map((c) => c.kind)
  assert.equal(kinds[0], 'own-bundle')
  assert.equal(candidates({}, owningBundle(inside))[0].path, '/Applications/Naoba.app')

  // A checkout is not inside a bundle, and must not invent one.
  assert.equal(owningBundle('file:///Users/someone/www/naoba/packages/mcp-server/launch.mjs'), null)
  assert.equal(candidates({}, null)[0].kind, 'bundle-id')

  // NAOBA_APP still wins: it is the one a person set on purpose.
  assert.equal(candidates({ NAOBA_APP: '/tmp/Other.app' }, owningBundle(inside))[0].kind, 'explicit')
})

test('the panel tells a person where this copy keeps its MCP server', () => {
  // An installed application carries the MCP server; the line the panel prints has
  // to name that file, because somebody who bought the application has no
  // checkout to substitute for it.
  const installed = mcpServerEntry(true, '/Applications/Naoba.app/Contents/Resources', '/whatever/app.asar')
  assert.equal(installed, '/Applications/Naoba.app/Contents/Resources/mcp-server/index.mjs')
  assert.equal(mcpServerCommand(installed), `claude mcp add naoba -- node ${installed}`)

  assert.equal(mcpServerEntry(false, '', '/Users/someone/www/naoba'), '/Users/someone/www/naoba/packages/mcp-server/index.mjs')
})
