import adminOpenapi from '../.generated/admin-openapi.json' with { type: 'json' }
import { jsonResponse } from './http.js'

export function handleAdminOpenApiRequest() {
  return jsonResponse(adminOpenapi)
}
