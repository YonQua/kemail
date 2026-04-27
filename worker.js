import { APP_RELEASE_TAG, APP_VERSION } from './version.js'
import { invalidateAnalysisMemoryCache } from './worker/analysis.js'
import { handleApiRequest } from './worker/api-handlers.js'
import {
  checkRateLimit,
  ensureApiRouteAccess,
  getAuthorizedRateLimitPolicy,
  getBearerToken,
  UNAUTHORIZED_RATE_LIMIT_POLICY,
} from './worker/auth.js'
import {
  AUTO_CLEAN_DAYS,
  DAY_IN_MS,
  MAX_PARSE_EMAIL_BYTES,
  MAX_RAW_EMAIL_BYTES,
  MAX_STORED_SOURCE_BYTES,
  RAW_EMAIL_PARSE_SKIPPED_NOTICE,
  RAW_EMAIL_SOURCE_SKIPPED_NOTICE,
  RAW_EMAIL_TOO_LARGE_NOTICE,
} from './worker/constants.js'
import { insertMessage, MESSAGE_TABLE } from './worker/email-store.js'
import {
  buildStoredMessageForOversizedRaw,
  buildStoredMessageForPartialParse,
  normalizeIncomingEmail,
} from './worker/message-content.js'
import {
  isStaticAssetPath,
  isStaticDocumentPath,
  jsonResponse,
  methodNotAllowed,
  optionsResponse,
} from './worker/http.js'
import { executeScheduledGovernance } from './worker/mail-governance-executor.js'
import { GovernanceTablesMissingError } from './worker/mail-governance-store.js'
import { incrementReceivedMetrics } from './worker/metrics-store.js'
import { decodeRawEmailBytes, readRawEmailBytes } from './worker/parser.js'
import { API_RATE_LIMIT_CLASS, resolveApiRoute } from './worker/routes.js'
import { handleStaticAssetRequest, handleStaticDocumentRequest } from './worker/static-assets.js'
import { appendReadableNotice, normalizeAddress } from './worker/text-core.js'
import { logError } from './worker/text-logging.js'

async function runFallbackRetentionCleanup(env) {
  const cutoffIso = new Date(Date.now() - AUTO_CLEAN_DAYS * DAY_IN_MS).toISOString()
  const result = await env.DB.prepare(`DELETE FROM ${MESSAGE_TABLE} WHERE received_at < ?`)
    .bind(cutoffIso)
    .run()
  const deleted = result.meta.changes || 0
  return {
    cutoffIso,
    deleted,
  }
}

function tooManyRequestsResponse(policy) {
  return jsonResponse(
    { ok: false, error: 'Too many requests' },
    429,
    { 'Retry-After': String(policy.windowSeconds) }
  )
}

export default {
  async email(message, env) {
    const recipient = normalizeAddress(message.to)
    const fallbackSender = message.from || 'Unknown'
    const fallbackSubject = (message.headers && message.headers.get('subject')) || 'No Subject'

    if (!recipient) {
      logError('Email worker rejected', 'Missing recipient address', {
        fallbackSender,
        fallbackSubject,
      })
      return
    }

    try {
      const rawEmail = await readRawEmailBytes(message.raw, MAX_RAW_EMAIL_BYTES)
      const receivedAt = new Date().toISOString()
      let storedMessage = null

      if (rawEmail.truncated) {
        storedMessage = buildStoredMessageForOversizedRaw({
          recipient,
          sender: fallbackSender,
          subject: fallbackSubject,
          receivedAt,
          notice: RAW_EMAIL_TOO_LARGE_NOTICE,
          parseStatus: 'too_large',
        })
      } else {
        const rawSource = decodeRawEmailBytes(rawEmail.bytes)
        const canParseBody = rawEmail.byteLength <= MAX_PARSE_EMAIL_BYTES
        const canStoreSource = rawEmail.byteLength <= MAX_STORED_SOURCE_BYTES

        if (canParseBody) {
          const normalized = await normalizeIncomingEmail(rawSource, fallbackSender, fallbackSubject)
          storedMessage = {
            recipient,
            ...normalized,
            raw_source: canStoreSource ? normalized.raw_source : '',
            source_available: canStoreSource ? 1 : 0,
            source_truncated: canStoreSource ? 0 : 1,
            parse_status: canStoreSource ? 'parsed' : 'parsed_source_truncated',
            received_at: receivedAt,
          }
        } else {
          const readableNotice = canStoreSource
            ? RAW_EMAIL_PARSE_SKIPPED_NOTICE
            : appendReadableNotice(RAW_EMAIL_PARSE_SKIPPED_NOTICE, RAW_EMAIL_SOURCE_SKIPPED_NOTICE)
          storedMessage = buildStoredMessageForPartialParse({
            recipient,
            sender: fallbackSender,
            subject: fallbackSubject,
            receivedAt,
            rawSource,
            textBody: readableNotice,
            sourceAvailable: canStoreSource,
            sourceTruncated: !canStoreSource,
            parseStatus: canStoreSource ? 'parse_skipped' : 'parse_skipped_source_truncated',
          })
        }
      }

      await insertMessage(env, storedMessage)
      await incrementReceivedMetrics(env, {
        receivedAt,
        sender: storedMessage.sender,
      })
      invalidateAnalysisMemoryCache()
    } catch (err) {
      logError('Email worker error', err, { recipient, fallbackSender, fallbackSubject })
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'OPTIONS') {
      return optionsResponse()
    }

    const isStaticDocument = isStaticDocumentPath(path)
    const isStaticAsset = isStaticAssetPath(path)
    const isApiRequest = path.startsWith('/api/')

    if (isStaticDocument) {
      return handleStaticDocumentRequest(request, env)
    }

    if (isStaticAsset) {
      return handleStaticAssetRequest(request, env)
    }
    const resolvedApiRoute = isApiRequest ? resolveApiRoute(path, request.method) : null

    if (isApiRequest) {
      if (resolvedApiRoute?.operation) {
        const authFailure = ensureApiRouteAccess(request, env, resolvedApiRoute.operation.auth)
        if (authFailure) {
          if (!(await checkRateLimit(request, env, UNAUTHORIZED_RATE_LIMIT_POLICY))) {
            return tooManyRequestsResponse(UNAUTHORIZED_RATE_LIMIT_POLICY)
          }
          return authFailure
        }

        if (resolvedApiRoute.operation.rateLimit !== API_RATE_LIMIT_CLASS.NONE) {
          const token = getBearerToken(request)
          const rateLimitPolicy = getAuthorizedRateLimitPolicy(resolvedApiRoute.operation.rateLimit)
          if (!(await checkRateLimit(request, env, { ...rateLimitPolicy, token }))) {
            return tooManyRequestsResponse(rateLimitPolicy)
          }
        }
      }
    }

    return handleApiRequest(request, env, url, path, resolvedApiRoute, {
      version: APP_VERSION,
      releaseTag: APP_RELEASE_TAG,
    })
  },

  async scheduled(_event, env) {
    try {
      const outcome = await executeScheduledGovernance(env)
      const totalDeleted =
        Number(outcome?.retention?.deleted_count || 0) + Number(outcome?.rules?.deleted_count || 0)
      if (totalDeleted > 0) {
        invalidateAnalysisMemoryCache()
        console.log(
          `[定时治理] retention=${Number(outcome?.retention?.deleted_count || 0)} rule_cleanup=${Number(outcome?.rules?.deleted_count || 0)}`
        )
      }
    } catch (err) {
      if (err instanceof GovernanceTablesMissingError) {
        try {
          const fallback = await runFallbackRetentionCleanup(env)
          if (fallback.deleted > 0) {
            invalidateAnalysisMemoryCache()
            console.log(`[定时清理] 已删除 ${fallback.deleted} 封超过 ${AUTO_CLEAN_DAYS} 天的旧邮件`)
          }
          return
        } catch (fallbackError) {
          logError('Scheduled fallback cleanup failed', fallbackError, {
            autoCleanDays: AUTO_CLEAN_DAYS,
          })
          return
        }
      }
      logError('Scheduled cleanup failed', err, { autoCleanDays: AUTO_CLEAN_DAYS })
    }
  },
}
