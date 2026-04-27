import {
  handleAnalysisSendersRequest,
  handleAnalysisSummaryRequest,
  handleAnalysisTrendRequest,
  invalidateAnalysisMemoryCache,
} from './analysis.js'
import { handleAdminOpenApiRequest } from './api-docs-handlers.js'
import { hasAdminAccess } from './auth.js'
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
  buildMessagePageCursor,
  buildMessageCountQuery,
  buildMessageListQuery,
  normalizeIdList,
  parseMessageCursor,
  parseDateParam,
  parseMessageLimit,
  parseSortOrder,
} from './query.js'
import { resolveApiRoute } from './routes.js'
import { normalizeAddress, normalizeText } from './text-core.js'
import { logError } from './text-logging.js'

const MESSAGE_NEXT_EFFECTS = new Set(['none', 'mark_read', 'delete'])

function missingMessagesTableResponse() {
  return jsonResponse({ ok: false, error: 'emails 表不存在，请先执行 D1 迁移' }, 503)
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
  const address = normalizeAddress(url.searchParams.get('address'))
  const sender = normalizeText(url.searchParams.get('sender'))
  const subject = normalizeText(url.searchParams.get('subject'))
  const query = normalizeText(url.searchParams.get('q'))
  const start = parseDateParam(url.searchParams.get('start'))
  const end = parseDateParam(url.searchParams.get('end'))
  const cursor = parseMessageCursor(url.searchParams.get('cursor'))
  const sortOrder = parseSortOrder(url.searchParams.get('sort'))
  const pageSize = parseMessageLimit(url.searchParams.get('limit'))

  try {
    const { sql, params } = buildMessageListQuery(MESSAGE_SUMMARY_FIELDS, {
      address,
      sender,
      subject,
      query,
      start,
      end,
      cursor,
      sortOrder,
      limit: pageSize + 1,
    })
    const { sql: countSql, params: countParams } = buildMessageCountQuery({
      address,
      sender,
      subject,
      query,
      start,
      end,
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
    const hasMore = rows.length > pageSize
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows
    const messages = pageRows.map(formatMessageSummary).filter(Boolean)
    const totalCount = Number(totalRow?.total || 0)
    const nextCursor = hasMore ? buildMessagePageCursor(pageRows[pageRows.length - 1]) : ''

    return jsonResponse({
      ok: true,
      messages,
      page_info: {
        count: messages.length,
        total_count: totalCount,
        has_more: hasMore,
        next_cursor: nextCursor,
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
      cursor: cursor ? `${cursor.receivedAt}|${cursor.id}` : '',
      sortOrder,
      limit: pageSize,
    })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleAdminMessageDetailGetRequest(request, env, id, path) {
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

export async function handleApiRequest(request, env, url, path, resolvedRoute, runtime = {}) {
  const routeMatch = resolvedRoute || resolveApiRoute(path, request.method)
  if (!routeMatch) {
    return jsonResponse({ ok: false, error: 'Not found' }, 404)
  }

  if (!routeMatch.operation) {
    return methodNotAllowed(routeMatch.allowedMethods)
  }

  const params = routeMatch.params || {}

  switch (routeMatch.operation.handler) {
    case 'version':
      return jsonResponse({
        ok: true,
        version: runtime.version || '',
        release_tag: runtime.releaseTag || '',
      })
    case 'messagesNext':
      return handleMessagesNextRequest(request, env, path)
    case 'mailboxesCreate':
      return handleMailboxCreateRequest(request, env, path)
    case 'adminMessagesList':
      return handleAdminMessageListRequest(request, env, url, path)
    case 'adminMessagesRead':
      return handleAdminMessageReadRequest(request, env, path)
    case 'adminMessagesStar':
      return handleAdminMessageStarRequest(request, env, path)
    case 'adminMessagesDeleteBatch':
      return handleAdminMessageBatchDeleteRequest(request, env, path)
    case 'analysisSummary':
      return handleAnalysisSummaryRequest(url, env, path)
    case 'analysisTrend':
      return handleAnalysisTrendRequest(url, env, path)
    case 'analysisSenders':
      return handleAnalysisSendersRequest(url, env, path)
    case 'adminDomainsList':
      return handleManagedDomainsRequest(request, env, path)
    case 'adminOpenapi':
      return handleAdminOpenApiRequest(request, env, path)
    case 'adminDomainsSync':
      return handleManagedDomainSyncRequest(request, env, path)
    case 'adminDomainsBatch':
      return handleManagedDomainBatchPolicyRequest(request, env, path)
    case 'adminGovernanceSettings':
      return handleGovernanceSettingsRequest(request, env, path)
    case 'adminGovernanceStatus':
      return handleGovernanceStatusRequest(request, env, path)
    case 'adminGovernanceRetentionRun':
      return handleGovernanceRetentionRunRequest(request, env, path)
    case 'adminCleanupRules':
      return handleCleanupRulesRequest(request, env, path)
    case 'adminCleanupRulesPreview':
      return handleCleanupRulePreviewRequest(request, env, path)
    case 'adminCleanupRulesRun':
      return handleCleanupRulesRunRequest(request, env, path)
    case 'adminMessageDetail':
      return handleAdminMessageDetailRequest(request, env, path, params.id)
    case 'adminDomainDetail':
      return handleManagedDomainPolicyRequest(request, env, path, params.zoneId)
    case 'adminCleanupRuleRun':
      return handleCleanupRuleRunRequest(request, env, path, params.id)
    case 'adminCleanupRuleDetail':
      return handleCleanupRuleDetailRequest(request, env, path, params.id)
    default:
      return jsonResponse({ ok: false, error: 'Not found' }, 404)
  }
}
