import { compactDisplayText, decodeBasicEntities, stripHtml } from './text-core.js'
import {
  buildTextLinkLabel,
  extractContextLabel,
  normalizeActionLinkLabel,
  rankActionLinks,
} from './text-link-label.js'
import {
  decodeQuotedPrintableForLinkExtraction,
  normalizeHtmlHref,
  normalizeTextLinkUrl,
} from './text-link-url.js'

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
