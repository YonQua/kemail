import { decodeBasicEntities, normalizeText } from './text-core.js'

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

export function normalizeHtmlHref(rawHref) {
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

export function decodeQuotedPrintableForLinkExtraction(rawSource) {
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

export function normalizeTextLinkUrl(rawToken) {
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
