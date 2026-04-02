import { invalidateAnalysisMemoryCache } from './analysis.js'
import { authErrorResponse, hasAdminAccess } from './auth.js'
import { jsonResponse } from './http.js'
import {
  countCleanupRuleMatches,
  executeCleanupRule,
  executeCleanupRules,
  executeRetentionCleanup,
} from './mail-governance-executor.js'
import {
  countCleanupRules,
  deleteCleanupRule,
  GovernanceTablesMissingError,
  hasCleanupRuleMatcher,
  insertCleanupRule,
  listCleanupRules,
  normalizeCleanupRuleInput,
  readGovernanceSettings,
  selectCleanupRuleById,
  updateCleanupRule,
  updateGovernanceSettings,
} from './mail-governance-store.js'
import { logError } from './text-logging.js'

function ensureAdminRequest(request, env) {
  if (!hasAdminAccess(request, env)) {
    return authErrorResponse(403, 'Admin access required')
  }
  return null
}

function governanceMigrationRequiredResponse() {
  return jsonResponse(
    {
      ok: false,
      error: 'Governance tables missing, run the D1 migration first',
      code: 'GOVERNANCE_MIGRATION_REQUIRED',
    },
    503
  )
}

async function parseJsonPayload(request, path, actionLabel) {
  try {
    return await request.json()
  } catch (error) {
    logError(`${actionLabel} payload parse failed`, error, { path })
    return null
  }
}

function parseBooleanFlag(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  return null
}

function buildGovernanceStatus(settings, totalRules, enabledRules) {
  return {
    retention: {
      enabled: settings.retention_enabled ? 1 : 0,
      retention_days: settings.retention_days,
      last_run_at: settings.retention_last_run_at,
      last_deleted_count: settings.retention_last_deleted_count,
      last_error: settings.retention_last_error,
    },
    rules: {
      total_rules: totalRules,
      enabled_rules: enabledRules,
      last_run_at: settings.rules_last_run_at,
      last_deleted_count: settings.rules_last_deleted_count,
      last_rule_count: settings.rules_last_rule_count,
      last_error: settings.rules_last_error,
    },
    scheduled: {
      last_run_at: settings.scheduled_last_run_at,
      last_error: settings.scheduled_last_error,
    },
  }
}

function validateRuleInput(rule) {
  if (!rule.name) {
    return 'Missing name'
  }
  if (!hasCleanupRuleMatcher(rule)) {
    return 'At least one matcher is required'
  }
  return ''
}

export async function handleGovernanceSettingsRequest(request, env, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  try {
    if (request.method === 'GET') {
      const settings = await readGovernanceSettings(env)
      return jsonResponse({ ok: true, settings })
    }

    const payload = await parseJsonPayload(request, path, 'Governance settings')
    if (payload == null) {
      return jsonResponse({ ok: false, error: 'Invalid request body' }, 400)
    }

    const updatePayload = {}

    if (Object.prototype.hasOwnProperty.call(payload, 'retention_enabled')) {
      const retentionEnabled = parseBooleanFlag(payload?.retention_enabled, false)
      if (retentionEnabled == null) {
        return jsonResponse({ ok: false, error: 'Invalid retention_enabled' }, 400)
      }
      updatePayload.retention_enabled = retentionEnabled ? 1 : 0
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'retention_days')) {
      const retentionDaysRaw = payload?.retention_days
      const retentionDays =
        retentionDaysRaw == null || retentionDaysRaw === '' ? undefined : Number(retentionDaysRaw)
      if (retentionDays !== undefined && (!Number.isFinite(retentionDays) || retentionDays < 1)) {
        return jsonResponse({ ok: false, error: 'Invalid retention_days' }, 400)
      }
      if (retentionDays !== undefined) {
        updatePayload.retention_days = retentionDays
      }
    }

    if (!Object.keys(updatePayload).length) {
      return jsonResponse({ ok: false, error: 'No updatable governance fields provided' }, 400)
    }

    const settings = await updateGovernanceSettings(env, updatePayload)
    invalidateAnalysisMemoryCache()
    return jsonResponse({ ok: true, settings })
  } catch (error) {
    if (error instanceof GovernanceTablesMissingError) {
      return governanceMigrationRequiredResponse()
    }
    logError('Governance settings request failed', error, { path, method: request.method })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleGovernanceStatusRequest(request, env, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  try {
    const settings = await readGovernanceSettings(env)
    const [totalRules, enabledRules] = await Promise.all([
      countCleanupRules(env),
      countCleanupRules(env, { onlyEnabled: true }),
    ])
    return jsonResponse({
      ok: true,
      status: buildGovernanceStatus(settings, totalRules, enabledRules),
    })
  } catch (error) {
    if (error instanceof GovernanceTablesMissingError) {
      return governanceMigrationRequiredResponse()
    }
    logError('Governance status request failed', error, { path })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleGovernanceRetentionRunRequest(request, env, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  try {
    const result = await executeRetentionCleanup(env)
    if (result.deleted_count > 0) {
      invalidateAnalysisMemoryCache()
    }
    return jsonResponse({ ok: true, result })
  } catch (error) {
    if (error instanceof GovernanceTablesMissingError) {
      return governanceMigrationRequiredResponse()
    }
    logError('Governance retention run failed', error, { path })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleCleanupRulesRequest(request, env, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  try {
    if (request.method === 'GET') {
      const rules = await listCleanupRules(env)
      return jsonResponse({ ok: true, rules })
    }

    const payload = await parseJsonPayload(request, path, 'Cleanup rules create')
    if (payload == null) {
      return jsonResponse({ ok: false, error: 'Invalid request body' }, 400)
    }

    const rule = normalizeCleanupRuleInput(payload)
    const validationError = validateRuleInput(rule)
    if (validationError) {
      return jsonResponse({ ok: false, error: validationError }, 400)
    }

    const created = await insertCleanupRule(env, rule)
    return jsonResponse({ ok: true, rule: created }, 201)
  } catch (error) {
    if (error instanceof GovernanceTablesMissingError) {
      return governanceMigrationRequiredResponse()
    }
    logError('Cleanup rules request failed', error, { path, method: request.method })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleCleanupRulePreviewRequest(request, env, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  try {
    const payload = await parseJsonPayload(request, path, 'Cleanup rule preview')
    if (payload == null) {
      return jsonResponse({ ok: false, error: 'Invalid request body' }, 400)
    }

    const rule = normalizeCleanupRuleInput(payload)
    const validationError = validateRuleInput({
      ...rule,
      name: rule.name || 'preview',
    })
    if (validationError) {
      return jsonResponse({ ok: false, error: validationError }, 400)
    }

    const matchCount = await countCleanupRuleMatches(env, rule)
    return jsonResponse({
      ok: true,
      preview: {
        match_count: matchCount,
      },
    })
  } catch (error) {
    if (error instanceof GovernanceTablesMissingError) {
      return governanceMigrationRequiredResponse()
    }
    logError('Cleanup rule preview failed', error, { path })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleCleanupRulesRunRequest(request, env, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  try {
    const result = await executeCleanupRules(env, {
      onlyEnabled: true,
    })
    if (result.deleted_count > 0) {
      invalidateAnalysisMemoryCache()
    }
    return jsonResponse({ ok: true, result })
  } catch (error) {
    if (error instanceof GovernanceTablesMissingError) {
      return governanceMigrationRequiredResponse()
    }
    logError('Cleanup rules run failed', error, { path })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleCleanupRuleDetailRequest(request, env, path, id) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  try {
    if (request.method === 'DELETE') {
      const existing = await selectCleanupRuleById(env, id)
      if (!existing) {
        return jsonResponse({ ok: false, error: 'Not found' }, 404)
      }
      await deleteCleanupRule(env, id)
      return jsonResponse({ ok: true, deleted: String(id) })
    }

    const payload = await parseJsonPayload(request, path, 'Cleanup rule update')
    if (payload == null) {
      return jsonResponse({ ok: false, error: 'Invalid request body' }, 400)
    }

    const existing = await selectCleanupRuleById(env, id)
    if (!existing) {
      return jsonResponse({ ok: false, error: 'Not found' }, 404)
    }

    const rule = normalizeCleanupRuleInput({
      name: Object.prototype.hasOwnProperty.call(payload, 'name') ? payload.name : existing.name,
      enabled: Object.prototype.hasOwnProperty.call(payload, 'enabled')
        ? payload.enabled
        : existing.enabled,
      recipient: Object.prototype.hasOwnProperty.call(payload, 'recipient')
        ? payload.recipient
        : existing.recipient,
      sender_contains: Object.prototype.hasOwnProperty.call(payload, 'sender_contains')
        ? payload.sender_contains
        : existing.sender_contains,
      subject_contains: Object.prototype.hasOwnProperty.call(payload, 'subject_contains')
        ? payload.subject_contains
        : existing.subject_contains,
      note: Object.prototype.hasOwnProperty.call(payload, 'note') ? payload.note : existing.note,
    })
    const validationError = validateRuleInput(rule)
    if (validationError) {
      return jsonResponse({ ok: false, error: validationError }, 400)
    }

    const updated = await updateCleanupRule(env, id, rule)
    return jsonResponse({ ok: true, rule: updated })
  } catch (error) {
    if (error instanceof GovernanceTablesMissingError) {
      return governanceMigrationRequiredResponse()
    }
    logError('Cleanup rule detail request failed', error, { path, id, method: request.method })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleCleanupRuleRunRequest(request, env, path, id) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  try {
    const rule = await selectCleanupRuleById(env, id)
    if (!rule) {
      return jsonResponse({ ok: false, error: 'Not found' }, 404)
    }

    const result = await executeCleanupRule(env, rule)
    if (result.deleted_count > 0) {
      invalidateAnalysisMemoryCache()
    }
    return jsonResponse({ ok: true, result })
  } catch (error) {
    if (error instanceof GovernanceTablesMissingError) {
      return governanceMigrationRequiredResponse()
    }
    logError('Cleanup rule run failed', error, { path, id })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}
