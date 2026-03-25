import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { APP_RELEASE_TAG, APP_VERSION } from '../version.js'
import worker from '../worker.js'
import { parseEmail } from '../worker/parser.js'

const DAY_IN_MS = 24 * 60 * 60 * 1000
const SCHEMA_SQL = `
  CREATE TABLE emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    body_readable TEXT,
    received_at DATETIME,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_recipient ON emails (recipient);
  CREATE INDEX idx_recipient_received_at ON emails (recipient, received_at DESC);
  CREATE INDEX idx_received_at ON emails (received_at);
  CREATE INDEX idx_is_read ON emails (is_read);
  CREATE INDEX idx_is_starred ON emails (is_starred);
  CREATE TABLE managed_domains (
    zone_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    zone_status TEXT,
    issuable_enabled INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT,
    sync_error TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE mail_daily_metrics (
    day TEXT PRIMARY KEY,
    received_total INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE mail_sender_daily_metrics (
    day TEXT NOT NULL,
    sender TEXT NOT NULL,
    received_total INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (day, sender)
  );
`

class SqliteD1Statement {
  constructor(database, sql) {
    this.database = database
    this.sql = sql
    this.params = []
  }

  bind(...params) {
    this.params = params
    return this
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.params) || null
  }

  async all() {
    return {
      results: this.database.prepare(this.sql).all(...this.params),
    }
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.params)
    return {
      success: true,
      meta: {
        changes: Number(result.changes || 0),
        last_row_id: Number(result.lastInsertRowid || 0),
      },
    }
  }
}

class SqliteD1Database {
  constructor() {
    this.database = new DatabaseSync(':memory:')
    this.database.exec(SCHEMA_SQL)
  }

  prepare(sql) {
    return new SqliteD1Statement(this.database, sql)
  }

  close() {
    this.database.close()
  }
}

class MemoryKVNamespace {
  constructor() {
    this.store = new Map()
  }

  readEntry(key) {
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      return null
    }
    return entry
  }

  async get(key) {
    return this.readEntry(key)?.value ?? null
  }

  async put(key, value, options = {}) {
    const ttl = Number(options.expirationTtl || 0)
    this.store.set(key, {
      value,
      expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0,
    })
  }

  async delete(key) {
    this.store.delete(key)
  }
}

function createEnv() {
  return {
    DB: new SqliteD1Database(),
    CACHE: new MemoryKVNamespace(),
    READ_API_KEY: 'read-key',
    ADMIN_API_KEY: 'admin-key',
    CLOUDFLARE_API_TOKEN: 'cf-token',
    ASSETS: {
      async fetch(request) {
        const assetPath = new URL(request.url).pathname

        if (assetPath === '/api-docs.html') {
          return new Response('<!doctype html><title>public docs</title><h1>对外集成接口</h1>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        }

        if (assetPath === '/admin-api-docs.html') {
          return new Response(
            '<!doctype html><title>admin docs</title><a href="/api/admin/openapi">内部 OpenAPI</a><h1>后台管理接口</h1>',
            {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            }
          )
        }

        if (assetPath === '/openapi.json') {
          return new Response(
            JSON.stringify({
              openapi: '3.1.0',
              tags: [{ name: 'external' }],
              paths: {
                '/api/addresses/generate': {
                  post: { operationId: 'generateAddress' },
                },
              },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }
          )
        }

        if (assetPath === '/admin-openapi.json') {
          return new Response(
            JSON.stringify({
              openapi: '3.1.0',
              tags: [{ name: 'external' }, { name: 'admin-domains' }],
              paths: {
                '/api/addresses/generate': {
                  post: { operationId: 'generateAddress' },
                },
                '/api/admin/domains': {
                  get: { operationId: 'listManagedDomains' },
                },
              },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }
          )
        }

        return new Response('<!doctype html><title>stub</title>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      },
    },
  }
}

function buildMimeMessage({ to, from, subject, html, text }) {
  const boundary = '----kemail-regression-boundary'
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    '',
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    '',
    html,
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

async function dispatchJson(env, { method = 'GET', path, token = '', body = null }) {
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (body != null) headers.set('Content-Type', 'application/json')

  const response = await worker.fetch(
    new Request(`https://regression.local${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    }),
    env
  )

  const text = await response.text()
  return {
    response,
    status: response.status,
    headers: response.headers,
    json: text ? JSON.parse(text) : null,
  }
}

async function dispatchText(env, { method = 'GET', path, token = '', body = null }) {
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (body != null) headers.set('Content-Type', 'application/json')

  const response = await worker.fetch(
    new Request(`https://regression.local${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    }),
    env
  )

  const text = await response.text()
  return {
    response,
    status: response.status,
    headers: response.headers,
    text,
  }
}

async function ingestEmail(
  env,
  { recipient, subject, marker, linkPath = '/verify', linkUrl = '' }
) {
  const sender = 'Notify Service <notify@example.test>'
  const resolvedLinkUrl = linkUrl || `https://example.com${linkPath}`
  const mime = buildMimeMessage({
    to: recipient,
    from: sender,
    subject,
    text: `Action marker: ${marker}.`,
    html: `<html><body><p>Action marker <strong>${marker}</strong>.</p><a href="${resolvedLinkUrl}">Open Action</a></body></html>`,
  })

  await worker.email(
    {
      to: recipient,
      from: sender,
      raw: new TextEncoder().encode(mime),
      headers: new Headers({ subject }),
    },
    env
  )
}

function buildTrackingUrl(targetUrl) {
  const innerPayload = JSON.stringify({
    url: targetUrl,
  })
  const payload = JSON.stringify({
    p: innerPayload,
  })
  const encodedPayload = Buffer.from(payload).toString('base64url')
  return `https://track.example.test/click?p=${encodedPayload}`
}

async function readEmailCount(env, recipient = '') {
  if (!recipient) {
    const row = await env.DB.prepare('SELECT COUNT(*) as total FROM emails').first()
    return Number(row?.total || 0)
  }

  const row = await env.DB.prepare('SELECT COUNT(*) as total FROM emails WHERE recipient = ?')
    .bind(recipient)
    .first()
  return Number(row?.total || 0)
}

async function main() {
  const env = createEnv()
  const recipient = 'regression@example.test'
  const oldRecipient = 'cleanup@example.test'
  const originalConsoleError = console.error
  const originalConsoleLog = console.log
  const originalFetch = globalThis.fetch
  let mockCloudflareZones = [
    {
      id: 'zone-primary',
      name: 'example.test',
      status: 'active',
    },
    {
      id: 'zone-secondary',
      name: 'mail.example.test',
      status: 'active',
    },
    {
      id: 'zone-pending',
      name: 'pending.example',
      status: 'pending',
    },
  ]

  try {
    console.error = (...args) => {
      if (
        args[0] === '[WASM parse error]' &&
        typeof args[1]?.message === 'string' &&
        args[1].message.includes('mail-parser-wasm-worker/mail_parser_wasm')
      ) {
        return
      }
      originalConsoleError(...args)
    }
    console.log = (...args) => {
      if (
        typeof args[0] === 'string' &&
        args[0].startsWith('[定时清理] 已删除 1 封超过 3 天的旧邮件')
      ) {
        return
      }
      originalConsoleLog(...args)
    }

    const textOnlyParsed = await parseEmail(
      [
        'From: sender@example.test',
        'To: text-only@example.test',
        'Subject: plain text link',
        '',
        'Visit https://example.com/text-only to continue.',
        '',
      ].join('\r\n'),
      'sender@example.test',
      'plain text link'
    )
    assert.ok(
      textOnlyParsed.actionLinks.some((link) =>
        String(link?.url || '').includes('https://example.com/text-only')
      )
    )

    const htmlNoLinksParsed = await parseEmail(
      buildMimeMessage({
        to: 'html-fallback@example.test',
        from: 'sender@example.test',
        subject: 'html fallback link',
        text: 'Continue at https://example.com/fallback-only',
        html: '<html><body><p>No buttons or anchors here.</p></body></html>',
      }),
      'sender@example.test',
      'html fallback link'
    )
    assert.ok(
      htmlNoLinksParsed.actionLinks.some((link) =>
        String(link?.url || '').includes('https://example.com/fallback-only')
      )
    )

    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input?.url || ''
      if (url.startsWith('https://api.cloudflare.com/client/v4/zones')) {
        assert.equal(init.headers?.Authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`)
        return new Response(
          JSON.stringify({
            success: true,
            result: mockCloudflareZones,
            result_info: {
              page: 1,
              per_page: 50,
              total_pages: 1,
              count: mockCloudflareZones.length,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          }
        )
      }

      return originalFetch(input, init)
    }

    const publicVersion = await dispatchJson(env, {
      path: '/api/version',
    })
    assert.equal(publicVersion.status, 200)
    assert.deepEqual(publicVersion.json, {
      ok: true,
      version: APP_VERSION,
      release_tag: APP_RELEASE_TAG,
    })

    const unauthorized = await dispatchJson(env, {
      path: '/api/emails',
    })
    assert.equal(unauthorized.status, 401)
    assert.equal(
      Array.from(env.CACHE.store.keys()).filter((key) => key.startsWith('ratelimit:unauthorized:'))
        .length,
      1
    )

    const rateLimitEnv = createEnv()
    for (let index = 0; index < 30; index += 1) {
      const allowedSummary = await dispatchJson(rateLimitEnv, {
        path: '/api/analysis/summary',
        token: rateLimitEnv.READ_API_KEY,
      })
      assert.equal(allowedSummary.status, 200)
    }
    const rateLimitedSummary = await dispatchJson(rateLimitEnv, {
      path: '/api/analysis/summary',
      token: rateLimitEnv.READ_API_KEY,
    })
    assert.equal(rateLimitedSummary.status, 429)
    assert.equal(rateLimitedSummary.json?.error, 'Too many requests')
    assert.equal(
      Array.from(rateLimitEnv.CACHE.store.keys()).filter((key) =>
        key.startsWith('ratelimit:authorized-')
      ).length,
      0
    )

    const publicOpenApi = await dispatchText(env, {
      path: '/openapi.json',
    })
    assert.equal(publicOpenApi.status, 200)
    assert.equal(publicOpenApi.headers.get('Cache-Control'), 'no-store')
    const publicOpenApiSpec = JSON.parse(publicOpenApi.text)
    assert.deepEqual(
      publicOpenApiSpec.tags.map((tag) => tag.name),
      ['external']
    )
    assert.ok(publicOpenApiSpec.paths['/api/addresses/generate'])
    assert.equal(publicOpenApiSpec.paths['/api/admin/domains'], undefined)

    const publicApiDocs = await dispatchText(env, {
      path: '/api-docs',
    })
    assert.equal(publicApiDocs.status, 200)
    assert.match(publicApiDocs.text, /对外集成接口/)

    const domainAdminReadOnly = await dispatchJson(env, {
      path: '/api/admin/domains',
      token: env.READ_API_KEY,
    })
    assert.equal(domainAdminReadOnly.status, 403)

    const adminDocsReadOnly = await dispatchText(env, {
      path: '/api/admin/docs',
      token: env.READ_API_KEY,
    })
    assert.equal(adminDocsReadOnly.status, 403)

    const adminOpenApiReadOnly = await dispatchText(env, {
      path: '/api/admin/openapi',
      token: env.READ_API_KEY,
    })
    assert.equal(adminOpenApiReadOnly.status, 403)

    const adminDocs = await dispatchText(env, {
      path: '/api/admin/docs',
      token: env.ADMIN_API_KEY,
    })
    assert.equal(adminDocs.status, 200)
    assert.match(adminDocs.text, /后台管理接口/)

    const adminOpenApi = await dispatchText(env, {
      path: '/api/admin/openapi',
      token: env.ADMIN_API_KEY,
    })
    assert.equal(adminOpenApi.status, 200)
    assert.equal(adminOpenApi.headers.get('Cache-Control'), 'no-store')
    const adminOpenApiSpec = JSON.parse(adminOpenApi.text)
    assert.ok(adminOpenApiSpec.paths['/api/admin/domains'])

    const domainsBeforeSync = await dispatchJson(env, {
      path: '/api/admin/domains',
      token: env.ADMIN_API_KEY,
    })
    assert.equal(domainsBeforeSync.status, 200)
    assert.deepEqual(domainsBeforeSync.json?.domains, [])

    const generateWithoutDomains = await dispatchJson(env, {
      method: 'POST',
      path: '/api/addresses/generate',
      token: env.ADMIN_API_KEY,
    })
    assert.equal(generateWithoutDomains.status, 409)

    const syncDomains = await dispatchJson(env, {
      method: 'POST',
      path: '/api/admin/domains/sync',
      token: env.ADMIN_API_KEY,
    })
    assert.equal(syncDomains.status, 200)
    assert.equal(syncDomains.json?.synced_count, 3)
    assert.equal(syncDomains.json?.domains?.length, 3)
    assert.equal(syncDomains.json?.domains?.[0]?.issuable_enabled, 0)

    const enablePrimaryDomain = await dispatchJson(env, {
      method: 'PUT',
      path: '/api/admin/domains/zone-primary',
      token: env.ADMIN_API_KEY,
      body: { issuable_enabled: 1, note: 'primary pool' },
    })
    assert.equal(enablePrimaryDomain.status, 200)
    assert.equal(enablePrimaryDomain.json?.domain?.issuable_enabled, 1)
    assert.equal(enablePrimaryDomain.json?.domain?.note, 'primary pool')

    const batchEnableDomains = await dispatchJson(env, {
      method: 'POST',
      path: '/api/admin/domains/batch',
      token: env.ADMIN_API_KEY,
      body: { zone_ids: ['zone-primary', 'zone-secondary', 'missing-zone'], issuable_enabled: 1 },
    })
    assert.equal(batchEnableDomains.status, 200)
    assert.equal(batchEnableDomains.json?.updated_count, 2)
    assert.deepEqual(batchEnableDomains.json?.missing, ['missing-zone'])

    const syncedAgain = await dispatchJson(env, {
      method: 'POST',
      path: '/api/admin/domains/sync',
      token: env.ADMIN_API_KEY,
    })
    const primaryDomainAfterResync = syncedAgain.json?.domains?.find(
      (item) => item.zone_id === 'zone-primary'
    )
    const secondaryDomainAfterResync = syncedAgain.json?.domains?.find(
      (item) => item.zone_id === 'zone-secondary'
    )
    assert.equal(primaryDomainAfterResync?.issuable_enabled, 1)
    assert.equal(primaryDomainAfterResync?.note, 'primary pool')
    assert.equal(secondaryDomainAfterResync?.issuable_enabled, 1)

    mockCloudflareZones = []
    const guardedSync = await dispatchJson(env, {
      method: 'POST',
      path: '/api/admin/domains/sync',
      token: env.ADMIN_API_KEY,
    })
    assert.equal(guardedSync.status, 409)
    assert.match(guardedSync.json?.error || '', /中止同步/)

    const domainsAfterGuard = await dispatchJson(env, {
      path: '/api/admin/domains',
      token: env.ADMIN_API_KEY,
    })
    const primaryDomainAfterGuard = domainsAfterGuard.json?.domains?.find(
      (item) => item.zone_id === 'zone-primary'
    )
    const secondaryDomainAfterGuard = domainsAfterGuard.json?.domains?.find(
      (item) => item.zone_id === 'zone-secondary'
    )
    assert.equal(primaryDomainAfterGuard?.issuable_enabled, 1)
    assert.equal(secondaryDomainAfterGuard?.issuable_enabled, 1)

    mockCloudflareZones = [
      {
        id: 'zone-primary',
        name: 'example.test',
        status: 'active',
      },
      {
        id: 'zone-secondary',
        name: 'mail.example.test',
        status: 'active',
      },
      {
        id: 'zone-pending',
        name: 'pending.example',
        status: 'pending',
      },
    ]

    const generatedAddress = await dispatchJson(env, {
      method: 'POST',
      path: '/api/addresses/generate',
      token: env.ADMIN_API_KEY,
    })
    assert.equal(generatedAddress.status, 200)
    assert.match(
      generatedAddress.json?.email || '',
      /^oc[a-f0-9]{10}@(example\.test|mail\.example\.test)$/
    )

    await ingestEmail(env, {
      recipient,
      subject: 'service invite',
      marker: 'mk-123456',
      linkPath: '/first',
    })

    const latest = await dispatchJson(env, {
      path: `/api/latest?address=${encodeURIComponent(recipient)}`,
      token: env.READ_API_KEY,
    })
    assert.equal(latest.status, 200)
    assert.equal(latest.json?.ok, true)
    assert.equal(latest.json?.email?.recipient, recipient)
    assert.match(latest.json?.email?.body || '', /mk-123456/)
    assert.equal(
      Array.from(env.CACHE.store.keys()).some((key) => key.startsWith('latest:')),
      false
    )

    const summaryList = await dispatchJson(env, {
      path: `/api/emails?address=${encodeURIComponent(recipient)}&summary=1`,
      token: env.READ_API_KEY,
    })
    assert.equal(summaryList.status, 200)
    assert.equal(summaryList.json?.emails?.length, 1)
    assert.equal(summaryList.json?.permissions?.admin, false)
    const firstEmailId = Number(summaryList.json.emails[0].id)

    const summaryListAdmin = await dispatchJson(env, {
      path: `/api/emails?address=${encodeURIComponent(recipient)}&summary=1`,
      token: env.ADMIN_API_KEY,
    })
    assert.equal(summaryListAdmin.status, 200)
    assert.equal(summaryListAdmin.json?.permissions?.admin, true)

    const generatedByReadKey = await dispatchJson(env, {
      method: 'POST',
      path: '/api/addresses/generate',
      token: env.READ_API_KEY,
    })
    assert.equal(generatedByReadKey.status, 200)
    assert.equal(generatedByReadKey.json?.ok, true)
    assert.match(String(generatedByReadKey.json?.email || ''), /^oc[a-f0-9]{10}@/)

    const detail = await dispatchJson(env, {
      path: `/api/emails/${firstEmailId}`,
      token: env.READ_API_KEY,
    })
    assert.equal(detail.status, 200)
    assert.equal(detail.json?.email?.rich_enabled, false)
    assert.ok(Array.isArray(detail.json?.email?.action_links))
    assert.ok(
      detail.json.email.action_links.some((link) =>
        String(link?.url || '').includes('https://example.com/first')
      )
    )

    const richDetail = await dispatchJson(env, {
      path: `/api/emails/${firstEmailId}?rich=1`,
      token: env.ADMIN_API_KEY,
    })
    assert.equal(richDetail.status, 200)
    assert.equal(richDetail.json?.email?.rich_enabled, true)
    assert.match(richDetail.json?.email?.body_html || '', /Open Action/)
    assert.equal(
      Array.from(env.CACHE.store.keys()).some((key) => key.startsWith('rich:')),
      false
    )

    const richDetailAgain = await dispatchJson(env, {
      path: `/api/emails/${firstEmailId}?rich=1`,
      token: env.ADMIN_API_KEY,
    })
    assert.equal(richDetailAgain.status, 200)
    assert.equal(richDetailAgain.json?.email?.rich_enabled, true)
    assert.equal(
      Array.from(env.CACHE.store.keys()).some((key) => key.startsWith('rich:')),
      false
    )

    const source = await dispatchJson(env, {
      path: `/api/emails/${firstEmailId}/source`,
      token: env.ADMIN_API_KEY,
    })
    assert.equal(source.status, 200)
    assert.match(source.json?.source?.body_source || '', /MIME-Version: 1\.0/)

    const summaryBeforeUpdate = await dispatchJson(env, {
      path: '/api/analysis/summary',
      token: env.READ_API_KEY,
    })
    assert.equal(summaryBeforeUpdate.status, 200)
    assert.equal(summaryBeforeUpdate.json?.summary?.total, 1)
    assert.equal(summaryBeforeUpdate.json?.summary?.currentTotal, 1)
    assert.equal(summaryBeforeUpdate.json?.summary?.totalReceived, 1)
    assert.equal(summaryBeforeUpdate.json?.summary?.todayReceived, 1)
    assert.equal(summaryBeforeUpdate.json?.summary?.last7DaysReceived, 1)
    assert.equal(summaryBeforeUpdate.json?.summary?.unread, 1)
    assert.equal(summaryBeforeUpdate.json?.summary?.starred, 0)

    const markRead = await dispatchJson(env, {
      method: 'PUT',
      path: '/api/emails/read',
      token: env.ADMIN_API_KEY,
      body: { ids: [firstEmailId], read: 1 },
    })
    assert.equal(markRead.status, 200)
    assert.equal(markRead.json?.updated, 1)

    const latestAfterRead = await dispatchJson(env, {
      path: `/api/latest?address=${encodeURIComponent(recipient)}`,
      token: env.READ_API_KEY,
    })
    assert.equal(latestAfterRead.status, 200)
    assert.equal(latestAfterRead.json?.email?.is_read, 1)

    const markStar = await dispatchJson(env, {
      method: 'PUT',
      path: '/api/emails/star',
      token: env.ADMIN_API_KEY,
      body: { ids: [firstEmailId], starred: 1 },
    })
    assert.equal(markStar.status, 200)
    assert.equal(markStar.json?.updated, 1)

    const latestAfterStar = await dispatchJson(env, {
      path: `/api/latest?address=${encodeURIComponent(recipient)}`,
      token: env.READ_API_KEY,
    })
    assert.equal(latestAfterStar.status, 200)
    assert.equal(latestAfterStar.json?.email?.is_starred, 1)
    assert.equal(
      Array.from(env.CACHE.store.keys()).some((key) => key.startsWith('latest:')),
      false
    )

    const deleteByReadKey = await dispatchJson(env, {
      method: 'DELETE',
      path: `/api/emails/${firstEmailId}`,
      token: env.READ_API_KEY,
    })
    assert.equal(deleteByReadKey.status, 200)
    assert.equal(deleteByReadKey.json?.deleted, String(firstEmailId))

    const summaryAfterUpdate = await dispatchJson(env, {
      path: '/api/analysis/summary',
      token: env.READ_API_KEY,
    })
    assert.equal(summaryAfterUpdate.status, 200)
    assert.equal(summaryAfterUpdate.json?.summary?.total, 0)
    assert.equal(summaryAfterUpdate.json?.summary?.currentTotal, 0)
    assert.equal(summaryAfterUpdate.json?.summary?.totalReceived, 1)
    assert.equal(summaryAfterUpdate.json?.summary?.unread, 0)
    assert.equal(summaryAfterUpdate.json?.summary?.starred, 0)

    const trackedTargetUrl = 'https://docs.example.com/invite/help'
    await ingestEmail(env, {
      recipient,
      subject: 'service invite follow-up',
      marker: 'mk-654321',
      linkUrl: buildTrackingUrl(trackedTargetUrl),
    })
    const trackedRow = await env.DB.prepare(
      'SELECT id FROM emails WHERE recipient = ? AND subject = ? ORDER BY id DESC LIMIT 1'
    )
      .bind(recipient, 'service invite follow-up')
      .first()
    const trackedEmailId = Number(trackedRow?.id || 0)
    assert.ok(trackedEmailId > 0)

    const trackedDetail = await dispatchJson(env, {
      path: `/api/emails/${trackedEmailId}`,
      token: env.READ_API_KEY,
    })
    assert.equal(trackedDetail.status, 200)
    assert.ok(
      trackedDetail.json?.email?.action_links?.some(
        (link) => String(link?.url || '') === trackedTargetUrl
      )
    )

    await ingestEmail(env, {
      recipient,
      subject: 'service invite backup',
      marker: 'mk-111222',
      linkPath: '/third',
    })

    const fullList = await dispatchJson(env, {
      path: `/api/emails?address=${encodeURIComponent(recipient)}&sort=asc`,
      token: env.READ_API_KEY,
    })
    assert.equal(fullList.status, 200)
    assert.equal(fullList.json?.emails?.length, 2)
    const batchIds = fullList.json.emails
      .map((email) => Number(email.id))
      .filter((id) => id !== firstEmailId)
    assert.equal(batchIds.length, 2)

    const batchDelete = await dispatchJson(env, {
      method: 'POST',
      path: '/api/emails/delete',
      token: env.READ_API_KEY,
      body: { ids: [...batchIds, 999999] },
    })
    assert.equal(batchDelete.status, 200)
    assert.equal(batchDelete.json?.deleted_count, 2)
    assert.deepEqual(batchDelete.json?.missing, ['999999'])

    const summaryAfterBatchDelete = await dispatchJson(env, {
      path: '/api/analysis/summary',
      token: env.READ_API_KEY,
    })
    assert.equal(summaryAfterBatchDelete.status, 200)
    assert.equal(summaryAfterBatchDelete.json?.summary?.total, 0)
    assert.equal(summaryAfterBatchDelete.json?.summary?.currentTotal, 0)
    assert.equal(summaryAfterBatchDelete.json?.summary?.totalReceived, 3)
    assert.equal(summaryAfterBatchDelete.json?.summary?.todayReceived, 3)
    assert.equal(summaryAfterBatchDelete.json?.summary?.last7DaysReceived, 3)
    assert.equal(summaryAfterBatchDelete.json?.summary?.unread, 0)
    assert.equal(summaryAfterBatchDelete.json?.summary?.starred, 0)

    const trendAfterBatchDelete = await dispatchJson(env, {
      path: '/api/analysis/trend?days=14',
      token: env.READ_API_KEY,
    })
    assert.equal(trendAfterBatchDelete.status, 200)
    assert.equal(trendAfterBatchDelete.json?.trend?.series?.length, 14)
    assert.equal(
      trendAfterBatchDelete.json?.trend?.series?.[
        trendAfterBatchDelete.json.trend.series.length - 1
      ]?.total,
      3
    )

    const currentMetricDay = new Date().toISOString().slice(0, 10)
    const currentMetricUpdatedAt = new Date().toISOString()
    await env.DB.prepare(
      'INSERT INTO mail_sender_daily_metrics (day, sender, received_total, updated_at) VALUES (?, ?, ?, ?)'
    )
      .bind(currentMetricDay, 'OpenAI <otp@tm1.openai.com>', 2, currentMetricUpdatedAt)
      .run()
    await env.DB.prepare(
      'INSERT INTO mail_sender_daily_metrics (day, sender, received_total, updated_at) VALUES (?, ?, ?, ?)'
    )
      .bind(currentMetricDay, 'OpenAI <noreply@tm.openai.com>', 2, currentMetricUpdatedAt)
      .run()
    await env.DB.prepare(
      'INSERT INTO mail_sender_daily_metrics (day, sender, received_total, updated_at) VALUES (?, ?, ?, ?)'
    )
      .bind(currentMetricDay, 'ChatGPT <noreply@tm.openai.com>', 1, currentMetricUpdatedAt)
      .run()

    const sendersAfterBatchDelete = await dispatchJson(env, {
      path: '/api/analysis/senders?limit=5&days=14',
      token: env.READ_API_KEY,
    })
    assert.equal(sendersAfterBatchDelete.status, 200)
    assert.equal(sendersAfterBatchDelete.json?.senders?.[0]?.sender, 'openai.com')
    assert.equal(sendersAfterBatchDelete.json?.senders?.[0]?.total, 5)
    assert.equal(sendersAfterBatchDelete.json?.senders?.[1]?.sender, 'example.test')
    assert.equal(sendersAfterBatchDelete.json?.senders?.[1]?.total, 3)

    const oldMetricDay = new Date(Date.now() - 5 * DAY_IN_MS).toISOString().slice(0, 10)
    const oldMetricUpdatedAt = new Date(Date.now() - 5 * DAY_IN_MS).toISOString()
    await env.DB.prepare(
      'INSERT INTO emails (recipient, sender, subject, body, body_readable, received_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(
        oldRecipient,
        'cleanup@example.com',
        'old mail',
        'old body',
        'old body',
        new Date(Date.now() - 5 * DAY_IN_MS).toISOString()
      )
      .run()
    await env.DB.prepare(
      'INSERT INTO mail_daily_metrics (day, received_total, updated_at) VALUES (?, ?, ?)'
    )
      .bind(oldMetricDay, 1, oldMetricUpdatedAt)
      .run()
    await env.DB.prepare(
      'INSERT INTO mail_sender_daily_metrics (day, sender, received_total, updated_at) VALUES (?, ?, ?, ?)'
    )
      .bind(oldMetricDay, 'cleanup@example.com', 1, oldMetricUpdatedAt)
      .run()
    assert.equal(await readEmailCount(env, oldRecipient), 1)

    await worker.scheduled({}, env)
    assert.equal(await readEmailCount(env, oldRecipient), 0)

    const summaryAfterScheduled = await dispatchJson(env, {
      path: '/api/analysis/summary',
      token: env.READ_API_KEY,
    })
    assert.equal(summaryAfterScheduled.status, 200)
    assert.equal(summaryAfterScheduled.json?.summary?.currentTotal, 0)
    assert.equal(summaryAfterScheduled.json?.summary?.totalReceived, 4)
    assert.equal(summaryAfterScheduled.json?.summary?.last7DaysReceived, 4)

    await ingestEmail(env, {
      recipient: generatedAddress.json.email,
      subject: 'generated inbox message',
      marker: 'mk-generated',
      linkPath: '/generated',
    })
    const latestGenerated = await dispatchJson(env, {
      path: `/api/latest?address=${encodeURIComponent(generatedAddress.json.email)}`,
      token: env.READ_API_KEY,
    })
    assert.equal(latestGenerated.status, 200)
    assert.equal(latestGenerated.json?.email?.recipient, generatedAddress.json.email)
    assert.match(latestGenerated.json?.email?.body || '', /mk-generated/)
    assert.equal(await readEmailCount(env, generatedAddress.json.email), 1)

    const generatedRow = await env.DB.prepare(
      'SELECT id FROM emails WHERE recipient = ? ORDER BY id DESC LIMIT 1'
    )
      .bind(generatedAddress.json.email)
      .first()
    const generatedEmailId = Number(generatedRow?.id || 0)
    assert.ok(generatedEmailId > 0)

    const singleDelete = await dispatchJson(env, {
      method: 'DELETE',
      path: `/api/emails/${generatedEmailId}`,
      token: env.READ_API_KEY,
    })
    assert.equal(singleDelete.status, 200)
    assert.equal(singleDelete.json?.deleted, String(generatedEmailId))

    const latestAfterGeneratedDelete = await dispatchJson(env, {
      path: `/api/latest?address=${encodeURIComponent(generatedAddress.json.email)}`,
      token: env.READ_API_KEY,
    })
    assert.equal(latestAfterGeneratedDelete.status, 200)
    assert.equal(latestAfterGeneratedDelete.json?.email, null)

    console.log(
      '回归通过：邮件入站、详情/富解析、读写操作、域名同步/发号、当前状态与历史统计分层、以及定时清理链路正常（定时清理验证基于本地临时测试数据）。'
    )
  } finally {
    console.error = originalConsoleError
    console.log = originalConsoleLog
    globalThis.fetch = originalFetch
    env.DB.close()
  }
}

main().catch((error) => {
  console.error('回归失败：', error)
  process.exitCode = 1
})
