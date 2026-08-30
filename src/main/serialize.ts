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

  if (value instanceof Error) {
    return { $type: 'error', name: value.name, message: value.message, stack: value.stack ?? null }
  }
  if (value instanceof Date) return { $type: 'date', value: value.toISOString() }
  if (value instanceof RegExp) return { $type: 'regexp', value: String(value) }

  seen.add(object)
  try {
    if (value instanceof Map) {
      return {
        $type: 'map',
        entries: [...value.entries()]
          .slice(0, limits.maxArrayLength)
          .map(([k, v]) => [walk(k, limits, depth + 1, seen), walk(v, limits, depth + 1, seen)]),
      }
    }
    if (value instanceof Set) {
      return { $type: 'set', values: [...value].slice(0, limits.maxArrayLength).map((v) => walk(v, limits, depth + 1, seen)) }
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

/** JSON with the markers already applied — what actually goes on the wire. */
export function encodeResult(value: unknown, limits: SerializeLimits = DEFAULT_LIMITS): string {
  return JSON.stringify(toTransferable(value, limits))
}
