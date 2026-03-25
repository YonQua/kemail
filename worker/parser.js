import PostalMime from 'postal-mime'
import { normalizeAttachments } from './email-store.js'
import { compactDisplayText, normalizeHeaders, normalizeText, stripHtml } from './text-core.js'
import { extractActionLinks, extractActionLinksFromText } from './text-links.js'
import { logError } from './text-logging.js'

let wasmMailParserModulePromise = null

function hasExplicitPlainTextPart(rawSource) {
  return /content-type:\s*text\/plain\b/i.test(String(rawSource || ''))
}

// HTML-only 邮件直接按 HTML 结构导出纯文本，避免继续信任 parser 产出的劣化 text。
// 只有原始 MIME 明确提供 text/plain part 时，才把 parser text 视为首选正文。
function selectPreferredBodyText(bodyText, bodyHtml, rawSource) {
  const parserText = compactDisplayText(bodyText)
  const htmlText = compactDisplayText(stripHtml(normalizeText(bodyHtml)))

  if (hasExplicitPlainTextPart(rawSource)) {
    return parserText || htmlText
  }

  return htmlText || parserText
}

function concatUint8Arrays(chunks, totalLength) {
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

// 以流式方式读取原始邮件，并在超过上限后立即停止，避免超大 MIME 直接占满 Worker 内存。
export async function readRawEmailBytes(rawInput, maxBytes) {
  const body = new Response(rawInput).body
  if (!body) {
    return {
      bytes: new Uint8Array(0),
      byteLength: 0,
      truncated: false,
    }
  }

  const reader = body.getReader()
  const chunks = []
  let totalLength = 0
  let truncated = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      if (totalLength + chunk.byteLength > maxBytes) {
        const remaining = maxBytes - totalLength
        if (remaining > 0) {
          chunks.push(chunk.slice(0, remaining))
          totalLength += remaining
        }
        truncated = true
        await reader.cancel('raw email exceeds configured limit')
        break
      }

      chunks.push(chunk)
      totalLength += chunk.byteLength
    }
  } finally {
    reader.releaseLock()
  }

  return {
    bytes: concatUint8Arrays(chunks, totalLength),
    byteLength: truncated ? maxBytes + 1 : totalLength,
    truncated,
  }
}

export function decodeRawEmailBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return ''
  return new TextDecoder().decode(bytes)
}

function hasMeaningfulParsedContent(parsedEmail) {
  return Boolean(
    normalizeText(parsedEmail.sender) ||
    normalizeText(parsedEmail.subject) ||
    normalizeText(parsedEmail.bodyText) ||
    normalizeText(parsedEmail.bodyHtml)
  )
}

async function loadWasmMailParser() {
  if (!wasmMailParserModulePromise) {
    wasmMailParserModulePromise = import('mail-parser-wasm-worker').catch((error) => {
      wasmMailParserModulePromise = null
      throw error
    })
  }
  return wasmMailParserModulePromise
}

function buildParsedEmailResult({
  sender,
  subject,
  bodyText,
  bodyHtml,
  rawSource,
  headers,
  attachments,
  parser,
  fallbackSender,
  fallbackSubject,
}) {
  const resolvedSender = normalizeText(sender) || fallbackSender || 'Unknown'
  const resolvedSubject = normalizeText(subject) || fallbackSubject || 'No Subject'
  const normalizedHtml = normalizeText(bodyHtml)
  const normalizedText = selectPreferredBodyText(bodyText, normalizedHtml, rawSource)

  let actionLinks = extractActionLinks(normalizedHtml)
  if (actionLinks.length === 0) {
    actionLinks = extractActionLinksFromText(normalizedText)
  }

  const readableText = normalizedText || compactDisplayText(stripHtml(normalizedHtml)) || ''

  return {
    sender: resolvedSender,
    subject: resolvedSubject,
    bodyText: normalizedText,
    bodyHtml: normalizedHtml,
    bodyReadable: readableText,
    headers: normalizeHeaders(headers),
    attachments: normalizeAttachments(attachments),
    actionLinks,
    parser,
  }
}

// 使用 Wasm parser 优先、PostalMime 回退的双层解析链，兼顾复杂 MIME 兼容性与运行稳定性。
export async function parseEmail(raw, fallbackSender, fallbackSubject) {
  const source = typeof raw === 'string' ? raw : ''

  try {
    const { parse_message_wrapper } = await loadWasmMailParser()
    const parsed = parse_message_wrapper(source)
    const result = buildParsedEmailResult({
      sender: parsed?.sender,
      subject: parsed?.subject,
      bodyText: parsed?.text,
      bodyHtml: parsed?.body_html,
      rawSource: source,
      headers: parsed?.headers,
      attachments: parsed?.attachments,
      parser: 'wasm',
      fallbackSender,
      fallbackSubject,
    })

    if (hasMeaningfulParsedContent(result)) {
      return result
    }

    throw new Error('WASM parser returned empty result')
  } catch (error) {
    logError('WASM parse error', error, { fallbackSender, fallbackSubject })
  }

  try {
    const parser = new PostalMime()
    const parsed = await parser.parse(source)

    const parsedSender = parsed.from?.address
      ? [parsed.from.name, `<${parsed.from.address}>`].filter(Boolean).join(' ')
      : ''

    return buildParsedEmailResult({
      sender: parsedSender,
      subject: parsed.subject,
      bodyText: parsed.text,
      bodyHtml: parsed.html,
      rawSource: source,
      headers: parsed.headers,
      attachments: parsed.attachments,
      parser: 'postal-mime',
      fallbackSender,
      fallbackSubject,
    })
  } catch (error) {
    logError('PostalMime parse error', error, { fallbackSender, fallbackSubject })
  }

  return buildParsedEmailResult({
    sender: fallbackSender,
    subject: fallbackSubject,
    bodyText: '',
    bodyHtml: '',
    rawSource: source,
    headers: [],
    attachments: [],
    parser: 'fallback',
    fallbackSender,
    fallbackSubject,
  })
}
