import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

/**
 * A project is the isolation boundary of the whole application: agents inside
 * one share a window, its tabs and its logins; agents in different ones share
 * nothing. Identity therefore has to be stable across the different spellings
 * of the same directory an IDE may hand us — a symlink, a trailing slash, a
 * different letter case on a case-insensitive volume.
 */
export interface ProjectIdentity {
  /** Hash of the normalised root. Used for partition names, so it never carries the path itself. */
  readonly id: string
  /** Absolute, symlink-resolved directory the project lives in. */
  readonly root: string
  /** Folder name, for the interface. */
  readonly name: string
}

/** Walk up from `cwd` to the nearest repository root, or return `cwd` itself. */
export function resolveProjectRoot(cwd: string): string {
  let dir = absolute(cwd)
  const seen = new Set<string>()
  while (!seen.has(dir)) {
    seen.add(dir)
    if (existsSync(resolve(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return absolute(cwd)
}

/** Absolute path with symlinks resolved; falls back to the plain absolute path for a missing directory. */
export function absolute(path: string): string {
  const abs = resolve(path)
  try {
    return realpathSync.native(abs)
  } catch {
    return abs
  }
}

/**
 * macOS volumes are case-insensitive by default, so `/Users/x/WWW` and
 * `/Users/x/www` are one directory and must be one project. Lowercasing here is
 * what makes them collide on purpose.
 */
export function normalizeRoot(root: string): string {
  return absolute(root).replace(/\/+$/, '').toLowerCase()
}

export function projectIdFor(root: string): string {
  return createHash('sha256').update(normalizeRoot(root)).digest('hex').slice(0, 16)
}

export function identify(cwd: string): ProjectIdentity {
  const root = resolveProjectRoot(cwd)
  return { id: projectIdFor(root), root, name: basename(root) || root }
}

/** Electron partition name. Carries the hash only — never the user's path. */
export function partitionFor(id: string): string {
  return `persist:p-${id}`
}
