import { normalizeAddress, normalizeHeaders, normalizeText } from './text-core.js'

export const MESSAGE_TABLE = 'emails'
export const MESSAGE_SUMMARY_FIELDS =
  'id, recipient, sender, subject, preview_text, received_at, is_read, is_starred'
export const MESSAGE_DETAIL_FIELDS =
  'id, recipient, sender, subject, preview_text, text_body, html_body, raw_source, headers_json, attachments_json, artifacts_json, source_available, source_truncated, parse_status, received_at, is_read, is_starred'

function buildIdPlaceholders(ids) {
  return ids.map(() => '?').join(', ')
}

function parseStoredJson(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed == null ? fallback : parsed
  } catch (_) {
    return fallback
  }
}

function normalizeStoredArtifacts(value) {
  const parsed = parseStoredJson(value, { codes: [], links: [] })
  return {
    codes: Array.isArray(parsed?.codes) ? parsed.codes.filter((item) => typeof item === 'string') : [],
    links: Array.isArray(parsed?.links) ? parsed.links : [],
  }
}

function normalizeStoredAttachments(value) {
  const parsed = parseStoredJson(value, [])
  return Array.isArray(parsed) ? parsed : []
}

function normalizeBooleanFlag(value) {
  return Boolean(Number(value || 0))
}

function buildMessageEnvelope(row, options = {}) {
  if (!row || typeof row !== 'object') return null

  const includeSource = options.includeSource === true
  const includeHeaders = options.includeHeaders !== false
  const includeAttachments = options.includeAttachments !== false
  const sourceAvailable = normalizeBooleanFlag(row.source_available)
  const sourceTruncated = normalizeBooleanFlag(row.source_truncated)
  const headers = includeHeaders ? normalizeHeaders(parseStoredJson(row.headers_json, [])) : []
  const attachments = includeAttachments ? normalizeStoredAttachments(row.attachments_json) : []

  return {
    id: Number(row.id || 0),
    recipient: normalizeAddress(row.recipient),
    sender: normalizeText(row.sender) || 'Unknown',
    subject: normalizeText(row.subject) || 'No Subject',
    received_at: row.received_at || '',
    is_read: normalizeBooleanFlag(row.is_read),
    is_starred: normalizeBooleanFlag(row.is_starred),
    preview: normalizeText(row.preview_text),
    parse_status: normalizeText(row.parse_status) || 'parsed',
    source_available: sourceAvailable,
    source_truncated: sourceTruncated,
    content: {
      text: normalizeText(row.text_body),
      html: typeof row.html_body === 'string' ? row.html_body : '',
      source: includeSource && sourceAvailable ? String(row.raw_source || '') : '',
    },
    artifacts: normalizeStoredArtifacts(row.artifacts_json),
    headers,
    attachments,
  }
}

export function formatMessageSummary(row) {
  if (!row || typeof row !== 'object') return null

  return {
    id: Number(row.id || 0),
    recipient: normalizeAddress(row.recipient),
    sender: normalizeText(row.sender) || 'Unknown',
    subject: normalizeText(row.subject) || 'No Subject',
    preview: normalizeText(row.preview_text),
    received_at: row.received_at || '',
    is_read: normalizeBooleanFlag(row.is_read),
    is_starred: normalizeBooleanFlag(row.is_starred),
  }
}

export function formatMessageDetail(row, options = {}) {
  return buildMessageEnvelope(row, options)
}

export function isMessagesTableMissing(error) {
  return String(error?.message || '').includes(`no such table: ${MESSAGE_TABLE}`)
}

export async function insertMessage(env, message) {
  return env.DB.prepare(
    `INSERT INTO ${MESSAGE_TABLE} (
      recipient,
      sender,
      subject,
      preview_text,
      text_body,
      html_body,
      raw_source,
      headers_json,
      attachments_json,
      artifacts_json,
      source_available,
      source_truncated,
      parse_status,
      received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      message.recipient,
      message.sender,
      message.subject,
      message.preview_text,
      message.text_body,
      message.html_body,
      message.raw_source,
      message.headers_json,
      message.attachments_json,
      message.artifacts_json,
      message.source_available ? 1 : 0,
      message.source_truncated ? 1 : 0,
      message.parse_status,
      message.received_at
    )
    .run()
}

export async function selectLatestMessageRow(env, recipient, options = {}) {
  const unreadOnly = options?.unreadOnly === true
  const sql = unreadOnly
    ? `SELECT ${MESSAGE_DETAIL_FIELDS} FROM ${MESSAGE_TABLE} WHERE recipient = ? AND is_read = 0 ORDER BY received_at DESC, id DESC LIMIT 1`
    : `SELECT ${MESSAGE_DETAIL_FIELDS} FROM ${MESSAGE_TABLE} WHERE recipient = ? ORDER BY received_at DESC, id DESC LIMIT 1`

  return env.DB.prepare(sql).bind(recipient).first()
}

export async function consumeLatestMessageRow(env, recipient, options = {}) {
  const unreadOnly = options?.unreadOnly === true
  const effect = normalizeText(options?.effect || 'none').toLowerCase()
  const selectorWhere = unreadOnly ? 'recipient = ? AND is_read = 0' : 'recipient = ?'

  if (effect === 'none') {
    return selectLatestMessageRow(env, recipient, { unreadOnly })
  }

  if (effect === 'mark_read') {
    return env.DB.prepare(
      `UPDATE ${MESSAGE_TABLE}
       SET is_read = 1
       WHERE id = (
         SELECT id FROM ${MESSAGE_TABLE} WHERE ${selectorWhere} ORDER BY received_at DESC, id DESC LIMIT 1
       )
       RETURNING ${MESSAGE_DETAIL_FIELDS}`
    )
      .bind(recipient)
      .first()
  }

  if (effect === 'delete') {
    return env.DB.prepare(
      `DELETE FROM ${MESSAGE_TABLE}
       WHERE id = (
         SELECT id FROM ${MESSAGE_TABLE} WHERE ${selectorWhere} ORDER BY received_at DESC, id DESC LIMIT 1
       )
       RETURNING ${MESSAGE_DETAIL_FIELDS}`
    )
      .bind(recipient)
      .first()
  }

  return null
}

export async function selectMessageRowById(env, id) {
  return env.DB.prepare(`SELECT ${MESSAGE_DETAIL_FIELDS} FROM ${MESSAGE_TABLE} WHERE id = ?`)
    .bind(id)
    .first()
}

export async function selectMessageRecipientById(env, id) {
  return env.DB.prepare(`SELECT id, recipient FROM ${MESSAGE_TABLE} WHERE id = ?`).bind(id).first()
}

export async function selectMessageRecipientsByIds(env, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return []

  const out = await env.DB.prepare(
    `SELECT id, recipient FROM ${MESSAGE_TABLE} WHERE id IN (${buildIdPlaceholders(ids)})`
  )
    .bind(...ids)
    .all()

  return Array.isArray(out?.results) ? out.results : []
}

export async function deleteMessageById(env, id) {
  return env.DB.prepare(`DELETE FROM ${MESSAGE_TABLE} WHERE id = ?`).bind(id).run()
}

export async function deleteMessagesByIds(env, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { meta: { changes: 0 } }
  }

  return env.DB.prepare(`DELETE FROM ${MESSAGE_TABLE} WHERE id IN (${buildIdPlaceholders(ids)})`)
    .bind(...ids)
    .run()
}

async function updateMessageBooleanState(env, ids, column, value) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { meta: { changes: 0 } }
  }

  return env.DB.prepare(
    `UPDATE ${MESSAGE_TABLE} SET ${column} = ? WHERE id IN (${buildIdPlaceholders(ids)})`
  )
    .bind(value ? 1 : 0, ...ids)
    .run()
}

export async function updateMessageReadState(env, ids, readValue) {
  return updateMessageBooleanState(env, ids, 'is_read', readValue)
}

export async function updateMessageStarState(env, ids, starredValue) {
  return updateMessageBooleanState(env, ids, 'is_starred', starredValue)
}

export function buildPublicMessage(row, options = {}) {
  return buildMessageEnvelope(row, {
    includeSource: options.includeSource === true,
    includeHeaders: true,
    includeAttachments: true,
  })
}

export function buildAdminMessage(row) {
  return buildMessageEnvelope(row, {
    includeSource: true,
    includeHeaders: true,
    includeAttachments: true,
  })
}
