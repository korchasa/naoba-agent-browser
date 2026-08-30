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
   */
  async dist() {
    const built = await tasks.check!()
    if (built !== 0) return built
    return await npm(['run', 'dist'], { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
  },
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
