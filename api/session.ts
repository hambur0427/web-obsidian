import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAuthConfigured, isAuthenticated } from './_auth.js'

export default function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    return response.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  return response.status(200).json({
    ok: true,
    authRequired: isAuthConfigured(),
    authenticated: isAuthenticated(request),
  })
}
