import type { APIRoute } from 'astro'
import { AUTH_BODY_LIMIT, errorResponse, readCapped } from '../../../server/http'
import { getAuth } from '../../../server/services'

// Better Auth's endpoints (sign-in by email code or link, TOTP, sessions), at /api/auth/*. Reachable signed out, so a
// request body is read with a cap (413 over AUTH_BODY_LIMIT) before Better Auth parses it.
export const ALL: APIRoute = async ({ request }) => {
  let req = request
  if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      req = new Request(request, { method: request.method, body: await readCapped(request, AUTH_BODY_LIMIT) })
    } catch (e) {
      return errorResponse(e)
    }
  }
  const res = await getAuth(req.url).handler(req)
  // Copy so the headers are mutable whatever Better Auth built the response with.
  const response = new Response(res.body, res)
  response.headers.set('Cache-Control', 'no-store')
  return response
}
