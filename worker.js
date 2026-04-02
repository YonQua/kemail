import { APP_RELEASE_TAG, APP_VERSION } from './version.js'
import { invalidateAnalysisMemoryCache } from './worker/analysis.js'
import { ensureApiReadAccess, handleApiRequest } from './worker/api-handlers.js'
import { authenticatedRateLimitPolicy, checkRateLimit, getBearerToken } from './worker/auth.js'
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
import { decodeRawEmailBytes, parseEmail, readRawEmailBytes } from './worker/parser.js'
import { handleStaticAssetRequest, handleStaticDocumentRequest } from './worker/static-assets.js'
import { appendReadableNotice, normalizeAddress } from './worker/text-core.js'
import { logError } from './worker/text-logging.js'

async function runLegacyRetentionCleanup(env) {
  const cutoffIso = new Date(Date.now() - AUTO_CLEAN_DAYS * DAY_IN_MS).toISOString()
  const result = await env.DB.prepare('DELETE FROM emails WHERE received_at < ?')
    .bind(cutoffIso)
    .run()
  const deleted = result.meta.changes || 0
  return {
    cutoffIso,
    deleted,
  }
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
      let sender = fallbackSender
      let subject = fallbackSubject
      let rawBody = null
      let bodyReadable = ''

      if (rawEmail.truncated) {
        bodyReadable = RAW_EMAIL_TOO_LARGE_NOTICE
      } else {
        const decodedRawBody = decodeRawEmailBytes(rawEmail.bytes)
        const canParseBody = rawEmail.byteLength <= MAX_PARSE_EMAIL_BYTES
        const canStoreSource = rawEmail.byteLength <= MAX_STORED_SOURCE_BYTES

        if (canParseBody) {
          const parsed = await parseEmail(decodedRawBody, fallbackSender, fallbackSubject)
          sender = parsed.sender
          subject = parsed.subject
          bodyReadable = parsed.bodyReadable
        } else {
          bodyReadable = RAW_EMAIL_PARSE_SKIPPED_NOTICE
        }

        if (canStoreSource) {
          rawBody = decodedRawBody
        } else {
          bodyReadable = appendReadableNotice(bodyReadable, RAW_EMAIL_SOURCE_SKIPPED_NOTICE)
        }
      }

      const receivedAt = new Date().toISOString()

      const insert = env.DB.prepare(
        'INSERT INTO emails (recipient, sender, subject, body, body_readable, received_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      await insert.bind(recipient, sender, subject, rawBody, bodyReadable || null, receivedAt).run()
      await incrementReceivedMetrics(env, {
        receivedAt,
        sender,
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

    // 管理页与静态资源都是站内受控流量，继续让它们经过 KV 限流会把免费额度浪费在页面加载上。
    if (isStaticDocument) {
      return handleStaticDocumentRequest(request, env)
    }

    if (isStaticAsset) {
      return handleStaticAssetRequest(request, env)
    }

    if (path === '/api/version') {
      if (request.method !== 'GET') {
        return methodNotAllowed(['GET'])
      }
      return jsonResponse({
        ok: true,
        version: APP_VERSION,
        release_tag: APP_RELEASE_TAG,
      })
    }

    if (isApiRequest) {
      const authFailure = ensureApiReadAccess(request, env)
      if (authFailure) {
        // 只对未鉴权 API 请求做 KV 限流，保留暴力探测防护，同时避免后台正常轮询持续消耗 KV。
        if (!(await checkRateLimit(request, env, 'unauthorized'))) {
          return jsonResponse({ ok: false, error: 'Too many requests' }, 429)
        }
        return authFailure
      }

      const token = getBearerToken(request)
      const rateLimitPolicy = authenticatedRateLimitPolicy(request, url, path)
      // 已鉴权请求改为进程内限流，避免高频业务读链路持续写入 Workers KV。
      if (!(await checkRateLimit(request, env, { ...rateLimitPolicy, token }))) {
        return jsonResponse({ ok: false, error: 'Too many requests' }, 429)
      }
    }

    return handleApiRequest(request, env, url, path)
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
          const legacy = await runLegacyRetentionCleanup(env)
          if (legacy.deleted > 0) {
            invalidateAnalysisMemoryCache()
            console.log(`[定时清理] 已删除 ${legacy.deleted} 封超过 ${AUTO_CLEAN_DAYS} 天的旧邮件`)
          }
          return
        } catch (legacyError) {
          logError('Scheduled legacy cleanup failed', legacyError, {
            autoCleanDays: AUTO_CLEAN_DAYS,
          })
          return
        }
      }
      logError('Scheduled cleanup failed', err, { autoCleanDays: AUTO_CLEAN_DAYS })
    }
  },
}
