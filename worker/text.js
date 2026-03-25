import { EMAIL_PREVIEW_LIMIT } from './constants.js'

export function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// 统一修整地址字符串，避免空格导致缓存键、入库值与查询条件错位。
export function normalizeAddress(value) {
  return normalizeText(value)
}

export function redactEmailLike(value) {
  const text = normalizeText(value)
  if (!text) return ''

  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  if (!match) return text.length > 12 ? `${text.slice(0, 4)}…(${text.length})` : '[redacted]'

  const [localPart = '', domain = ''] = match[0].split('@')
  const domainParts = domain.split('.').filter(Boolean)
  const domainHead = domainParts.shift() || ''
  const safeLocal =
    localPart.length <= 2 ? `${localPart.slice(0, 1) || '*'}***` : `${localPart.slice(0, 2)}***`
  const safeDomain = domainHead
    ? `${domainHead.slice(0, 2)}***${domainParts.length ? `.${domainParts.join('.')}` : ''}`
    : '***'

  return `${safeLocal}@${safeDomain}`
}

export function redactFreeText(value) {
  return normalizeText(String(value || '')).replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    (match) => redactEmailLike(match)
  )
}

export function redactContextValue(key, value) {
  if (value == null || value === '') return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return `[array:${value.length}]`
  if (typeof value === 'object') return '[object]'

  const text = redactFreeText(value)
  if (!text) return ''
  if (/(token|secret|authorization|cookie|api[_-]?key)/i.test(key)) return '[redacted]'
  if (/(body|html|text|source|mime|raw|header|attachment)/i.test(key))
    return `[redacted:${text.length}]`
  if (/(sender|recipient|address|email|from|to)/i.test(key)) return redactEmailLike(text)
  if (/subject/i.test(key)) return `[redacted:${text.length}]`
  if (/path/i.test(key)) return text
  return text.length > 96 ? `${text.slice(0, 48)}…(${text.length})` : text
}

// 统一输出结构化错误上下文，提升线上排障效率，同时避免把敏感字段直接写入日志。
export function logError(scope, error, context = {}) {
  const filteredContext = Object.fromEntries(
    Object.entries(context)
      .filter(([, value]) => value != null && value !== '')
      .map(([key, value]) => [key, redactContextValue(key, value)])
  )

  console.error(`[${scope}]`, {
    message: redactFreeText(error instanceof Error ? error.message : String(error)),
    stack:
      error instanceof Error && typeof error.stack === 'string'
        ? error.stack
            .split('\n')
            .slice(0, 6)
            .map((line) => redactFreeText(line))
            .join('\n')
        : undefined,
    context: filteredContext,
  })
}

export function stripHtml(html) {
  if (!html || typeof html !== 'string') return ''
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
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

const LOW_SIGNAL_LINK_PATTERNS = [
  /\bread\s*more\b/i,
  /\bunsubscribe\b/i,
  /\bprivacy\b/i,
  /\bterms?\b/i,
  /\bcookie\b/i,
  /\bhelp\b/i,
  /\bsupport\b/i,
  /\bcontact\b/i,
  /\bfaq\b/i,
  /\bmanage\s+(?:preferences?|subscription)/i,
  /\bview\s+in\s+browser\b/i,
  /\bposted\b/i,
  /\banswered\b/i,
  /\bupdated\b/i,
  /阅读更多|查看更多|退订|取消订阅|隐私|条款|帮助|支持|联系我们|联系|常见问题|偏好设置|已发布|已回答|已更新/,
]
const HIGH_SIGNAL_LINK_PATTERNS = [
  /\b(join|accept|verify|confirm|activate|reset|signin|sign\s*in|login|open|continue|start|pay|download|register|apply|invite)\b/i,
  /加入|接受|验证|确认|激活|重置|登录|打开|继续|开始|支付|下载|注册|申请|邀请/,
]
const ACTION_LINK_SCORE_MIN = 9
const ACTION_LINK_SCORE_KEEP = 12

function hasAnyPattern(text, patterns) {
  const value = String(text || '')
  if (!value) return false
  return patterns.some((pattern) => pattern.test(value))
}

function parseUrlSafe(url) {
  try {
    return new URL(String(url || ''))
  } catch (_) {
    return null
  }
}

function rankActionLinks(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return []

  const deduped = []
  const seen = new Set()
  for (const candidate of candidates) {
    const url = normalizeText(candidate?.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    deduped.push({
      label: normalizeText(candidate?.label),
      url,
      order: Number.isFinite(candidate?.order) ? candidate.order : deduped.length,
      positionRatio:
        Number.isFinite(candidate?.positionRatio) && candidate.positionRatio >= 0
          ? candidate.positionRatio
          : 1,
      context: normalizeText(candidate?.context || ''),
      isButton: Boolean(candidate?.isButton),
    })
  }
  if (deduped.length === 0) return []

  const hostCounts = new Map()
  const labelCounts = new Map()
  deduped.forEach((item) => {
    if (item.label) {
      labelCounts.set(item.label, (labelCounts.get(item.label) || 0) + 1)
    }
    const parsed = parseUrlSafe(item.url)
    const host = parsed ? parsed.host.toLowerCase() : ''
    if (host) hostCounts.set(host, (hostCounts.get(host) || 0) + 1)
  })

  const scored = deduped
    .map((item) => {
      const parsed = parseUrlSafe(item.url)
      const host = parsed ? parsed.host.toLowerCase() : ''
      const pathname = parsed ? parsed.pathname || '' : ''
      const search = parsed ? parsed.search || '' : ''
      const labelLength = item.label.length
      const digitCount = (item.label.match(/\d/g) || []).length

      let score = 18
      score += Math.max(0, 10 - item.positionRatio * 14)
      if (item.isButton) score += 7

      if (labelLength >= 2 && labelLength <= 24) score += 5
      else if (labelLength <= 40) score += 2
      else score -= 3

      if (/https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,}/i.test(item.label)) score -= 4
      if (labelLength > 0 && digitCount / labelLength > 0.45) score -= 3
      if (!/[\u3400-\u9fffA-Za-z0-9]/.test(item.label)) score -= 5

      if (hasAnyPattern(item.label, HIGH_SIGNAL_LINK_PATTERNS)) score += 6
      if (hasAnyPattern(item.context, HIGH_SIGNAL_LINK_PATTERNS)) score += 3

      if (hasAnyPattern(item.label, LOW_SIGNAL_LINK_PATTERNS)) score -= 12
      if (hasAnyPattern(item.context, LOW_SIGNAL_LINK_PATTERNS)) score -= 6
      if (hasAnyPattern(`${host}${pathname}`, LOW_SIGNAL_LINK_PATTERNS)) score -= 8

      if (search.length >= 12) score += 2
      if (/[A-Za-z0-9_-]{18,}/.test(item.url)) score += 2

      const hostDupCount = host ? hostCounts.get(host) || 0 : 0
      if (hostDupCount > 4) score -= (hostDupCount - 4) * 1.5

      const labelDupCount = item.label ? labelCounts.get(item.label) || 0 : 0
      if (labelDupCount > 1) score -= (labelDupCount - 1) * 2

      score -= item.order * 0.1

      return {
        ...item,
        score,
      }
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)

  const selected = scored
    .filter((item) => item.score >= ACTION_LINK_SCORE_MIN)
    .slice(0, ACTION_LINK_SCORE_KEEP)
  const fallback = scored.slice(0, Math.min(6, scored.length))
  const output = (selected.length >= 2 ? selected : fallback).map((item) => ({
    label: item.label || buildTextLinkLabel(item.url),
    url: item.url,
    score: Number(item.score.toFixed(2)),
  }))

  return output
}

function normalizeActionLinkLabel(label, url) {
  const compacted = compactDisplayText(label)
  if (!compacted) return url

  // 通用策略：按结构分段（换行/句读/中日韩文本空格）后做可读性评分，避免硬编码业务短语。
  const candidates = []
  compacted
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, lineIndex) => {
      const sentenceParts = line
        .split(/[。！？!?；;]/)
        .map((part) => part.trim())
        .filter(Boolean)
      const baseParts = sentenceParts.length ? sentenceParts : [line]
      baseParts.forEach((part, partIndex) => {
        candidates.push({ text: part, lineIndex, partIndex, tokenIndex: 0 })
        if (/[\u3400-\u9fff]/.test(part) && /\s+/.test(part)) {
          part
            .split(/\s+/)
            .map((token) => token.trim())
            .filter(Boolean)
            .forEach((token, tokenIndex) => {
              candidates.push({ text: token, lineIndex, partIndex, tokenIndex: tokenIndex + 1 })
            })
        }
      })
    })

  let bestText = ''
  let bestScore = Number.NEGATIVE_INFINITY
  for (const candidate of candidates) {
    const text = candidate.text.replace(/[：:，,。！？!?;；、]+$/g, '').trim()
    if (text.length < 2) continue
    let score = 0
    if (/https?:\/\//i.test(text) || /@/.test(text)) score -= 6
    if (!/[\u3400-\u9fffA-Za-z0-9]/.test(text)) score -= 4
    if (text.length <= 18) score += 4
    else if (text.length <= 28) score += 2
    else if (text.length <= 40) score += 1
    else score -= 2

    const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length
    const cjkRatio = cjkCount / text.length
    if (cjkRatio > 0.6 && !/\s/.test(text)) score += 2
    if (cjkRatio > 0.6 && /\s/.test(text)) score -= 1
    score -= candidate.lineIndex * 0.6
    score -= candidate.partIndex * 0.2
    score -= candidate.tokenIndex * 0.1

    if (score > bestScore) {
      bestScore = score
      bestText = text
    }
  }

  if (!bestText) bestText = compacted.split('\n')[0] || ''
  if (!bestText) return url
  if (bestText.length > 24) return bestText.slice(0, 24).trimEnd() + '…'
  return bestText
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

export function extractActionLinks(html) {
  if (!html || typeof html !== 'string') return []

  const candidates = []
  const anchorRegex = /<a\b([^>]*?)href=(['"])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi
  const totalLength = html.length || 1
  let match = null

  while ((match = anchorRegex.exec(html))) {
    const url = normalizeHtmlHref(match[3])
    if (!url) continue

    const rawLabel = compactDisplayText(stripHtml(match[5] || ''))
    const label = normalizeActionLinkLabel(rawLabel, url)
    const attrs = `${match[1] || ''} ${match[4] || ''}`
    const isButton =
      /\b(btn|button)\b/i.test(attrs) || /background-color|role\s*=\s*["']?button/i.test(attrs)
    const context = compactDisplayText(
      stripHtml(
        decodeBasicEntities(
          html.slice(Math.max(0, match.index - 180), match.index + match[0].length + 180)
        )
      )
    )
    candidates.push({
      label,
      url,
      order: candidates.length,
      positionRatio: Math.min(1, match.index / totalLength),
      context,
      isButton,
    })
  }

  return rankActionLinks(candidates)
}

function tryDecodeBase64Url(input) {
  const raw = String(input || '').trim()
  if (!raw || !/^[A-Za-z0-9\-_]+=*$/.test(raw)) return ''
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    if (typeof atob === 'function') return atob(padded)
    return Buffer.from(padded, 'base64').toString('utf8')
  } catch (_) {
    return ''
  }
}

function firstHttpUrlInText(input) {
  const text = String(input || '')
  const match = text.match(/https?:\/\/[^\s"'<>\\]+/i)
  return match ? match[0] : ''
}

function findUrlInPayload(value, depth = 0) {
  if (depth > 5 || value == null) return ''

  if (typeof value === 'string') {
    const raw = value.trim()
    if (!raw) return ''
    if (/^https?:\/\//i.test(raw)) return raw

    const directUrl = firstHttpUrlInText(raw.replace(/\\\//g, '/'))
    if (directUrl) return directUrl

    const decodedPercent = (() => {
      try {
        return decodeURIComponent(raw)
      } catch (_) {
        return ''
      }
    })()
    if (decodedPercent && decodedPercent !== raw) {
      const nested = findUrlInPayload(decodedPercent, depth + 1)
      if (nested) return nested
    }

    const decodedBase64 = tryDecodeBase64Url(raw)
    if (decodedBase64) {
      const nested = findUrlInPayload(decodedBase64, depth + 1)
      if (nested) return nested
    }

    try {
      const parsed = JSON.parse(raw)
      const nested = findUrlInPayload(parsed, depth + 1)
      if (nested) return nested
    } catch (_) {}

    return ''
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findUrlInPayload(item, depth + 1)
      if (nested) return nested
    }
    return ''
  }

  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const nested = findUrlInPayload(value[key], depth + 1)
      if (nested) return nested
    }
  }

  return ''
}

function tryUnwrapTrackedUrl(url) {
  try {
    const parsed = new URL(url)
    for (const [, value] of parsed.searchParams.entries()) {
      const unwrapped = findUrlInPayload(value)
      if (!unwrapped) continue
      try {
        return new URL(unwrapped).href
      } catch (_) {}
    }

    return url
  } catch (_) {
    return url
  }
}

function normalizeHtmlHref(rawHref) {
  const decoded = decodeBasicEntities(String(rawHref || ''))
    .replace(/=\r?\n/g, '')
    .replace(/\s+/g, '')
    .trim()
  if (!decoded || !/^https?:\/\//i.test(decoded)) return ''
  const repaired = decoded.replace(/([?&][^=&?#\s]+)3D(?=[^&]*)/g, '$1=')

  try {
    return tryUnwrapTrackedUrl(new URL(repaired).href)
  } catch (_) {
    return ''
  }
}

function decodeQuotedPrintableForLinkExtraction(rawSource) {
  const input = String(rawSource || '')
  if (!input) return ''
  if (!/=\r?\n|=[A-Fa-f0-9]{2}/.test(input)) return input

  const bytes = []
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]

    if (ch === '=') {
      const next = input[i + 1] || ''
      const nextNext = input[i + 2] || ''

      if (next === '\r' && nextNext === '\n') {
        i += 2
        continue
      }
      if (next === '\n') {
        i += 1
        continue
      }
      if (/^[A-Fa-f0-9]$/.test(next) && /^[A-Fa-f0-9]$/.test(nextNext)) {
        bytes.push(Number.parseInt(`${next}${nextNext}`, 16))
        i += 2
        continue
      }
    }

    const codePoint = input.codePointAt(i)
    if (codePoint == null) continue
    if (codePoint <= 0xff) {
      bytes.push(codePoint)
    } else {
      bytes.push(...new TextEncoder().encode(String.fromCodePoint(codePoint)))
    }
    if (codePoint > 0xffff) i += 1
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes))
}

export function extractActionLinksFromRawSource(rawSource) {
  if (!rawSource || typeof rawSource !== 'string') return []

  const source = decodeQuotedPrintableForLinkExtraction(rawSource)
  const bodyMatch = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  const content = bodyMatch ? bodyMatch[1] : source
  const totalLength = content.length || 1
  const candidates = []
  const anchorRegex = /<a\b([^>]*?)href=(['"])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi
  let match = null

  while ((match = anchorRegex.exec(content))) {
    const url = normalizeHtmlHref(match[3])
    if (!url) continue

    const rawLabel = compactDisplayText(stripHtml(decodeBasicEntities(match[5] || '')))
    const label = normalizeActionLinkLabel(rawLabel, url)
    const attrs = `${match[1] || ''} ${match[4] || ''}`
    const isButton =
      /\b(btn|button)\b/i.test(attrs) || /background-color|role\s*=\s*["']?button/i.test(attrs)
    const context = compactDisplayText(
      stripHtml(
        decodeBasicEntities(
          content.slice(Math.max(0, match.index - 180), match.index + match[0].length + 180)
        )
      )
    )
    candidates.push({
      label,
      url,
      order: candidates.length,
      positionRatio: Math.min(1, match.index / totalLength),
      context,
      isButton,
    })
  }

  return rankActionLinks(candidates)
}

function normalizeTextLinkUrl(rawToken) {
  let token = normalizeText(rawToken)
  if (!token) return ''
  token = token
    .replace(/^[<([{'"`]+/, '')
    .replace(/[>)\]}'"`,.;!?，。！？；：]+$/g, '')
    .trim()
  if (!token || token.includes('@')) return ''

  if (/^www\./i.test(token)) {
    token = `https://${token}`
  } else if (!/^https?:\/\//i.test(token)) {
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?$/i.test(token)) return ''
    token = `https://${token}`
  }

  try {
    return tryUnwrapTrackedUrl(new URL(token).href)
  } catch (_) {
    return ''
  }
}

function buildTextLinkLabel(url) {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./i, '')
    if (!host) return url
    const path = parsed.pathname.replace(/\/{2,}/g, '/')
    if (!path || path === '/') return host
    const shortPath = path.length > 20 ? `${path.slice(0, 20)}…` : path
    return `${host}${shortPath}`
  } catch (_) {
    return url
  }
}

function extractContextLabel(rawText) {
  const text = compactDisplayText(rawText)
  if (!text) return ''

  const clauses = text
    .replace(/[<>]+/g, ' ')
    .split(/[，,。！？!?；;：:]/)
    .map((item) => item.trim())
    .filter(Boolean)
  let primary = clauses[clauses.length - 1] || text
  primary = primary.replace(/^[\s\-–—|>]+|[\s\-–—|<]+$/g, '').trim()
  if (!primary) return ''
  if (!/[\u3400-\u9fffA-Za-z0-9]/.test(primary)) return ''

  // CJK 文本里出现空格通常是模板拼接，优先取尾部词组（如“请 与我们联系” -> “与我们联系”）。
  if (/[\u3400-\u9fff]/.test(primary) && /\s+/.test(primary)) {
    const words = primary.split(/\s+/).filter(Boolean)
    const tail = words[words.length - 1] || primary
    if (tail.length >= 2) return tail
  }

  return primary
}

export function extractActionLinksFromText(text) {
  const compacted = compactDisplayText(text)
  if (!compacted) return []

  const candidates = []
  const seen = new Set()
  const lines = compacted
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const totalLines = lines.length || 1

  const urlPattern =
    /<\s*(https?:\/\/[^\s>]+)\s*>|((?:https?:\/\/|www\.)[^\s<>()]+)|((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>()]+)?)/gi

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let match = null

    while ((match = urlPattern.exec(line))) {
      const rawToken = match[1] || match[2] || match[3] || ''
      const startIndex = match.index
      const charBefore = startIndex > 0 ? line[startIndex - 1] : ''
      if (charBefore === '@') continue
      const url = normalizeTextLinkUrl(rawToken)
      if (!url || seen.has(url)) continue

      const before = line.slice(0, match.index).trim()
      const after = line.slice(match.index + match[0].length).trim()
      const inlineBeforeLabel = extractContextLabel(before)
      const inlineAfterLabel = extractContextLabel(after)
      const inlineLabel = inlineBeforeLabel || inlineAfterLabel
      const previousLineLabel = !inlineLabel && i > 0 ? extractContextLabel(lines[i - 1]) : ''
      const resolvedLabel =
        normalizeActionLinkLabel(inlineLabel || previousLineLabel, url) || buildTextLinkLabel(url)

      const context = [lines[i - 1] || '', line, lines[i + 1] || ''].filter(Boolean).join(' ')
      candidates.push({
        label: resolvedLabel,
        url,
        order: candidates.length,
        positionRatio: Math.min(1, i / totalLines),
        context,
        isButton: false,
      })
      seen.add(url)
    }
  }

  return rankActionLinks(candidates)
}

export function appendActionLinks(text, actionLinks) {
  const compacted = compactDisplayText(text)
  if (!Array.isArray(actionLinks) || actionLinks.length === 0) return compacted

  const missingLinks = actionLinks.filter((link) => !compacted.includes(link.url))
  if (missingLinks.length === 0) return compacted

  const suffix =
    '\n\n可用链接：\n' +
    missingLinks
      .map((link) => {
        const label = normalizeText(link.label)
        return label && label !== link.url ? `- ${label}: ${link.url}` : `- ${link.url}`
      })
      .join('\n')

  return compactDisplayText(compacted + suffix)
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
