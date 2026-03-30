import { authErrorResponse, hasAdminAccess } from './auth.js'
import { fetchStaticAssetByPath } from './static-assets.js'

function ensureAdminRequest(request, env) {
  if (!hasAdminAccess(request, env)) {
    return authErrorResponse(403, 'Admin access required')
  }
  return null
}

export async function handleAdminOpenApiRequest(request, env) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure
  return fetchStaticAssetByPath(request, env, '/admin-openapi.json', '/openapi.json')
}
