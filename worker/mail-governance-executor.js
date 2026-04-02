import { AUTO_CLEAN_DAYS, DEFAULT_CLEANUP_RULE_DELETE_BATCH_SIZE } from './constants.js'
import { clearRichDetailMemoryCache, deleteEmailsByIds } from './email-store.js'
import {
  GovernanceTablesMissingError,
  hasCleanupRuleMatcher,
  listCleanupRules,
  normalizeCleanupRuleInput,
  readGovernanceSettings,
  selectCleanupRuleById,
  updateCleanupRuleRunStatus,
  updateGovernanceRetentionStatus,
  updateGovernanceRulesStatus,
  updateGovernanceScheduledStatus,
} from './mail-governance-store.js'

function normalizeBatchSize(value) {
  const parsed = parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CLEANUP_RULE_DELETE_BATCH_SIZE
  return Math.min(parsed, 1000)
}

function buildCleanupRuleWhere(rule) {
  const normalizedRule = normalizeCleanupRuleInput(rule)
  const conditions = ['is_starred = 0']
  const params = []

  if (normalizedRule.recipient) {
    conditions.push('recipient = ?')
    params.push(normalizedRule.recipient)
  }

  if (normalizedRule.sender_contains) {
    conditions.push('sender LIKE ?')
    params.push(`%${normalizedRule.sender_contains}%`)
  }

  if (normalizedRule.subject_contains) {
    conditions.push('subject LIKE ?')
    params.push(`%${normalizedRule.subject_contains}%`)
  }

  return {
    rule: normalizedRule,
    whereClause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

async function countEmailsByWhereClause(env, whereClause, params) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM emails ${whereClause}`)
    .bind(...params)
    .first()
  return Number(row?.total || 0)
}

async function listEmailIdsByWhereClause(env, whereClause, params, limit) {
  const out = await env.DB.prepare(
    `SELECT id FROM emails ${whereClause} ORDER BY received_at DESC LIMIT ?`
  )
    .bind(...params, limit)
    .all()
  return (out.results || [])
    .map((row) => Number(row?.id || 0))
    .filter((id) => Number.isFinite(id) && id > 0)
}

export async function countCleanupRuleMatches(env, rule) {
  const { rule: normalizedRule, whereClause, params } = buildCleanupRuleWhere(rule)
  if (!hasCleanupRuleMatcher(normalizedRule)) {
    return 0
  }
  return countEmailsByWhereClause(env, whereClause, params)
}

export async function executeRetentionCleanup(env, options = {}) {
  const settings = options?.settings || (await readGovernanceSettings(env))
  const triggeredAt = options?.triggeredAt || new Date().toISOString()
  const retentionEnabled = settings.retention_enabled ? 1 : 0
  const retentionDays = settings.retention_days || AUTO_CLEAN_DAYS
  const cutoffIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

  if (!retentionEnabled) {
    await updateGovernanceRetentionStatus(env, {
      retention_last_run_at: triggeredAt,
      retention_last_deleted_count: 0,
      retention_last_error: '',
      updated_at: triggeredAt,
    })
    return {
      triggered_at: triggeredAt,
      retention_enabled: 0,
      retention_days: retentionDays,
      cutoff_iso: cutoffIso,
      deleted_count: 0,
      skipped: true,
    }
  }

  const result = await env.DB.prepare('DELETE FROM emails WHERE received_at < ?')
    .bind(cutoffIso)
    .run()
  const deletedCount = Number(result?.meta?.changes || 0)
  if (deletedCount > 0) {
    await clearRichDetailMemoryCache(env)
  }

  await updateGovernanceRetentionStatus(env, {
    retention_last_run_at: triggeredAt,
    retention_last_deleted_count: deletedCount,
    retention_last_error: '',
    updated_at: triggeredAt,
  })

  return {
    triggered_at: triggeredAt,
    retention_enabled: 1,
    retention_days: retentionDays,
    cutoff_iso: cutoffIso,
    deleted_count: deletedCount,
    skipped: false,
  }
}

export async function executeCleanupRule(env, rule, options = {}) {
  const triggeredAt = options?.triggeredAt || new Date().toISOString()
  const batchSize = normalizeBatchSize(options?.batchSize)
  const persistRuleStatus = options?.persistRuleStatus !== false
  const normalizedRule = normalizeCleanupRuleInput(rule)

  if (!hasCleanupRuleMatcher(normalizedRule)) {
    const emptyResult = {
      rule_id: Number(rule?.id || 0),
      rule_name: normalizedRule.name,
      match_count: 0,
      deleted_count: 0,
      triggered_at: triggeredAt,
      skipped: true,
      error: 'Rule has no matcher',
    }
    if (persistRuleStatus && rule?.id) {
      await updateCleanupRuleRunStatus(env, rule.id, {
        last_run_at: triggeredAt,
        last_match_count: 0,
        last_deleted_count: 0,
        total_deleted_increment: 0,
        last_error: emptyResult.error,
        updated_at: triggeredAt,
      })
    }
    return emptyResult
  }

  const { whereClause, params } = buildCleanupRuleWhere(normalizedRule)
  const matchCount = await countEmailsByWhereClause(env, whereClause, params)
  let deletedCount = 0

  while (true) {
    const ids = await listEmailIdsByWhereClause(env, whereClause, params, batchSize)
    if (ids.length === 0) break
    await deleteEmailsByIds(env, ids)
    deletedCount += ids.length
    if (ids.length < batchSize) break
  }

  if (deletedCount > 0) {
    await clearRichDetailMemoryCache(env)
  }

  if (persistRuleStatus && rule?.id) {
    await updateCleanupRuleRunStatus(env, rule.id, {
      last_run_at: triggeredAt,
      last_match_count: matchCount,
      last_deleted_count: deletedCount,
      total_deleted_increment: deletedCount,
      last_error: '',
      updated_at: triggeredAt,
    })
  }

  return {
    rule_id: Number(rule?.id || 0),
    rule_name: normalizedRule.name,
    match_count: matchCount,
    deleted_count: deletedCount,
    triggered_at: triggeredAt,
    skipped: false,
    error: '',
  }
}

export async function executeCleanupRules(env, options = {}) {
  const triggeredAt = options?.triggeredAt || new Date().toISOString()
  const onlyEnabled = options?.onlyEnabled !== false
  const batchSize = normalizeBatchSize(options?.batchSize)
  const requestedRuleId = Number(options?.ruleId || 0)
  const selectedRule =
    requestedRuleId > 0 ? await selectCleanupRuleById(env, requestedRuleId) : null

  if (requestedRuleId > 0 && !selectedRule) {
    return {
      triggered_at: triggeredAt,
      rule_count: 0,
      deleted_count: 0,
      errors: [],
      results: [],
    }
  }

  const rules = selectedRule
    ? [selectedRule]
    : (await listCleanupRules(env)).filter((rule) => (onlyEnabled ? rule.enabled : true))

  const results = []
  const errors = []
  let deletedCount = 0

  for (const rule of rules) {
    try {
      const result = await executeCleanupRule(env, rule, {
        triggeredAt,
        batchSize,
        persistRuleStatus: true,
      })
      deletedCount += result.deleted_count
      results.push(result)
    } catch (error) {
      const message = String(error?.message || 'Unknown error')
      errors.push(`${rule.name || `rule-${rule.id}`}: ${message}`)
      if (rule?.id) {
        await updateCleanupRuleRunStatus(env, rule.id, {
          last_run_at: triggeredAt,
          last_match_count: 0,
          last_deleted_count: 0,
          total_deleted_increment: 0,
          last_error: message,
          updated_at: triggeredAt,
        })
      }
      results.push({
        rule_id: Number(rule?.id || 0),
        rule_name: rule?.name || '',
        match_count: 0,
        deleted_count: 0,
        triggered_at: triggeredAt,
        skipped: false,
        error: message,
      })
    }
  }

  await updateGovernanceRulesStatus(env, {
    rules_last_run_at: triggeredAt,
    rules_last_deleted_count: deletedCount,
    rules_last_rule_count: results.length,
    rules_last_error: errors.join(' | '),
    updated_at: triggeredAt,
  })

  return {
    triggered_at: triggeredAt,
    rule_count: results.length,
    deleted_count: deletedCount,
    errors,
    results,
  }
}

export async function executeScheduledGovernance(env, options = {}) {
  const triggeredAt = options?.triggeredAt || new Date().toISOString()

  try {
    const settings = await readGovernanceSettings(env)
    const retention = await executeRetentionCleanup(env, {
      settings,
      triggeredAt,
    })
    let rules
    try {
      rules = await executeCleanupRules(env, {
        triggeredAt,
        onlyEnabled: true,
      })
    } catch (error) {
      if (!(error instanceof GovernanceTablesMissingError)) {
        throw error
      }
      rules = {
        triggered_at: triggeredAt,
        rule_count: 0,
        deleted_count: 0,
        errors: [],
        results: [],
      }
    }

    await updateGovernanceScheduledStatus(env, {
      scheduled_last_run_at: triggeredAt,
      scheduled_last_error: '',
      updated_at: triggeredAt,
    })

    return {
      triggered_at: triggeredAt,
      retention,
      rules,
    }
  } catch (error) {
    const message = String(error?.message || 'Unknown error')
    await updateGovernanceScheduledStatus(env, {
      scheduled_last_run_at: triggeredAt,
      scheduled_last_error: message,
      updated_at: triggeredAt,
    })
    throw error
  }
}
