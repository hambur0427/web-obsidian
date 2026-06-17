import { createHmac, timingSafeEqual } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const COOKIE_NAME = 'web_obsidian_session'
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
const MAX_LOGIN_FAILURES = 5
const LOGIN_LOCK_MS = 10 * 60 * 1000

type LoginAttemptState = {
  failures: number
  lockedUntil: number
}

const loginAttempts = new Map<string, LoginAttemptState>()

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

export function getClientIp(request: VercelRequest) {
  const forwardedFor = getHeader(request, 'x-forwarded-for')
  const realIp = getHeader(request, 'x-real-ip')

  return forwardedFor.split(',')[0]?.trim() || realIp || request.socket.remoteAddress || 'unknown'
}

export function getLoginLockout(ip: string) {
  const state = loginAttempts.get(ip)
  if (!state) return 0

  if (state.lockedUntil <= Date.now()) {
    if (state.lockedUntil) loginAttempts.delete(ip)
    return 0
  }

  return state.lockedUntil
}

export function recordFailedLogin(ip: string) {
  const now = Date.now()
  const state = loginAttempts.get(ip)

  if (!state || state.lockedUntil <= now) {
    loginAttempts.set(ip, {
      failures: 1,
      lockedUntil: 0,
    })
    return 0
  }

  const failures = state.failures + 1
  const lockedUntil = failures >= MAX_LOGIN_FAILURES ? now + LOGIN_LOCK_MS : 0

  loginAttempts.set(ip, {
    failures,
    lockedUntil,
  })

  return lockedUntil
}

export function clearFailedLogins(ip: string) {
  loginAttempts.delete(ip)
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

function getHeader(request: VercelRequest, name: string) {
  const value = request.headers[name]
  if (Array.isArray(value)) return value[0] || ''
  return value || ''
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
