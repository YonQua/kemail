import { normalizeText } from './text-core.js'

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
const CLOUDFLARE_ZONE_PAGE_SIZE = 50

function extractCloudflareErrorMessage(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : []
  const parts = errors.map((item) => normalizeText(item?.message || item?.code)).filter(Boolean)

  if (parts.length > 0) {
    return parts.join('; ')
  }

  return normalizeText(payload?.message) || 'Cloudflare API request failed'
}

function normalizeZoneRecord(zone) {
  return {
    zone_id: normalizeText(zone?.id),
    domain: normalizeText(zone?.name),
    zone_status: normalizeText(zone?.status),
  }
}

async function requestCloudflareJson(url, env, fetchFn) {
  const apiToken = normalizeText(env.CLOUDFLARE_API_TOKEN)
  if (!apiToken) {
    throw new Error('CLOUDFLARE_API_TOKEN is not configured')
  }

  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
    },
  })

  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch (_) {
    payload = null
  }

  if (!response.ok) {
    throw new Error(extractCloudflareErrorMessage(payload))
  }

  if (payload && payload.success === false) {
    throw new Error(extractCloudflareErrorMessage(payload))
  }

  return payload || {}
}

export async function listCloudflareZones(env, options = {}) {
  const fetchFn = typeof options.fetchFn === 'function' ? options.fetchFn : fetch
  const zones = []
  let page = 1
  let totalPages = 1

  do {
    const url = new URL(`${CLOUDFLARE_API_BASE}/zones`)
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', String(CLOUDFLARE_ZONE_PAGE_SIZE))

    const payload = await requestCloudflareJson(url.toString(), env, fetchFn)
    const results = Array.isArray(payload?.result) ? payload.result : []

    zones.push(...results.map(normalizeZoneRecord).filter((item) => item.zone_id && item.domain))
    totalPages = Number(payload?.result_info?.total_pages || 1)
    page += 1
  } while (page <= totalPages)

  return zones.sort((left, right) => left.domain.localeCompare(right.domain))
}
