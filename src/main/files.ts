import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * What a scenario is allowed to hand a website.
 *
 * The rule that outranks the others here is about browsing context, and a file
 * on disk is not browsing state — so it does not settle this by itself. What
 * settles it is where the read happens. A scenario runs in the browser process:
 * nothing in the agent's own harness sees it and nobody is asked, while the text
 * the scenario was written from is page text, written by whoever controls the
 * page. "Attach your key to continue" is a real shape of prompt injection, and
 * the answer must not be that the browser quietly obliges.
 *
 * So the boundary is the directory this application already reasons in: the
 * project. A file from anywhere else is copied in first, and that copy runs in
 * the agent's own tools, where the person is already asked. The neighbouring
 * `screenshot(path)` writes anywhere, which is looser — writing a picture onto
 * the person's own disk and handing their file to a website are not the same
 * operation, and whether that write deserves a boundary of its own is a
 * separate question (recorded 2026-09-12, not answered here).
 */
export interface UploadBoundary {
  /** Directories a file may come from. The first is the project itself. */
  roots: string[]
  /** The boundary in the words an agent should read it in. */
  describe: string
}

/**
 * Is `candidate` inside `root`?
 *
 * Both sides have to be resolved through realpath before they get here, and the
 * comparison is `relative`, never a string prefix. Two traps, both of which
 * refuse or admit exactly the wrong path: on macOS `identify()` resolves a
 * project root through `realpathSync.native`, so a project under `/tmp` is
 * really `/private/tmp` and a string comparison refuses the project's own
 * files; and `/a/project-evil` starts with `/a/project` while being no part of
 * it.
 */
export function within(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const step = relative(root, candidate)
  return step !== '' && !step.startsWith('..') && !isAbsolute(step)
}

/**
 * Turn what an agent asked for into paths the browser may be handed, or say why
 * not. A relative path is read against the project, which is the only directory
 * an agent could mean — the browser's own working directory means nothing to it.
 */
export async function resolveUploadPaths(asked: string[], boundary: UploadBoundary): Promise<string[]> {
  const roots = await Promise.all(boundary.roots.map(canonical))
  const project = roots[0] ?? resolve('.')
  const inside = (path: string) => roots.some((root) => within(root, path))
  const outside = (raw: string, leadsTo: string | null) => {
    const link = leadsTo === null ? '' : ` (it leads to ${leadsTo})`
    return new Error(
      `${raw} is outside this project${link}, so setFiles will not read it. It reads files under ` +
        `${boundary.describe}. Copy the file into the project and pass the copy — that copy happens in your own ` +
        `tools, where the person is asked.`,
    )
  }

  const files: string[] = []
  for (const raw of asked) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error('setFiles takes a path, or a list of them: setFiles("#photo", "/path/to/photo.jpg")')
    }
    const wanted = resolve(project, raw)
    let real: string
    try {
      real = await realpath(wanted)
    } catch {
      // Nothing is there — but a path outside the project is refused for being
      // outside it whether or not it exists, or the refusal tells an agent which
      // paths on the person's disk are real. The check still has to go through
      // the directories that do exist: a project under `/tmp` really lives in
      // `/private/tmp`, and comparing the unresolved path would call the
      // project's own missing file an intruder.
      const asFarAsItGoes = await resolveThroughExisting(wanted)
      if (!inside(asFarAsItGoes)) throw outside(raw, null)
      throw new Error(`there is no file at ${raw}`)
    }
    if (!inside(real)) throw outside(raw, real === wanted ? null : real)
    const info = await stat(real)
    if (info.isDirectory()) throw new Error(`${raw} is a directory, and setFiles takes files — name one inside it`)
    if (!info.isFile()) throw new Error(`${raw} is not a regular file, so it cannot be uploaded`)
    try {
      await access(real, constants.R_OK)
    } catch {
      throw new Error(`${raw} cannot be read`)
    }
    files.push(real)
  }
  return files
}

/**
 * The path with every directory that exists resolved, and the missing tail left
 * as written. `realpath` refuses a path that is not there, and the answer to
 * "may this file be read" must not depend on whether it happens to exist.
 */
async function resolveThroughExisting(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      const real = await realpath(current)
      return missing.length === 0 ? real : join(real, ...missing)
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.unshift(basename(current))
      current = parent
    }
  }
}

/** A directory that may not exist yet — the screenshot one is made on first use. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}
