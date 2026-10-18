import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { sendOfferEmails, sendQuietly } from './enrolment/core'
import { describeError, scrubMessage } from './log'

const leaky = () =>
  new DrizzleQueryError(
    'insert into "email_outbox" ("id", "to", "template", "payload") values (?, ?, ?, ?)',
    ['row-1', 'pat@example.com', 'enrolment.offer', '{"url":"https://x/enrol/offer#o1.r.secret"}'],
    Object.assign(new Error('D1_ERROR: database is overloaded'), { code: 'SQLITE_BUSY' }),
  )

describe('describeError', () => {
  it('keeps what went wrong and drops the query text and its bound values', () => {
    const text = describeError(leaky())
    expect(text).toContain('Failed query (SQL not logged)')
    expect(text).toContain('database is overloaded')
    expect(text).toContain('SQLITE_BUSY')
    for (const secret of ['pat@example.com', 'o1.r.secret', 'email_outbox', 'params']) expect(text).not.toContain(secret)
  })

  it('scrubs strings too, names other values by type, and caps the length', () => {
    expect(describeError('Failed query: select 1 params: a@b.c')).toBe('Failed query (SQL not logged)')
    expect(describeError({ email: 'pat@example.com' })).toBe('object')
    expect(scrubMessage('x'.repeat(900))).toHaveLength(500)
  })
})

describe('email failures are logged scrubbed', () => {
  it('sendQuietly and sendOfferEmails log no address, name or link', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await sendQuietly(() => Promise.reject(leaky()), 'confirm-email')).toBe(false)
      const sent = await sendOfferEmails(
        {
          mailer: { sendEmail: () => Promise.reject(leaky()), queueStatement: () => undefined as never },
          secret: 's'.repeat(32),
          siteUrl: 'https://x',
        },
        [
          {
            type: 'registration',
            id: 'r1',
            registrationId: 'r1',
            reference: 'TVB-AAAA',
            email: 'pat@example.com',
            firstName: 'Pat',
            teamName: null,
            offeredAt: '2026-10-19T00:00:00.000Z',
            expiresAt: '2026-10-21T00:00:00.000Z',
            hours: 48,
          },
        ],
        { programme: 'Training', target: 'Thu 22 Oct' },
      )
      expect(sent).toBe(0)
      const logged = warn.mock.calls.flat().join('\n')
      expect(logged).toContain('database is overloaded')
      for (const secret of ['pat@example.com', 'o1.r.secret', 'params']) expect(logged).not.toContain(secret)
    } finally {
      warn.mockRestore()
    }
  })
})

// ── A lint-style check: every console call on the Worker side logs errors through describeError ──

const ROOTS = ['src/server', 'src/pages', 'src/middleware.ts', 'src/worker.ts']

function files(path: string): string[] {
  const st = statSync(path)
  if (st.isFile()) return /\.(ts|astro)$/.test(path) && !path.endsWith('.test.ts') ? [path] : []
  return readdirSync(path).flatMap((f) => files(join(path, f)))
}

/** The argument text of each console.<x>( … ) call, with its line. */
function consoleCalls(source: string) {
  const out: { line: number; args: string }[] = []
  const re = /console\.(error|warn|info|log|debug)\(/g
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
    }
    out.push({ line: source.slice(0, m.index).split('\n').length, args: source.slice(start, i - 1) })
  }
  return out
}

/** What an argument list still says once describeError(…) calls and the literal text of strings are taken out. */
function exposed(args: string) {
  let s = args
  // Drop describeError(…) (one level of nested parentheses is enough here).
  s = s.replace(/describeError\((?:[^()]|\([^()]*\))*\)/g, '')
  // Template literals: keep only their ${…} expressions. Quoted strings: drop.
  s = s.replace(/`(?:[^`\\]|\\.)*`/g, (t) => (t.match(/\$\{[^}]*\}/g) ?? []).join(' '))
  s = s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '')
  return s
}

const RAW_ERROR = /\b(e|err|error|reason|cause)\b|\.message\b|\bString\(/

describe('console calls on the Worker side', () => {
  it('never log a raw error (an error object, its message or String(e)): they go through describeError', () => {
    const offenders: string[] = []
    for (const root of ROOTS)
      for (const file of files(root)) {
        const source = readFileSync(file, 'utf8')
        for (const call of consoleCalls(source))
          if (RAW_ERROR.test(exposed(call.args))) offenders.push(`${relative('.', file)}:${call.line}: console(${call.args.trim()})`)
      }
    expect(offenders).toEqual([])
  })

  it('the check itself catches the usual shapes', () => {
    const flagged = (src: string) => consoleCalls(src).some((c) => RAW_ERROR.test(exposed(c.args)))
    expect(flagged("console.error('failed', e)")).toBe(true)
    expect(flagged('console.warn(`x: ${e instanceof Error ? e.message : String(e)}`)')).toBe(true)
    expect(flagged("console.error('cache purge failed', { tags, error })")).toBe(true)
    expect(flagged('console.warn(`x: ${describeError(e)}`)')).toBe(false)
    expect(flagged("console.info('the error page loaded')")).toBe(false)
  })
})
