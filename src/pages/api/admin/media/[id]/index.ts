import type { APIRoute } from 'astro'
import { deleteMedia, getMedia, mediaUsage, updateMedia } from '../../../../../server/content/media'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getMediaBucket, getServices } from '../../../../../server/services'

/** One file and where it's used. */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    requireRole(locals.user, 'editor', request)
    const db = getServices().db
    const [media, usage] = await Promise.all([getMedia(db, params.id!), mediaUsage(db, params.id!)])
    return json({ media, usage })
  })

/** Edits alt text / file name: { alt?, filename? }. */
export const PATCH: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const actor = requireRole(locals.user, 'editor', request)
    return json({ media: await updateMedia(getServices().db, actor, params.id!, await readJson(request)) })
  })

/** Deletes the file and its copies (409 while a page or post uses it). Audited. */
export const DELETE: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const actor = requireRole(locals.user, 'editor', request)
    return json(await deleteMedia(getServices().db, getMediaBucket(), actor, params.id!))
  })
