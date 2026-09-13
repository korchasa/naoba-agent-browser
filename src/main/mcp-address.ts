/**
 * Where an agent reaches this copy, in the words a person pastes.
 *
 * The address used to be found rather than told: the application took whatever
 * port was free, wrote it into a file, and the relay read the file. Nothing
 * reads a file any more — the address lives in the IDE's configuration, so it
 * has to be the same after a restart. Hence a fixed port per copy, and two
 * copies that cannot be confused with each other.
 *
 * Pure on purpose — no `electron` here, so the unit tests read it directly.
 */

/**
 * The port this copy listens on.
 *
 * The development copy and the copy people download are different
 * applications with different state directories, and an agent pointed at one
 * must never land in the other.
 */
export function mcpPort(isDevCopy: boolean): number {
  return isDevCopy ? 8900 : 8899
}

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`
}

/**
 * The whole line that connects an agent, token included.
 *
 * `${PWD}` is not ours to expand: the IDE does it, once per session, and that
 * is how one line written today answers for every repository the person works
 * in tomorrow. The token is here because there is nowhere else for it — the
 * IDE reads no state directory, so the secret has to sit in its configuration.
 */
export function connectCommand(port: number, token: string): string {
  return [
    'claude mcp add --transport http naoba',
    mcpUrl(port),
    '--header "X-Project: ${PWD}"',
    `--header "Authorization: Bearer ${token}"`,
  ].join(' ')
}
