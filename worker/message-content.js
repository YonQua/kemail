import { parseEmail } from './parser.js'
import { compactDisplayText, normalizeText, stripHtml, truncateText } from './text-core.js'

const CODE_PATTERN = /(?<!\d)(\d{6})(?!\d)/g

export function buildPreviewText(textBody, htmlBody = '') {
  const previewSource = compactDisplayText(textBody) || compactDisplayText(stripHtml(htmlBody))
  return truncateText(previewSource)
}

export function extractCodes(subject, textBody) {
  const content = `${normalizeText(subject)}\n${compactDisplayText(textBody)}`
  return Array.from(new Set(content.match(CODE_PATTERN) || []))
}

export function buildArtifacts({ subject = '', textBody = '', actionLinks = [] } = {}) {
  return {
    codes: extractCodes(subject, textBody),
    links: Array.isArray(actionLinks) ? actionLinks : [],
  }
}

export async function normalizeIncomingEmail(rawSource, fallbackSender, fallbackSubject) {
  const parsed = await parseEmail(rawSource, fallbackSender, fallbackSubject)
  const textBody = compactDisplayText(parsed.bodyText || '')
  const htmlBody = normalizeText(parsed.bodyHtml || '')
  const headers = Array.isArray(parsed.headers) ? parsed.headers : []
  const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : []
  const artifacts = buildArtifacts({
    subject: parsed.subject,
    textBody,
    actionLinks: parsed.actionLinks,
  })

  return {
    sender: normalizeText(parsed.sender) || fallbackSender || 'Unknown',
    subject: normalizeText(parsed.subject) || fallbackSubject || 'No Subject',
    preview_text: buildPreviewText(textBody, htmlBody),
    text_body: textBody,
    html_body: htmlBody,
    raw_source: rawSource,
    headers_json: JSON.stringify(headers),
    attachments_json: JSON.stringify(attachments),
    artifacts_json: JSON.stringify(artifacts),
    source_available: 1,
    source_truncated: 0,
    parse_status: 'parsed',
  }
}

export function buildStoredMessageForOversizedRaw({
  recipient,
  sender,
  subject,
  receivedAt,
  notice,
  parseStatus,
}) {
  const textBody = compactDisplayText(notice)
  return {
    recipient,
    sender,
    subject,
    preview_text: buildPreviewText(textBody),
    text_body: textBody,
    html_body: '',
    raw_source: '',
    headers_json: '[]',
    attachments_json: '[]',
    artifacts_json: '{"codes":[],"links":[]}',
    source_available: 0,
    source_truncated: 1,
    parse_status: parseStatus,
    received_at: receivedAt,
  }
}

export function buildStoredMessageForPartialParse({
  recipient,
  sender,
  subject,
  receivedAt,
  rawSource,
  textBody,
  sourceAvailable,
  sourceTruncated,
  parseStatus,
}) {
  const compactText = compactDisplayText(textBody)
  return {
    recipient,
    sender,
    subject,
    preview_text: buildPreviewText(compactText),
    text_body: compactText,
    html_body: '',
    raw_source: sourceAvailable ? rawSource : '',
    headers_json: '[]',
    attachments_json: '[]',
    artifacts_json: '{"codes":[],"links":[]}',
    source_available: sourceAvailable ? 1 : 0,
    source_truncated: sourceTruncated ? 1 : 0,
    parse_status: parseStatus,
    received_at: receivedAt,
  }
}
