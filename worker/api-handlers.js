import {
  handleAnalysisSendersRequest,
  handleAnalysisSummaryRequest,
  handleAnalysisTrendRequest,
  invalidateAnalysisMemoryCache,
} from './analysis.js'
import { handleAdminOpenApiRequest } from './api-docs-handlers.js'
import { authErrorResponse, hasAdminAccess, hasReadAccess } from './auth.js'
import { MAX_BATCH_MESSAGE_IDS } from './constants.js'
import {
  handleMailboxCreateRequest,
  handleManagedDomainBatchPolicyRequest,
  handleManagedDomainPolicyRequest,
  handleManagedDomainsRequest,
  handleManagedDomainSyncRequest,
} from './domain-handlers.js'
import {
  buildAdminMessage,
  buildPublicMessage,
  consumeLatestMessageRow,
  deleteMessageById,
  deleteMessagesByIds,
  formatMessageSummary,
  isMessagesTableMissing,
  MESSAGE_SUMMARY_FIELDS,
  selectMessageRecipientById,
  selectMessageRecipientsByIds,
  selectMessageRowById,
  updateMessageReadState,
  updateMessageStarState,
} from './email-store.js'
import { jsonResponse, methodNotAllowed } from './http.js'
import {
  handleCleanupRuleDetailRequest,
  handleCleanupRulePreviewRequest,
  handleCleanupRuleRunRequest,
  handleCleanupRulesRequest,
  handleCleanupRulesRunRequest,
  handleGovernanceRetentionRunRequest,
  handleGovernanceSettingsRequest,
  handleGovernanceStatusRequest,
} from './mail-governance-handlers.js'
import {
  buildMessageCountQuery,
  buildMessageListQuery,
  normalizeIdList,
  parseDateParam,
  parseMessageLimit,
  parseSinceId,
  parseSortOrder,
} from './query.js'
import { normalizeAddress, normalizeText } from './text-core.js'
import { logError } from './text-logging.js'

const MESSAGE_NEXT_EFFECTS = new Set(['none', 'mark_read', 'delete'])

function missingMessagesTableResponse() {
  return jsonResponse({ ok: false, error: 'emails 表不存在，请先执行 D1 迁移' }, 503)
}

export function ensureApiReadAccess(request, env) {
  if (!hasReadAccess(request, env)) {
    return authErrorResponse(401, 'Unauthorized')
  }
  return null
}

function ensureAdminRequest(request, env) {
  if (!hasAdminAccess(request, env)) {
    return authErrorResponse(403, 'Admin access required')
  }
  return null
}

async function parseJsonPayload(request, path, actionLabel) {
  try {
    return await request.json()
  } catch (error) {
    logError(`${actionLabel} payload parse failed`, error, { path })
    return null
  }
}

function validateBatchIds(ids) {
  if (!ids.length) {
    return jsonResponse({ ok: false, error: 'Missing ids' }, 400)
  }

  if (ids.length > MAX_BATCH_MESSAGE_IDS) {
    return jsonResponse(
      { ok: false, error: `Too many ids (max ${MAX_BATCH_MESSAGE_IDS})` },
      400
    )
  }

  return null
}

async function parseBatchMutationPayload(request, path, actionLabel) {
  const payload = await parseJsonPayload(request, path, actionLabel)
  if (payload == null) {
    return { errorResponse: jsonResponse({ ok: false, error: 'Invalid request body' }, 400) }
  }

  const ids = normalizeIdList(payload?.ids)
  const validationError = validateBatchIds(ids)
  if (validationError) {
    return { payload, ids, errorResponse: validationError }
  }

  return { payload, ids, errorResponse: null }
}

function parseBooleanFlag(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  return null
}

async function parseMessagesNextPayload(request, path) {
  const payload = await parseJsonPayload(request, path, 'Message next')
  if (payload == null) {
    return { errorResponse: jsonResponse({ ok: false, error: 'Invalid request body' }, 400) }
  }

  const address = normalizeAddress(payload?.address)
  if (!address) {
    return { errorResponse: jsonResponse({ ok: false, error: 'Missing address' }, 400) }
  }

  const unreadOnly = parseBooleanFlag(payload?.unread_only, true)
  if (unreadOnly == null) {
    return { errorResponse: jsonResponse({ ok: false, error: 'Invalid unread_only' }, 400) }
  }

  const includeSource = parseBooleanFlag(payload?.include_source, false)
  if (includeSource == null) {
    return { errorResponse: jsonResponse({ ok: false, error: 'Invalid include_source' }, 400) }
  }

  const effect = normalizeText(payload?.effect || 'none').toLowerCase()
  if (!MESSAGE_NEXT_EFFECTS.has(effect)) {
    return { errorResponse: jsonResponse({ ok: false, error: 'Invalid effect' }, 400) }
  }

  return {
    address,
    unreadOnly,
    includeSource,
    effect,
    errorResponse: null,
  }
}

async function handleMessagesNextRequest(request, env, path) {
  const authFailure = ensureApiReadAccess(request, env)
  if (authFailure) return authFailure

  const { address, unreadOnly, includeSource, effect, errorResponse } =
    await parseMessagesNextPayload(request, path)
  if (errorResponse) return errorResponse

  try {
    const row = await consumeLatestMessageRow(env, address, { unreadOnly, effect })
    if (!row) {
      return jsonResponse({ ok: true, message: null })
    }

    if (effect !== 'none') {
      invalidateAnalysisMemoryCache()
    }

    return jsonResponse({
      ok: true,
      message: buildPublicMessage(row, { includeSource }),
    })
  } catch (error) {
    if (isMessagesTableMissing(error)) {
      return missingMessagesTableResponse()
    }
    logError('Message next failed', error, { path, address, unreadOnly, includeSource, effect })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleAdminMessageListRequest(request, env, url, path) {
  const authFailure = ensureApiReadAccess(request, env)
  if (authFailure) return authFailure

  const address = normalizeAddress(url.searchParams.get('address'))
  const sender = normalizeText(url.searchParams.get('sender'))
  const subject = normalizeText(url.searchParams.get('subject'))
  const query = normalizeText(url.searchParams.get('q'))
  const start = parseDateParam(url.searchParams.get('start'))
  const end = parseDateParam(url.searchParams.get('end'))
  const sinceId = parseSinceId(url.searchParams.get('since_id'))
  const sortOrder = parseSortOrder(url.searchParams.get('sort'))
  const limit = parseMessageLimit(url.searchParams.get('limit'))

  try {
    const { sql, params } = buildMessageListQuery(MESSAGE_SUMMARY_FIELDS, {
      address,
      sender,
      subject,
      query,
      start,
      end,
      sinceId,
      sortOrder,
      limit,
    })
    const { sql: countSql, params: countParams } = buildMessageCountQuery({
      address,
      sender,
      subject,
      query,
      start,
      end,
      sinceId,
      sortOrder,
      limit,
    })
    const [out, totalRow] = await Promise.all([
      env.DB.prepare(sql)
        .bind(...params)
        .all(),
      env.DB.prepare(countSql)
        .bind(...countParams)
        .first(),
    ])

    const rows = Array.isArray(out?.results) ? out.results : []
    const messages = rows.map(formatMessageSummary).filter(Boolean)

    return jsonResponse({
      ok: true,
      messages,
      result_info: {
        count: messages.length,
        total_count: Number(totalRow?.total || 0),
      },
      permissions: {
        admin: hasAdminAccess(request, env),
      },
    })
  } catch (error) {
    if (isMessagesTableMissing(error)) {
      return missingMessagesTableResponse()
    }
    logError('Admin message list query failed', error, {
      path,
      address,
      sender,
      subject,
      query,
      start,
      end,
      sinceId,
      sortOrder,
      limit,
    })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleAdminMessageDetailGetRequest(request, env, id, path) {
  const authFailure = ensureApiReadAccess(request, env)
  if (authFailure) return authFailure

  try {
    const row = await selectMessageRowById(env, id)
    if (!row) return jsonResponse({ ok: false, error: 'Not found' }, 404)
    return jsonResponse({ ok: true, message: buildAdminMessage(row) })
  } catch (error) {
    if (isMessagesTableMissing(error)) {
      return missingMessagesTableResponse()
    }
    logError('Admin message detail query failed', error, { path, id })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleAdminMessageDeleteRequest(request, env, id, path) {
  const authFailure = ensureApiReadAccess(request, env)
  if (authFailure) return authFailure

  try {
    const existing = await selectMessageRecipientById(env, id)
    if (!existing) return jsonResponse({ ok: false, error: 'Not found' }, 404)

    await deleteMessageById(env, id)
    invalidateAnalysisMemoryCache()
    return jsonResponse({ ok: true, deleted: String(id) })
  } catch (error) {
    if (isMessagesTableMissing(error)) {
      return missingMessagesTableResponse()
    }
    logError('Admin message delete failed', error, { path, id })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleAdminMessageDetailRequest(request, env, path, id) {
  if (request.method === 'GET') {
    return handleAdminMessageDetailGetRequest(request, env, id, path)
  }

  if (request.method === 'DELETE') {
    return handleAdminMessageDeleteRequest(request, env, id, path)
  }

  return methodNotAllowed(['GET', 'DELETE'])
}

async function handleAdminMessageBatchDeleteRequest(request, env, path) {
  const authFailure = ensureApiReadAccess(request, env)
  if (authFailure) return authFailure

  const { ids, errorResponse } = await parseBatchMutationPayload(
    request,
    path,
    'Admin message batch delete'
  )
  if (errorResponse) return errorResponse

  try {
    const rows = await selectMessageRecipientsByIds(env, ids)
    const existingIds = new Set(rows.map((row) => Number(row.id)))

    if (rows.length > 0) {
      await deleteMessagesByIds(env, ids)
      invalidateAnalysisMemoryCache()
    }

    const deleted = ids.filter((id) => existingIds.has(id)).map((id) => String(id))
    const missing = ids.filter((id) => !existingIds.has(id)).map((id) => String(id))

    return jsonResponse({
      ok: true,
      deleted,
      missing,
      deleted_count: deleted.length,
    })
  } catch (error) {
    if (isMessagesTableMissing(error)) {
      return missingMessagesTableResponse()
    }
    logError('Admin message batch delete failed', error, { path, ids: ids.join(',') })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleAdminMessageReadRequest(request, env, path) {
  const authFailure = ensureApiReadAccess(request, env)
  if (authFailure) return authFailure

  const { payload, ids, errorResponse } = await parseBatchMutationPayload(
    request,
    path,
    'Admin message read'
  )
  if (errorResponse) return errorResponse

  const readValue = parseBooleanFlag(payload?.read, true)
  if (readValue == null) {
    return jsonResponse({ ok: false, error: 'Invalid read' }, 400)
  }

  try {
    const result = await updateMessageReadState(env, ids, readValue)
    invalidateAnalysisMemoryCache()
    return jsonResponse({ ok: true, updated: result?.meta?.changes || 0 })
  } catch (error) {
    if (isMessagesTableMissing(error)) {
      return missingMessagesTableResponse()
    }
    logError('Admin message read update failed', error, { path, ids: ids.join(',') })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleAdminMessageStarRequest(request, env, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  const { payload, ids, errorResponse } = await parseBatchMutationPayload(
    request,
    path,
    'Admin message star'
  )
  if (errorResponse) return errorResponse

  const starredValue = parseBooleanFlag(payload?.starred, true)
  if (starredValue == null) {
    return jsonResponse({ ok: false, error: 'Invalid starred' }, 400)
  }

  try {
    const result = await updateMessageStarState(env, ids, starredValue)
    invalidateAnalysisMemoryCache()
    return jsonResponse({ ok: true, updated: result?.meta?.changes || 0 })
  } catch (error) {
    if (isMessagesTableMissing(error)) {
      return missingMessagesTableResponse()
    }
    logError('Admin message star update failed', error, { path, ids: ids.join(',') })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleApiRequest(request, env, url, path) {
  if (path === '/api/messages/next') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleMessagesNextRequest(request, env, path)
  }

  if (path === '/api/mailboxes') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleMailboxCreateRequest(request, env, path)
  }

  if (path === '/api/admin/messages') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleAdminMessageListRequest(request, env, url, path)
  }

  if (path === '/api/admin/messages/read') {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT'])
    return handleAdminMessageReadRequest(request, env, path)
  }

  if (path === '/api/admin/messages/star') {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT'])
    return handleAdminMessageStarRequest(request, env, path)
  }

  if (path === '/api/admin/messages/delete') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleAdminMessageBatchDeleteRequest(request, env, path)
  }

  if (path === '/api/analysis/summary') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleAnalysisSummaryRequest(url, env, path)
  }

  if (path === '/api/analysis/trend') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleAnalysisTrendRequest(url, env, path)
  }

  if (path === '/api/analysis/senders') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleAnalysisSendersRequest(url, env, path)
  }

  if (path === '/api/admin/domains') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleManagedDomainsRequest(request, env, path)
  }

  if (path === '/api/admin/openapi') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleAdminOpenApiRequest(request, env, path)
  }

  if (path === '/api/admin/domains/sync') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleManagedDomainSyncRequest(request, env, path)
  }

  if (path === '/api/admin/domains/batch') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleManagedDomainBatchPolicyRequest(request, env, path)
  }

  if (path === '/api/admin/governance/settings') {
    if (request.method !== 'GET' && request.method !== 'PUT') {
      return methodNotAllowed(['GET', 'PUT'])
    }
    return handleGovernanceSettingsRequest(request, env, path)
  }

  if (path === '/api/admin/governance/status') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleGovernanceStatusRequest(request, env, path)
  }

  if (path === '/api/admin/governance/retention/run') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleGovernanceRetentionRunRequest(request, env, path)
  }

  if (path === '/api/admin/cleanup-rules') {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return methodNotAllowed(['GET', 'POST'])
    }
    return handleCleanupRulesRequest(request, env, path)
  }

  if (path === '/api/admin/cleanup-rules/preview') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleCleanupRulePreviewRequest(request, env, path)
  }

  if (path === '/api/admin/cleanup-rules/run') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleCleanupRulesRunRequest(request, env, path)
  }

  const adminMessageDetailMatch = path.match(/^\/api\/admin\/messages\/(\d+)$/)
  if (adminMessageDetailMatch) {
    return handleAdminMessageDetailRequest(
      request,
      env,
      path,
      parseInt(adminMessageDetailMatch[1], 10)
    )
  }

  const managedDomainMatch = path.match(/^\/api\/admin\/domains\/([^/]+)$/)
  if (managedDomainMatch) {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT'])
    return handleManagedDomainPolicyRequest(request, env, path, managedDomainMatch[1])
  }

  const cleanupRuleRunMatch = path.match(/^\/api\/admin\/cleanup-rules\/(\d+)\/run$/)
  if (cleanupRuleRunMatch) {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleCleanupRuleRunRequest(request, env, path, parseInt(cleanupRuleRunMatch[1], 10))
  }

  const cleanupRuleDetailMatch = path.match(/^\/api\/admin\/cleanup-rules\/(\d+)$/)
  if (cleanupRuleDetailMatch) {
    if (request.method !== 'PUT' && request.method !== 'DELETE') {
      return methodNotAllowed(['PUT', 'DELETE'])
    }
    return handleCleanupRuleDetailRequest(
      request,
      env,
      path,
      parseInt(cleanupRuleDetailMatch[1], 10)
    )
  }

  return jsonResponse({ ok: false, error: 'Not found' }, 404)
}
