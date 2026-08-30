import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const BUNDLE_ID = 'dev.korchasa.AgentBrowser'
export const APP_NAME = 'Agent Browser.app'

/**
 * Where the application might be, in the order worth trying.
 *
 * The last entry is the one that matters while the app itself is being built:
 * there is no bundle in /Applications yet, and a bridge that only knows the
 * installed path fails in exactly the situation where it is needed most.
 */
export function candidates() {
  const explicit = process.env.AGENT_BROWSER_APP
  const devRoot = process.env.AGENT_BROWSER_DEV_ROOT
  return [
    explicit ? { kind: 'explicit', path: explicit } : null,
    { kind: 'bundle-id', path: BUNDLE_ID },
    { kind: 'applications', path: join('/Applications', APP_NAME) },
    { kind: 'home-applications', path: join(process.env.HOME ?? '', 'Applications', APP_NAME) },
    devRoot ? { kind: 'dev', path: devRoot } : null,
  ].filter(Boolean)
}

/** Start the app, or explain every place we looked. Never a silent hang. */
export async function launchApp() {
  const tried = []
  for (const candidate of candidates()) {
    tried.push(`${candidate.kind}: ${candidate.path}`)
    if (candidate.kind === 'bundle-id') {
      if (await openByBundleId(candidate.path)) return { started: true, how: candidate }
      continue
    }
    if (candidate.kind === 'dev') {
      const electron = join(candidate.path, 'node_modules/.bin/electron')
      const entry = join(candidate.path, 'dist/main.js')
      if (!existsSync(electron) || !existsSync(entry)) continue
      detach(electron, [entry], candidate.path)
      return { started: true, how: candidate }
    }
    if (!existsSync(candidate.path)) continue
    detach('/usr/bin/open', ['-a', candidate.path])
    return { started: true, how: candidate }
  }
  const error = new Error(
    'Agent Browser is not running and could not be started. Looked in:\n  ' +
      tried.join('\n  ') +
      '\nSet AGENT_BROWSER_APP to the application, or AGENT_BROWSER_DEV_ROOT to a checkout, and try again.',
  )
  error.code = 'app-not-found'
  throw error
}

function detach(command, args, cwd) {
  const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' })
  child.unref()
}

function openByBundleId(bundleId) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/open', ['-g', '-b', bundleId], { stdio: 'ignore' })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}
