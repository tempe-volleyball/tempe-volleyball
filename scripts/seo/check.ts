// SEO report for a running copy of the site (docs/public-site.md "Checking a build"):
//
//   npx tsx scripts/seo/check.ts --base http://127.0.0.1:8787            # every sitemap page + the extra pages below
//   npx tsx scripts/seo/check.ts --base http://127.0.0.1:8787 --old-urls # …and every old WordPress URL (one 301 to a 200)
//
// Prints one line per page (status, H1 count, JSON-LD types, problems) and exits 1 if anything is wrong.
// Read-only: it only sends GETs. Point it at a local build or staging, not production.
import { parseArgs } from 'node:util'
import { followOnce, oldUrls, pageReport, sitemapPaths } from './crawl'

const { values } = parseArgs({ options: { base: { type: 'string' }, 'old-urls': { type: 'boolean', default: false } } })
const base = values.base
if (!base) throw new Error('Pass --base http://127.0.0.1:<port>')

/** Pages that aren't in the sitemap but must still be right: search results and the enrolment pages linked from emails. */
const EXTRA = ['/search?q=thursday', '/enrol/confirm', '/enrol/offer']

const xml = await (await fetch(new URL('/sitemap.xml', base))).text()
let failed = 0
for (const path of [...sitemapPaths(xml), ...EXTRA]) {
  const r = await pageReport(base, path)
  // The noindex pages only need to render; their canonical is their own path without a query.
  const problems = EXTRA.includes(path) ? r.problems.filter((p) => !p.startsWith('canonical is')) : r.problems
  if (problems.length) failed++
  console.info(
    `${problems.length ? 'FAIL' : 'ok  '} ${r.status} h1=${r.h1s} ${path}  [${r.jsonLdTypes.join(', ')}]${problems.length ? `  ${problems.join('; ')}` : ''}`,
  )
}

const notFound = await fetch(new URL('/no-such-page-at-all', base), { redirect: 'manual' })
if (notFound.status !== 404) failed++
console.info(`${notFound.status === 404 ? 'ok  ' : 'FAIL'} ${notFound.status} /no-such-page-at-all (expects 404)`)

if (values['old-urls']) {
  const { urls } = await oldUrls()
  let bad = 0
  for (const u of urls) {
    const h = await followOnce(base, u)
    const ok = u === '/' ? h.status === 200 : h.status === 301 && h.finalStatus === 200
    if (!ok) {
      bad++
      console.info(`FAIL old ${u}: ${h.status} -> ${h.location} (${h.finalStatus})`)
    }
  }
  console.info(`old URLs: ${urls.length - bad} of ${urls.length} are one 301 to a 200`)
  failed += bad
}

console.info(failed ? `${failed} problem(s)` : 'all good')
process.exitCode = failed ? 1 : 0
