import { TOOL_DESCRIPTION } from './reference.mjs'

/**
 * What the agent sees. The description is the only thing that arrives
 * unasked, and the client cuts it at about 2040 characters — so it carries the
 * shape of a scenario, the handful of helpers that save a round trip, and the
 * name of the call that prints the rest. `reference.mjs` owns both texts.
 */
export const TOOLS = [
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
