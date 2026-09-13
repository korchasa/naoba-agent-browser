/**
 * Where this copy's MCP server is, in the words a person can paste.
 *
 * The panel says how to connect an agent, and that sentence has to be true of
 * the copy in front of them: an installed application carries its MCP server inside
 * the bundle, a checkout has it in the repository. Getting this wrong sends
 * somebody who just bought the application looking for a checkout they do not
 * have.
 *
 * Pure on purpose — no `electron` here, so the unit tests read it directly.
 */

/** The file an IDE launches with `node`. */
export function mcpServerEntry(packaged: boolean, resourcesPath: string, appPath: string): string {
  return packaged ? `${resourcesPath}/mcp-server/index.mjs` : `${appPath}/packages/mcp-server/index.mjs`
}

/**
 * Where an installed copy keeps it, spelled out.
 *
 * The pictures of the application are taken from a checkout, and a checkout's
 * path is the photographer's home directory — not what the screen says to
 * anybody who bought the thing. The snapshot run reports this instead.
 */
export const INSTALLED_MCP_SERVER = '/Applications/Naoba.app/Contents/Resources/mcp-server/index.mjs'

/** The whole line, as the empty panel prints it. */
export function mcpServerCommand(entry: string): string {
  return `claude mcp add naoba -- node ${entry}`
}
