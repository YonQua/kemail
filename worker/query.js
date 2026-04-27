import { DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT } from './constants.js'
import { MESSAGE_TABLE } from './email-store.js'
import { normalizeText } from './text-core.js'

export function parseMessageLimit(rawValue) {
  const parsed = parseInt(rawValue || '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MESSAGE_LIMIT
  return Math.min(parsed, MAX_MESSAGE_LIMIT)
}

export function parseMessageCursor(rawValue) {
  const text = normalizeText(rawValue)
  if (!text) return null

  const parts = text.split('|')
  if (parts.length !== 2) return null

  const receivedAt = new Date(parts[0])
  const id = parseInt(parts[1] || '', 10)
  if (Number.isNaN(receivedAt.getTime()) || !Number.isFinite(id) || id < 1) {
    return null
  }

  return {
    receivedAt: receivedAt.toISOString(),
    id,
  }
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

function buildMessageFilterConditions(options) {
  const { address, sender, subject, query, start, end } = options
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

  return { conditions, params }
}

function buildCursorCondition(options, conditions, params) {
  const { cursor, sortOrder } = options
  if (!cursor) return

  if (sortOrder === 'ASC') {
    conditions.push('(received_at > ? OR (received_at = ? AND id > ?))')
  } else {
    conditions.push('(received_at < ? OR (received_at = ? AND id < ?))')
  }

  params.push(cursor.receivedAt, cursor.receivedAt, cursor.id)
}

export function buildMessageListQuery(fields, options) {
  const { sortOrder, limit } = options
  const { conditions, params } = buildMessageFilterConditions(options)
  buildCursorCondition(options, conditions, params)
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const sql = `SELECT ${fields} FROM ${MESSAGE_TABLE} ${whereClause} ORDER BY received_at ${sortOrder}, id ${sortOrder} LIMIT ?`
  params.push(limit)
  return { sql, params }
}

export function buildMessageCountQuery(options) {
  const { conditions, params } = buildMessageFilterConditions(options)
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return {
    sql: `SELECT COUNT(*) as total FROM ${MESSAGE_TABLE} ${whereClause}`,
    params,
  }
}

export function buildMessagePageCursor(row) {
  if (!row || typeof row !== 'object') return ''
  const receivedAt = normalizeText(row.received_at)
  const id = parseInt(String(row.id || ''), 10)
  if (!receivedAt || !Number.isFinite(id) || id < 1) return ''
  return `${receivedAt}|${id}`
}

export function normalizeIdList(value) {
  if (!Array.isArray(value)) return []
  const ids = value
    .map((item) => parseInt(String(item || ''), 10))
    .filter((num) => Number.isFinite(num) && num > 0)
  return Array.from(new Set(ids))
}
