import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'

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

/**
 * The project an agent named, as this application will refer to it from now on.
 *
 * The agent says which project it is in; nothing here second-guesses it. What
 * is left is spelling, and spelling is not a matter of trust: a symlink, a
 * trailing slash and a different letter case are three ways of writing one
 * directory, and two agents writing it two ways have to land in one window.
 */
export function identify(project: string): ProjectIdentity {
  const root = absolute(project)
  return { id: projectIdFor(root), root, name: basename(root) || root }
}

/** Electron partition name. Carries the hash only — never the user's path. */
export function partitionFor(id: string): string {
  return `persist:p-${id}`
}
