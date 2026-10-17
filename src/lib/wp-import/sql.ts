// SQL text for the importer: literal escaping, multi-row upserts, and chunking to stay inside D1's limits
// (100 KB per statement; we also keep each `wrangler d1 execute --file` modest).

export type SqlValue = string | number | boolean | null | undefined | object

export const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

/** A SQL literal. Objects and arrays are stored as JSON text (Drizzle's text({ mode: 'json' })). */
export function sqlLiteral(v: SqlValue): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Not a finite number: ${v}`)
    return String(v)
  }
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  // SQLite string literal: double the quotes. NUL bytes can't appear in TEXT literals, so drop them.
  return `'${s.replaceAll('\0', '').replaceAll("'", "''")}'`
}

const ident = (s: string) => `"${s.replaceAll('"', '""')}"`

export type UpsertOptions = {
  /** Conflict target columns (a primary key or unique index). */
  conflict: string[]
  /** Columns to overwrite on conflict; default every inserted column not in `conflict`. [] = DO NOTHING. */
  update?: string[]
  /** Also set updated_at to now on conflict (tables with our timestamps). */
  touch?: boolean
  /** Only update when this holds, e.g. `"redirects"."source" = 'wp-import'`. */
  where?: string
}

/** One INSERT … ON CONFLICT statement for rows that all have the same columns. */
export function upsertSql(table: string, rows: Record<string, SqlValue>[], opts: UpsertOptions): string {
  if (rows.length === 0) throw new Error('upsertSql: no rows')
  const cols = Object.keys(rows[0]!)
  const values = rows.map((r) => {
    const keys = Object.keys(r)
    if (keys.length !== cols.length || keys.some((k, i) => k !== cols[i])) throw new Error(`upsertSql(${table}): rows differ in columns`)
    return `(${cols.map((c) => sqlLiteral(r[c])).join(', ')})`
  })
  const update = opts.update ?? cols.filter((c) => !opts.conflict.includes(c))
  const sets = update.map((c) => `${ident(c)} = excluded.${ident(c)}`)
  if (opts.touch && update.length) sets.push(`"updated_at" = ${NOW_SQL}`)
  const action = sets.length ? `DO UPDATE SET ${sets.join(', ')}${opts.where ? ` WHERE ${opts.where}` : ''}` : 'DO NOTHING'
  return `INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES\n${values.join(',\n')}\nON CONFLICT (${opts.conflict.map(ident).join(', ')}) ${action};`
}

export const MAX_STATEMENT_BYTES = 90_000

const encoder = new TextEncoder()
const bytes = (s: string) => encoder.encode(s).length

/**
 * Upserts as few statements as fit under MAX_STATEMENT_BYTES. A single row too big for one statement (a long page
 * body) is inserted with its largest text column empty, then that column is appended to in pieces by `key`.
 */
export function upsertStatements(table: string, rows: Record<string, SqlValue>[], opts: UpsertOptions & { key?: string }): string[] {
  const out: string[] = []
  let batch: Record<string, SqlValue>[] = []
  const flush = () => {
    if (batch.length) out.push(upsertSql(table, batch, opts))
    batch = []
  }
  let size = 0
  for (const row of rows) {
    const single = bytes(upsertSql(table, [row], opts))
    if (single > MAX_STATEMENT_BYTES) {
      flush()
      out.push(...oversizedRow(table, row, opts))
      continue
    }
    // `single` counts the INSERT/ON CONFLICT text once per row, so the running total over-estimates: safe.
    if (batch.length && size + single > MAX_STATEMENT_BYTES) flush()
    if (!batch.length) size = 0
    batch.push(row)
    size += single
  }
  flush()
  return out
}

function oversizedRow(table: string, row: Record<string, SqlValue>, opts: UpsertOptions & { key?: string }): string[] {
  const key = opts.key ?? 'id'
  const big = Object.entries(row)
    .map(
      ([k, v]) =>
        [
          k,
          v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean'
            ? ''
            : typeof v === 'string'
              ? v
              : JSON.stringify(v),
        ] as const,
    )
    .sort((a, b) => b[1].length - a[1].length)[0]!
  const [col, text] = big
  const stmts = [upsertSql(table, [{ ...row, [col]: '' }], opts)]
  // Split on code points so a piece never ends inside a surrogate pair. A code point is at most 4 bytes, doubled if
  // it's a quote, so pieces of (limit / 8) code points always fit.
  const chars = [...text]
  const piece = Math.floor((MAX_STATEMENT_BYTES - 1000) / 8)
  for (let i = 0; i < chars.length; i += piece) {
    const part = chars.slice(i, i + piece).join('')
    stmts.push(
      `UPDATE ${ident(table)} SET ${ident(col)} = ${ident(col)} || ${sqlLiteral(part)} WHERE ${ident(key)} = ${sqlLiteral(row[key])};`,
    )
  }
  return stmts
}

/** Groups statements into files of at most `maxBytes` each (no statement is split). */
export function chunkStatements(stmts: string[], maxBytes = 400_000): string[] {
  const files: string[] = []
  let cur: string[] = []
  let size = 0
  for (const s of stmts) {
    const n = bytes(s) + 1
    if (cur.length && size + n > maxBytes) {
      files.push(cur.join('\n') + '\n')
      cur = []
      size = 0
    }
    cur.push(s)
    size += n
  }
  if (cur.length) files.push(cur.join('\n') + '\n')
  return files
}
