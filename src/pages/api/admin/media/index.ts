import type { APIRoute } from 'astro'
import { createMedia, listMedia } from '../../../../server/content/media'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { getMediaBucket, getServices } from '../../../../server/services'

/** The media library, newest first: ?q=&offset=&limit=&images=1. */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    await requireRole(locals.user, 'editor', request, getServices().db)
    const p = url.searchParams
    return json(
      await listMedia(getServices().db, {
        q: p.get('q') ?? undefined,
        offset: Number(p.get('offset') ?? 0) || 0,
        limit: Number(p.get('limit') ?? 60) || 60,
        images: p.get('images') === '1',
      }),
    )
  })

/** Records an upload once its files are in R2 (see src/server/content/media.ts for the protocol). */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    return json({ media: await createMedia(getServices().db, getMediaBucket(), actor, await readJson(request)) }, 201)
  })
