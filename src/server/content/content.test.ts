import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type QueryStats, type TestDb } from '../db/testing'
import { loadSite } from '../site'
import { auditLog, leagues, media, menuItems, pageRevisions, pages, redirects, siteSettings, user, type UserRole } from '../db/schema'
import { HttpError } from '../http'
import { purge } from '../cache'
import { REVISION_LIMIT, createPage, deletePage, getPage, listPages, restoreRevision, setPageStatus, updatePage } from './pages'
import { createPost, deletePost, listPosts, setPostStatus, updatePost } from './posts'
import { getMenu, saveMenu } from './menu'
import { createMedia, deleteMedia, listMedia, mediaUsage, storeUpload, updateMedia, type MediaBucket } from './media'
import { getSettings, saveSettings } from './settings'

const NOW = new Date('2026-10-18T00:00:00.000Z')
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

let db: TestDb
let stats: QueryStats
let editor: { id: string; ip: string }
beforeEach(async () => {
  ;({ db, stats } = createTestDb())
  editor = await addUser('ed', 'editor')
})

const addUser = async (id: string, role: UserRole) => {
  await db.insert(user).values({ id, name: id, email: `${id}@example.com`, emailVerified: true, role })
  return { id, ip: '203.0.113.9' }
}

const doc = (text: string) => [{ type: 'paragraph', content: [{ type: 'text', text }] }]

const rejects = async (p: Promise<unknown>, status: number, code?: string) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpError)
  expect((e as HttpError).status).toBe(status)
  if (code) expect((e as HttpError).code).toBe(code)
  return e as HttpError
}

const redirectRows = () =>
  db.select({ from: redirects.fromPath, to: redirects.toPath, status: redirects.status }).from(redirects).orderBy(redirects.fromPath).all()

describe('pages', () => {
  it('creates a draft with sanitised HTML rendered on the server', async () => {
    const page = await createPage(db, editor, {
      title: '  About  us ',
      path: 'About',
      blocks: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '<b>hi</b>', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
        },
      ],
    })
    expect(page).toMatchObject({ title: 'About us', path: '/about', status: 'draft', template: 'content', updatedBy: 'ed' })
    expect(page.body.html).toBe('<p>&lt;b&gt;hi&lt;/b&gt;</p>')
    const { revisions } = await getPage(db, page.id)
    expect(revisions).toHaveLength(1)
    expect(revisions[0]!.createdBy).toBe('ed@example.com')
  })

  it('validates input', async () => {
    await rejects(createPage(db, editor, { title: '', path: '/x' }), 400)
    await rejects(createPage(db, editor, { title: 'x', path: '/admin/x' }), 400)
    await rejects(createPage(db, editor, { title: 'x', path: '/x', template: 'weird' }), 400)
    await rejects(createPage(db, editor, { title: 'x', path: '/x', blocks: 'not json blocks' }), 400)
    await rejects(createPage(db, editor, { title: 'x', path: '/x', ogImageId: 'missing' }), 400)
    await rejects(createPage(db, editor, { title: 'x', path: '/x', metaDescription: 'm'.repeat(301) }), 400)
    await createPage(db, editor, { title: 'One', path: '/x' })
    const e = await rejects(createPage(db, editor, { title: 'Two', path: '/X/' }), 409)
    expect(e.message).toContain('One')
  })

  it('lists and searches', async () => {
    await createPage(db, editor, { title: 'Rules', path: '/rules' })
    await createPage(db, editor, { title: 'FAQ', path: '/faq' })
    await createPage(db, editor, { title: '100% fun', path: '/fun' })
    expect((await listPages(db)).map((p) => p.path)).toEqual(['/faq', '/fun', '/rules'])
    expect((await listPages(db, { q: 'rul' })).map((p) => p.path)).toEqual(['/rules'])
    expect((await listPages(db, { q: '100%' })).map((p) => p.path)).toEqual(['/fun'])
    expect(await listPages(db, { q: '%' })).toHaveLength(1)
  })

  it('a path change on a never-published page leaves no redirect', async () => {
    const page = await createPage(db, editor, { title: 'Draft', path: '/draft' })
    await updatePage(db, editor, page.id, { path: '/draft-2' })
    expect(await redirectRows()).toEqual([])
  })

  it('a published page moving gets a 301, chains are flattened and moving back is not a loop', async () => {
    const page = await createPage(db, editor, { title: 'About', path: '/about-tempe-vb' }, at(0))
    await db.insert(redirects).values({ fromPath: '/about-us-old', toPath: '/about-tempe-vb', source: 'wp-import' })
    await setPageStatus(db, editor, page.id, 'published', at(1))

    const moved = await updatePage(db, editor, page.id, { path: '/about' }, at(2))
    expect(moved.result.path).toBe('/about')
    expect(moved.purge).toEqual({ tags: ['page:/about-tempe-vb', 'page:/about', 'site'] })
    expect(await redirectRows()).toEqual([
      { from: '/about-tempe-vb', to: '/about', status: 301 },
      { from: '/about-us-old', to: '/about', status: 301 },
    ])

    // Moving back: /about-tempe-vb is a page again, so its redirect goes; /about now redirects back.
    await updatePage(db, editor, page.id, { path: '/about-tempe-vb' }, at(3))
    expect(await redirectRows()).toEqual([
      { from: '/about', to: '/about-tempe-vb', status: 301 },
      { from: '/about-us-old', to: '/about-tempe-vb', status: 301 },
    ])
  })

  it("can't move onto another page's path", async () => {
    await createPage(db, editor, { title: 'A', path: '/a' })
    const b = await createPage(db, editor, { title: 'B', path: '/b' })
    await rejects(updatePage(db, editor, b.id, { path: '/a' }), 409)
    expect((await getPage(db, b.id)).page.path).toBe('/b')
  })

  it('refuses a save based on a stale copy', async () => {
    const page = await createPage(db, editor, { title: 'A', path: '/a' }, at(0))
    await updatePage(db, editor, page.id, { title: 'B', baseUpdatedAt: page.updatedAt }, at(1))
    await rejects(updatePage(db, editor, page.id, { title: 'C', baseUpdatedAt: page.updatedAt }, at(2)), 409, 'conflict')
    expect((await getPage(db, page.id)).page.title).toBe('B')
  })

  it('keeps the last 20 revisions and can restore one', async () => {
    const page = await createPage(db, editor, { title: 'v0', path: '/r', blocks: doc('v0') }, at(0))
    for (let i = 1; i <= 25; i++) await updatePage(db, editor, page.id, { title: `v${i}`, blocks: doc(`v${i}`) }, at(i))
    const all = await db.select().from(pageRevisions).where(eq(pageRevisions.pageId, page.id)).all()
    expect(all).toHaveLength(REVISION_LIMIT)
    const { revisions } = await getPage(db, page.id)
    expect(revisions.map((r) => r.title).slice(0, 3)).toEqual(['v25', 'v24', 'v23'])
    expect(revisions.at(-1)!.title).toBe('v6')

    const v10 = revisions.find((r) => r.title === 'v10')!
    const restored = await restoreRevision(db, editor, page.id, v10.id, at(30))
    expect(restored.result).toMatchObject({ title: 'v10' })
    expect(restored.result.body.html).toBe('<p>v10</p>')
    expect((await getPage(db, page.id)).revisions[0]!.title).toBe('v10')
    await rejects(restoreRevision(db, editor, page.id, 'nope'), 404)
  })

  it('snapshots an imported page (no revisions yet) before its first edit', async () => {
    await db.insert(pages).values({
      id: 'imported',
      path: '/rules',
      title: 'Rules',
      body: { blocks: [], html: '<p>Imported <iframe src="https://www.youtube.com/embed/x"></iframe></p>' },
      status: 'published',
      publishedAt: '2023-01-01T00:00:00.000Z',
      updatedAt: '2023-01-01T00:00:00.000Z',
    })
    await updatePage(db, editor, 'imported', { blocks: doc('New') }, at(0))
    const { revisions } = await getPage(db, 'imported')
    expect(revisions.map((r) => r.title)).toEqual(['Rules', 'Rules'])
    const original = revisions[1]!
    const back = await restoreRevision(db, editor, 'imported', original.id, at(1))
    expect(back.result.body.html).toContain('Imported')
  })

  it('publish and unpublish are audited and purge the page and layout', async () => {
    const page = await createPage(db, editor, { title: 'A', path: '/a' })
    await db.insert(redirects).values({ fromPath: '/a', toPath: '/somewhere' })
    const pub = await setPageStatus(db, editor, page.id, 'published', at(1))
    expect(pub.result).toMatchObject({ status: 'published', publishedAt: at(1).toISOString() })
    expect(pub.purge).toEqual({ tags: ['page:/a', 'site'] })
    expect(await redirectRows()).toEqual([])
    // Re-publishing keeps the first publish date.
    await setPageStatus(db, editor, page.id, 'draft', at(2))
    const again = await setPageStatus(db, editor, page.id, 'published', at(3))
    expect(again.result.publishedAt).toBe(at(1).toISOString())
    const log = await db.select().from(auditLog).orderBy(auditLog.at).all()
    expect(log.map((l) => l.action)).toEqual(['page.publish', 'page.unpublish', 'page.publish'])
    expect(log[0]).toMatchObject({ actorUserId: 'ed', targetType: 'page', targetId: page.id, ip: '203.0.113.9' })
    // Saving a draft purges nothing; saving a live page purges it.
    expect((await updatePage(db, editor, page.id, { title: 'B' })).purge).toEqual({ tags: ['page:/a'] })
    await rejects(setPageStatus(db, editor, page.id, 'weird' as never), 400)
  })

  it('delete is refused while the menu links to the page, and audited', async () => {
    const page = await createPage(db, editor, { title: 'A', path: '/a' })
    await db.insert(menuItems).values({ label: 'A link', kind: 'page', pageId: page.id })
    const e = await rejects(deletePage(db, editor, page.id), 409)
    expect(e.message).toContain('A link')
    await db.delete(menuItems)
    await deletePage(db, editor, page.id)
    expect(await db.select().from(pages).all()).toEqual([])
    expect((await db.select().from(auditLog).all()).map((l) => [l.action, (l.before as { path: string }).path])).toEqual([
      ['page.delete', '/a'],
    ])
    await rejects(deletePage(db, editor, page.id), 404)
  })
})

describe('posts', () => {
  it('create, publish (excerpt from the body), slug change redirect, delete', async () => {
    const post = await createPost(
      db,
      editor,
      { title: 'Season starts', slug: 'season-starts', blocks: doc('Games begin Thursday.') },
      at(0),
    )
    expect(post.excerpt).toBeNull()
    await rejects(createPost(db, editor, { title: 'Dup', slug: 'season-starts' }), 409)
    await rejects(createPost(db, editor, { title: 'Bad', slug: 'Season Starts' }), 400)

    const pub = await setPostStatus(db, editor, post.id, 'published', at(1))
    expect(pub.result).toMatchObject({ status: 'published', excerpt: 'Games begin Thursday.', publishedAt: at(1).toISOString() })
    expect(pub.purge).toEqual({ tags: ['news', 'page:/', 'post:season-starts'] })

    const moved = await updatePost(db, editor, post.id, { slug: 'season-2026-starts', publishedAt: '2026-10-01T00:00:00Z' }, at(2))
    expect(moved.result.publishedAt).toBe('2026-10-01T00:00:00.000Z')
    expect(await redirectRows()).toEqual([{ from: '/news/season-starts', to: '/news/season-2026-starts', status: 301 }])

    expect((await listPosts(db, { q: '2026' })).map((p) => p.slug)).toEqual(['season-2026-starts'])
    await deletePost(db, editor, post.id, at(3))
    expect((await db.select().from(auditLog).orderBy(auditLog.at).all()).map((l) => l.action)).toEqual(['post.publish', 'post.delete'])
  })

  it('lists unpublished posts first, then newest', async () => {
    const a = await createPost(db, editor, { title: 'Old', slug: 'old' }, at(0))
    const b = await createPost(db, editor, { title: 'New', slug: 'new' }, at(1))
    await createPost(db, editor, { title: 'Draft', slug: 'draft' }, at(2))
    await setPostStatus(db, editor, a.id, 'published', at(3))
    await setPostStatus(db, editor, b.id, 'published', at(4))
    expect((await listPosts(db)).map((p) => p.slug)).toEqual(['draft', 'new', 'old'])
  })
})

describe('menu', () => {
  it('saves the whole tree in one go and reads it back', async () => {
    const home = await createPage(db, editor, { title: 'Home', path: '/' })
    const faq = await createPage(db, editor, { title: 'FAQ', path: '/faq' })
    await setPageStatus(db, editor, home.id, 'published')
    await db.insert(leagues).values({ id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4 })
    const items = [
      { label: 'Home', kind: 'page', pageId: home.id },
      {
        label: 'Leagues',
        kind: 'url',
        children: [
          { label: 'TNL Ladder', kind: 'league_ladder', leagueId: 'tnl' },
          { label: 'TNL Fixtures', kind: 'league_fixtures', leagueId: 'tnl' },
          ...Array.from({ length: 12 }, (_, i) => ({ label: `Link ${i}`, kind: 'url', url: `/x${i}` })),
        ],
      },
      { label: 'About', kind: 'url', children: [{ label: 'FAQ', kind: 'page', pageId: faq.id }] },
    ]
    const res = await saveMenu(db, editor, items)
    expect(res).toEqual({ result: { items: 18 }, purge: { tags: ['site'] } })
    const { tree, pages: choices, leagues: ls } = await getMenu(db)
    expect(tree.map((n) => [n.label, n.href])).toEqual([
      ['Home', '/'],
      ['Leagues', null],
      ['About', null],
    ])
    expect(tree[1]!.children.slice(0, 2).map((c) => c.href)).toEqual(['/leagues/tnl#ladder', '/leagues/tnl#fixtures'])
    expect(choices).toHaveLength(2)
    expect(ls).toEqual([{ id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl' }])

    // Saving again with ids keeps them, and dropped items are deleted.
    const again = (await getMenu(db)).tree.slice(0, 1).map((n) => ({ id: n.id, label: 'Start', kind: n.kind, pageId: n.pageId }))
    await saveMenu(db, editor, again)
    const rows = await db.select().from(menuItems).all()
    expect(rows.map((r) => [r.id, r.label])).toEqual([[tree[0]!.id, 'Start']])
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'menu.update')).all()).length).toBe(2)
  })

  it('saves category dropdowns, pinned links and programme visibility, and expands them on the public site', async () => {
    const admin = { ...(await addUser('ad', 'admin')), role: 'admin' as const }
    const rules = await createPage(db, editor, { title: 'Rules', path: '/rules' })
    await setPageStatus(db, editor, rules.id, 'published')
    await db.insert(leagues).values([
      { id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4, categoryId: 'cat_mixed_leagues', sort: 0 },
      { id: 'fnl', code: 'FNL', name: 'Friday Night League', slug: 'fnl', weekday: 5, categoryId: 'cat_mixed_leagues', sort: 1 },
      { id: 'tr', code: 'SCT', name: 'Scrims', slug: 'scrims', weekday: 3, kind: 'training', categoryId: 'cat_adult_training' },
    ])
    const items = [
      {
        label: 'Mixed Leagues',
        kind: 'category',
        categoryId: 'cat_mixed_leagues',
        children: [
          { label: 'Rules', kind: 'page', pageId: rules.id, placement: 'before' },
          { label: 'Secret', kind: 'url', url: '/secret', hidden: true },
        ],
      },
      { label: 'Training', kind: 'programme', leagueId: 'tr' },
      // Near the size limit: 4 hidden headings with 25 links each.
      ...Array.from({ length: 4 }, (_, h) => ({
        label: `Heading ${h}`,
        kind: 'url',
        hidden: true,
        children: Array.from({ length: 25 }, (_, i) => ({ label: `Link ${i}`, kind: 'url', url: `/x${h}-${i}` })),
      })),
    ]
    stats.reset()
    // Editors can edit the menu but not programme settings.
    await rejects(saveMenu(db, { ...editor, role: 'editor' }, items, NOW, { fnl: false }), 403)
    const res = await saveMenu(db, admin, items, NOW, { fnl: false })
    expect(res.purge.tags).toEqual(['site', 'programmes'])
    expect(stats.queries).toBeLessThanOrEqual(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect((await db.select({ v: leagues.menuVisible }).from(leagues).where(eq(leagues.id, 'fnl')).get())!.v).toBe(false)

    const site = await loadSite(db)
    expect(site.menu.map((m) => [m.label, m.href])).toEqual([
      ['Mixed Leagues', '/mixed-leagues'],
      ['Training', '/training/scrims'],
    ])
    // Rules pinned before the automatic programme links; FNL hidden from menus; the hidden link left out.
    expect(site.menu[0]!.children.map((c) => [c.label, c.href])).toEqual([
      ['Rules', '/rules'],
      ['Thursday Night League', '/leagues/tnl'],
    ])
    const { tree, programmes: progs, categories: cats } = await getMenu(db)
    expect(tree[0]!.children.map((c) => [c.label, c.placement, c.hidden])).toEqual([
      ['Rules', 'before', false],
      ['Secret', null, true],
    ])
    expect(progs.map((p) => p.code)).toEqual(['SCT', 'TNL', 'FNL'])
    expect(cats.map((c) => c.id)).toContain('cat_juniors')
    const entry = await db.select().from(auditLog).where(eq(auditLog.action, 'menu.update')).get()
    expect(entry!.after).toMatchObject({ programmeVisibility: { FNL: false } })
  })

  it('rejects invalid menus without touching the saved one', async () => {
    await saveMenu(db, editor, [{ label: 'Keep', kind: 'url', url: '/keep' }])
    await rejects(saveMenu(db, editor, [{ label: 'x', kind: 'page', pageId: 'missing' }]), 400)
    expect((await db.select().from(menuItems).all()).map((r) => r.label)).toEqual(['Keep'])
  })
})

/** An in-memory stand-in for the R2 binding. */
const fakeBucket = () => {
  const files = new Map<string, { bytes: Uint8Array; type: string }>()
  const bucket = {
    files,
    async put(key: string, body: ReadableStream | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())
      files.set(key, { bytes, type: opts?.httpMetadata?.contentType ?? '' })
      return { key, size: bytes.length }
    },
    async head(key: string) {
      const f = files.get(key)
      return f ? { key, size: f.bytes.length } : null
    },
    async get(key: string) {
      return files.get(key) ?? null
    },
    async delete(keys: string | string[]) {
      for (const k of [keys].flat()) files.delete(k)
    },
  }
  return bucket as typeof bucket & MediaBucket
}

describe('media', () => {
  const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const file = (bytes: number, type: string) => ({
    body: new Response(new Uint8Array(bytes)).body,
    contentType: type,
    contentLength: String(bytes),
  })

  const upload = async (bucket: ReturnType<typeof fakeBucket>) => {
    await storeUpload(db, bucket, ID, 'original.jpg', file(3000, 'image/jpeg'))
    for (const w of [400, 800, 1200]) await storeUpload(db, bucket, ID, `${w}.webp`, file(w, 'image/webp'))
  }

  it('stores uploads, then records the row once every file is there', async () => {
    const bucket = fakeBucket()
    const meta = {
      id: ID,
      filename: 'team.jpg',
      mime: 'image/jpeg',
      bytes: 3000,
      width: 1200,
      height: 900,
      variants: [400, 800, 1200],
      alt: 'The team',
    }
    await storeUpload(db, bucket, ID, 'original.jpg', file(3000, 'image/jpeg'))
    await rejects(createMedia(db, bucket, editor, meta), 400)
    for (const w of [400, 800, 1200]) await storeUpload(db, bucket, ID, `${w}.webp`, file(w, 'image/webp'))
    await rejects(createMedia(db, bucket, editor, { ...meta, alt: '  ' }), 400)
    await rejects(createMedia(db, bucket, editor, { ...meta, bytes: 2999 }), 400)
    const row = await createMedia(db, bucket, editor, meta)
    expect(row).toMatchObject({ id: ID, keyBase: `media/${ID}`, alt: 'The team', variants: [400, 800, 1200], uploadedBy: 'ed' })
    expect(row.urls.src).toBe(`/media/${ID}/800.webp`)
    expect(bucket.files.get(`media/${ID}/original.jpg`)!.type).toBe('image/jpeg')
    // The id is taken now: no overwriting its files.
    await rejects(storeUpload(db, bucket, ID, '400.webp', file(10, 'image/webp')), 409)
    await rejects(createMedia(db, bucket, editor, meta), 409)

    const listed = await listMedia(db, { q: 'team' })
    expect(listed.items.map((m) => [m.id, m.uploadedByEmail])).toEqual([[ID, 'ed@example.com']])
    expect((await listMedia(db, { q: 'zzz' })).items).toEqual([])
    expect((await updateMedia(db, editor, ID, { alt: 'Champions' })).alt).toBe('Champions')
  })

  it('checks upload names, types and sizes', async () => {
    const bucket = fakeBucket()
    await rejects(storeUpload(db, bucket, 'not-a-uuid', 'original.jpg', file(10, 'image/jpeg')), 400)
    await rejects(storeUpload(db, bucket, ID, 'original.svg', file(10, 'image/svg+xml')), 400)
    await rejects(storeUpload(db, bucket, ID, 'original.jpg', file(10, 'image/png')), 415)
    await rejects(storeUpload(db, bucket, ID, '800.webp', { ...file(10, 'image/webp'), contentLength: String(6 * 1024 * 1024) }), 413)
    await rejects(storeUpload(db, bucket, ID, '800.webp', { body: null, contentType: 'image/webp', contentLength: null }), 411)
    expect(bucket.files.size).toBe(0)
  })

  it('refuses to delete a file that is in use, then deletes row and files', async () => {
    const bucket = fakeBucket()
    await upload(bucket)
    await createMedia(db, bucket, editor, {
      id: ID,
      filename: 'x.jpg',
      mime: 'image/jpeg',
      bytes: 3000,
      width: 1200,
      height: 900,
      variants: [400, 800, 1200],
      alt: 'x',
    })
    const page = await createPage(db, editor, {
      title: 'Gallery',
      path: '/gallery',
      blocks: [{ type: 'image', attrs: { src: `/media/${ID}/800.webp`, alt: 'x' } }],
    })
    const post = await createPost(db, editor, { title: 'News', slug: 'news-1', coverMediaId: ID })
    expect((await mediaUsage(db, ID)).map((u) => [u.type, u.where])).toEqual([
      ['page', 'body'],
      ['post', 'cover image'],
    ])
    const e = await rejects(deleteMedia(db, bucket, editor, ID), 409, 'in_use')
    expect(e.message).toContain('Gallery')
    await deletePage(db, editor, page.id)
    await updatePost(db, editor, post.id, { coverMediaId: null })
    await deleteMedia(db, bucket, editor, ID)
    expect(await db.select().from(media).all()).toEqual([])
    expect(bucket.files.size).toBe(0)
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'media.delete')).all()).length).toBe(1)
  })
})

describe('settings', () => {
  it('returns defaults, saves changed keys with an audit entry each, and enforces per-key roles', async () => {
    expect((await getSettings(db)).contact.email).toBe('tempevb@gmail.com')
    const admin = { ...(await addUser('ad', 'admin')), role: 'admin' as const }
    const ed = { ...editor, role: 'editor' as const }

    const res = await saveSettings(db, ed, { announcement: { enabled: true, text: 'No games on the long weekend' } }, at(1))
    expect(res.result.announcement).toMatchObject({ enabled: true, text: 'No games on the long weekend' })
    expect(res.purge).toEqual({ tags: ['site'] })
    await rejects(saveSettings(db, ed, { payid: { payId: 'tempevb@gmail.com' } }), 403)
    await rejects(saveSettings(db, ed, { nonsense: 1 }), 400)
    await rejects(saveSettings(db, ed, { contact: { email: 'bad' } }), 400)
    await saveSettings(
      db,
      admin,
      { payid: { payId: 'tempevb@gmail.com', name: 'M Smith' }, contact: (await getSettings(db)).contact },
      at(2),
    )
    // Unchanged values aren't rewritten or audited.
    const log = await db.select().from(auditLog).orderBy(auditLog.at).all()
    expect(log.map((l) => [l.action, l.targetId])).toEqual([
      ['settings.update', 'announcement'],
      ['settings.update', 'payid'],
    ])
    expect((await db.select().from(siteSettings).all()).map((r) => r.key).toSorted()).toEqual(['announcement', 'payid'])
    expect((await saveSettings(db, admin, { payid: (await getSettings(db)).payid })).purge).toEqual({})
  })
})

describe('purge', () => {
  it('purges unique tags, and never throws', async () => {
    const calls: unknown[] = []
    const fake = (invalidate: (o: unknown) => Promise<void>, enabled = true) => ({ enabled, set: () => {}, invalidate })
    expect(
      await purge(
        fake(async (o) => void calls.push(o)),
        { tags: ['page:/a', 'page:/a'] },
      ),
    ).toBe('purged')
    expect(calls).toEqual([{ tags: ['page:/a'] }])
    expect(
      await purge(
        fake(async () => {}),
        {},
      ),
    ).toBe('nothing')
    expect(
      await purge(
        fake(async () => {}, false),
        { tags: ['x'] },
      ),
    ).toBe('disabled')
    const failing = fake(async () => {
      throw new Error('nope')
    })
    expect(await purge(failing, { tags: ['x'] })).toBe('failed')
  })
})
