/**
 * What the agent actually reads: the text an `evalInBrowser` call comes back as.
 *
 * It lives apart from the endpoint that sends it so a test can assert the words
 * themselves. The shapes below are known by their form rather than by their
 * type: `runner.ts` builds them, and this module reads them without importing
 * anything from it.
 */

export function renderOutcome(outcome) {
  const parts = []
  if (outcome?.logs?.length) parts.push(outcome.logs.join('\n'))
  const value = outcome?.value
  if (value === undefined || (value && value.$type === 'undefined')) parts.push('(the script returned nothing)')
  else parts.push(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  return parts.join('\n\n')
}

export function renderError(error) {
  const lines = [error.message ?? String(error)]
  if (error.code) lines.unshift(`[${error.code}]`)
  const stack = error.details?.stack
  if (stack) lines.push('', stack)
  const logs = error.details?.logs
  if (logs?.length) lines.push('', 'console before the failure:', ...logs)
  lines.push(...renderTrail(error.details?.trail))
  return lines.join('\n')
}

/**
 * The api calls that ran before the failure, so the work they did is not lost
 * with the scenario.
 *
 * The sentence is the load-bearing part. These steps already happened — a click
 * that submitted a form is not undone by being listed — so an agent that reads
 * the trail as a checkpoint and re-runs from the top does the whole of it twice.
 * For a step that bought something, that is an expensive way to learn the
 * difference, which is why the warning is in the heading and not in a manual
 * nobody re-reads at the moment of failure.
 */
function renderTrail(trail) {
  if (!trail?.calls?.length) return []
  const lines = [
    '',
    `${trail.callCount} api call${trail.callCount === 1 ? '' : 's'} ran before this. ` +
    'They already happened: this is a record of what was done, not a checkpoint to resume from.',
  ]
  const dropped = trail.callCount - trail.calls.length
  if (dropped > 0) lines.push(`  (the first ${dropped} are not listed)`)
  for (const call of trail.calls) lines.push(`  ${call.step} ${call.call}${renderAnswer(call)}`)
  return lines
}

function renderAnswer(call) {
  // A scenario that runs out of time dies inside a call, so the call that never
  // came back is named rather than left out of the list.
  if (call.pending) return ' … still running when the scenario ended'
  if (!call.ok) return ` ✗ ${call.error ?? 'failed'}`
  // One line per call, whatever the value was: a `getText` answer carries its
  // own newlines, and a list that breaks across them cannot be counted.
  return call.value === undefined ? '' : ` → ${JSON.stringify(call.value)}`
}
