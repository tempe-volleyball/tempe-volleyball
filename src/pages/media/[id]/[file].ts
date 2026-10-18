import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { SOCIAL_FILE } from '../../../lib/content/media'
import { MEDIA_CACHE, tags } from '../../../server/cache'
import { mediaKey, mediaResponse, socialMediaKey } from '../../../server/media'
import { publicDb } from '../../../server/public'

// /media/<id>/<width>.webp and /media/<id>/original.<ext>, streamed from R2 (MEDIA) with year-long immutable caching.
// /media/<id>/social is the image's sharing size (src/lib/content/media.ts socialFile), for og:image and JSON-LD.
// After the cutover these move to an R2 custom domain so they stop counting as Worker requests (PLAN.md "Images").
export const GET: APIRoute = async ({ params, request, cache }) => {
  const id = params.id ?? ''
  const key = params.file === SOCIAL_FILE ? await socialMediaKey(publicDb(), id) : mediaKey(id, params.file ?? '')
  if (!key) return new Response('Not found', { status: 404 })
  const object = await env.MEDIA.get(key, { onlyIf: request.headers })
  const response = mediaResponse(object, request.headers.get('if-none-match'))
  if (response.status === 200) cache.set({ ...MEDIA_CACHE, tags: [tags.media(id.toLowerCase())] })
  return response
}
