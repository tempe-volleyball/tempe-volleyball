# Menu and page blocks API

The site menu (docs/admin.md §3.5) and the data blocks in the page editor (§3.4). All routes are under `/api/admin`,
need a signed-in user, return JSON and send `Cache-Control: no-store`. Writes need the request's `Origin` to match
the site (CSRF guard). Errors are `{ error, message }`.

## Menu

### `GET /api/admin/menu` (editor+)

```jsonc
{
  "tree": [MenuNode],      // every item, hidden ones and unpublished pages included; category items NOT expanded
  "pages": [{ "id", "title", "path", "status" }],
  "leagues": [{ "id", "code", "name", "slug" }],                    // kind 'league' only (old ladder/fixtures items)
  "programmes": [{ "id", "kind", "name", "code", "slug", "status", "menuVisible", "categoryId", "sort" }],
  "categories": [{ "id", "name", "slug", "status", "sort" }]
}
```

`MenuNode` is a `menu_items` row (`id, parentId, label, kind, pageId, leagueId, categoryId, url, sort, placement,
hidden`) plus `href` (null for a heading, a draft page or a missing target) and `children`. The editor previews a
category item's automatic links itself with `autoProgrammes()` from `src/lib/content/menu.ts`.

### `PUT /api/admin/menu` (editor+; `programmeVisibility` needs admin+)

```jsonc
{
  "items": [MenuInput],                          // the whole tree, two levels
  "programmeVisibility": { "<programmeId>": false } // optional: leagues.menu_visible changes from the dropdown previews
}
```

`MenuInput` is `{ id?, label, kind, pageId?, leagueId?, categoryId?, url?, placement?, hidden?, children? }`:

| kind                                | Needs                              | Links to                                                                                                  |
| ----------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `page`                              | `pageId`                           | The page's path while it's published                                                                      |
| `url`                               | `url` (optional: none = a heading) | The URL (`https://`, `/path`, `mailto:`, `tel:`)                                                          |
| `category`                          | `categoryId`                       | `/<category slug>`; at the top level it fills its dropdown with each active, menu-visible programme in it |
| `programme`                         | `leagueId` (any kind)              | `/leagues/…`, `/training/…`, `/programs/…` or `/events/…` while the programme is active                   |
| `league_ladder` / `league_fixtures` | `leagueId` (kind league)           | `/leagues/<slug>#ladder` / `#fixtures` (old items; the editor doesn't offer them for new items)           |

`placement` (`before` \| `after`, default after) applies to children of a category item: they sit before or after the
automatic programme links. A `programme` child for a programme the dropdown lists anyway replaces its automatic link
(rename or move it). `hidden` keeps an item (and its children) in the admin but off the site. Limits: 20 top-level
items, 30 children each, 120 in all, labels up to 60 characters.

The response is the GET body plus `cache` (`purged` \| `disabled` \| `failed` \| `nothing`). It purges `site` (every
page), plus `programmes` when visibility changed. Audited as `menu.update` (labels before and after, and any
visibility changes by programme code). One batch: delete, inserts of 6 rows each, at most 2 visibility updates and the
audit row; under 30 statements at the size limit.

## Page blocks

Blocks are TipTap atom nodes in a page body: `programmeList`, `ladder` and `fixtures`, with the attrs in
`src/lib/content/blocks.ts`. Saving a page (`POST /api/admin/pages`, `PATCH /api/admin/pages/:id`) normalises their
attrs (`normaliseDataBlocks`), leaves them out of the stored `body.html`, and rewrites the page's `page_data_refs` in
the same batch. Public page routes render them at view time (`renderBody` in `src/server/content/blocks.ts`).

### `GET /api/admin/blocks/choices` (editor+)

```jsonc
{
  "categories": [{ "id", "name", "status" }],
  "programmes": [{ "id", "kind", "code", "name", "status", "categoryId" }],   // drafts included
  "leagues": [{ "id", "code", "name", "status", "season": "TNL Q4 2026" | null, "teams": [{ "id", "name" }] }],
  "venues": [{ "id", "name" }]                                                // venue order
}
```

### `POST /api/admin/blocks/preview` (editor+, read-only)

Body `{ "block": { "type": "programmeList" | "ladder" | "fixtures" | "venues", "attrs": { … } } }`. Returns the block rendered
exactly as the public page shows it:

```jsonc
{
  "html": "<div class=\"data-block programme-list\">…",   // '' when it shows nothing
  "lines": [ProgrammeLine],                              // programme lists: every matching line, hidden ones too
  "note": "This league has no published season yet, …" | null
}
```

`ProgrammeLine` (`src/lib/content/data-blocks.ts`): `id, name, code, kind, href, text, html, source ('override' |
'summary' | 'template' | 'generated'), hidden, override, changed (source fields that changed since the override), current (the
`ProgrammeLineSource` snapshot to store with a new override), automatic (the text without the override),
enrolmentOpen`.

## Rendering and cache

- **Programme list:** active programmes only (draft and retired never, overrides or not), filtered by categories,
  kinds and enrolment (`any` \| `open` \| `closed`). Order: the block's dragged ids, then the rest by category order,
  programme order and name, so new programmes join on their own. Text: page override → the programme's summary line
  (unless the block turns `useSummaryLines` off) → the block's template, if it has one → the generated summary line
  (`generatedSummaryLine`, the same text as category pages and `/enrol`). Template placeholders: `{name} {code} {venue}
{suburb} {day} {times} {nextStarts} {category} {summary} {price} {link}` (aliases `{nextStart}`, `{next}`,
  `{when}`); empty values tidy away.
- **Ladder:** the league's current season (the published one, else the latest archived), compact (Pos, Team, Pts, P;
  W/D/L from small screens up) or full, top N rows, title, the generated "Week 4 of 9 · Updated …" line, a link to the
  league page's ladder.
- **Fixtures:** the same season; `this_week` (the next game night, tonight's until midnight), `upcoming`, `results`
  (newest first) or `all`; a number of game nights; one team's games, duties and byes; court and duty columns.
- **Venues:** attrs `{ venueIds: string[] (empty = every venue, venue order), title, showAddress, showMap,
showDirections, showProgrammes }`. Each venue (`<div class="venue" id="venue-<slug>">`) has its name (H2, or H3 under
  the block's heading), address, a "Map and directions" link (the venue's `map_url` when it's http(s), else a Google
  Maps search for name and address; opens in a new tab), the directions (blank lines make paragraphs) and "Who plays
  here" (active programmes whose default venue it is). Reads `loadSite()`'s venues and programmes: no queries. No
  `page_data_refs` row.
- **Queries:** a page without data blocks serves its stored HTML with no extra work. A page with them adds at most one
  batch to `loadSite()` + `lookupPath()`: the four next-start queries (programme lists) and, for a league between
  seasons, its latest season (7 statements). A full page view stays under 30 D1 statements (tested).
- **Cache tags:** programme lists and venues blocks add `programmes` and `venues` (venue edits purge `site`,
  `venues` and `programmes`); ladders and fixtures add `league:<slug>`. Season and
  results publishes already purge `league:<slug>` and `site`; programme, category and venue writes purge `programmes`
  (and `page:<path>` for pages in `page_data_refs`, via `blockPageTags`).
