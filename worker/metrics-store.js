import { AUTO_CLEAN_DAYS, DAY_IN_MS } from './constants.js'
import { normalizeText } from './text-core.js'

const COMMON_SECOND_LEVEL_DOMAINS = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org'])

function toUtcDay(value) {
  const resolved =
    value instanceof Date ? value : typeof value === 'string' ? new Date(value) : new Date()
  if (Number.isNaN(resolved.getTime())) {
    return new Date().toISOString().slice(0, 10)
  }
  return resolved.toISOString().slice(0, 10)
}

function toIsoString(value) {
  const resolved =
    value instanceof Date ? value : typeof value === 'string' ? new Date(value) : new Date()
  if (Number.isNaN(resolved.getTime())) {
    return new Date().toISOString()
  }
  return resolved.toISOString()
}

function extractSenderEmail(value) {
  const text = normalizeText(value)
  if (!text) return ''

  const angleMatch = text.match(/<([^>]+)>/)
  if (angleMatch?.[1]) {
    return normalizeText(angleMatch[1]).toLowerCase()
  }

  const directMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return directMatch ? normalizeText(directMatch[0]).toLowerCase() : ''
}

function extractRegistrableDomain(email) {
  const normalizedEmail = normalizeText(email).toLowerCase()
  if (!normalizedEmail.includes('@')) return ''

  const [, domain = ''] = normalizedEmail.split('@')
  const parts = domain.split('.').filter(Boolean)
  if (parts.length <= 2) return domain

  const last = parts[parts.length - 1]
  const secondLast = parts[parts.length - 2]
  if (last.length === 2 && COMMON_SECOND_LEVEL_DOMAINS.has(secondLast)) {
    return parts.slice(-3).join('.')
  }
  return parts.slice(-2).join('.')
}

function normalizeMetricSender(value) {
  const email = extractSenderEmail(value)
  const registrableDomain = extractRegistrableDomain(email)
  if (registrableDomain) return registrableDomain
  return normalizeText(value) || 'Unknown'
}

function normalizeCount(row, key = 'total') {
  return Number(row?.[key] || 0)
}

export function buildUtcDayRange(days) {
  const now = new Date()
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const start = new Date(todayStart.getTime() - (days - 1) * DAY_IN_MS)
  return {
    nowIso: now.toISOString(),
    todayDay: todayStart.toISOString().slice(0, 10),
    startDay: start.toISOString().slice(0, 10),
    startIso: start.toISOString(),
    retentionDays: AUTO_CLEAN_DAYS,
    dayBucketTimezone: 'UTC',
  }
}

// 历史统计只在收件时递增，删除与定时清理不会回写这里，避免改写历史事实。
export async function incrementReceivedMetrics(env, { receivedAt, sender }) {
  const metricDay = toUtcDay(receivedAt)
  const updatedAt = toIsoString(receivedAt)
  const normalizedSender = normalizeMetricSender(sender)

  await env.DB.prepare(
    `INSERT INTO mail_daily_metrics (day, received_total, updated_at)
     VALUES (?, 1, ?)
     ON CONFLICT(day) DO UPDATE SET
       received_total = mail_daily_metrics.received_total + 1,
       updated_at = excluded.updated_at`
  )
    .bind(metricDay, updatedAt)
    .run()

  await env.DB.prepare(
    `INSERT INTO mail_sender_daily_metrics (day, sender, received_total, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(day, sender) DO UPDATE SET
       received_total = mail_sender_daily_metrics.received_total + 1,
       updated_at = excluded.updated_at`
  )
    .bind(metricDay, normalizedSender, updatedAt)
    .run()
}

export async function readCurrentMailboxSummary(env) {
  const currentTotalRow = await env.DB.prepare('SELECT COUNT(*) as total FROM emails').first()
  const unreadRow = await env.DB.prepare(
    'SELECT COUNT(*) as total FROM emails WHERE is_read = 0'
  ).first()
  const starredRow = await env.DB.prepare(
    'SELECT COUNT(*) as total FROM emails WHERE is_starred = 1'
  ).first()

  return {
    currentTotal: normalizeCount(currentTotalRow),
    unread: normalizeCount(unreadRow),
    starred: normalizeCount(starredRow),
  }
}

export async function readHistoricalSummary(env, { todayDay, startDay }) {
  const totalReceivedRow = await env.DB.prepare(
    'SELECT COALESCE(SUM(received_total), 0) as total FROM mail_daily_metrics'
  ).first()
  const todayReceivedRow = await env.DB.prepare(
    'SELECT received_total as total FROM mail_daily_metrics WHERE day = ?'
  )
    .bind(todayDay)
    .first()
  const last7DaysRow = await env.DB.prepare(
    'SELECT COALESCE(SUM(received_total), 0) as total FROM mail_daily_metrics WHERE day >= ? AND day <= ?'
  )
    .bind(startDay, todayDay)
    .first()
  const historyStartRow = await env.DB.prepare(
    'SELECT day FROM mail_daily_metrics ORDER BY day ASC LIMIT 1'
  ).first()

  return {
    totalReceived: normalizeCount(totalReceivedRow),
    todayReceived: normalizeCount(todayReceivedRow),
    last7DaysReceived: normalizeCount(last7DaysRow),
    historyStartDay: normalizeText(historyStartRow?.day),
  }
}

export async function readHistoricalTrend(env, { startDay, todayDay, days }) {
  const out = await env.DB.prepare(
    'SELECT day, received_total as total FROM mail_daily_metrics WHERE day >= ? AND day <= ? ORDER BY day ASC'
  )
    .bind(startDay, todayDay)
    .all()
  const rows = out.results || []
  const totalsByDay = new Map(rows.map((row) => [row.day, Number(row.total || 0)]))
  const series = []

  for (let index = 0; index < days; index += 1) {
    const day = new Date(`${startDay}T00:00:00.000Z`)
    day.setUTCDate(day.getUTCDate() + index)
    const normalizedDay = day.toISOString().slice(0, 10)
    series.push({
      day: normalizedDay,
      total: totalsByDay.get(normalizedDay) || 0,
    })
  }

  return series
}

export async function readHistoricalTopSenders(env, { startDay, todayDay, limit }) {
  const out = await env.DB.prepare(
    `SELECT sender, COALESCE(SUM(received_total), 0) as total
     FROM mail_sender_daily_metrics
     WHERE day >= ? AND day <= ?
     GROUP BY sender
     ORDER BY total DESC, sender ASC`
  )
    .bind(startDay, todayDay)
    .all()

  const mergedSenders = new Map()
  for (const row of out.results || []) {
    const senderBucket = normalizeMetricSender(row.sender)
    const currentTotal = mergedSenders.get(senderBucket) || 0
    mergedSenders.set(senderBucket, currentTotal + Number(row.total || 0))
  }

  return Array.from(mergedSenders.entries())
    .map(([sender, total]) => ({ sender, total }))
    .sort((left, right) => {
      if (right.total !== left.total) return right.total - left.total
      return left.sender.localeCompare(right.sender)
    })
    .slice(0, limit)
}
