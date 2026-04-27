import { fetchStaticAssetByPath } from './static-assets.js'

export async function handleAdminOpenApiRequest(request, env) {
  return fetchStaticAssetByPath(request, env, '/admin-openapi.json', '/openapi.json')
}
