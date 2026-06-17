import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  clearFailedLogins,
  getClientIp,
  getLoginLockout,
  isAuthConfigured,
  recordFailedLogin,
  setAuthCookie,
  verifyPassword,
} from './_auth.js'

export default function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return response.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  if (!isAuthConfigured()) {
    setAuthCookie(response)
    return response.status(200).json({ ok: true, authenticated: true, authRequired: false })
  }

  const ip = getClientIp(request)
  const lockedUntil = getLoginLockout(ip)

  if (lockedUntil) {
    const retryAfterSeconds = Math.ceil((lockedUntil - Date.now()) / 1000)
    response.setHeader('Retry-After', String(retryAfterSeconds))
    return response.status(429).json({
      ok: false,
      error: 'Too many failed attempts. Try again later.',
      retryAfterSeconds,
    })
  }

  const password = getPassword(request.body)

  if (!password || !verifyPassword(password)) {
    const nextLockedUntil = recordFailedLogin(ip)

    if (nextLockedUntil) {
      const retryAfterSeconds = Math.ceil((nextLockedUntil - Date.now()) / 1000)
      response.setHeader('Retry-After', String(retryAfterSeconds))
      return response.status(429).json({
        ok: false,
        error: 'Too many failed attempts. Try again later.',
        retryAfterSeconds,
      })
    }

    return response.status(401).json({ ok: false, error: 'Invalid password' })
  }

  clearFailedLogins(ip)
  setAuthCookie(response)
  return response.status(200).json({ ok: true, authenticated: true, authRequired: true })
}

function getPassword(body: unknown) {
  if (!body || typeof body !== 'object') return ''

  const candidate = body as { password?: unknown }
  return typeof candidate.password === 'string' ? candidate.password : ''
}
