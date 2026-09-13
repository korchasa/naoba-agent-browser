/**
 * One entry point for every verb the release tooling and the developer use.
 *
 * The application itself is an Electron app and lives on npm, so each task is a
 * thin wrapper: the uniform `deno task <verb>` interface is what matters, not
 * which package manager runs underneath.
 */
const verb = Deno.args[0] ?? 'check'
const rest = Deno.args.slice(1)

const run = async (command: string, args: string[], env: Record<string, string> = {}): Promise<number> => {
  const child = new Deno.Command(command, {
    args,
    env: { ...env },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }).spawn()
  const status = await child.status
  return status.code
}

const npm = (args: string[], env?: Record<string, string>) => run('npm', args, env)

const tasks: Record<string, () => Promise<number>> = {
  /** Compile, type-check and build. Says nothing about behaviour — that is `test`. */
  async check() {
    const install = await ensureDependencies()
    if (install !== 0) return install
    const types = await npm(['run', 'typecheck'])
    if (types !== 0) return types
    return await npm(['run', 'build'])
  },

  async test() {
    const built = await tasks.check!()
    if (built !== 0) return built
    return await npm(['run', 'test'])
  },

  async dev() {
    const built = await tasks.check!()
    if (built !== 0) return built
    return await run('node', ['scripts/restart.mjs', ...rest])
  },

  async fmt() {
    return await run('deno', ['fmt'])
  },

  /**
   * The release contract: an unsigned application bundle. Signing, packaging
   * and upload all happen outside this repository.
   *
   * `deno task dist dev` builds the development copy instead: the same
   * application under its own bundle id and name, so it can be installed next
   * to the release one and keeps its own state directory.
   */
  async dist() {
    const built = await tasks.check!()
    if (built !== 0) return built
    return await npm(['run', 'dist', '--', ...variant().builderArgs], { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
  },

  /**
   * Build a copy and put it in /Applications, replacing the one there. The copy
   * that is running is quit first (its sessions reach disk on quit) and the new
   * one is started in its place — about a minute, no signing involved. Without
   * an argument this installs the release copy; `deno task install dev` the
   * development one.
   */
  async install() {
    const built = await tasks.dist!()
    if (built !== 0) return built
    const { name, bundleId } = variant()
    const source = `build/mac-arm64/${name}.app`
    const target = `/Applications/${name}.app`
    try {
      await Deno.stat(source)
    } catch {
      console.error(`dist produced nothing at ${source}`)
      return 1
    }
    // `osascript` asks the running copy to quit the way the menu does, which is
    // what lets it flush the sessions; a signal would do the same, but only the
    // bundle id tells this copy apart from the other one.
    if (await isRunning(name)) {
      await run('osascript', ['-e', `tell application id "${bundleId}" to quit`])
      await waitUntilGone(name, 15_000)
    }
    const copied = await run('rsync', ['-a', '--delete', `${source}/`, `${target}/`])
    if (copied !== 0) return copied
    // Launch Services learned the bundle id from the build directory first and
    // would keep answering `open -b` with that copy — the MCP server launches by
    // bundle id — so the build copy is struck off and the installed one
    // registered in its place.
    await run(LSREGISTER, ['-u', source])
    await run(LSREGISTER, ['-f', target])
    console.log(`installed ${target}`)
    const opened = await run('/usr/bin/open', ['-g', '-a', target])
    if (opened !== 0) return opened
    // The copy registers itself as a login item on its first start; the list
    // System Events keeps is the one place a shell can read that back.
    console.log(
      (await isLoginItem(name, 15_000))
        ? `login item: ${name} is registered`
        : `login item: ${name} is not registered (off in System Settings, or the OS did not take it)`,
    )
    return 0
  },
}

/** The two copies of the application, told apart by the `dev` argument. */
function variant(): { name: string; bundleId: string; builderArgs: string[] } {
  if (rest[0] === 'dev') {
    const name = 'Naoba Dev'
    return {
      name,
      bundleId: 'dev.korchasa.Naoba.dev',
      builderArgs: [
        `-c.appId=dev.korchasa.Naoba.dev`,
        `-c.productName=${name}`,
        `-c.extraMetadata.productName=${name}`,
      ],
    }
  }
  if (rest[0] !== undefined) {
    console.error(`unknown variant "${rest[0]}"; the only one is "dev"`)
    Deno.exit(2)
  }
  return { name: 'Naoba', bundleId: 'dev.korchasa.Naoba', builderArgs: [] }
}

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister'

async function isRunning(name: string): Promise<boolean> {
  const probe = new Deno.Command('pgrep', {
    args: ['-f', `/${name}.app/Contents/MacOS/`],
    stdout: 'null',
    stderr: 'null',
  })
  return (await probe.output()).code === 0
}

/** Whether the login items System Settings shows include `name`, polled while the copy starts. */
async function isLoginItem(name: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const listed = await new Deno.Command('osascript', {
      args: ['-e', 'tell application "System Events" to get the name of every login item'],
      stdout: 'piped',
      stderr: 'null',
    }).output()
    const names = new TextDecoder().decode(listed.stdout).trim().split(', ')
    if (names.includes(name)) return true
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return false
}

async function waitUntilGone(name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isRunning(name))) return
    await new Promise((r) => setTimeout(r, 300))
  }
  console.error('the running copy did not quit in time; installing over it anyway')
}
async function ensureDependencies(): Promise<number> {
  try {
    const stat = await Deno.stat('node_modules/electron')
    if (stat.isDirectory) return 0
  } catch {
    // Not installed yet.
  }
  return await npm(['install', '--no-audit', '--no-fund'])
}

const task = tasks[verb]
if (!task) {
  console.error(`unknown task "${verb}"; try one of: ${Object.keys(tasks).join(', ')}`)
  Deno.exit(2)
}
Deno.exit(await task())
