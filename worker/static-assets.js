import {
  cloneResponseWithHeaders,
  getStaticAssetHeaders,
  jsonResponse,
  methodNotAllowed,
  resolveStaticAssetPath,
} from './http.js'

export async function fetchStaticAssetByPath(request, env, assetPath, responsePath = assetPath) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return jsonResponse({ ok: false, error: 'Static assets unavailable' }, 500)
  }

  const assetUrl = new URL(request.url)
  assetUrl.pathname = assetPath

  const response = await env.ASSETS.fetch(new Request(assetUrl.toString(), request))
  const extraHeaders = getStaticAssetHeaders(responsePath)
  return cloneResponseWithHeaders(response, extraHeaders)
}

export async function handleStaticAssetRequest(request, env) {
  const url = new URL(request.url)
  const assetUrl = new URL(request.url)
  assetUrl.pathname = resolveStaticAssetPath(url.pathname)
  return fetchStaticAssetByPath(request, env, assetUrl.pathname, assetUrl.pathname)
}

export async function handleStaticDocumentRequest(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed(['GET', 'HEAD'])
  }
  return handleStaticAssetRequest(request, env)
}
