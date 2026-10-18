import type { APIRoute } from 'astro'
import { listTargets } from '../../../../../server/enrolment/admin'
import { handle, json, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/** Every enrolment target with counts against its caps (?all=1 includes past ones, ?programmeId= narrows). Admin+. */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const programmeId = url.searchParams.get('programmeId') ?? undefined
    return json({ targets: await listTargets(db, { all: url.searchParams.get('all') === '1', programmeId }) })
  })
