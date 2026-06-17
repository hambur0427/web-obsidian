import type { VercelRequest, VercelResponse } from '@vercel/node'
import { clearAuthCookie } from './_auth.js'

export default function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return response.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  clearAuthCookie(response)
  return response.status(200).json({ ok: true, authenticated: false })
}
