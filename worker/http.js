import {
  ANALYSIS_CACHE_TTL,
  HTML_SECURITY_HEADERS,
  IMMUTABLE_STATIC_ASSET_PATTERN,
  JSON_RESPONSE_HEADERS,
  RESPONSE_SECURITY_HEADERS,
  STATIC_ASSET_PREFIX,
  STATIC_DOCUMENT_PATHS,
} from './constants.js'

export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_RESPONSE_HEADERS, ...extraHeaders },
  })
}

export function analysisCacheHeaders() {
  return {
    'Cache-Control': `private, max-age=${ANALYSIS_CACHE_TTL}`,
    Vary: 'Authorization',
  }
}

export function isStaticDocumentPath(path) {
  return STATIC_DOCUMENT_PATHS.has(path)
}

export function isStaticAssetPath(path) {
  return isStaticDocumentPath(path) || path.startsWith(STATIC_ASSET_PREFIX)
}

export function resolveStaticAssetPath(path) {
  return STATIC_DOCUMENT_PATHS.get(path) || path
}

export function resolveManagedAssetFallbackPath(pathname) {
  if (/^\/assets\/manage\.[a-f0-9]{10}\.css$/i.test(pathname)) return '/assets/manage.latest.css'
  if (/^\/assets\/manage\.[a-f0-9]{10}\.js$/i.test(pathname)) return '/assets/manage.latest.js'
  if (/^\/assets\/api-docs\.[a-f0-9]{10}\.css$/i.test(pathname))
    return '/assets/api-docs.latest.css'
  if (/^\/assets\/vendor-chart\.[a-f0-9]{10}\.js$/i.test(pathname))
    return '/assets/vendor-chart.latest.js'
  if (/^\/assets\/vendor-alpine\.[a-f0-9]{10}\.js$/i.test(pathname))
    return '/assets/vendor-alpine.latest.js'
  return ''
}

export function getStaticAssetHeaders(pathname) {
  if (pathname === '/' || pathname.endsWith('.html')) {
    return {
      'Cache-Control': 'no-store',
      ...HTML_SECURITY_HEADERS,
    }
  }

  if (pathname === '/openapi.json') {
    return {
      'Cache-Control': 'no-store',
      ...RESPONSE_SECURITY_HEADERS,
    }
  }

  if (IMMUTABLE_STATIC_ASSET_PATTERN.test(pathname)) {
    return {
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...RESPONSE_SECURITY_HEADERS,
    }
  }

  return {
    'Cache-Control': 'public, max-age=300',
    ...RESPONSE_SECURITY_HEADERS,
  }
}

export function methodNotAllowed(allowedMethods) {
  return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, {
    Allow: allowedMethods.join(', '),
  })
}

export function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export function cloneResponseWithHeaders(response, extraHeaders = {}) {
  const headers = new Headers(response.headers)
  Object.entries(extraHeaders).forEach(([key, value]) => {
    headers.set(key, value)
  })

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
