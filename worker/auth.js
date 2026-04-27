import {
  ANALYSIS_RATE_LIMIT,
  ANALYSIS_RATE_WINDOW,
  AUTH_RATE_LIMIT,
  AUTH_RATE_WINDOW,
  RATE_LIMIT,
  RATE_WINDOW,
  WRITE_RATE_LIMIT,
  WRITE_RATE_WINDOW,
} from './constants.js'
import { jsonResponse } from './http.js'
import { API_AUTH_LEVEL, API_RATE_LIMIT_CLASS } from './routes.js'

// 管理后台列表刷新、详情切换和批量操作会产生一串短时间读请求，因此读限流单独放宽。
const ADMIN_READ_RATE_LIMIT = 200
const ADMIN_READ_RATE_WINDOW = 60
const memoryRateLimitStores = new WeakMap()
const fallbackMemoryRateLimitStore = new Map()

function buildRateLimitPolicy(scope, limit, windowSeconds, storage = 'memory') {
  return Object.freeze({ scope, limit, windowSeconds, storage })
}

export const UNAUTHORIZED_RATE_LIMIT_POLICY = buildRateLimitPolicy(
  'unauthorized',
  RATE_LIMIT,
  RATE_WINDOW,
  'kv'
)

const ANALYSIS_RATE_LIMIT_POLICY = buildRateLimitPolicy(
  'authorized-analysis',
  ANALYSIS_RATE_LIMIT,
  ANALYSIS_RATE_WINDOW
)

const AUTHORIZED_WRITE_RATE_LIMIT_POLICY = buildRateLimitPolicy(
  'authorized-write',
  WRITE_RATE_LIMIT,
  WRITE_RATE_WINDOW
)

const AUTHORIZED_ADMIN_READ_RATE_LIMIT_POLICY = buildRateLimitPolicy(
  'authorized-admin-read',
  ADMIN_READ_RATE_LIMIT,
  ADMIN_READ_RATE_WINDOW
)

const AUTHORIZED_READ_RATE_LIMIT_POLICY = buildRateLimitPolicy(
  'authorized-read',
  AUTH_RATE_LIMIT,
  AUTH_RATE_WINDOW
)

const AUTHORIZED_RATE_LIMIT_POLICIES = Object.freeze({
  [API_RATE_LIMIT_CLASS.ANALYSIS]: ANALYSIS_RATE_LIMIT_POLICY,
  [API_RATE_LIMIT_CLASS.WRITE]: AUTHORIZED_WRITE_RATE_LIMIT_POLICY,
  [API_RATE_LIMIT_CLASS.ADMIN_READ]: AUTHORIZED_ADMIN_READ_RATE_LIMIT_POLICY,
  [API_RATE_LIMIT_CLASS.READ]: AUTHORIZED_READ_RATE_LIMIT_POLICY,
})

export function getBearerToken(request) {
  const authHeader = request.headers.get('Authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  return ''
}

export function getReadApiKey(env) {
  return env.READ_API_KEY || ''
}

export function getAdminApiKey(env) {
  return env.ADMIN_API_KEY || ''
}

export function hasReadAccess(request, env) {
  const token = getBearerToken(request)
  const readKey = getReadApiKey(env)
  const adminKey = getAdminApiKey(env)
  if (!token) return false
  return token === readKey || token === adminKey
}

export function hasAdminAccess(request, env) {
  const token = getBearerToken(request)
  const adminKey = getAdminApiKey(env)
  if (!token || !adminKey) return false
  return token === adminKey
}

export function authErrorResponse(status, error) {
  return jsonResponse({ ok: false, error }, status)
}

export function ensureApiReadAccess(request, env) {
  if (!hasReadAccess(request, env)) {
    return authErrorResponse(401, 'Unauthorized')
  }
  return null
}

export function ensureApiAdminAccess(request, env) {
  if (!hasAdminAccess(request, env)) {
    return authErrorResponse(403, 'Admin access required')
  }
  return null
}

function getMemoryRateLimitStore(env) {
  const holder = env?.DB || env?.CACHE || env
  if (!holder || (typeof holder !== 'object' && typeof holder !== 'function')) {
    return fallbackMemoryRateLimitStore
  }

  let store = memoryRateLimitStores.get(holder)
  if (!store) {
    store = new Map()
    memoryRateLimitStores.set(holder, store)
  }
  return store
}

async function buildRateLimitIdentity(request, token = '') {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  if (!token) return ip

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const tokenHash = Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
  return `${ip}:${tokenHash}`
}

function readMemoryRateLimitCount(store, key, now) {
  const entry = store.get(key)
  if (!entry) return 0
  if (entry.expiresAt <= now) {
    store.delete(key)
    return 0
  }
  return entry.count
}

export async function checkRateLimit(request, env, scope = 'api') {
  const options =
    typeof scope === 'string'
      ? { scope, limit: RATE_LIMIT, windowSeconds: RATE_WINDOW, token: '', storage: 'kv' }
      : {
          scope: scope?.scope || 'api',
          limit: scope?.limit || RATE_LIMIT,
          windowSeconds: scope?.windowSeconds || RATE_WINDOW,
          token: scope?.token || '',
          storage: scope?.storage || 'kv',
        }

  const identity = await buildRateLimitIdentity(request, options.token)
  const key = `ratelimit:${options.scope}:${identity}`

  if (options.storage === 'memory') {
    const store = getMemoryRateLimitStore(env)
    const now = Date.now()
    const current = readMemoryRateLimitCount(store, key, now)
    if (current >= options.limit) return false
    store.set(key, {
      count: current + 1,
      expiresAt: now + options.windowSeconds * 1000,
    })
    return true
  }

  if (!env.CACHE) return true
  const current = parseInt((await env.CACHE.get(key)) || '0', 10)
  if (current >= options.limit) return false
  await env.CACHE.put(key, String(current + 1), { expirationTtl: options.windowSeconds })
  return true
}

export function getAuthorizedRateLimitPolicy(rateLimitClass = API_RATE_LIMIT_CLASS.READ) {
  return AUTHORIZED_RATE_LIMIT_POLICIES[rateLimitClass] || AUTHORIZED_READ_RATE_LIMIT_POLICY
}

export function ensureApiRouteAccess(request, env, authLevel = API_AUTH_LEVEL.READ) {
  if (authLevel === API_AUTH_LEVEL.NONE) return null
  if (authLevel === API_AUTH_LEVEL.ADMIN) {
    return ensureApiAdminAccess(request, env)
  }
  return ensureApiReadAccess(request, env)
}
