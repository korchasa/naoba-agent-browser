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
      'Call this first, before any other tool here. Say which project you are working in and, in a few words, ' +
      'what you are doing there: the project decides whose browser you get, and the name is what the person ' +
      'sees in the window beside your tab. Opens your tab — at `url` if you give one — and answers with the ' +
      'project, your tab and whoever else is here.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'What you are here to do, in a few words — "rewriting the checkout tests", not "agent 2". Shown ' +
            'to the person beside your tab.',
        },
        dir: {
          type: 'string',
          description:
            'The absolute path of the project you are working in — your working directory, or the repository ' +
            'root above it. Agents that name the same project share a browser; agents in different projects ' +
            'share nothing.',
        },
        url: {
          type: 'string',
          description: 'Where to open your tab. Left out, the tab opens empty and waits for your first scenario.',
        },
      },
      required: ['name', 'dir'],
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
