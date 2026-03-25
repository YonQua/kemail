import { EMAIL_PREVIEW_LIMIT } from './constants.js'

const HTML_BLOCK_BREAK_TAG_PATTERN =
  /<\/?(?:address|article|aside|blockquote|caption|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g

export function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// 统一修整地址字符串，避免空格导致缓存键、入库值与查询条件错位。
export function normalizeAddress(value) {
  return normalizeText(value)
}

export function stripHtml(html) {
  if (!html || typeof html !== 'string') return ''
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(HTML_COMMENT_PATTERN, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(HTML_BLOCK_BREAK_TAG_PATTERN, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function compactDisplayText(value) {
  if (typeof value !== 'string') return ''

  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())

  const compacted = []
  let previousBlank = false

  for (const line of normalized) {
    const isBlank = line.length === 0
    if (isBlank) {
      if (!previousBlank && compacted.length > 0) {
        compacted.push('')
      }
      previousBlank = true
      continue
    }

    compacted.push(line)
    previousBlank = false
  }

  while (compacted[0] === '') compacted.shift()
  while (compacted[compacted.length - 1] === '') compacted.pop()

  return compacted.join('\n')
}

export function appendReadableNotice(baseText, notice) {
  const resolvedNotice = normalizeText(notice)
  if (!resolvedNotice) return compactDisplayText(baseText)

  const compacted = compactDisplayText(baseText)
  return compacted ? `${compacted}\n\n${resolvedNotice}` : resolvedNotice
}

export function decodeBasicEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

export function truncateText(value, maxLength = EMAIL_PREVIEW_LIMIT) {
  const text = compactDisplayText(value)
  if (!text) return ''
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength).trimEnd() + '…'
}

export function sanitizeEmailHtml(html) {
  if (!html || typeof html !== 'string') return ''
  const withoutDangerousTags = html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<(iframe|object|embed|base|meta|form)[\s\S]*?>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(iframe|object|embed|base|meta|form)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/@import[^;]+;/gi, '')
    .replace(/url\((?!['"]?(?:data|cid|https?):)[^)]+\)/gi, 'none')
    .replace(/\s+(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, ' $1="#"')

  return withoutDangerousTags
    .replace(/\s+(src|srcset|poster)=\s*(['"])([\s\S]*?)\2/gi, (_match, attr, quote, value) => {
      const trimmed = String(value || '').trim()
      if (/^(cid:|data:|https:)/i.test(trimmed)) {
        return ` ${attr}=${quote}${trimmed}${quote}`
      }
      return ''
    })
    .replace(/\s+(src|srcset|poster)=\s*([^\s>]+)/gi, (_match, attr, value) => {
      const trimmed = String(value || '').trim()
      if (/^(cid:|data:|https:)/i.test(trimmed)) {
        return ` ${attr}=${trimmed}`
      }
      return ''
    })
}

export function normalizeHeaders(headers) {
  if (!headers) return []

  if (Array.isArray(headers)) {
    return headers
      .map((header) => {
        if (Array.isArray(header) && header.length >= 2) {
          return {
            key: normalizeText(header[0]),
            value: normalizeText(header[1]),
          }
        }

        if (header && typeof header === 'object') {
          return {
            key: normalizeText(header.key || header.name),
            value: normalizeText(header.value),
          }
        }

        return null
      })
      .filter((item) => item && item.key)
  }

  if (typeof headers.entries === 'function') {
    return Array.from(headers.entries())
      .map(([key, value]) => ({
        key: normalizeText(key),
        value: normalizeText(value),
      }))
      .filter((item) => item.key)
  }

  if (typeof headers === 'object') {
    return Object.entries(headers)
      .map(([key, value]) => ({
        key: normalizeText(key),
        value: normalizeText(value),
      }))
      .filter((item) => item.key)
  }

  return []
}
