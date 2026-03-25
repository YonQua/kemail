import { normalizeText } from './text-core.js'

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
