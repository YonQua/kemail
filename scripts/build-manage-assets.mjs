import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { APP_RELEASE_TAG } from '../version.js'

const rootDir = process.cwd()
const sourceDir = path.join(rootDir, 'manage-src')
const sourceAssetsDir = path.join(sourceDir, 'assets')
const sourceVendorDir = path.join(sourceDir, 'vendor')
const specsDir = path.join(rootDir, 'specs')
const publicDir = path.join(rootDir, 'public')
const publicAssetsDir = path.join(publicDir, 'assets')
const MANAGED_ASSET_NAMES = new Set([
  'manage',
  'api-docs',
  'ui-foundation',
  'vendor-chart',
  'vendor-alpine',
])
const MANAGED_ASSET_LATEST_ALIASES = new Map([
  ['manage.css', 'manage.latest.css'],
  ['manage.js', 'manage.latest.js'],
  ['api-docs.css', 'api-docs.latest.css'],
  ['api-docs.js', 'api-docs.latest.js'],
  ['ui-foundation.css', 'ui-foundation.latest.css'],
  ['vendor-chart.js', 'vendor-chart.latest.js'],
  ['vendor-alpine.js', 'vendor-alpine.latest.js'],
])
const HTML_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

function isManagedAsset(filename) {
  const match = filename.match(/^([a-z-]+)\.[a-f0-9]{10}\.(css|js)$/)
  if (!match) return false
  return MANAGED_ASSET_NAMES.has(match[1])
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content)
}

function readJson(filePath) {
  return JSON.parse(readFile(filePath))
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 10)
}

function replacePlaceholder(template, placeholder, value) {
  if (!template.includes(placeholder)) {
    throw new Error(`Missing placeholder: ${placeholder}`)
  }
  return template.replaceAll(placeholder, value)
}

function cleanupManageAssets(activeFilenames) {
  ensureDir(publicAssetsDir)

  for (const filename of fs.readdirSync(publicAssetsDir)) {
    if (!isManagedAsset(filename)) continue
    if (activeFilenames.has(filename)) continue
    fs.rmSync(path.join(publicAssetsDir, filename), { force: true })
  }
}

function removeGeneratedFile(filename) {
  fs.rmSync(path.join(publicDir, filename), { force: true })
}

function buildHashedAsset(sourcePath, baseName, ext) {
  const source = readFile(sourcePath)
  const hash = hashContent(source)
  const filename = `${baseName}.${hash}.${ext}`
  return { source, filename, publicPath: `/assets/${filename}`, baseName, ext }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttr(value) {
  return escapeHtml(value)
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2)
}

function safeInlineJson(value) {
  return prettyJson(value).replaceAll('<', '\\u003c')
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value))
}

function isHttpOperationMethod(value) {
  return ['get', 'post', 'put', 'delete', 'patch'].includes(value)
}

function decodeJsonPointerSegment(value) {
  return String(value || '')
    .replaceAll('~1', '/')
    .replaceAll('~0', '~')
}

function resolveLocalRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null

  let current = root
  for (const segment of ref
    .slice(2)
    .split('/')
    .map((part) => decodeJsonPointerSegment(part))) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return null
    }
    current = current[segment]
  }

  return current
}

function filterSpecByTags(spec, allowedTags, overrides = {}) {
  const allowedTagSet = new Set(allowedTags)
  const excludedPathSet = new Set(overrides.excludePaths || [])
  const nextSpec = cloneJsonValue(spec)
  const filteredPaths = {}
  const allowedOperationKeys = new Set()

  for (const [pathKey, pathItem] of Object.entries(spec.paths || {})) {
    if (excludedPathSet.has(pathKey)) continue
    const nextPathItem = {}

    Object.entries(pathItem || {}).forEach(([key, value]) => {
      if (!isHttpOperationMethod(key)) {
        nextPathItem[key] = cloneJsonValue(value)
      }
    })

    let hasOperation = false
    Object.entries(pathItem || {}).forEach(([method, operation]) => {
      if (!isHttpOperationMethod(method)) return
      const operationTags = Array.isArray(operation?.tags) ? operation.tags : []
      const shouldInclude =
        operationTags.some((tag) => allowedTagSet.has(tag)) ||
        (operationTags.length === 0 && allowedTagSet.has('external-core'))

      if (!shouldInclude) return
      nextPathItem[method] = cloneJsonValue(operation)
      allowedOperationKeys.add(`${method} ${pathKey}`)
      hasOperation = true
    })

    if (hasOperation) {
      filteredPaths[pathKey] = nextPathItem
    }
  }

  nextSpec.paths = filteredPaths
  nextSpec.tags = (Array.isArray(spec.tags) ? spec.tags : [])
    .filter((tag) => allowedTagSet.has(tag.name))
    .map((tag) => cloneJsonValue(tag))

  const docsMeta = cloneJsonValue(spec['x-docs'] || {})
  if (Array.isArray(docsMeta.quickstart)) {
    docsMeta.quickstart = docsMeta.quickstart.filter((entry) =>
      allowedOperationKeys.has(`${String(entry.method || '').toLowerCase()} ${entry.path}`)
    )
  }

  if (overrides.contractInfo) docsMeta.contractInfo = overrides.contractInfo
  if (overrides.responseEnvelope) docsMeta.responseEnvelope = overrides.responseEnvelope
  nextSpec['x-docs'] = docsMeta

  if (nextSpec.info) {
    if (overrides.infoTitle) nextSpec.info.title = overrides.infoTitle
    if (overrides.infoDescription) nextSpec.info.description = overrides.infoDescription
  }

  if (Array.isArray(overrides.servers)) {
    nextSpec.servers = cloneJsonValue(overrides.servers)
  }

  const bearerAuth = nextSpec.components?.securitySchemes?.BearerAuth
  if (bearerAuth && overrides.securityDescription) {
    bearerAuth.description = overrides.securityDescription
  }

  return nextSpec
}

function collectUsedSecuritySchemes(spec) {
  const usedNames = new Set()

  const recordSecurity = (value) => {
    if (!Array.isArray(value)) return
    value.forEach((item) => {
      if (!item || typeof item !== 'object') return
      Object.keys(item).forEach((name) => usedNames.add(name))
    })
  }

  recordSecurity(spec.security)

  Object.values(spec.paths || {}).forEach((pathItem) => {
    Object.entries(pathItem || {}).forEach(([method, operation]) => {
      if (!isHttpOperationMethod(method)) return
      recordSecurity(operation?.security)
    })
  })

  return usedNames
}

function collectReferencedComponents(spec) {
  const usedEntries = new Map()
  const visitedRefs = new Set()

  const markUsedEntry = (section, name) => {
    if (!section || !name) return
    if (!usedEntries.has(section)) {
      usedEntries.set(section, new Set())
    }
    usedEntries.get(section).add(name)
  }

  const visit = (value) => {
    if (!value || typeof value !== 'object') return

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item))
      return
    }

    Object.entries(value).forEach(([key, nestedValue]) => {
      if (
        key === '$ref' &&
        typeof nestedValue === 'string' &&
        nestedValue.startsWith('#/components/')
      ) {
        if (visitedRefs.has(nestedValue)) return
        visitedRefs.add(nestedValue)

        const segments = nestedValue
          .slice(2)
          .split('/')
          .map((part) => decodeJsonPointerSegment(part))
        if (segments[0] !== 'components' || segments.length < 3) return

        const section = segments[1]
        const name = segments.slice(2).join('/')
        markUsedEntry(section, name)
        visit(resolveLocalRef(spec, nestedValue))
        return
      }

      visit(nestedValue)
    })
  }

  visit(spec.paths)
  visit(spec.webhooks)

  const usedSecuritySchemes = collectUsedSecuritySchemes(spec)
  if (usedSecuritySchemes.size > 0) {
    usedEntries.set('securitySchemes', usedSecuritySchemes)
  }

  return usedEntries
}

function pruneUnusedComponents(spec) {
  const components = spec.components
  if (!components || typeof components !== 'object') return spec

  const usedEntries = collectReferencedComponents(spec)
  const nextComponents = {}

  Object.entries(components).forEach(([section, value]) => {
    if (!value || typeof value !== 'object') return
    const usedNames = usedEntries.get(section)
    if (!usedNames || usedNames.size === 0) return

    const filteredEntries = Object.fromEntries(
      Object.entries(value).filter(([name]) => usedNames.has(name))
    )
    if (Object.keys(filteredEntries).length > 0) {
      nextComponents[section] = filteredEntries
    }
  })

  if (Object.keys(nextComponents).length === 0) {
    delete spec.components
    return spec
  }

  spec.components = nextComponents
  return spec
}

function stripVendorExtensions(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stripVendorExtensions(item))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('x-'))
      .map(([key, nestedValue]) => [key, stripVendorExtensions(nestedValue)])
  )
}

function sanitizeSpecForMachineConsumers(spec, options = {}) {
  let nextSpec = cloneJsonValue(spec)

  if (options.pruneUnusedComponents) {
    nextSpec = pruneUnusedComponents(nextSpec)
  }

  if (options.stripServers) {
    delete nextSpec.servers
  }

  if (options.stripVendorExtensions) {
    nextSpec = stripVendorExtensions(nextSpec)
  }

  return nextSpec
}

function renderDocsAppHtml(template, options) {
  return [
    ['__API_DOCS_TITLE__', escapeHtml(options.title || 'kemail API Docs')],
    ['__API_DOCS_META_DESCRIPTION__', escapeAttr(options.description || '')],
    ['__UI_FOUNDATION_CSS__', options.foundationCssPath],
    ['__API_DOCS_CSS__', options.docsCssPath],
    ['__API_DOCS_JS__', options.docsJsPath],
    ['__API_DOCS_BOOTSTRAP__', safeInlineJson(options.bootstrap || {})],
  ].reduce((html, [placeholder, value]) => replacePlaceholder(html, placeholder, value), template)
}

function buildManageAssets() {
  ensureDir(publicAssetsDir)

  const htmlTemplate = readFile(path.join(sourceDir, 'index.template.html'))
  const docsAppTemplate = readFile(path.join(sourceDir, 'api-docs.template.html'))
  const fullOpenapiSpec = readJson(path.join(specsDir, 'openapi.json'))
  const publicDocsSpec = sanitizeSpecForMachineConsumers(
    filterSpecByTags(fullOpenapiSpec, ['external-core'], {
      excludePaths: ['/api/version'],
      infoTitle: 'kemail API Docs',
      infoDescription:
        'kemail 的公开主链接口契约。公开发布的 `/openapi.json` 与 `/api-docs` 只保留第三方自动化最常用的生成与消费链路。',
      contractInfo:
        '公开 `/openapi.json` 仅包含最推荐的两步主链：发号与消费最新地址邮件；高级查询、回溯与后台能力只在内部文档中提供。',
      securityDescription:
        '统一使用 `Authorization: Bearer <TOKEN>`。公开契约只覆盖发号与 consume 主链，`READ_API_KEY` 与 `ADMIN_API_KEY` 都可调用。',
    }),
    {
      pruneUnusedComponents: true,
    }
  )
  const publicOpenapiSpec = sanitizeSpecForMachineConsumers(publicDocsSpec, {
    stripVendorExtensions: true,
    stripServers: true,
  })
  const adminOpenapiSpec = filterSpecByTags(
    fullOpenapiSpec,
    ['external-core', 'external-ops', 'admin-mail', 'admin-analytics', 'admin-domains'],
    {
      infoTitle: 'kemail Admin API Docs',
      infoDescription:
        'kemail 的完整后台与高级接口契约，包含公开主链、调试/回溯接口与后台管理接口。此版本只通过管理员受保护入口提供。',
      contractInfo: '完整后台契约只通过管理页中的受保护入口提供，不对公开访客直接暴露。',
    }
  )

  const foundationCssAsset = buildHashedAsset(
    path.join(sourceAssetsDir, 'ui-foundation.css'),
    'ui-foundation',
    'css'
  )
  const cssAsset = buildHashedAsset(path.join(sourceAssetsDir, 'manage.css'), 'manage', 'css')
  const apiDocsCssAsset = buildHashedAsset(
    path.join(sourceAssetsDir, 'api-docs.css'),
    'api-docs',
    'css'
  )
  const apiDocsJsAsset = buildHashedAsset(
    path.join(sourceAssetsDir, 'api-docs.js'),
    'api-docs',
    'js'
  )
  const jsAsset = buildHashedAsset(path.join(sourceAssetsDir, 'manage.js'), 'manage', 'js')
  const chartAsset = buildHashedAsset(
    path.join(sourceVendorDir, 'chart.umd.min.js'),
    'vendor-chart',
    'js'
  )
  const alpineAsset = buildHashedAsset(
    path.join(sourceVendorDir, 'alpine.cdn.min.js'),
    'vendor-alpine',
    'js'
  )
  const assets = [
    foundationCssAsset,
    cssAsset,
    apiDocsCssAsset,
    apiDocsJsAsset,
    jsAsset,
    chartAsset,
    alpineAsset,
  ]

  cleanupManageAssets(new Set(assets.map((asset) => asset.filename)))
  assets.forEach((asset) => {
    writeFile(path.join(publicAssetsDir, asset.filename), asset.source)
  })
  assets.forEach((asset) => {
    const aliasKey = `${asset.baseName}.${asset.ext}`
    const aliasName = MANAGED_ASSET_LATEST_ALIASES.get(aliasKey)
    if (!aliasName) return
    writeFile(path.join(publicAssetsDir, aliasName), asset.source)
  })

  const html = [
    ['__UI_FOUNDATION_CSS__', foundationCssAsset.publicPath],
    ['__MANAGE_CSS__', cssAsset.publicPath],
    ['__API_DOCS_CSS__', apiDocsCssAsset.publicPath],
    ['__API_DOCS_JS__', apiDocsJsAsset.publicPath],
    ['__MANAGE_JS__', jsAsset.publicPath],
    ['__CHART_JS__', chartAsset.publicPath],
    ['__ALPINE_JS__', alpineAsset.publicPath],
    ['__APP_RELEASE_TAG__', APP_RELEASE_TAG],
  ].reduce(
    (template, [placeholder, assetPath]) => replacePlaceholder(template, placeholder, assetPath),
    htmlTemplate
  )
  writeFile(path.join(publicDir, 'index.html'), html)
  writeFile(
    path.join(publicDir, 'api-docs.html'),
    renderDocsAppHtml(docsAppTemplate, {
      title: publicDocsSpec.info?.title || 'kemail API Docs',
      description: publicDocsSpec.info?.description || '',
      foundationCssPath: foundationCssAsset.publicPath,
      docsCssPath: apiDocsCssAsset.publicPath,
      docsJsPath: apiDocsJsAsset.publicPath,
      bootstrap: {
        title: publicDocsSpec.info?.title || 'kemail API Docs',
        description: publicDocsSpec.info?.description || '',
        mode: 'public',
        machineHref: '/openapi.json',
        machineLabel: '/openapi.json',
        specUrl: '/api-docs-spec.json',
      },
    })
  )
  removeGeneratedFile('admin-api-docs.html')
  writeFile(path.join(publicDir, 'api-docs-spec.json'), `${prettyJson(publicDocsSpec)}\n`)
  writeFile(path.join(publicDir, 'openapi.json'), `${prettyJson(publicOpenapiSpec)}\n`)
  writeFile(path.join(publicDir, 'admin-openapi.json'), `${prettyJson(adminOpenapiSpec)}\n`)

  const headerLines = [
    '/index.html',
    '  Cache-Control: no-store',
    '  Referrer-Policy: no-referrer',
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: DENY',
    `  Content-Security-Policy: ${HTML_CSP}`,
    '',
    '/',
    '  Cache-Control: no-store',
    '  Referrer-Policy: no-referrer',
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: DENY',
    `  Content-Security-Policy: ${HTML_CSP}`,
    '',
    '/api-docs',
    '  Cache-Control: no-store',
    '  Referrer-Policy: no-referrer',
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: DENY',
    `  Content-Security-Policy: ${HTML_CSP}`,
    '',
    '/api-docs.html',
    '  Cache-Control: no-store',
    '  Referrer-Policy: no-referrer',
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: DENY',
    `  Content-Security-Policy: ${HTML_CSP}`,
    '',
    '/openapi.json',
    '  Cache-Control: no-store',
    '  Referrer-Policy: no-referrer',
    '  X-Content-Type-Options: nosniff',
    '',
    '/api-docs-spec.json',
    '  Cache-Control: no-store',
    '  Referrer-Policy: no-referrer',
    '  X-Content-Type-Options: nosniff',
    '',
  ]

  assets.forEach((asset) => {
    headerLines.push(asset.publicPath)
    headerLines.push('  Cache-Control: public, max-age=31536000, immutable')
    headerLines.push('  X-Content-Type-Options: nosniff')
    headerLines.push('')
  })

  headerLines.push('/assets/manage.latest.css')
  headerLines.push('  Cache-Control: no-store')
  headerLines.push('  X-Content-Type-Options: nosniff')
  headerLines.push('')
  headerLines.push('/assets/manage.latest.js')
  headerLines.push('  Cache-Control: no-store')
  headerLines.push('  X-Content-Type-Options: nosniff')
  headerLines.push('')
  headerLines.push('/assets/api-docs.latest.css')
  headerLines.push('  Cache-Control: no-store')
  headerLines.push('  X-Content-Type-Options: nosniff')
  headerLines.push('')
  headerLines.push('/assets/api-docs.latest.js')
  headerLines.push('  Cache-Control: no-store')
  headerLines.push('  X-Content-Type-Options: nosniff')
  headerLines.push('')
  headerLines.push('/assets/ui-foundation.latest.css')
  headerLines.push('  Cache-Control: no-store')
  headerLines.push('  X-Content-Type-Options: nosniff')
  headerLines.push('')
  headerLines.push('/assets/vendor-chart.latest.js')
  headerLines.push('  Cache-Control: no-store')
  headerLines.push('  X-Content-Type-Options: nosniff')
  headerLines.push('')
  headerLines.push('/assets/vendor-alpine.latest.js')
  headerLines.push('  Cache-Control: no-store')
  headerLines.push('  X-Content-Type-Options: nosniff')
  headerLines.push('')

  writeFile(path.join(publicDir, '_headers'), headerLines.join('\n'))

  process.stdout.write(
    JSON.stringify(
      {
        css: cssAsset.publicPath,
        foundationCss: foundationCssAsset.publicPath,
        js: jsAsset.publicPath,
        apiDocsCss: apiDocsCssAsset.publicPath,
        apiDocsJs: apiDocsJsAsset.publicPath,
        chart: chartAsset.publicPath,
        alpine: alpineAsset.publicPath,
        docs: '/api-docs',
        docsSpec: '/api-docs-spec.json',
        openapi: '/openapi.json',
        adminOpenapi: '/api/admin/openapi',
      },
      null,
      2
    ) + '\n'
  )
}

buildManageAssets()
