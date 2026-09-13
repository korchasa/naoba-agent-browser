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
      'Call this first, before any other tool here. Say in a few words what you are working on: that is the ' +
      'name the person sees in the window beside your tab, and it is how they tell you from the other agents ' +
      'working in this same project. Opens your tab — at `url` if you give one — and answers with the project, ' +
      'your tab and whoever else is here.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'What you are here to do, in a few words — "rewriting the checkout tests", not "agent 2". Shown ' +
            'to the person beside your tab.',
        },
        url: {
          type: 'string',
          description: 'Where to open your tab. Left out, the tab opens empty and waits for your first scenario.',
        },
      },
      required: ['name'],
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
