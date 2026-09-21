import { ANALYSIS_CACHE_TTL } from './constants.js'
import { analysisCacheHeaders, jsonResponse } from './http.js'
import {
  GovernanceTablesMissingError,
  readEffectiveRetentionDays,
} from './mail-governance-store.js'
import {
  buildUtcDayRange,
  readCurrentMailboxSummary,
  readHistoricalSummary,
  readHistoricalTopSenders,
  readHistoricalTrend,
} from './metrics-store.js'
import { parseMessageLimit } from './query.js'
import { logError } from './text-logging.js'

// A short-lived UI cache should not grow with the number of parameter combinations.
const MAX_ANALYSIS_CACHE_ENTRIES = 128
const analysisResponseCache = new Map()
let analysisCacheGeneration = 0

function readAnalysisMemoryCache(cacheKey) {
  const cached = analysisResponseCache.get(cacheKey)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    analysisResponseCache.delete(cacheKey)
    return null
  }
  return cached.payload
}

function writeAnalysisMemoryCache(cacheKey, payload) {
  const now = Date.now()
  for (const [key, cached] of analysisResponseCache) {
    if (cached.expiresAt <= now) analysisResponseCache.delete(key)
  }
  analysisResponseCache.delete(cacheKey)
  if (analysisResponseCache.size >= MAX_ANALYSIS_CACHE_ENTRIES) {
    analysisResponseCache.delete(analysisResponseCache.keys().next().value)
  }
  analysisResponseCache.set(cacheKey, {
    payload,
    expiresAt: now + ANALYSIS_CACHE_TTL * 1000,
  })
}

function parseAnalysisDays(url, defaultDays = 14) {
  const daysRaw = parseInt(url.searchParams.get('days') || '', 10)
  return Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 90) : defaultDays
}

function isMissingMetricsTableError(error) {
  const message = String(error?.message || error || '')
  return message.includes('mail_daily_metrics') || message.includes('mail_sender_daily_metrics')
}

export function invalidateAnalysisMemoryCache() {
  analysisCacheGeneration += 1
  analysisResponseCache.clear()
}

async function respondWithAnalysisCache(cacheKey, producer) {
  const cachedPayload = readAnalysisMemoryCache(cacheKey)
  if (cachedPayload) {
    return jsonResponse(cachedPayload, 200, analysisCacheHeaders())
  }

  const generation = analysisCacheGeneration
  const payload = await producer()
  // A query started before invalidation must not repopulate the cache afterwards.
  if (generation === analysisCacheGeneration) {
    writeAnalysisMemoryCache(cacheKey, payload)
  }
  return jsonResponse(payload, 200, analysisCacheHeaders())
}

export async function handleAnalysisSummaryRequest(url, env, path) {
  try {
    return await respondWithAnalysisCache('summary', async () => {
      const currentSummary = await readCurrentMailboxSummary(env)
      let effectiveRetentionDays = -1
      try {
        effectiveRetentionDays = await readEffectiveRetentionDays(env)
      } catch (error) {
        if (!(error instanceof GovernanceTablesMissingError)) {
          throw error
        }
      }
      const historyWindow = buildUtcDayRange(
        7,
        effectiveRetentionDays >= 0 ? effectiveRetentionDays : undefined
      )
      const historicalSummary = await readHistoricalSummary(env, {
        todayDay: historyWindow.todayDay,
        startDay: historyWindow.startDay,
      })

      return {
        ok: true,
        summary: {
          currentTotal: currentSummary.currentTotal,
          totalReceived: historicalSummary.totalReceived,
          todayReceived: historicalSummary.todayReceived,
          last7DaysReceived: historicalSummary.last7DaysReceived,
          unread: currentSummary.unread,
          starred: currentSummary.starred,
          historyStartDay: historicalSummary.historyStartDay,
          dayBucketTimezone: historyWindow.dayBucketTimezone,
          retentionDays: historyWindow.retentionDays,
          start: historyWindow.startIso,
          end: historyWindow.nowIso,
        },
      }
    })
  } catch (error) {
    if (isMissingMetricsTableError(error)) {
      return jsonResponse(
        {
          ok: false,
          error: 'Metrics tables missing, run the D1 migration first',
          code: 'METRICS_MIGRATION_REQUIRED',
        },
        503
      )
    }
    logError('Analysis summary failed', error, { path })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleAnalysisTrendRequest(url, env, path) {
  const days = parseAnalysisDays(url, 14)

  try {
    return await respondWithAnalysisCache(`trend:${days}`, async () => {
      const range = buildUtcDayRange(days)
      const series = await readHistoricalTrend(env, {
        startDay: range.startDay,
        todayDay: range.todayDay,
        days,
      })

      return {
        ok: true,
        trend: {
          days,
          start: range.startIso,
          end: range.nowIso,
          dayBucketTimezone: range.dayBucketTimezone,
          series,
        },
      }
    })
  } catch (error) {
    if (isMissingMetricsTableError(error)) {
      return jsonResponse(
        {
          ok: false,
          error: 'Metrics tables missing, run the D1 migration first',
          code: 'METRICS_MIGRATION_REQUIRED',
        },
        503
      )
    }
    logError('Analysis trend failed', error, { path, days })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}

export async function handleAnalysisSendersRequest(url, env, path) {
  const limit = parseMessageLimit(url.searchParams.get('limit'))
  const days = parseAnalysisDays(url, 14)

  try {
    return await respondWithAnalysisCache(`senders:${days}:${limit}`, async () => {
      const range = buildUtcDayRange(days)
      const senders = await readHistoricalTopSenders(env, {
        startDay: range.startDay,
        todayDay: range.todayDay,
        limit,
      })

      return {
        ok: true,
        days,
        start: range.startIso,
        end: range.nowIso,
        dayBucketTimezone: range.dayBucketTimezone,
        senders,
      }
    })
  } catch (error) {
    if (isMissingMetricsTableError(error)) {
      return jsonResponse(
        {
          ok: false,
          error: 'Metrics tables missing, run the D1 migration first',
          code: 'METRICS_MIGRATION_REQUIRED',
        },
        503
      )
    }
    logError('Analysis senders failed', error, { path, limit, days })
    return jsonResponse({ ok: false, error: 'Internal error' }, 500)
  }
}
