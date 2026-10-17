import type { APIRoute } from 'astro'
import { storeUpload } from '../../../../../server/content/media'
import { handle, json, requireRole } from '../../../../../server/http'
import { getMediaBucket, getServices } from '../../../../../server/services'

/** Streams one file of an upload (original.<ext> or <width>.webp) straight into R2. The body is the raw file. */
export const PUT: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    requireRole(locals.user, 'editor', request)
    const stored = await storeUpload(getServices().db, getMediaBucket(), params.id!, params.file!, {
      body: request.body,
      contentType: request.headers.get('content-type'),
      contentLength: request.headers.get('content-length'),
    })
    return json(stored, 201)
  })
