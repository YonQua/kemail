export const ANALYSIS_CACHE_TTL = 20
export const RATE_LIMIT = 60
export const RATE_WINDOW = 60
export const AUTH_RATE_LIMIT = 180
export const AUTH_RATE_WINDOW = 60
export const ANALYSIS_RATE_LIMIT = 30
export const ANALYSIS_RATE_WINDOW = 60
export const SOURCE_HEAVY_RATE_LIMIT = 20
export const SOURCE_HEAVY_RATE_WINDOW = 60
export const WRITE_RATE_LIMIT = 60
export const WRITE_RATE_WINDOW = 60

export const AUTO_CLEAN_DAYS = 3
export const MAX_GOVERNANCE_RETENTION_DAYS = 365
export const DEFAULT_CLEANUP_RULE_DELETE_BATCH_SIZE = 200
export const DAY_IN_MS = 24 * 60 * 60 * 1000
export const DEFAULT_MESSAGE_LIMIT = 20
export const MAX_MESSAGE_LIMIT = 100
export const MAX_BATCH_MESSAGE_IDS = 100
export const EMAIL_PREVIEW_LIMIT = 280
export const MAX_RAW_EMAIL_BYTES = 1024 * 1024
export const MAX_PARSE_EMAIL_BYTES = 256 * 1024
export const MAX_STORED_SOURCE_BYTES = 120000
export const RAW_EMAIL_TOO_LARGE_NOTICE = '邮件原文超过安全上限，已跳过完整解析与原始 MIME 保存。'
export const RAW_EMAIL_PARSE_SKIPPED_NOTICE = '邮件原文较大，已跳过完整解析，仅保留原始 MIME 与基础提示。'
export const RAW_EMAIL_SOURCE_SKIPPED_NOTICE = '邮件原文超过保存上限，已仅保留解析结果，不提供原始 MIME。'
export const STATIC_DOCUMENT_PATHS = new Map([
  ['/', '/index.html'],
  ['/manage', '/index.html'],
  ['/index.html', '/index.html'],
  ['/api-docs', '/api-docs.html'],
  ['/api-docs.html', '/api-docs.html'],
  ['/api-docs-spec.json', '/api-docs-spec.json'],
  ['/openapi.json', '/openapi.json'],
])
export const STATIC_ASSET_PREFIX = '/assets/'
export const IMMUTABLE_STATIC_ASSET_PATTERN =
  /^\/assets\/(?:manage|api-docs|ui-foundation|vendor-chart|vendor-alpine)\.[a-f0-9]{10}\.(css|js)$/
export const RESPONSE_SECURITY_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}
export const JSON_SECURITY_HEADERS = {
  ...RESPONSE_SECURITY_HEADERS,
}
export const HTML_SECURITY_HEADERS = {
  ...RESPONSE_SECURITY_HEADERS,
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
}
export const JSON_RESPONSE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  ...JSON_SECURITY_HEADERS,
}
