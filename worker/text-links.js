import { compactDisplayText, stripHtml } from './text-core.js'
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

// Bound intermediate work before ranking; the final 12-link limit alone is too late.
const MAX_LINK_MATCHES = 256
const MAX_LINK_CANDIDATES = 128
const LINK_CONTEXT_RADIUS = 180
const MAX_LINK_LABEL_LENGTH = 360

const SUPPORTED_HTML_HREF_TAGS = new Set(['a', 'area', 'button', 'v:roundrect', 'v:rect'])

function extractHtmlText(fragment) {
  return compactDisplayText(stripHtml(fragment))
}

function buildHtmlLinkContext(html, start, end, label) {
  const before = extractHtmlText(
    html.slice(Math.max(0, start - LINK_CONTEXT_RADIUS), start)
  )
  const after = extractHtmlText(html.slice(end, end + LINK_CONTEXT_RADIUS))
  // Keep converted text out of HTML processing; clipped fragments must not consume the label.
  return [before, label, after].filter(Boolean).join(' ')
}

function collectHtmlHrefCandidates(content) {
  const html = typeof content === 'string' ? content : ''
  if (!html) return []

  const candidates = []
  const seen = new Set()
  let scanned = 0
  const totalLength = html.length || 1
  const hrefTagRegex =
    /<([a-z0-9:_-]+)\b([^>]*?)href=(['"])(.*?)\3([^>]*)>([\s\S]*?)<\/\1>/gi
  let match = null

  while (
    scanned < MAX_LINK_MATCHES &&
    candidates.length < MAX_LINK_CANDIDATES &&
    (match = hrefTagRegex.exec(html))
  ) {
    scanned += 1
    const tagName = String(match[1] || '').toLowerCase()
    if (!SUPPORTED_HTML_HREF_TAGS.has(tagName)) continue

    const url = normalizeHtmlHref(match[4])
    if (!url || seen.has(url)) continue
    seen.add(url)

    // Strip complete markup before clipping text so long attributes cannot become labels.
    const rawLabel = extractHtmlText(match[6] || '').slice(0, MAX_LINK_LABEL_LENGTH)
    const label = normalizeActionLinkLabel(rawLabel, url)
    const attrs = `${match[2] || ''} ${match[5] || ''}`
    const isButton =
      tagName === 'button' ||
      tagName.startsWith('v:') ||
      /\b(btn|button)\b/i.test(attrs) ||
      /background-color|role\s*=\s*["']?button/i.test(attrs)
    const context = buildHtmlLinkContext(
      html,
      match.index,
      hrefTagRegex.lastIndex,
      rawLabel
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

  return candidates
}

export function extractActionLinks(html) {
  if (!html || typeof html !== 'string') return []
  return rankActionLinks(collectHtmlHrefCandidates(html))
}

export function extractActionLinksFromRawSource(rawSource) {
  if (!rawSource || typeof rawSource !== 'string') return []

  const source = decodeQuotedPrintableForLinkExtraction(rawSource)
  const bodyMatch = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  const content = bodyMatch ? bodyMatch[1] : source
  return rankActionLinks(collectHtmlHrefCandidates(content))
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
  let scanned = 0

  const urlPattern =
    /<\s*(https?:\/\/[^\s>]+)\s*>|((?:https?:\/\/|www\.)[^\s<>()]+)|((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>()]+)?)/gi

  scanLines:
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    while (true) {
      if (scanned >= MAX_LINK_MATCHES || candidates.length >= MAX_LINK_CANDIDATES) {
        break scanLines
      }
      const match = urlPattern.exec(line)
      if (!match) break
      scanned += 1
      const rawToken = match[1] || match[2] || match[3] || ''
      const startIndex = match.index
      const charBefore = startIndex > 0 ? line[startIndex - 1] : ''
      if (charBefore === '@') continue
      const url = normalizeTextLinkUrl(rawToken)
      if (!url || seen.has(url)) continue

      const endIndex = match.index + match[0].length
      const before = line.slice(Math.max(0, match.index - LINK_CONTEXT_RADIUS), match.index).trim()
      const after = line.slice(endIndex, endIndex + LINK_CONTEXT_RADIUS).trim()
      const inlineBeforeLabel = extractContextLabel(before)
      const inlineAfterLabel = extractContextLabel(after)
      const inlineLabel = inlineBeforeLabel || inlineAfterLabel
      const previousLine = (lines[i - 1] || '').slice(-LINK_CONTEXT_RADIUS)
      const nextLine = (lines[i + 1] || '').slice(0, LINK_CONTEXT_RADIUS)
      const previousLineLabel = !inlineLabel ? extractContextLabel(previousLine) : ''
      const resolvedLabel =
        normalizeActionLinkLabel(inlineLabel || previousLineLabel, url) || buildTextLinkLabel(url)

      const context = [
        previousLine,
        before,
        rawToken.slice(0, LINK_CONTEXT_RADIUS),
        after,
        nextLine,
      ].filter(Boolean).join(' ')
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
