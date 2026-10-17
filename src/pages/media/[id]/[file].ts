import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { MEDIA_CACHE, tags } from '../../../server/cache'
import { mediaKey, mediaResponse } from '../../../server/media'

// /media/<id>/<width>.webp and /media/<id>/original.<ext>, streamed from R2 (MEDIA) with year-long immutable caching.
// After the cutover these move to an R2 custom domain so they stop counting as Worker requests (PLAN.md "Images").
export const GET: APIRoute = async ({ params, request, cache }) => {
  const key = mediaKey(params.id ?? '', params.file ?? '')
  if (!key) return new Response('Not found', { status: 404 })
  const object = await env.MEDIA.get(key, { onlyIf: request.headers })
  const response = mediaResponse(object, request.headers.get('if-none-match'))
  if (response.status === 200) cache.set({ ...MEDIA_CACHE, tags: [tags.media(params.id ?? '')] })
  return response
}
