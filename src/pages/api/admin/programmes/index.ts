import type { APIRoute } from 'astro'
import type { ProgrammeKind } from '../../../../server/db/schema'
import { createProgramme, listProgrammes } from '../../../../server/programmes/programmes'
import { purge } from '../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** Every programme, or one kind (?kind=league|training|development|event). Editors and up. */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'editor', request, db)
    const kind = url.searchParams.get('kind') ?? undefined
    return json({ programmes: await listProgrammes(db, { kind: kind as ProgrammeKind | undefined }) })
  })

/** Creates a programme: { kind, name, code, categoryId, weekday, slug?, status?, …fields }. Admins. */
export const POST: APIRoute = ({ locals, request, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await createProgramme(db, actor, await readJson(request))
    return json({ ...result, cache: await purge(cache, targets) }, 201)
  })
