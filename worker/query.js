import { DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT } from './constants.js'
import { MESSAGE_TABLE } from './email-store.js'
import { normalizeText } from './text-core.js'

export function parseMessageLimit(rawValue) {
  const parsed = parseInt(rawValue || '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MESSAGE_LIMIT
  return Math.min(parsed, MAX_MESSAGE_LIMIT)
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

function buildMessageListConditions(options) {
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

  return { conditions, params, sortOrder, limit }
}

export function buildMessageListQuery(fields, options) {
  const { conditions, params, sortOrder, limit } = buildMessageListConditions(options)
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const sql = `SELECT ${fields} FROM ${MESSAGE_TABLE} ${whereClause} ORDER BY received_at ${sortOrder}, id ${sortOrder} LIMIT ?`
  params.push(limit)
  return { sql, params }
}

export function buildMessageCountQuery(options) {
  const { conditions, params } = buildMessageListConditions(options)
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return {
    sql: `SELECT COUNT(*) as total FROM ${MESSAGE_TABLE} ${whereClause}`,
    params,
  }
}

export function normalizeIdList(value) {
  if (!Array.isArray(value)) return []
  const ids = value
    .map((item) => parseInt(String(item || ''), 10))
    .filter((num) => Number.isFinite(num) && num > 0)
  return Array.from(new Set(ids))
}
