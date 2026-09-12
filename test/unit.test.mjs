import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createContext, Script } from 'node:vm'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { identify, normalizeRoot, projectIdFor, resolveProjectRoot } from '../src/main/project.ts'
import { resolveUploadPaths, within } from '../src/main/files.ts'
import { KeyedQueue, QueueTimeout } from '../src/main/queue.ts'
import { LeaseTable } from '../src/main/lease.ts'
import { toTransferable } from '../src/main/serialize.ts'
import { decodeLines } from '../src/main/protocol.ts'
import { CommandLog } from '../src/main/commands.ts'
import { buildTree, expandNew, groupKey, projectKey, sortGroups, tabKey } from '../src/renderer/tree.ts'
import { documentedNames, fullReference, helpFor, namesIn, TOOL_DESCRIPTION } from '../packages/bridge/reference.mjs'
import { TOOLS } from '../packages/bridge/tools.mjs'

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

test("the settings view describes the login item in the person's terms", async () => {
  const { describeLoginItem } = await import('../src/main/login.ts')
  assert.equal(describeLoginItem({ packaged: true, status: 'enabled' }), 'Starts when you log in.')
  assert.equal(
    describeLoginItem({ packaged: true, status: 'requires-approval' }),
    'Waiting for your approval in System Settings › Login Items.',
  )
  assert.equal(describeLoginItem({ packaged: true, status: 'not-registered' }), 'Off.')
  assert.equal(describeLoginItem({ packaged: true, status: 'not-found' }), 'Off.')
  assert.equal(
    describeLoginItem({ packaged: false, status: 'not-registered' }),
    'Not available from a checkout — install the application first.',
  )
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
  // Both, on purpose: an application older than this bridge has no help().
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
