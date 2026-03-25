import {
  DETAIL_REPARSE_MAX_LENGTH,
  DETAIL_SOURCE_MAX_LENGTH,
  DETAIL_TEXT_DIRECT_THRESHOLD,
  EMAIL_DETAIL_FIELDS,
  EMAIL_SOURCE_FIELDS,
  MAX_RICH_DETAIL_MEMORY_CACHE_ENTRIES,
  PARSER_VERSION,
  RICH_DETAIL_MEMORY_CACHE_TTL,
} from './constants.js'
import {
  compactDisplayText,
  extractActionLinksFromRawSource,
  extractActionLinksFromText,
  normalizeAddress,
  normalizeHeaders,
  normalizeText,
  sanitizeEmailHtml,
  truncateText,
} from './text.js'

const richDetailMemoryCaches = new WeakMap()
const fallbackRichDetailMemoryCache = new Map()

function displayBody(row) {
  const resolvedRow = row && typeof row === 'object' ? row : {}
  const readable = resolvedRow.body_readable
  if (readable != null && readable !== '') return compactDisplayText(readable)
  return compactDisplayText(resolvedRow.body != null ? resolvedRow.body : '')
}

function buildEmailPreview(row) {
  return truncateText(displayBody(row))
}

function looksLikeMimeMessage(raw) {
  if (!raw || typeof raw !== 'string') return false

  const headerBoundary = raw.search(/\r?\n\r?\n/)
  if (headerBoundary <= 0) return false

  const head = raw.slice(0, Math.min(headerBoundary, 4000))
  return /^(from|to|subject|date|mime-version|content-type):/im.test(head)
}

function shouldAttemptRichDetail(raw) {
  if (!looksLikeMimeMessage(raw)) return false

  const headerBoundary = raw.search(/\r?\n\r?\n/)
  const head = raw.slice(0, Math.min(headerBoundary > 0 ? headerBoundary : 4000, 4000))
  return /content-type:\s*(text\/html|multipart\/alternative|multipart\/mixed)/i.test(head)
}

function canEnableRichDetail(rawSource, readableText) {
  if (!rawSource) return false
  if (readableText.length > DETAIL_TEXT_DIRECT_THRESHOLD) return false
  if (rawSource.length > DETAIL_REPARSE_MAX_LENGTH) return false
  return shouldAttemptRichDetail(rawSource)
}

function canLoadRawSource(rawSource) {
  return (
    typeof rawSource === 'string' &&
    rawSource.length > 0 &&
    rawSource.length <= DETAIL_SOURCE_MAX_LENGTH
  )
}

function richDetailCacheKey(emailId) {
  return `rich:${PARSER_VERSION}:${String(emailId)}`
}

function getRichDetailMemoryCache(env) {
  const holder = env?.DB || env?.CACHE || env
  if (!holder || (typeof holder !== 'object' && typeof holder !== 'function')) {
    return fallbackRichDetailMemoryCache
  }

  let cache = richDetailMemoryCaches.get(holder)
  if (!cache) {
    cache = new Map()
    richDetailMemoryCaches.set(holder, cache)
  }
  return cache
}

function pruneExpiredRichDetailEntries(cache, now) {
  for (const [key, entry] of cache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      cache.delete(key)
    }
  }
}

function trimRichDetailMemoryCache(cache) {
  while (cache.size >= MAX_RICH_DETAIL_MEMORY_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) break
    cache.delete(oldestKey)
  }
}

function resolveStoredDetailParser(rawSource, readableText, richRequested, richAvailable) {
  if (!rawSource) return 'stored-text'
  if (!richRequested) return 'stored-lite'
  if (richAvailable) return 'stored-fallback'
  if (readableText.length > DETAIL_TEXT_DIRECT_THRESHOLD) return 'stored-long'
  if (rawSource.length > DETAIL_REPARSE_MAX_LENGTH) return 'stored-large'
  return 'stored-text'
}

function buildBaseDetail(
  row,
  { parser = 'stored', richAvailable = false, richEnabled = false } = {}
) {
  const rawSource = typeof row.body === 'string' ? row.body : ''
  const sourceAvailable = canLoadRawSource(rawSource)
  const bodyText = displayBody(row)
  const preview = buildEmailPreview(row)
  const sourceLinks = extractActionLinksFromRawSource(rawSource)
  const actionLinks = sourceLinks.length > 0 ? sourceLinks : extractActionLinksFromText(bodyText)

  return {
    id: row.id,
    recipient: normalizeAddress(row.recipient),
    sender: normalizeText(row.sender) || 'Unknown',
    subject: normalizeText(row.subject) || 'No Subject',
    received_at: row.received_at || '',
    is_read: row.is_read ? 1 : 0,
    is_starred: row.is_starred ? 1 : 0,
    preview,
    body: preview,
    body_text: bodyText,
    body_html: '',
    body_source: '',
    raw_available: false,
    source_available: sourceAvailable,
    rich_available: richAvailable,
    rich_enabled: richEnabled,
    headers: [],
    attachments: [],
    action_links: actionLinks,
    parser,
    parser_version: PARSER_VERSION,
  }
}

function applyRichDetail(baseDetail, richDetail) {
  return {
    ...baseDetail,
    sender: normalizeText(richDetail.sender) || baseDetail.sender,
    subject: normalizeText(richDetail.subject) || baseDetail.subject,
    body_text: compactDisplayText(richDetail.body_text || baseDetail.body_text),
    body_html: sanitizeEmailHtml(richDetail.body_html),
    headers: normalizeHeaders(richDetail.headers),
    attachments: normalizeAttachments(richDetail.attachments),
    action_links: Array.isArray(richDetail.action_links) ? richDetail.action_links : [],
    parser: normalizeText(richDetail.parser) || 'rich-cache',
    parser_version: normalizeText(richDetail.parser_version) || PARSER_VERSION,
    rich_enabled: true,
  }
}

export function buildEmailSource(row) {
  if (!row || typeof row !== 'object') return null

  const rawSource = typeof row.body === 'string' ? row.body : ''
  const sourceAvailable = canLoadRawSource(rawSource)
  return {
    id: row.id,
    source_available: sourceAvailable,
    raw_available: sourceAvailable,
    body_source: sourceAvailable ? rawSource : '',
    parser_version: PARSER_VERSION,
  }
}

export function formatEmailOutput(row) {
  if (!row || typeof row !== 'object') return null

  const recipient = normalizeAddress(row.recipient)
  return {
    ...row,
    recipient,
    body: displayBody(row),
    preview: buildEmailPreview(row),
    is_read: row.is_read ? 1 : 0,
    is_starred: row.is_starred ? 1 : 0,
  }
}

export function formatEmailSummary(row) {
  if (!row || typeof row !== 'object') return null

  return {
    id: row.id,
    recipient: normalizeAddress(row.recipient),
    sender: normalizeText(row.sender) || 'Unknown',
    subject: normalizeText(row.subject) || 'No Subject',
    preview: truncateText(row.preview),
    received_at: row.received_at || '',
    is_read: row.is_read ? 1 : 0,
    is_starred: row.is_starred ? 1 : 0,
  }
}

export async function selectLatestEmailRow(env, recipient) {
  return env.DB.prepare(
    `SELECT ${EMAIL_DETAIL_FIELDS} FROM emails WHERE recipient = ? ORDER BY received_at DESC LIMIT 1`
  )
    .bind(recipient)
    .first()
}

export async function selectEmailRecipientById(env, id) {
  return env.DB.prepare('SELECT recipient FROM emails WHERE id = ?').bind(id).first()
}

export async function selectEmailRowById(env, id) {
  return env.DB.prepare(`SELECT ${EMAIL_DETAIL_FIELDS} FROM emails WHERE id = ?`).bind(id).first()
}

export async function selectEmailSourceRowById(env, id) {
  return env.DB.prepare(`SELECT ${EMAIL_SOURCE_FIELDS} FROM emails WHERE id = ?`).bind(id).first()
}

function buildIdPlaceholders(ids) {
  return ids.map(() => '?').join(', ')
}

export async function selectEmailRecipientsByIds(env, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return []

  const out = await env.DB.prepare(
    `SELECT id, recipient FROM emails WHERE id IN (${buildIdPlaceholders(ids)})`
  )
    .bind(...ids)
    .all()
  return out.results || []
}

export async function deleteEmailById(env, id) {
  return env.DB.prepare('DELETE FROM emails WHERE id = ?').bind(id).run()
}

export async function deleteEmailsByIds(env, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { meta: { changes: 0 } }
  }

  return env.DB.prepare(`DELETE FROM emails WHERE id IN (${buildIdPlaceholders(ids)})`)
    .bind(...ids)
    .run()
}

async function updateEmailFlagByIds(env, column, value, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { meta: { changes: 0 } }
  }

  return env.DB.prepare(`UPDATE emails SET ${column} = ? WHERE id IN (${buildIdPlaceholders(ids)})`)
    .bind(value, ...ids)
    .run()
}

export async function updateEmailReadState(env, ids, readValue) {
  return updateEmailFlagByIds(env, 'is_read', readValue, ids)
}

export async function updateEmailStarState(env, ids, starredValue) {
  return updateEmailFlagByIds(env, 'is_starred', starredValue, ids)
}

async function readRichDetailCache(env, emailId) {
  const cache = getRichDetailMemoryCache(env)
  const now = Date.now()
  const key = richDetailCacheKey(emailId)
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= now) {
    cache.delete(key)
    return null
  }
  return entry.payload
}

async function writeRichDetailCache(env, emailId, detail) {
  if (!detail) return

  const payload = {
    sender: detail.sender,
    subject: detail.subject,
    body_text: detail.body_text,
    body_html: detail.body_html,
    headers: detail.headers,
    attachments: detail.attachments,
    action_links: detail.action_links,
    parser: detail.parser,
    parser_version: detail.parser_version || PARSER_VERSION,
  }

  const cache = getRichDetailMemoryCache(env)
  const now = Date.now()
  pruneExpiredRichDetailEntries(cache, now)
  trimRichDetailMemoryCache(cache)
  cache.set(richDetailCacheKey(emailId), {
    payload,
    expiresAt: now + RICH_DETAIL_MEMORY_CACHE_TTL * 1000,
  })
}

export async function invalidateRichDetailCache(env, emailId) {
  const cache = getRichDetailMemoryCache(env)
  cache.delete(richDetailCacheKey(emailId))
}

export async function buildEmailDetail(env, row, options = {}) {
  if (!row || typeof row !== 'object') return null

  const { rich = false, parseEmailFn = null } = options
  const rawSource = typeof row.body === 'string' ? row.body : ''
  const readableText = displayBody(row)
  const richAvailable = canEnableRichDetail(rawSource, readableText)
  const baseDetail = buildBaseDetail(row, {
    parser: resolveStoredDetailParser(rawSource, readableText, rich, richAvailable),
    richAvailable,
    richEnabled: false,
  })

  if (!rawSource || !rich || !richAvailable) {
    return baseDetail
  }

  const cachedRich = await readRichDetailCache(env, row.id)
  if (cachedRich) {
    return applyRichDetail(baseDetail, cachedRich)
  }

  if (typeof parseEmailFn !== 'function') {
    throw new Error('parseEmailFn is required when rich detail is requested')
  }

  const parsed = await parseEmailFn(rawSource, row.sender, row.subject)
  const richDetail = applyRichDetail(baseDetail, {
    sender: parsed.sender || normalizeText(row.sender) || 'Unknown',
    subject: parsed.subject || normalizeText(row.subject) || 'No Subject',
    body_text: parsed.bodyText || readableText,
    body_html: sanitizeEmailHtml(parsed.bodyHtml),
    headers: parsed.headers,
    attachments: parsed.attachments,
    action_links: parsed.actionLinks || [],
    parser: parsed.parser,
    parser_version: PARSER_VERSION,
  })
  await writeRichDetailCache(env, row.id, richDetail)
  return richDetail
}

function getAttachmentSize(content) {
  if (!content) return 0
  if (typeof content.length === 'number') return content.length
  if (typeof content.byteLength === 'number') return content.byteLength
  return 0
}

export function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return []

  return attachments
    .map((attachment) => {
      if (!attachment || typeof attachment !== 'object') return null
      return {
        filename: normalizeText(attachment.filename),
        content_type: normalizeText(
          attachment.content_type || attachment.mimeType || attachment.mime_type
        ),
        content_id: normalizeText(attachment.content_id || attachment.contentId),
        size: getAttachmentSize(attachment.content),
      }
    })
    .filter(
      (attachment) =>
        attachment && (attachment.filename || attachment.content_type || attachment.size > 0)
    )
}
