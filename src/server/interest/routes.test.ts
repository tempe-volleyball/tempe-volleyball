import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// EOIs and players are personal data (docs/admin.md §3.16): every handler under /api/admin/interest and
// /api/admin/players must require an admin with the role re-read from D1 (`{ fresh: true }`), so editors get 403 and
// a demoted admin loses access at once, and every body read must be capped below the admin default.

const ROUTES = ['src/pages/api/admin/interest', 'src/pages/api/admin/players']
const HANDLER = /export const (GET|POST|PATCH|PUT|DELETE): APIRoute = [\s\S]*?(?=\nexport const |\n*$)/g

describe('interest and players routes', () => {
  const files = ROUTES.flatMap((dir) => readdirSync(dir).map((f) => join(dir, f)))

  it('exist', () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
  })

  for (const file of files) {
    it(`${file}: every handler is admin+ with a fresh role read, and bodies are capped`, () => {
      const src = readFileSync(file, 'utf8')
      const handlers = [...src.matchAll(HANDLER)].map((m) => m[0])
      expect(handlers.length).toBeGreaterThan(0)
      for (const h of handlers) expect(h).toMatch(/requireRole\(locals\.user, 'admin', request, db, \{ fresh: true \}\)/)
      // Each readJson call, up to its first closing parenthesis.
      const reads = src
        .split(/readJson(?=[(<])/)
        .slice(1)
        .map((rest) => rest.slice(0, rest.indexOf(')') + 1))
      const writes = handlers.filter((h) => /export const (POST|PATCH|PUT)/.test(h)).length
      expect(reads.length).toBeGreaterThanOrEqual(writes)
      for (const r of reads) expect(r).toMatch(/\(request, \{ maxBytes: (INTEREST|PLAYER)_BODY_LIMIT \}\)$/)
    })
  }
})
