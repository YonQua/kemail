import { DEFAULT_EMAIL_LIMIT, MAX_EMAIL_LIMIT } from './constants.js'
import { normalizeText } from './text.js'

export function parseEmailLimit(rawValue) {
  const parsed = parseInt(rawValue || '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_EMAIL_LIMIT
  return Math.min(parsed, MAX_EMAIL_LIMIT)
}

export function parseSinceId(rawValue) {
  const parsed = parseInt(rawValue || '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 0
  return parsed
}

export function parseSortOrder(rawValue) {
  return rawValue === 'asc' ? 'ASC' : 'DESC'
}

export function parseDateParam(rawValue) {
  const text = normalizeText(rawValue)
  if (!text) return ''
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString()
}

export function buildEmailListQuery(fields, options) {
  const { address, sender, subject, query, start, end, sinceId, sortOrder, limit } = options

  const conditions = []
  const params = []

  if (address) {
    conditions.push('recipient = ?')
    params.push(address)
  }

  if (sender) {
    conditions.push('sender LIKE ?')
    params.push(`%${sender}%`)
  }

  if (subject) {
    conditions.push('subject LIKE ?')
    params.push(`%${subject}%`)
  }

  if (query) {
    conditions.push('(sender LIKE ? OR subject LIKE ? OR recipient LIKE ?)')
    const likeValue = `%${query}%`
    params.push(likeValue, likeValue, likeValue)
  }

  if (start) {
    conditions.push('received_at >= ?')
    params.push(start)
  }

  if (end) {
    conditions.push('received_at <= ?')
    params.push(end)
  }

  if (sinceId > 0) {
    conditions.push('id > ?')
    params.push(sinceId)
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const sql = `SELECT ${fields} FROM emails ${whereClause} ORDER BY received_at ${sortOrder} LIMIT ?`
  params.push(limit)
  return { sql, params }
}

export function normalizeIdList(value) {
  if (!Array.isArray(value)) return []
  const ids = value
    .map((item) => parseInt(String(item || ''), 10))
    .filter((num) => Number.isFinite(num) && num > 0)
  return Array.from(new Set(ids))
}
