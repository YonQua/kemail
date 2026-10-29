import { logError } from './text-logging.js'

export async function parseJsonPayload(request, path, actionLabel) {
  try {
    return await request.json()
  } catch (error) {
    logError(`${actionLabel} payload parse failed`, error, { path })
    return null
  }
}

export function parseBooleanFlag(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  return null
}
