import { compactDisplayText, normalizeText } from './text-core.js'

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

export function buildTextLinkLabel(url) {
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

export function extractContextLabel(rawText) {
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

  if (/[\u3400-\u9fff]/.test(primary) && /\s+/.test(primary)) {
    const words = primary.split(/\s+/).filter(Boolean)
    const tail = words[words.length - 1] || primary
    if (tail.length >= 2) return tail
  }

  return primary
}

export function normalizeActionLinkLabel(label, url) {
  const compacted = compactDisplayText(label)
  if (!compacted) return url

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

export function rankActionLinks(candidates) {
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
