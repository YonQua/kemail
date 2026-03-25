import {
  handleAnalysisSendersRequest,
  handleAnalysisSummaryRequest,
  handleAnalysisTrendRequest,
  invalidateAnalysisMemoryCache,
} from './analysis.js'
import { handleAdminApiDocsRequest, handleAdminOpenApiRequest } from './api-docs-handlers.js'
import { authErrorResponse, hasAdminAccess, hasReadAccess } from './auth.js'
import { EMAIL_DETAIL_FIELDS, EMAIL_SUMMARY_FIELDS, MAX_BATCH_EMAIL_IDS } from './constants.js'
import {
  handleGeneratedAddressRequest,
  handleManagedDomainBatchPolicyRequest,
  handleManagedDomainPolicyRequest,
  handleManagedDomainsRequest,
  handleManagedDomainSyncRequest,
} from './domain-handlers.js'
import {
  buildEmailDetail,
  buildEmailSource,
  deleteEmailById,
  deleteEmailsByIds,
  formatEmailOutput,
  formatEmailSummary,
  invalidateRichDetailCache,
  selectEmailRecipientById,
  selectEmailRecipientsByIds,
  selectEmailRowById,
  selectEmailSourceRowById,
  selectLatestEmailRow,
  updateEmailReadState,
  updateEmailStarState,
} from './email-store.js'
import { jsonResponse, methodNotAllowed } from './http.js'
import { parseEmail } from './parser.js'
import {
  buildEmailListQuery,
  normalizeIdList,
  parseDateParam,
  parseEmailLimit,
  parseSinceId,
  parseSortOrder,
} from './query.js'
import { logError, normalizeAddress, normalizeText } from './text.js'

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

  if (ids.length > MAX_BATCH_EMAIL_IDS) {
    return jsonResponse({ ok: false, error: `Too many ids (max ${MAX_BATCH_EMAIL_IDS})` }, 400)
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
    return { errorResponse: validationError }
  }

  return { payload, ids, errorResponse: null }
}

async function handleLatestRequest(env, url, path) {
  const address = normalizeAddress(url.searchParams.get('address'))
  if (!address) return jsonResponse({ ok: false, error: 'Missing address' }, 400)

  try {
    // `/api/latest` 改为直接走 D1，配合 `(recipient, received_at DESC)` 索引，避免高频轮询持续写 Workers KV。
    const row = await selectLatestEmailRow(env, address)
    const out = formatEmailOutput(row)
    return jsonResponse({ ok: true, email: out })
  } catch (error) {
    logError('Latest email query failed', error, { path, address })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleEmailListRequest(request, env, url, path) {
  const address = normalizeAddress(url.searchParams.get('address'))
  const sender = normalizeText(url.searchParams.get('sender'))
  const subject = normalizeText(url.searchParams.get('subject'))
  const query = normalizeText(url.searchParams.get('q'))
  const start = parseDateParam(url.searchParams.get('start'))
  const end = parseDateParam(url.searchParams.get('end'))
  const sinceId = parseSinceId(url.searchParams.get('since_id'))
  const sortOrder = parseSortOrder(url.searchParams.get('sort'))
  const limit = parseEmailLimit(url.searchParams.get('limit'))
  const summaryOnly = url.searchParams.get('summary') === '1'

  try {
    const formatter = summaryOnly ? formatEmailSummary : formatEmailOutput
    const fields = summaryOnly ? EMAIL_SUMMARY_FIELDS : EMAIL_DETAIL_FIELDS
    const { sql, params } = buildEmailListQuery(fields, {
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
    const out = await env.DB.prepare(sql)
      .bind(...params)
      .all()
    const rows = out.results || []
    const results = rows.map(formatter).filter(Boolean)
    return jsonResponse({
      ok: true,
      emails: results,
      permissions: {
        admin: hasAdminAccess(request, env),
      },
    })
  } catch (error) {
    logError('Email list query failed', error, {
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
      summaryOnly,
    })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleEmailSourceRequest(request, env, id, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  try {
    const row = await selectEmailSourceRowById(env, id)
    if (!row) return jsonResponse({ ok: false, error: 'Not found' }, 404)

    const source = buildEmailSource(row)
    if (!source || !source.raw_available) {
      return jsonResponse({ ok: false, error: 'Raw source unavailable' }, 404)
    }

    return jsonResponse({ ok: true, source })
  } catch (error) {
    logError('Email source query failed', error, { path, id })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleEmailDetailGetRequest(request, env, url, id, path) {
  try {
    const row = await selectEmailRowById(env, id)
    if (!row) return jsonResponse({ ok: false, error: 'Not found' }, 404)

    const rich = url.searchParams.get('rich') === '1'
    if (rich) {
      const authFailure = ensureAdminRequest(request, env)
      if (authFailure) return authFailure
    }

    const email = await buildEmailDetail(env, row, { rich, parseEmailFn: parseEmail })
    return jsonResponse({ ok: true, email })
  } catch (error) {
    logError('Email detail query failed', error, { path, id })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleEmailDeleteRequest(request, env, id, path) {
  try {
    const authFailure = ensureApiReadAccess(request, env)
    if (authFailure) return authFailure

    const existing = await selectEmailRecipientById(env, id)
    if (!existing) return jsonResponse({ ok: false, error: 'Not found' }, 404)

    await deleteEmailById(env, id)
    await invalidateRichDetailCache(env, id)
    invalidateAnalysisMemoryCache()

    return jsonResponse({ ok: true, deleted: String(id) })
  } catch (error) {
    logError('Email delete failed', error, { path, id })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleEmailBatchDeleteRequest(request, env, path) {
  const authFailure = ensureApiReadAccess(request, env)
  if (authFailure) return authFailure

  const { ids, errorResponse } = await parseBatchMutationPayload(
    request,
    path,
    'Email batch delete'
  )
  if (errorResponse) return errorResponse

  try {
    const rows = await selectEmailRecipientsByIds(env, ids)
    const existingIds = new Set(rows.map((row) => Number(row.id)))

    if (rows.length > 0) {
      await deleteEmailsByIds(env, ids)
      await Promise.all(rows.map((row) => invalidateRichDetailCache(env, row.id)))
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
    logError('Email batch delete failed', error, { path, ids: ids.join(',') })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleEmailDetailRequest(request, env, url, path, id) {
  if (request.method === 'GET') {
    return handleEmailDetailGetRequest(request, env, url, id, path)
  }

  if (request.method === 'DELETE') {
    return handleEmailDeleteRequest(request, env, id, path)
  }

  return methodNotAllowed(['GET', 'DELETE'])
}

async function handleEmailReadRequest(request, env, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  const { payload, ids, errorResponse } = await parseBatchMutationPayload(
    request,
    path,
    'Email read'
  )
  if (errorResponse) return errorResponse

  const readValue = payload?.read === 0 ? 0 : 1

  try {
    const result = await updateEmailReadState(env, ids, readValue)
    invalidateAnalysisMemoryCache()
    return jsonResponse({ ok: true, updated: result?.meta?.changes || 0 })
  } catch (error) {
    logError('Email read update failed', error, { path, ids: ids.join(',') })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

async function handleEmailStarRequest(request, env, path) {
  const authFailure = ensureAdminRequest(request, env)
  if (authFailure) return authFailure

  const { payload, ids, errorResponse } = await parseBatchMutationPayload(
    request,
    path,
    'Email star'
  )
  if (errorResponse) return errorResponse

  const starredValue = payload?.starred === 0 ? 0 : 1

  try {
    const result = await updateEmailStarState(env, ids, starredValue)
    invalidateAnalysisMemoryCache()
    return jsonResponse({ ok: true, updated: result?.meta?.changes || 0 })
  } catch (error) {
    logError('Email star update failed', error, { path, ids: ids.join(',') })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

// API 路由拆成独立 handler，降低 `fetch()` 分支深度并便于后续继续扩展。
export async function handleApiRequest(request, env, url, path) {
  if (path === '/api/latest') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleLatestRequest(env, url, path)
  }

  if (path === '/api/emails') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleEmailListRequest(request, env, url, path)
  }

  if (path === '/api/emails/read') {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT'])
    return handleEmailReadRequest(request, env, path)
  }

  if (path === '/api/emails/star') {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT'])
    return handleEmailStarRequest(request, env, path)
  }

  if (path === '/api/emails/delete') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleEmailBatchDeleteRequest(request, env, path)
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

  if (path === '/api/admin/docs') {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleAdminApiDocsRequest(request, env, path)
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

  if (path === '/api/addresses/generate') {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    return handleGeneratedAddressRequest(request, env, path)
  }

  const emailSourceMatch = path.match(/^\/api\/emails\/(\d+)\/source$/)
  if (emailSourceMatch) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return handleEmailSourceRequest(request, env, parseInt(emailSourceMatch[1], 10), path)
  }

  const emailDetailMatch = path.match(/^\/api\/emails\/(\d+)$/)
  if (emailDetailMatch) {
    return handleEmailDetailRequest(request, env, url, path, parseInt(emailDetailMatch[1], 10))
  }

  const managedDomainMatch = path.match(/^\/api\/admin\/domains\/([^/]+)$/)
  if (managedDomainMatch) {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT'])
    return handleManagedDomainPolicyRequest(request, env, path, managedDomainMatch[1])
  }

  return jsonResponse({ ok: false, error: 'Not found' }, 404)
}
