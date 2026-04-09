import {
  ANALYSIS_RATE_LIMIT,
  ANALYSIS_RATE_WINDOW,
  AUTH_RATE_LIMIT,
  AUTH_RATE_WINDOW,
  RATE_LIMIT,
  RATE_WINDOW,
  SOURCE_HEAVY_RATE_LIMIT,
  SOURCE_HEAVY_RATE_WINDOW,
  WRITE_RATE_LIMIT,
  WRITE_RATE_WINDOW,
} from './constants.js'
import { jsonResponse } from './http.js'

const memoryRateLimitStores = new WeakMap()
const fallbackMemoryRateLimitStore = new Map()

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

export function authenticatedRateLimitPolicy(request, _url, path) {
  const method = request.method
  const isAnalysisPath = path.startsWith('/api/analysis/')
  const isAdminMessageDetailPath = /^\/api\/admin\/messages\/\d+$/.test(path)
  const isWritePath =
    path === '/api/messages/next' ||
    method === 'DELETE' ||
    path === '/api/admin/messages/delete' ||
    path === '/api/admin/messages/read' ||
    path === '/api/admin/messages/star' ||
    path === '/api/admin/domains/sync' ||
    path === '/api/admin/domains/batch' ||
    path === '/api/admin/governance/settings' ||
    path === '/api/admin/governance/retention/run' ||
    path === '/api/admin/cleanup-rules' ||
    path === '/api/admin/cleanup-rules/run' ||
    /^\/api\/admin\/domains\/[^/]+$/.test(path) ||
    /^\/api\/admin\/cleanup-rules\/\d+$/.test(path) ||
    /^\/api\/admin\/cleanup-rules\/\d+\/run$/.test(path)
  const isSourceHeavyPath = isAdminMessageDetailPath

  if (isAnalysisPath) {
    return {
      scope: 'authorized-analysis',
      limit: ANALYSIS_RATE_LIMIT,
      windowSeconds: ANALYSIS_RATE_WINDOW,
      storage: 'memory',
    }
  }

  if (isSourceHeavyPath) {
    return {
      scope: 'authorized-source-heavy',
      limit: SOURCE_HEAVY_RATE_LIMIT,
      windowSeconds: SOURCE_HEAVY_RATE_WINDOW,
      storage: 'memory',
    }
  }

  if (isWritePath) {
    return {
      scope: 'authorized-write',
      limit: WRITE_RATE_LIMIT,
      windowSeconds: WRITE_RATE_WINDOW,
      storage: 'memory',
    }
  }

  return {
    scope: 'authorized-read',
    limit: AUTH_RATE_LIMIT,
    windowSeconds: AUTH_RATE_WINDOW,
    storage: 'memory',
  }
}
