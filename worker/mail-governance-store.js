import { AUTO_CLEAN_DAYS, MAX_GOVERNANCE_RETENTION_DAYS } from './constants.js'
import { normalizeAddress, normalizeText } from './text-core.js'

const GOVERNANCE_SETTINGS_FIELDS =
  'id, retention_enabled, retention_days, retention_last_run_at, retention_last_deleted_count, retention_last_error, rules_last_run_at, rules_last_deleted_count, rules_last_rule_count, rules_last_error, scheduled_last_run_at, scheduled_last_error, created_at, updated_at'

const CLEANUP_RULE_FIELDS =
  'id, name, enabled, recipient, sender_contains, subject_contains, note, last_run_at, last_match_count, last_deleted_count, total_deleted_count, last_error, created_at, updated_at'

export class GovernanceTablesMissingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GovernanceTablesMissingError'
  }
}

function normalizeInt(value, fallback = 0) {
  const parsed = parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clampRetentionDays(value) {
  const parsed = normalizeInt(value, AUTO_CLEAN_DAYS)
  if (parsed < 1) return 1
  return Math.min(parsed, MAX_GOVERNANCE_RETENTION_DAYS)
}

function formatGovernanceSettingsRow(row) {
  if (!row || typeof row !== 'object') {
    return {
      retention_enabled: 1,
      retention_days: AUTO_CLEAN_DAYS,
      retention_last_run_at: '',
      retention_last_deleted_count: 0,
      retention_last_error: '',
      rules_last_run_at: '',
      rules_last_deleted_count: 0,
      rules_last_rule_count: 0,
      rules_last_error: '',
      scheduled_last_run_at: '',
      scheduled_last_error: '',
      created_at: '',
      updated_at: '',
    }
  }

  return {
    retention_enabled: row.retention_enabled ? 1 : 0,
    retention_days: clampRetentionDays(row.retention_days),
    retention_last_run_at: row.retention_last_run_at || '',
    retention_last_deleted_count: normalizeInt(row.retention_last_deleted_count, 0),
    retention_last_error: normalizeText(row.retention_last_error),
    rules_last_run_at: row.rules_last_run_at || '',
    rules_last_deleted_count: normalizeInt(row.rules_last_deleted_count, 0),
    rules_last_rule_count: normalizeInt(row.rules_last_rule_count, 0),
    rules_last_error: normalizeText(row.rules_last_error),
    scheduled_last_run_at: row.scheduled_last_run_at || '',
    scheduled_last_error: normalizeText(row.scheduled_last_error),
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
  }
}

function formatCleanupRuleRow(row) {
  if (!row || typeof row !== 'object') return null

  return {
    id: normalizeInt(row.id, 0),
    name: normalizeText(row.name),
    enabled: row.enabled ? 1 : 0,
    recipient: normalizeAddress(row.recipient),
    sender_contains: normalizeText(row.sender_contains),
    subject_contains: normalizeText(row.subject_contains),
    note: normalizeText(row.note),
    last_run_at: row.last_run_at || '',
    last_match_count: normalizeInt(row.last_match_count, 0),
    last_deleted_count: normalizeInt(row.last_deleted_count, 0),
    total_deleted_count: normalizeInt(row.total_deleted_count, 0),
    last_error: normalizeText(row.last_error),
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
  }
}

async function firstRowOrThrowMissingTable(statement) {
  try {
    return await statement.first()
  } catch (error) {
    const message = String(error?.message || '')
    if (message.includes('mail_governance_settings') || message.includes('mail_cleanup_rules')) {
      throw new GovernanceTablesMissingError(message)
    }
    throw error
  }
}

async function runOrThrowMissingTable(statement) {
  try {
    return await statement.run()
  } catch (error) {
    const message = String(error?.message || '')
    if (message.includes('mail_governance_settings') || message.includes('mail_cleanup_rules')) {
      throw new GovernanceTablesMissingError(message)
    }
    throw error
  }
}

async function allRowsOrThrowMissingTable(statement) {
  try {
    return await statement.all()
  } catch (error) {
    const message = String(error?.message || '')
    if (message.includes('mail_governance_settings') || message.includes('mail_cleanup_rules')) {
      throw new GovernanceTablesMissingError(message)
    }
    throw error
  }
}

export function normalizeGovernanceSettingsInput(input = {}) {
  const retentionEnabled =
    input?.retention_enabled === 0 || input?.retention_enabled === false ? 0 : 1

  return {
    retention_enabled: retentionEnabled,
    retention_days: clampRetentionDays(input?.retention_days),
  }
}

export function normalizeCleanupRuleInput(input = {}) {
  const enabled = input?.enabled === 0 || input?.enabled === false ? 0 : 1

  return {
    name: normalizeText(input?.name).slice(0, 80),
    enabled,
    recipient: normalizeAddress(input?.recipient).slice(0, 320),
    sender_contains: normalizeText(input?.sender_contains).slice(0, 160),
    subject_contains: normalizeText(input?.subject_contains).slice(0, 200),
    note: normalizeText(input?.note).slice(0, 300),
  }
}

export function hasCleanupRuleMatcher(rule) {
  return Boolean(rule?.recipient || rule?.sender_contains || rule?.subject_contains)
}

export async function ensureGovernanceSettingsRow(env) {
  const now = new Date().toISOString()
  await runOrThrowMissingTable(
    env.DB.prepare(
      `INSERT OR IGNORE INTO mail_governance_settings (
        id,
        retention_enabled,
        retention_days,
        retention_last_run_at,
        retention_last_deleted_count,
        retention_last_error,
        rules_last_run_at,
        rules_last_deleted_count,
        rules_last_rule_count,
        rules_last_error,
        scheduled_last_run_at,
        scheduled_last_error,
        created_at,
        updated_at
      ) VALUES (1, 1, ?, '', 0, '', '', 0, 0, '', '', '', ?, ?)`
    ).bind(AUTO_CLEAN_DAYS, now, now)
  )
}

export async function readGovernanceSettings(env) {
  await ensureGovernanceSettingsRow(env)
  const row = await firstRowOrThrowMissingTable(
    env.DB.prepare(
      `SELECT ${GOVERNANCE_SETTINGS_FIELDS} FROM mail_governance_settings WHERE id = 1`
    )
  )
  return formatGovernanceSettingsRow(row)
}

export async function readEffectiveRetentionDays(env) {
  const settings = await readGovernanceSettings(env)
  return settings.retention_enabled ? settings.retention_days : 0
}

export async function updateGovernanceSettings(env, input = {}) {
  const current = await readGovernanceSettings(env)
  const next = normalizeGovernanceSettingsInput({
    retention_enabled: Object.prototype.hasOwnProperty.call(input, 'retention_enabled')
      ? input.retention_enabled
      : current.retention_enabled,
    retention_days: Object.prototype.hasOwnProperty.call(input, 'retention_days')
      ? input.retention_days
      : current.retention_days,
  })
  const updatedAt = new Date().toISOString()

  await runOrThrowMissingTable(
    env.DB.prepare(
      'UPDATE mail_governance_settings SET retention_enabled = ?, retention_days = ?, updated_at = ? WHERE id = 1'
    ).bind(next.retention_enabled, next.retention_days, updatedAt)
  )

  return readGovernanceSettings(env)
}

export async function updateGovernanceRetentionStatus(env, payload = {}) {
  await ensureGovernanceSettingsRow(env)
  const updatedAt = payload?.updated_at || new Date().toISOString()
  await runOrThrowMissingTable(
    env.DB.prepare(
      `UPDATE mail_governance_settings
       SET retention_last_run_at = ?,
           retention_last_deleted_count = ?,
           retention_last_error = ?,
           updated_at = ?
       WHERE id = 1`
    ).bind(
      payload?.retention_last_run_at || '',
      normalizeInt(payload?.retention_last_deleted_count, 0),
      normalizeText(payload?.retention_last_error),
      updatedAt
    )
  )
}

export async function updateGovernanceRulesStatus(env, payload = {}) {
  await ensureGovernanceSettingsRow(env)
  const updatedAt = payload?.updated_at || new Date().toISOString()
  await runOrThrowMissingTable(
    env.DB.prepare(
      `UPDATE mail_governance_settings
       SET rules_last_run_at = ?,
           rules_last_deleted_count = ?,
           rules_last_rule_count = ?,
           rules_last_error = ?,
           updated_at = ?
       WHERE id = 1`
    ).bind(
      payload?.rules_last_run_at || '',
      normalizeInt(payload?.rules_last_deleted_count, 0),
      normalizeInt(payload?.rules_last_rule_count, 0),
      normalizeText(payload?.rules_last_error),
      updatedAt
    )
  )
}

export async function updateGovernanceScheduledStatus(env, payload = {}) {
  await ensureGovernanceSettingsRow(env)
  const updatedAt = payload?.updated_at || new Date().toISOString()
  await runOrThrowMissingTable(
    env.DB.prepare(
      `UPDATE mail_governance_settings
       SET scheduled_last_run_at = ?,
           scheduled_last_error = ?,
           updated_at = ?
       WHERE id = 1`
    ).bind(
      payload?.scheduled_last_run_at || '',
      normalizeText(payload?.scheduled_last_error),
      updatedAt
    )
  )
}

export async function listCleanupRules(env) {
  const out = await allRowsOrThrowMissingTable(
    env.DB.prepare(
      `SELECT ${CLEANUP_RULE_FIELDS}
       FROM mail_cleanup_rules
       ORDER BY enabled DESC, updated_at DESC, id DESC`
    )
  )

  return (out.results || []).map(formatCleanupRuleRow).filter(Boolean)
}

export async function countCleanupRules(env, options = {}) {
  const onlyEnabled = options?.onlyEnabled === true
  const row = await firstRowOrThrowMissingTable(
    onlyEnabled
      ? env.DB.prepare('SELECT COUNT(*) AS total FROM mail_cleanup_rules WHERE enabled = 1')
      : env.DB.prepare('SELECT COUNT(*) AS total FROM mail_cleanup_rules')
  )
  return normalizeInt(row?.total, 0)
}

export async function selectCleanupRuleById(env, id) {
  const row = await firstRowOrThrowMissingTable(
    env.DB.prepare(`SELECT ${CLEANUP_RULE_FIELDS} FROM mail_cleanup_rules WHERE id = ?`).bind(id)
  )
  return formatCleanupRuleRow(row)
}

export async function insertCleanupRule(env, input = {}) {
  const rule = normalizeCleanupRuleInput(input)
  const now = new Date().toISOString()

  const result = await runOrThrowMissingTable(
    env.DB.prepare(
      `INSERT INTO mail_cleanup_rules (
        name,
        enabled,
        recipient,
        sender_contains,
        subject_contains,
        note,
        last_run_at,
        last_match_count,
        last_deleted_count,
        total_deleted_count,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '', 0, 0, 0, '', ?, ?)`
    ).bind(
      rule.name,
      rule.enabled,
      rule.recipient,
      rule.sender_contains,
      rule.subject_contains,
      rule.note,
      now,
      now
    )
  )

  return selectCleanupRuleById(env, result.meta.last_row_id)
}

export async function updateCleanupRule(env, id, input = {}) {
  const current = await selectCleanupRuleById(env, id)
  if (!current) return null

  const next = normalizeCleanupRuleInput({
    name: Object.prototype.hasOwnProperty.call(input, 'name') ? input.name : current.name,
    enabled: Object.prototype.hasOwnProperty.call(input, 'enabled')
      ? input.enabled
      : current.enabled,
    recipient: Object.prototype.hasOwnProperty.call(input, 'recipient')
      ? input.recipient
      : current.recipient,
    sender_contains: Object.prototype.hasOwnProperty.call(input, 'sender_contains')
      ? input.sender_contains
      : current.sender_contains,
    subject_contains: Object.prototype.hasOwnProperty.call(input, 'subject_contains')
      ? input.subject_contains
      : current.subject_contains,
    note: Object.prototype.hasOwnProperty.call(input, 'note') ? input.note : current.note,
  })
  const updatedAt = new Date().toISOString()

  await runOrThrowMissingTable(
    env.DB.prepare(
      `UPDATE mail_cleanup_rules
       SET name = ?,
           enabled = ?,
           recipient = ?,
           sender_contains = ?,
           subject_contains = ?,
           note = ?,
           updated_at = ?
       WHERE id = ?`
    ).bind(
      next.name,
      next.enabled,
      next.recipient,
      next.sender_contains,
      next.subject_contains,
      next.note,
      updatedAt,
      id
    )
  )

  return selectCleanupRuleById(env, id)
}

export async function deleteCleanupRule(env, id) {
  return runOrThrowMissingTable(
    env.DB.prepare('DELETE FROM mail_cleanup_rules WHERE id = ?').bind(id)
  )
}

export async function updateCleanupRuleRunStatus(env, id, payload = {}) {
  const updatedAt = payload?.updated_at || new Date().toISOString()
  await runOrThrowMissingTable(
    env.DB.prepare(
      `UPDATE mail_cleanup_rules
       SET last_run_at = ?,
           last_match_count = ?,
           last_deleted_count = ?,
           total_deleted_count = total_deleted_count + ?,
           last_error = ?,
           updated_at = ?
       WHERE id = ?`
    ).bind(
      payload?.last_run_at || '',
      normalizeInt(payload?.last_match_count, 0),
      normalizeInt(payload?.last_deleted_count, 0),
      normalizeInt(payload?.total_deleted_increment, 0),
      normalizeText(payload?.last_error),
      updatedAt,
      id
    )
  )

  return selectCleanupRuleById(env, id)
}
