import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { identify, normalizeRoot, projectIdFor, resolveProjectRoot } from '../src/main/project.ts'
import { KeyedQueue, QueueTimeout } from '../src/main/queue.ts'
import { LeaseTable } from '../src/main/lease.ts'
import { toTransferable } from '../src/main/serialize.ts'
import { decodeLines } from '../src/main/protocol.ts'

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
