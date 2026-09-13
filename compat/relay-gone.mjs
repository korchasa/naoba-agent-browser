/**
 * A signpost for a copy of Naoba that predates 1.0.4.
 *
 * Until 1.0.4 the application shipped a relay here: a program the IDE launched
 * per session, speaking MCP on one side and the application's own protocol on
 * the other. The application answers MCP itself now, so there is nothing left
 * for the IDE to launch — but the entry that launches it sits in the person's
 * own configuration, where an update cannot reach it.
 *
 * Without this file that entry dies with ERR_MODULE_NOT_FOUND, which says
 * nothing about what happened or what to do. So the file stays, and says both.
 */
const port = 8899

process.stderr.write(
  [
    'Naoba no longer runs a separate program for MCP.',
    '',
    'Since 1.0.4 the application answers MCP itself, over HTTP on',
    `127.0.0.1:${port}, and this entry in your MCP configuration launches a`,
    'program that is not there any more.',
    '',
    'Open Naoba, and under Settings › Connecting an agent press Copy: that is',
    "the whole line to paste, this copy's token and all. Remove this entry",
    'afterwards.',
    '',
  ].join('\n'),
)
process.exit(1)
