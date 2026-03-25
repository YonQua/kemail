import { authErrorResponse, hasAdminAccess, hasReadAccess } from './auth.js'
import { listCloudflareZones } from './cloudflare.js'
import {
  ManagedDomainSyncGuardError,
  listIssuableDomains,
  listManagedDomains,
  selectManagedDomainByZoneId,
  selectManagedDomainsByZoneIds,
  syncManagedDomains,
  updateManagedDomainPolicy,
  updateManagedDomainsIssuable,
} from './domain-store.js'
import { jsonResponse } from './http.js'
import { logError, normalizeText } from './text.js'

const MAX_BATCH_DOMAIN_ZONE_IDS = 200

function isManagedDomainsTableMissing(error) {
  return String(error?.message || '').includes('no such table: managed_domains')
}

function missingManagedDomainsTableResponse() {
  return jsonResponse({ ok: false, error: 'managed_domains 表不存在，请先执行 D1 迁移' }, 503)
}

function isCloudflareTokenMissing(error) {
  return String(error?.message || '') === 'CLOUDFLARE_API_TOKEN is not configured'
}

function ensureAdminRequest(request, env) {
  if (!hasAdminAccess(request, env)) {
    return authErrorResponse(403, 'Admin access required')
  }
  return null
}

function ensureExternalIssueRequest(request, env) {
  if (!hasReadAccess(request, env)) {
    return authErrorResponse(401, 'Unauthorized')
  }
  return null
}

function parseIssuableEnabled(value) {
  if (value === 1 || value === '1' || value === true) return 1
  if (value === 0 || value === '0' || value === false) return 0
  return null
}

function randomIndex(maxExclusive) {
  const values = new Uint32Array(1)
  crypto.getRandomValues(values)
  return values[0] % maxExclusive
}

function generateLocalPart() {
  const bytes = new Uint8Array(5)
  crypto.getRandomValues(bytes)
  const suffix = Array.from(bytes)
    .map((item) => item.toString(16).padStart(2, '0'))
    .join('')
  return `oc${suffix}`
}

async function parseJsonPayload(request, path, actionLabel) {
  try {
    return await request.json()
  } catch (error) {
    logError(`${actionLabel} payload parse failed`, error, { path })
    return null
  }
}

function normalizeZoneIdList(value) {
  if (!Array.isArray(value)) return []

  return Array.from(new Set(value.map((item) => normalizeText(String(item || ''))).filter(Boolean)))
}

export async function handleManagedDomainsRequest(request, env, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  try {
    const domains = await listManagedDomains(env)
    return jsonResponse({ ok: true, domains })
  } catch (error) {
    if (isManagedDomainsTableMissing(error)) {
      return missingManagedDomainsTableResponse()
    }
    logError('Managed domains query failed', error, { path })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleManagedDomainSyncRequest(request, env, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  try {
    const syncedAt = new Date().toISOString()
    const zones = await listCloudflareZones(env)
    const domains = await syncManagedDomains(env, zones, syncedAt)

    return jsonResponse({
      ok: true,
      synced_count: zones.length,
      synced_at: syncedAt,
      domains,
    })
  } catch (error) {
    if (error instanceof ManagedDomainSyncGuardError) {
      return jsonResponse({ ok: false, error: error.message }, 409)
    }
    if (isManagedDomainsTableMissing(error)) {
      return missingManagedDomainsTableResponse()
    }
    if (isCloudflareTokenMissing(error)) {
      return jsonResponse({ ok: false, error: 'CLOUDFLARE_API_TOKEN 未配置' }, 503)
    }
    logError('Managed domains sync failed', error, { path })
    return jsonResponse({ ok: false, error: 'Sync failed' }, 500)
  }
}

export async function handleManagedDomainPolicyRequest(request, env, path, zoneId) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  const payload = await parseJsonPayload(request, path, 'Managed domain policy')
  if (payload == null) {
    return jsonResponse({ ok: false, error: 'Invalid request body' }, 400)
  }

  try {
    const existing = await selectManagedDomainByZoneId(env, zoneId)
    if (!existing) {
      return jsonResponse({ ok: false, error: 'Not found' }, 404)
    }

    const hasIssuableEnabled = Object.prototype.hasOwnProperty.call(payload, 'issuable_enabled')
    const nextIssuableEnabled = hasIssuableEnabled
      ? parseIssuableEnabled(payload?.issuable_enabled)
      : existing.issuable_enabled
    if (nextIssuableEnabled == null) {
      return jsonResponse({ ok: false, error: 'Invalid issuable_enabled' }, 400)
    }

    const nextNote = Object.prototype.hasOwnProperty.call(payload, 'note')
      ? normalizeText(payload?.note).slice(0, 200)
      : existing.note
    const updatedAt = new Date().toISOString()
    const domain = await updateManagedDomainPolicy(
      env,
      zoneId,
      {
        issuable_enabled: nextIssuableEnabled,
        note: nextNote,
      },
      updatedAt
    )

    return jsonResponse({ ok: true, domain })
  } catch (error) {
    if (isManagedDomainsTableMissing(error)) {
      return missingManagedDomainsTableResponse()
    }
    logError('Managed domain policy update failed', error, { path, zoneId })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleManagedDomainBatchPolicyRequest(request, env, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  const payload = await parseJsonPayload(request, path, 'Managed domain batch policy')
  if (payload == null) {
    return jsonResponse({ ok: false, error: 'Invalid request body' }, 400)
  }

  const zoneIds = normalizeZoneIdList(payload?.zone_ids)
  if (zoneIds.length === 0) {
    return jsonResponse({ ok: false, error: 'Missing zone_ids' }, 400)
  }
  if (zoneIds.length > MAX_BATCH_DOMAIN_ZONE_IDS) {
    return jsonResponse(
      { ok: false, error: `Too many zone_ids (max ${MAX_BATCH_DOMAIN_ZONE_IDS})` },
      400
    )
  }

  const issuableEnabled = parseIssuableEnabled(payload?.issuable_enabled)
  if (issuableEnabled == null) {
    return jsonResponse({ ok: false, error: 'Invalid issuable_enabled' }, 400)
  }

  try {
    const rows = await selectManagedDomainsByZoneIds(env, zoneIds)
    const existingZoneIds = new Set(rows.map((row) => row.zone_id))
    const updatedAt = new Date().toISOString()

    if (rows.length > 0) {
      await updateManagedDomainsIssuable(
        env,
        rows.map((row) => row.zone_id),
        issuableEnabled,
        updatedAt
      )
    }

    const updated = zoneIds.filter((zoneId) => existingZoneIds.has(zoneId))
    const missing = zoneIds.filter((zoneId) => !existingZoneIds.has(zoneId))

    return jsonResponse({
      ok: true,
      updated,
      missing,
      updated_count: updated.length,
      issuable_enabled: issuableEnabled,
    })
  } catch (error) {
    if (isManagedDomainsTableMissing(error)) {
      return missingManagedDomainsTableResponse()
    }
    logError('Managed domain batch policy update failed', error, { path })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleGeneratedAddressRequest(request, env, path) {
  const authFailure = ensureExternalIssueRequest(request, env)
  if (authFailure) return authFailure

  try {
    const domains = await listIssuableDomains(env)
    if (domains.length === 0) {
      return jsonResponse({ ok: false, error: 'No issuable domains configured' }, 409)
    }

    const domain = domains[randomIndex(domains.length)]
    const localPart = generateLocalPart()
    const issuedAt = new Date().toISOString()

    return jsonResponse({
      ok: true,
      email: `${localPart}@${domain}`,
      domain,
      local_part: localPart,
      issued_at: issuedAt,
    })
  } catch (error) {
    if (isManagedDomainsTableMissing(error)) {
      return missingManagedDomainsTableResponse()
    }
    logError('Managed address generation failed', error, { path })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}
