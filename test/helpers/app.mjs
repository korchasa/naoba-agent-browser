import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppClient } from '../../packages/bridge/client.mjs'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/**
 * Start a copy of the application the tests own outright: its own port and its
 * own state directory, so a test run never touches the browser the owner is
 * actually using, and never inherits its admitted projects.
 */
export async function startApp(
  { port = 8951, extraArgs = [], userDataDir = null, keepState = false, headless = true } = {},
) {
  // A caller that passes a directory it already owns is restarting the app on
  // purpose — that is the only way to prove a login outlives the application.
  const userData = userDataDir ?? (await mkdtemp(join(tmpdir(), 'naoba-test-')))
  const child = spawn(
    join(root, 'node_modules/.bin/electron'),
    [
      join(root, 'dist/main.js'),
      '--admit-everything',
      // Tests drive a browser; they must not put windows on the owner's screen.
      // A test that needs the real windowing path passes headless: false — the
      // window is still invisible, but Chromium treats input the way it does
      // for the person's own machine, which is where key events go missing.
      ...(headless ? ['--headless'] : []),
      '--port',
      String(port),
      '--user-data-dir',
      userData,
      '--idle-unload-ms',
      '2000',
      // Short enough for the test that watches a departed agent's tab go, long
      // enough that a disconnect in any other test does not pull the tab from
      // under the agent that stayed.
      '--orphan-close-ms',
      '1500',
      '--contention-wait-ms',
      // Long enough that a slow machine does not read a queued command as a
      // deadlock, short enough that the contention test still finishes.
      '6000',
      ...extraArgs,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))

  const listening = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the app did not start in 30s\n${stderr.join('')}`)), 30_000)
    child.stdout.on('data', (chunk) => {
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(String(chunk))
      if (!match) return
      clearTimeout(timer)
      resolve(Number(match[1]))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the app exited with ${code}\n${stderr.join('')}`))
    })
  })

  // The application demands this on the first message of every connection, and
  // writes it into the state directory before it says it is listening.
  const { token } = JSON.parse(await readFile(join(userData, 'bridge.json'), 'utf8'))

  const clients = []

  return {
    port: listening,
    userData,
    token,
    /** Connect as one agent working in `projectDir`. */
    async agent(projectDir, label = 'test-agent') {
      const client = new AppClient()
      const events = []
      client.onEvent((event) => events.push(event))
      await client.connect(listening, token)
      const welcome = await client.hello(projectDir, { label, ide: 'test', pid: process.pid })
      clients.push(client)
      return {
        client,
        events,
        project: welcome.project,
        agentId: welcome.agentId,
        run: (code, timeout = 20_000) => client.call('eval', { code, timeout }),
        status: () => client.call('status', {}),
        close: () => client.close(),
      }
    },
    async stop() {
      for (const client of clients) client.close()
      child.kill('SIGTERM')
      await new Promise((resolve) => child.on('exit', resolve))
      if (!keepState) await rm(userData, { recursive: true, force: true })
    },
  }
}

// Well clear of the port the shared test app holds, so a test that starts its
// own copy cannot end up talking to that one instead.
export const nextPort = (() => {
  let next = 8960
  return () => next++
})()
