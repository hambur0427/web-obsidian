import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAuthConfigured, setAuthCookie, verifyPassword } from './_auth.js'

export default function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return response.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  if (!isAuthConfigured()) {
    setAuthCookie(response)
    return response.status(200).json({ ok: true, authenticated: true, authRequired: false })
  }

  const password = getPassword(request.body)

  if (!password || !verifyPassword(password)) {
    return response.status(401).json({ ok: false, error: 'Invalid password' })
  }

  setAuthCookie(response)
  return response.status(200).json({ ok: true, authenticated: true, authRequired: true })
}

function getPassword(body: unknown) {
  if (!body || typeof body !== 'object') return ''

  const candidate = body as { password?: unknown }
  return typeof candidate.password === 'string' ? candidate.password : ''
}
