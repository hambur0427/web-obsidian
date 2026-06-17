import { createHmac, timingSafeEqual } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const COOKIE_NAME = 'web_obsidian_session'
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

export function isAuthConfigured() {
  return Boolean(process.env.APP_PASSWORD)
}

export function isAuthenticated(request: VercelRequest) {
  if (!isAuthConfigured()) return true

  const token = getCookie(request, COOKIE_NAME)
  if (!token) return false

  const [issuedAt, signature] = token.split('.')
  const issuedAtMs = Number(issuedAt)

  if (!issuedAt || !signature || !Number.isFinite(issuedAtMs)) return false
  if (Date.now() - issuedAtMs > SESSION_MAX_AGE_SECONDS * 1000) return false

  return secureEqual(signature, signSession(issuedAt))
}

export function requireAuth(request: VercelRequest, response: VercelResponse) {
  if (isAuthenticated(request)) return true

  response.status(401).json({ ok: false, error: 'Unauthorized' })
  return false
}

export function verifyPassword(password: string) {
  const appPassword = process.env.APP_PASSWORD
  if (!appPassword) return true

  return secureEqual(password, appPassword)
}

export function setAuthCookie(response: VercelResponse) {
  const issuedAt = String(Date.now())
  const token = `${issuedAt}.${signSession(issuedAt)}`

  response.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, token, SESSION_MAX_AGE_SECONDS))
}

export function clearAuthCookie(response: VercelResponse) {
  response.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', 0))
}

function signSession(issuedAt: string) {
  return createHmac('sha256', getAuthSecret()).update(issuedAt).digest('base64url')
}

function getAuthSecret() {
  return process.env.AUTH_SECRET || process.env.APP_PASSWORD || 'local-development-secret'
}

function getCookie(request: VercelRequest, name: string) {
  const cookieHeader = request.headers.cookie
  if (!cookieHeader) return ''

  const cookies = cookieHeader.split(';').map((cookie) => cookie.trim())
  const cookie = cookies.find((item) => item.startsWith(`${name}=`))

  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : ''
}

function serializeCookie(name: string, value: string, maxAge: number) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]

  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    parts.push('Secure')
  }

  return parts.join('; ')
}

function secureEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}
