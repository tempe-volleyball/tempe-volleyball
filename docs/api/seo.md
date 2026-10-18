# SEO API and public routes

What Phase 7's SEO work added (docs/public-site.md "SEO" has the why).

## Admin fields

### Pages: `POST /api/admin/pages`, `PATCH /api/admin/pages/:id` (editor+)

Two more optional fields, alongside `metaDescription` and `ogImageId`:

| Field      | Type           | Rules                                                                                            |
| ---------- | -------------- | ------------------------------------------------------------------------------------------------ |
| `seoTitle` | string or null | At most 120 characters; whitespace collapsed; `''` or null = use the title.                      |
| `noindex`  | boolean        | `true` = robots noindex, left out of the sitemap and site search. Left out on PATCH = unchanged. |

Changing `noindex` on a published page purges `page:<path>` and `site` (the sitemap). Responses include both fields.

### Posts: `POST /api/admin/posts`, `PATCH /api/admin/posts/:id` (editor+)

| Field            | Type           | Rules                                                                   |
| ---------------- | -------------- | ----------------------------------------------------------------------- |
| `seoTitle`       | string or null | At most 120 characters; `''` or null = the title.                       |
| `seoDescription` | string or null | At most 300 characters; `''` or null = the excerpt, else the body text. |
| `noindex`        | boolean        | As for pages. Published posts purge `post:<slug>`, `news` and `page:/`. |

### Setting `seo`: `PUT /api/admin/settings` with `{ "seo": { … } }` (editor+)

```json
{ "description": "", "imageId": "", "alternateName": "Tempe VB", "foundingYear": "2005", "sameAs": [] }
```

- `description`: at most 300 characters; empty = the built-in default description.
- `imageId`: a media id (UUID) or empty (= `/images/og-default.jpg`).
- `alternateName`: at most 80 characters. `foundingYear`: four digits or empty.
- `sameAs`: up to 10 `https://` URLs (an array, or one string split on whitespace); duplicates and blanks dropped.

Saving purges `site` (every page).

## Public routes

| Route                   | What                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /sitemap.xml`      | `<urlset>` of every indexable page with `lastmod`; a `<sitemapindex>` of `/sitemap-<n>.xml` past 50,000 URLs. One D1 batch (5 queries). Tags `site`, `news`, `programmes`.                     |
| `GET /sitemap-<n>.xml`  | Part n of a split sitemap; 404 while it fits in one file.                                                                                                                                      |
| `GET /robots.txt`       | Production www: `Allow: /`, `Disallow: /admin`, `Disallow: /api/`, `Sitemap: …`. Elsewhere `Disallow: /`.                                                                                      |
| `GET /search?q=`        | Results page (noindex). `q` is canonicalised by the middleware (trimmed, ≤ 80 characters; other parameters 301 away). One D1 batch (4 queries).                                                |
| `GET /media/:id/social` | The image's sharing size (smallest variant ≥ 1200 px, else the largest, else a web-image original); one D1 lookup, then R2; immutable caching, tag `media:<id>`. 404 for PDFs and unknown ids. |
