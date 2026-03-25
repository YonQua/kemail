import { normalizeText } from './text-core.js'

const MANAGED_DOMAIN_FIELDS =
  'zone_id, domain, zone_status, issuable_enabled, last_synced_at, sync_error, note'

export class ManagedDomainSyncGuardError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ManagedDomainSyncGuardError'
  }
}

function buildIdPlaceholders(ids) {
  return ids.map(() => '?').join(', ')
}

function formatManagedDomainRow(row) {
  if (!row || typeof row !== 'object') return null

  return {
    zone_id: normalizeText(row.zone_id),
    domain: normalizeText(row.domain),
    zone_status: normalizeText(row.zone_status),
    issuable_enabled: row.issuable_enabled ? 1 : 0,
    last_synced_at: row.last_synced_at || '',
    sync_error: normalizeText(row.sync_error),
    note: normalizeText(row.note),
  }
}

export async function listManagedDomains(env) {
  const out = await env.DB.prepare(
    `SELECT ${MANAGED_DOMAIN_FIELDS} FROM managed_domains ORDER BY issuable_enabled DESC, domain ASC`
  ).all()

  return (out.results || []).map(formatManagedDomainRow).filter(Boolean)
}

export async function selectManagedDomainByZoneId(env, zoneId) {
  const row = await env.DB.prepare(
    `SELECT ${MANAGED_DOMAIN_FIELDS} FROM managed_domains WHERE zone_id = ?`
  )
    .bind(zoneId)
    .first()

  return formatManagedDomainRow(row)
}

export async function selectManagedDomainsByZoneIds(env, zoneIds) {
  if (!Array.isArray(zoneIds) || zoneIds.length === 0) return []

  const out = await env.DB.prepare(
    `SELECT ${MANAGED_DOMAIN_FIELDS} FROM managed_domains WHERE zone_id IN (${buildIdPlaceholders(zoneIds)})`
  )
    .bind(...zoneIds)
    .all()

  return (out.results || []).map(formatManagedDomainRow).filter(Boolean)
}

export async function updateManagedDomainPolicy(env, zoneId, policy, updatedAt) {
  await env.DB.prepare(
    'UPDATE managed_domains SET issuable_enabled = ?, note = ?, updated_at = ? WHERE zone_id = ?'
  )
    .bind(policy.issuable_enabled ? 1 : 0, policy.note || '', updatedAt, zoneId)
    .run()

  return selectManagedDomainByZoneId(env, zoneId)
}

export async function updateManagedDomainsIssuable(env, zoneIds, issuableEnabled, updatedAt) {
  if (!Array.isArray(zoneIds) || zoneIds.length === 0) {
    return { meta: { changes: 0 } }
  }

  return env.DB.prepare(
    `UPDATE managed_domains SET issuable_enabled = ?, updated_at = ? WHERE zone_id IN (${buildIdPlaceholders(zoneIds)})`
  )
    .bind(issuableEnabled ? 1 : 0, updatedAt, ...zoneIds)
    .run()
}

export async function syncManagedDomains(env, zones, syncedAt) {
  const normalizedZones = Array.isArray(zones)
    ? zones
        .map((zone) => ({
          zone_id: normalizeText(zone?.zone_id),
          domain: normalizeText(zone?.domain),
          zone_status: normalizeText(zone?.zone_status),
        }))
        .filter((zone) => zone.zone_id && zone.domain)
    : []

  const existingDomains = await listManagedDomains(env)
  if (normalizedZones.length === 0 && existingDomains.length > 0) {
    throw new ManagedDomainSyncGuardError('Cloudflare 未返回任何 Zone，已中止同步以保护现有域名池')
  }

  for (const zone of normalizedZones) {
    await env.DB.prepare(
      `INSERT INTO managed_domains (
        zone_id,
        domain,
        zone_status,
        last_synced_at,
        sync_error,
        note,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, '', ?, ?)
      ON CONFLICT(zone_id) DO UPDATE SET
        domain = excluded.domain,
        zone_status = excluded.zone_status,
        last_synced_at = excluded.last_synced_at,
        sync_error = excluded.sync_error,
        updated_at = excluded.updated_at`
    )
      .bind(zone.zone_id, zone.domain, zone.zone_status, syncedAt, '', syncedAt, syncedAt)
      .run()
  }

  const zoneIds = normalizedZones.map((zone) => zone.zone_id)
  if (zoneIds.length > 0) {
    await env.DB.prepare(
      `UPDATE managed_domains
       SET zone_status = ?,
           issuable_enabled = 0,
           last_synced_at = ?,
           sync_error = ?,
           updated_at = ?
       WHERE zone_id NOT IN (${buildIdPlaceholders(zoneIds)})`
    )
      .bind('missing', syncedAt, 'Not returned by latest Cloudflare sync', syncedAt, ...zoneIds)
      .run()
  }

  return listManagedDomains(env)
}

export async function listIssuableDomains(env) {
  const out = await env.DB.prepare(
    'SELECT domain FROM managed_domains WHERE issuable_enabled = 1 AND zone_status = ? ORDER BY domain ASC'
  )
    .bind('active')
    .all()

  return (out.results || []).map((row) => normalizeText(row?.domain)).filter(Boolean)
}
