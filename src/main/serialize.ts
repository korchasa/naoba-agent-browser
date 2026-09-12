/**
 * Whatever an agent's script returns has to survive the trip to its IDE as
 * JSON. Values that cannot make that trip — a cycle, a function, an Error, a
 * megabyte of text — are replaced by a marker that says what was there, because
 * an agent reading `{}` where a DOM node was cannot tell a bug from an empty
 * result.
 */
export interface SerializeLimits {
  maxDepth: number
  maxStringLength: number
  maxArrayLength: number
  maxKeys: number
}

export const DEFAULT_LIMITS: SerializeLimits = {
  maxDepth: 8,
  maxStringLength: 200_000,
  maxArrayLength: 1_000,
  maxKeys: 200,
}

export function toTransferable(value: unknown, limits: SerializeLimits = DEFAULT_LIMITS): unknown {
  return walk(value, limits, 0, new WeakSet())
}

function walk(value: unknown, limits: SerializeLimits, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) return null
  const type = typeof value

  if (type === 'undefined') return { $type: 'undefined' }
  if (type === 'boolean') return value
  if (type === 'bigint') return { $type: 'bigint', value: (value as bigint).toString() }
  if (type === 'symbol') return { $type: 'symbol', description: (value as symbol).description ?? null }
  if (type === 'function') return { $type: 'function', name: (value as { name?: string }).name || '(anonymous)' }

  if (type === 'number') {
    const n = value as number
    return Number.isFinite(n) ? n : { $type: 'number', value: String(n) }
  }

  if (type === 'string') {
    const s = value as string
    if (s.length <= limits.maxStringLength) return s
    return {
      $type: 'truncated-string',
      length: s.length,
      value: s.slice(0, limits.maxStringLength),
    }
  }

  const object = value as object
  if (seen.has(object)) return { $type: 'cycle' }
  if (depth >= limits.maxDepth) return { $type: 'max-depth', depth }

  if (isError(object)) {
    const error = value as Error
    return { $type: 'error', name: error.name, message: error.message, stack: error.stack ?? null }
  }
  if (isDate(object)) {
    // An Invalid Date answers `toISOString` with a RangeError, and a throw here
    // costs the whole result rather than this one value.
    const time = (value as Date).getTime()
    return Number.isFinite(time)
      ? { $type: 'date', value: (value as Date).toISOString() }
      : { $type: 'date', value: null, invalid: true }
  }
  if (isRegExp(object)) return { $type: 'regexp', value: String(value) }
  if (isThenable(object)) {
    return { $type: 'promise', hint: 'not awaited: write `await` before the call that produced this value' }
  }

  seen.add(object)
  try {
    if (isMap(object)) {
      return {
        $type: 'map',
        entries: [...(value as Map<unknown, unknown>)]
          .slice(0, limits.maxArrayLength)
          .map(([k, v]) => [walk(k, limits, depth + 1, seen), walk(v, limits, depth + 1, seen)]),
      }
    }
    if (isSet(object)) {
      return {
        $type: 'set',
        values: [...(value as Set<unknown>)].slice(0, limits.maxArrayLength).map((v) =>
          walk(v, limits, depth + 1, seen)
        ),
      }
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, limits.maxArrayLength).map((item) => walk(item, limits, depth + 1, seen))
      if (value.length > limits.maxArrayLength) items.push({ $type: 'truncated-array', length: value.length })
      return items
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      const length = value instanceof ArrayBuffer ? value.byteLength : value.byteLength
      return { $type: 'binary', byteLength: length }
    }

    const out: Record<string, unknown> = {}
    const keys = Object.keys(value as Record<string, unknown>)
    for (const key of keys.slice(0, limits.maxKeys)) {
      out[key] = walk((value as Record<string, unknown>)[key], limits, depth + 1, seen)
    }
    if (keys.length > limits.maxKeys) out.$truncatedKeys = keys.length - limits.maxKeys
    return out
  } finally {
    seen.delete(object)
  }
}

/**
 * Why every builtin below is recognised by its tag and not by `instanceof`.
 *
 * An agent's scenario runs in its own `node:vm` context (`runner.ts`), so every
 * value it builds itself belongs to another realm and fails `instanceof` here —
 * and an Error, Date, RegExp, Map, Set or Promise carries no own enumerable
 * keys, so it used to fall through to key enumeration and walk out as `{}`, the
 * one answer this file exists to prevent. The `Object.prototype.toString` tag
 * crosses the realm boundary. `Array.isArray` is cross-realm by design and
 * needs none of this.
 *
 * The tag alone cannot be acted on: `Symbol.toStringTag` is writable, so a plain
 * object can wear `'Map'` and turn `value.entries()` into a TypeError — and a
 * throw inside `walk` loses the whole result, not one value. Each test below
 * therefore pairs the tag with the members its branch is about to use; an object
 * that only wears the tag misses them and is enumerated as the data it is.
 */
function tagIs(value: object, tag: string): boolean {
  return Object.prototype.toString.call(value) === `[object ${tag}]`
}

function callable(value: object, member: PropertyKey): boolean {
  return typeof (value as Record<PropertyKey, unknown>)[member] === 'function'
}

function isError(value: object): boolean {
  return value instanceof Error || (tagIs(value, 'Error') && typeof (value as Error).message === 'string')
}

function isDate(value: object): boolean {
  return value instanceof Date || (tagIs(value, 'Date') && callable(value, 'getTime') && callable(value, 'toISOString'))
}

function isRegExp(value: object): boolean {
  return value instanceof RegExp || (tagIs(value, 'RegExp') && typeof (value as RegExp).source === 'string')
}

function isMap(value: object): boolean {
  return value instanceof Map ||
    (tagIs(value, 'Map') && callable(value, 'entries') && callable(value, Symbol.iterator))
}

function isSet(value: object): boolean {
  return value instanceof Set || (tagIs(value, 'Set') && callable(value, 'values') && callable(value, Symbol.iterator))
}

/**
 * Anything `await` would unwrap, whichever realm built it.
 *
 * The tag rule above, plus a `then` test that catches a thenable which is not a
 * promise at all — `await` unwraps that the same way, so returning one without
 * `await` is the same mistake and deserves the same answer. This branch reads no
 * member of the value, so a borrowed tag costs nothing here.
 */
function isThenable(value: object): boolean {
  if (tagIs(value, 'Promise')) return true
  return typeof (value as { then?: unknown }).then === 'function'
}

/** JSON with the markers already applied — what actually goes on the wire. */
export function encodeResult(value: unknown, limits: SerializeLimits = DEFAULT_LIMITS): string {
  return JSON.stringify(toTransferable(value, limits))
}
