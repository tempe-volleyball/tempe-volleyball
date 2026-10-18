// What the Worker logs about a failure. Workers Logs keep everything logged, and an error's message can carry
// personal data: drizzle's DrizzleQueryError reads "Failed query: <sql>\nparams: <bound values>", and those values
// are names, emails, phones and the signed links in offer, confirm and invite emails. So nothing in src/ logs an
// error object, `e.message` or `String(e)` directly; it logs describeError(e). src/server/log.test.ts checks every
// console call in src/ for that.

/** Cuts a failed query's text and bound values out of a message, keeping what went wrong. At most 500 characters. */
export function scrubMessage(message: string): string {
  return message
    .replace(/\s*params:[\s\S]*$/i, '')
    .replace(/Failed query:[\s\S]*/i, 'Failed query (SQL not logged)')
    .slice(0, 500)
}

const codeOf = (e: unknown) => {
  const code = (e as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? ` (${code})` : ''
}

/**
 * What's logged for an unexpected error: its name, code and message, and its cause's, with any query text and
 * parameters cut off. Never the error object itself. A string is scrubbed the same way; anything else is named by
 * its type only.
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return typeof e === 'string' ? scrubMessage(e) : typeof e
  const parts = [`${e.name}${codeOf(e)}: ${scrubMessage(e.message)}`]
  const cause = (e as { cause?: unknown }).cause
  if (cause instanceof Error) parts.push(`cause ${cause.name}${codeOf(cause)}: ${scrubMessage(cause.message)}`)
  return parts.join('; ')
}
