import type { APIRoute } from 'astro'
import { getServices } from '../../../server/services'

// Better Auth's endpoints (sign-in by email code or link, TOTP, sessions), at /api/auth/*.
export const ALL: APIRoute = async ({ request }) => {
  const res = await getServices().auth.handler(request)
  // Copy so the headers are mutable whatever Better Auth built the response with.
  const response = new Response(res.body, res)
  response.headers.set('Cache-Control', 'no-store')
  return response
}
