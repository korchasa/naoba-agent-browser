import { TOOL_DESCRIPTION } from './reference.mjs'

/**
 * What the agent sees. The description is the only thing that arrives
 * unasked, and the client cuts it at about 2040 characters — so it carries the
 * shape of a scenario, the handful of helpers that save a round trip, and the
 * name of the call that prints the rest. `reference.mjs` owns both texts.
 */
export const TOOLS = [
  {
    name: 'begin',
    description:
      'Call this first, before any other tool here. Say which project you are working in, by absolute path, ' +
      'and in a few words what this session of yours is doing there: the project decides whose browser you ' +
      'get, and the session name is what the person sees in the window beside your tab. Opens your tab — at ' +
      '`url` if you give one — and answers with that tab and the other sessions working here.',
    inputSchema: {
      type: 'object',
      properties: {
        session_name: {
          type: 'string',
          description:
            'What this session is doing, in a few words — "rewriting the checkout tests", not "agent 2". ' +
            'Shown to the person beside your tab, and to the other sessions in this project.',
        },
        absolute_project_path: {
          type: 'string',
          description:
            'The project this session is working in, as an absolute path from the root — never a relative one ' +
            'and never a shell expression, because nothing expands or resolves it on the way here. Sessions ' +
            'that name the same project share a browser, its tabs and its logins; sessions in different ' +
            'projects share nothing.',
        },
        url: {
          type: 'string',
          description: 'Where to open your tab. Left out, the tab opens empty and waits for your first scenario.',
        },
      },
      required: ['session_name', 'absolute_project_path'],
    },
  },
  {
    name: 'evalInBrowser',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript to run, with `api` in scope. Top-level await works; return what you need.',
        },
        timeout: {
          type: 'number',
          description: 'Milliseconds the whole scenario may take. Default 60000.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'status',
    description:
      "What this project's browser looks like right now: the tabs and their state, the agents connected to it, " +
      'and which of them is you.',
    inputSchema: { type: 'object', properties: {} },
  },
]
