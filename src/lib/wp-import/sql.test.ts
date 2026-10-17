import { describe, expect, it } from 'vitest'
import { createTestDb } from '../../server/db/testing'
import { chunkStatements, MAX_STATEMENT_BYTES, sqlLiteral, upsertSql, upsertStatements } from './sql'

describe('sqlLiteral', () => {
  it('escapes values', () => {
    expect(sqlLiteral(null)).toBe('NULL')
    expect(sqlLiteral(undefined)).toBe('NULL')
    expect(sqlLiteral(true)).toBe('1')
    expect(sqlLiteral(42)).toBe('42')
    expect(sqlLiteral("it's")).toBe("'it''s'")
    expect(sqlLiteral({ a: "b'c" })).toBe(`'{"a":"b''c"}'`)
    expect(() => sqlLiteral(Number.NaN)).toThrow('Not a finite number')
  })
})

describe('upserts', () => {
  it('builds INSERT … ON CONFLICT DO UPDATE', () => {
    expect(upsertSql('teams', [{ id: 'a', name: 'A' }], { conflict: ['id'], touch: true })).toBe(
      `INSERT INTO "teams" ("id", "name") VALUES\n('a', 'A')\nON CONFLICT ("id") DO UPDATE SET "name" = excluded."name", "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');`,
    )
    expect(upsertSql('t', [{ id: 'a' }], { conflict: ['id'], update: [] })).toContain('DO NOTHING')
  })

  it('is idempotent against the real schema, and splits rows too big for one statement', async () => {
    const { sqlite } = createTestDb()
    const body = { blocks: [], html: `<p>${"x'y".repeat(60_000)}</p>` }
    const page = { id: 'p1', path: '/big', title: 'Big', template: 'content', body, status: 'published', wp_id: 7 }
    const stmts = upsertStatements('pages', [page], { conflict: ['id'], touch: true })
    expect(stmts.length).toBeGreaterThan(2)
    for (const s of stmts) expect(new TextEncoder().encode(s).length).toBeLessThan(MAX_STATEMENT_BYTES)
    for (let run = 0; run < 2; run++) for (const s of stmts) sqlite.exec(s)
    const row = sqlite.prepare('SELECT body FROM pages WHERE id = ?').get('p1') as { body: string }
    expect(JSON.parse(row.body)).toEqual(body)
    expect((sqlite.prepare('SELECT count(*) AS n FROM pages').get() as { n: number }).n).toBe(1)
  })

  it('leaves rows the guard excludes alone, big ones included (as import-wp does for edited pages)', () => {
    const { sqlite } = createTestDb()
    sqlite.exec(
      `INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at") VALUES ('mm', 'M', 'm@x.au', 1, 0, 0)`,
    )
    const opts = { conflict: ['id'], touch: true, where: `"pages"."updated_by" IS NULL`, update: ['path', 'title', 'body'] }
    const page = (id: string, html: string) => ({
      id,
      path: `/${id}`,
      title: 'Imported',
      template: 'content',
      body: { blocks: [], html },
      status: 'published',
    })
    const rows = [page('small', '<p>a</p>'), page('big', `<p>${'x'.repeat(200_000)}</p>`), page('edited', `<p>${'y'.repeat(200_000)}</p>`)]
    for (const s of upsertStatements('pages', rows, opts)) sqlite.exec(s)
    sqlite.exec(`UPDATE pages SET status = 'archived' WHERE id = 'small'`)
    sqlite.exec(`UPDATE pages SET title = 'Mine', body = '{"blocks":[],"html":"<p>mine</p>"}', updated_by = 'mm' WHERE id = 'edited'`)
    for (const s of upsertStatements('pages', rows, opts)) sqlite.exec(s)
    const get = (id: string) =>
      sqlite.prepare('SELECT title, status, body FROM pages WHERE id = ?').get(id) as { title: string; status: string; body: string }
    expect(get('small').status).toBe('archived')
    expect(JSON.parse(get('big').body).html).toBe(rows[1]!.body.html)
    expect(get('edited')).toEqual({ title: 'Mine', status: 'published', body: '{"blocks":[],"html":"<p>mine</p>"}' })
  })

  it('batches many small rows into few statements', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `t${i}`, name: `Team ${i}`, slug: `team-${i}` }))
    const stmts = upsertStatements('teams', rows, { conflict: ['id'] })
    expect(stmts.length).toBe(1)
  })
})

describe('chunkStatements', () => {
  it('groups statements by size without splitting any', () => {
    const files = chunkStatements(['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(10)], 100)
    expect(files).toEqual([`${'a'.repeat(60)}\n`, `${'b'.repeat(60)}\n${'c'.repeat(10)}\n`])
  })
})
