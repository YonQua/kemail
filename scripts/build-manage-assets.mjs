import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const rootDir = process.cwd()
const sourceDir = path.join(rootDir, 'manage-src')
const sourceAssetsDir = path.join(sourceDir, 'assets')
const sourceVendorDir = path.join(sourceDir, 'vendor')
const specsDir = path.join(rootDir, 'specs')
const publicDir = path.join(rootDir, 'public')
const publicAssetsDir = path.join(publicDir, 'assets')
const MANAGED_ASSET_NAMES = new Set(['manage', 'api-docs', 'vendor-chart', 'vendor-alpine'])
const MANAGED_ASSET_LATEST_ALIASES = new Map([
  ['manage.css', 'manage.latest.css'],
  ['manage.js', 'manage.latest.js'],
  ['api-docs.css', 'api-docs.latest.css'],
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

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2)
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value))
}

function isHttpOperationMethod(value) {
  return ['get', 'post', 'put', 'delete', 'patch'].includes(value)
}

function toPythonLiteral(value, indent = 0) {
  const space = ' '.repeat(indent)
  const childSpace = ' '.repeat(indent + 4)

  if (value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value
      .map((item) => `${childSpace}${toPythonLiteral(item, indent + 4)}`)
      .join(',\n')}\n${space}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return '{}'
    return `{\n${entries
      .map(
        ([key, item]) => `${childSpace}${JSON.stringify(key)}: ${toPythonLiteral(item, indent + 4)}`
      )
      .join(',\n')}\n${space}}`
  }
  return JSON.stringify(String(value))
}

function readMediaExample(media) {
  if (!media || typeof media !== 'object') return null
  if (Object.prototype.hasOwnProperty.call(media, 'example')) return media.example

  const examples = media.examples
  if (examples && typeof examples === 'object') {
    const firstExample = Object.values(examples).find((item) => item && 'value' in item)
    if (firstExample) return firstExample.value
  }

  if (media.schema && Object.prototype.hasOwnProperty.call(media.schema, 'example')) {
    return media.schema.example
  }

  return null
}

function getOperationParameters(pathItem, operation) {
  const pathParameters = Array.isArray(pathItem?.parameters) ? pathItem.parameters : []
  const operationParameters = Array.isArray(operation?.parameters) ? operation.parameters : []
  return [...pathParameters, ...operationParameters]
}

function getParameterExample(parameter) {
  if (Object.prototype.hasOwnProperty.call(parameter, 'example')) return parameter.example
  if (parameter?.schema && Object.prototype.hasOwnProperty.call(parameter.schema, 'example')) {
    return parameter.schema.example
  }
  if (parameter?.required) return `replace_${parameter.name}`
  return ''
}

function buildResolvedOperationUrl(serverUrl, pathKey, pathItem, operation) {
  const parameters = getOperationParameters(pathItem, operation)
  let resolvedPath = pathKey
  const searchParams = new URLSearchParams()

  parameters.forEach((parameter) => {
    const example = getParameterExample(parameter)
    if (parameter?.in === 'path') {
      resolvedPath = resolvedPath.replaceAll(
        `{${parameter.name}}`,
        encodeURIComponent(String(example || parameter.name))
      )
    }

    if (parameter?.in === 'query' && example !== '') {
      searchParams.set(parameter.name, String(example))
    }
  })

  const query = searchParams.toString()
  return `${serverUrl}${resolvedPath}${query ? `?${query}` : ''}`
}

function getRequestBodyExample(operation) {
  const media = operation?.requestBody?.content?.['application/json']
  return readMediaExample(media)
}

function getSuccessResponse(operation) {
  const responseEntries = Object.entries(operation?.responses || {})
  return (
    responseEntries.find(([status]) => /^2\d\d$/.test(status)) ||
    responseEntries.find(([status]) => status === 'default') ||
    null
  )
}

function getSuccessResponseExample(operation) {
  const success = getSuccessResponse(operation)
  if (!success) return null
  return readMediaExample(success[1]?.content?.['application/json'])
}

function getErrorResponses(operation) {
  return Object.entries(operation?.responses || {})
    .filter(([status]) => !/^2\d\d$/.test(status))
    .map(([status, response]) => ({
      status,
      description: response?.description || '未说明',
    }))
}

function renderCodeBlock(code, className = 'code-block') {
  return `<pre class="${className}"><code>${escapeHtml(code)}</code></pre>`
}

function buildCurlExample(method, url, requestBody) {
  const lines = [
    `curl -X ${method.toUpperCase()} "${url}"`,
    '  -H "Authorization: Bearer YOUR_TOKEN"',
    '  -H "Accept: application/json"',
  ]

  if (requestBody != null) {
    lines.push('  -H "Content-Type: application/json"')
    lines.push(`  -d '${prettyJson(requestBody)}'`)
  }

  return lines.join(' \\\n')
}

function buildPythonExample(method, url, requestBody) {
  const lines = [
    'import requests',
    '',
    `url = "${url}"`,
    'headers = {',
    '    "Authorization": "Bearer YOUR_TOKEN",',
    '    "Accept": "application/json",',
  ]

  if (requestBody != null) {
    lines.push('    "Content-Type": "application/json",')
  }

  lines.push('}')
  lines.push('')
  lines.push(`response = requests.${method.toLowerCase()}(`)
  lines.push('    url,')
  lines.push('    headers=headers,')
  if (requestBody != null) {
    lines.push(`    json=${toPythonLiteral(requestBody, 4).replace(/\n/g, '\n    ')},`)
  }
  lines.push('    timeout=30,')
  lines.push(')')
  lines.push('response.raise_for_status()')
  lines.push('print(response.json())')
  return lines.join('\n')
}

function buildJsExample(method, url, requestBody) {
  const lines = [
    `const response = await fetch("${url}", {`,
    `  method: "${method.toUpperCase()}",`,
    '  headers: {',
    '    "Authorization": "Bearer YOUR_TOKEN",',
    '    "Accept": "application/json",',
  ]

  if (requestBody != null) {
    lines.push('    "Content-Type": "application/json",')
  }

  lines.push('  },')
  if (requestBody != null) {
    lines.push(`  body: JSON.stringify(${prettyJson(requestBody).replace(/\n/g, '\n  ')}),`)
  }
  lines.push('})')
  lines.push('')
  lines.push('if (!response.ok) {')
  lines.push('  throw new Error(`HTTP ${response.status}`)')
  lines.push('}')
  lines.push('')
  lines.push('const data = await response.json()')
  lines.push('console.log(data)')
  return lines.join('\n')
}

function renderParameterTable(parameters, location) {
  const rows = parameters.filter((parameter) => parameter?.in === location)
  if (rows.length === 0) return ''

  const locationLabel = location === 'path' ? '路径参数' : '查询参数'
  const body = rows
    .map((parameter) => {
      const example = getParameterExample(parameter)
      const schemaType = parameter?.schema?.type || 'string'
      return `<tr>
        <td><span class="param-name">${escapeHtml(parameter.name)}</span></td>
        <td>${parameter.required ? '<span class="param-required">必填</span>' : '可选'}</td>
        <td>${escapeHtml(schemaType)}</td>
        <td>${escapeHtml(example)}</td>
        <td>${escapeHtml(parameter.description || '')}</td>
      </tr>`
    })
    .join('')

  return `<div class="operation-block">
    <h3>${locationLabel}</h3>
    <table class="param-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>必填</th>
          <th>类型</th>
          <th>示例</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>`
}

function renderRequestBody(operation) {
  const requestBody = operation?.requestBody
  if (!requestBody?.content?.['application/json']) return ''

  const media = requestBody.content['application/json']
  const example = readMediaExample(media)
  const description = requestBody.description || 'JSON 请求体'

  return `<div class="operation-block">
    <h3>请求体</h3>
    <p class="callout">${escapeHtml(description)}${requestBody.required ? '（必填）' : '（可选）'}</p>
    ${example == null ? '' : renderCodeBlock(prettyJson(example), 'json-block')}
  </div>`
}

function renderCodeExamples(serverUrl, pathKey, pathItem, operation) {
  const url = buildResolvedOperationUrl(serverUrl, pathKey, pathItem, operation)
  const requestBody = getRequestBodyExample(operation)
  const curlCode = buildCurlExample(operation.method, url, requestBody)
  const pythonCode = buildPythonExample(operation.method, url, requestBody)
  const jsCode = buildJsExample(operation.method, url, requestBody)

  return `<div class="operation-block">
    <h3>调用示例</h3>
    <div class="code-examples">
      <details open>
        <summary>cURL</summary>
        ${renderCodeBlock(curlCode)}
      </details>
      <details>
        <summary>Python</summary>
        ${renderCodeBlock(pythonCode)}
      </details>
      <details>
        <summary>JavaScript</summary>
        ${renderCodeBlock(jsCode)}
      </details>
    </div>
  </div>`
}

function renderResponseExample(operation) {
  const example = getSuccessResponseExample(operation)
  if (example == null) return ''

  return `<div class="operation-block">
    <h3>成功返回示例</h3>
    ${renderCodeBlock(prettyJson(example), 'json-block')}
  </div>`
}

function renderErrorResponses(operation) {
  const errors = getErrorResponses(operation)
  if (errors.length === 0) return ''

  return `<div class="operation-block">
    <h3>常见错误</h3>
    <div class="response-list">
      ${errors
        .map(
          (item) =>
            `<div class="response-item"><strong>${escapeHtml(item.status)}</strong><span>${escapeHtml(item.description)}</span></div>`
        )
        .join('')}
    </div>
  </div>`
}

function renderOperationCard(serverUrl, pathKey, pathItem, method, operation, tagInfo) {
  const permission = operation['x-permission'] || 'read'
  const scope = operation['x-scope'] || (tagInfo?.name === 'external' ? 'external' : 'admin')
  const parameters = getOperationParameters(pathItem, operation)
  const pathParameters = renderParameterTable(parameters, 'path')
  const queryParameters = renderParameterTable(parameters, 'query')
  const successResponse = getSuccessResponse(operation)
  const successStatus = successResponse ? successResponse[0] : '200'
  const methodLabel = method.toUpperCase()
  const deprecatedBadge = operation.deprecated
    ? '<span class="deprecated-pill">deprecated</span>'
    : ''

  return `<article class="operation-card" id="${escapeAttr(`operation-${method}-${slugify(pathKey)}`)}">
    <div class="operation-topline">
      <span class="method-pill">${escapeHtml(methodLabel)}</span>
      <span class="scope-pill scope-${escapeAttr(scope)}">${escapeHtml(
        scope === 'external' ? '对外集成' : '后台管理'
      )}</span>
      <span class="permission-pill permission-${escapeAttr(permission)}">${escapeHtml(
        permission === 'admin' ? '管理员密钥' : '只读或管理员密钥'
      )}</span>
      ${deprecatedBadge}
    </div>
    <h3 class="operation-path">${escapeHtml(pathKey)}</h3>
    <p class="operation-summary">${escapeHtml(operation.summary || '')}</p>
    <div class="operation-meta-grid">
      <div class="meta-box">
        <span>接口说明</span>
        <strong>${escapeHtml(operation.description || '未补充额外说明')}</strong>
      </div>
      <div class="meta-box">
        <span>成功响应</span>
        <strong>${escapeHtml(successStatus)}</strong>
      </div>
      <div class="meta-box">
        <span>契约来源</span>
        <strong>OpenAPI operationId: ${escapeHtml(operation.operationId || '')}</strong>
      </div>
    </div>
    ${pathParameters}
    ${queryParameters}
    ${renderRequestBody(operation)}
    ${renderCodeExamples(serverUrl, pathKey, pathItem, operation)}
    ${renderResponseExample(operation)}
    ${renderErrorResponses(operation)}
  </article>`
}

function renderQuickstartCard(operationMap, entry) {
  const operation = operationMap.get(`${entry.method.toLowerCase()} ${entry.path}`)
  if (!operation) return ''

  return `<article class="quickstart-card">
    <span>${escapeHtml(entry.kicker || '推荐流程')}</span>
    <strong>${escapeHtml(entry.title)}</strong>
    <p>${escapeHtml(entry.description || operation.summary || '')}</p>
    <code>${escapeHtml(`${entry.method.toUpperCase()} ${entry.path}`)}</code>
  </article>`
}

function renderOverviewCards(spec) {
  const securityDescription =
    spec.components?.securitySchemes?.BearerAuth?.description || 'Bearer 鉴权'
  const responseEnvelope =
    spec['x-docs']?.responseEnvelope ||
    '所有接口默认返回 `{ ok: true, ... }` 或 `{ ok: false, error: "..." }`'
  const contractInfo =
    spec['x-docs']?.contractInfo || '推荐把 `/openapi.json` 作为 AI 与第三方工具的单一契约源'

  return [
    {
      kicker: '鉴权',
      title: '统一使用 Bearer API Key',
      description: securityDescription,
    },
    {
      kicker: '响应包络',
      title: '默认保持 ok/error 结构',
      description: responseEnvelope,
    },
    {
      kicker: '契约入口',
      title: '机器可读与人类可读同时提供',
      description: contractInfo,
    },
  ]
    .map(
      (item) => `<article class="overview-card">
        <span>${escapeHtml(item.kicker)}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.description)}</p>
      </article>`
    )
    .join('')
}

function renderHeroActionLinks(tags, openapiHref) {
  const links = []

  if (openapiHref) {
    links.push(
      `<a class="hero-link hero-link-primary" href="${escapeAttr(openapiHref)}">查看机器可读规范</a>`
    )
  }

  tags.forEach((tag) => {
    const anchor = `section-${slugify(tag.name)}`
    const title = tag['x-title'] || tag.name
    links.push(`<a class="hero-link" href="#${escapeAttr(anchor)}">跳到${escapeHtml(title)}</a>`)
  })

  return links.join('')
}

function filterSpecByTags(spec, allowedTags, overrides = {}) {
  const allowedTagSet = new Set(allowedTags)
  const nextSpec = cloneJsonValue(spec)
  const filteredPaths = {}
  const allowedOperationKeys = new Set()

  for (const [pathKey, pathItem] of Object.entries(spec.paths || {})) {
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
        (operationTags.length === 0 && allowedTagSet.has('external'))

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

  const bearerAuth = nextSpec.components?.securitySchemes?.BearerAuth
  if (bearerAuth && overrides.securityDescription) {
    bearerAuth.description = overrides.securityDescription
  }

  return nextSpec
}

function renderApiDocs(spec, apiDocsCssPath, options = {}) {
  const template = readFile(path.join(sourceDir, 'api-docs.template.html'))
  const serverUrl = spec.servers?.[0]?.url || ''
  const tags = Array.isArray(spec.tags) ? spec.tags : []
  const openapiHref = options.openapiHref || '/openapi.json'
  const openapiLabel = options.openapiLabel || openapiHref
  const operationMap = new Map()
  const groupedOperations = new Map(tags.map((tag) => [tag.name, []]))

  for (const [pathKey, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!isHttpOperationMethod(method)) continue
      const normalizedOperation = { ...operation, method }
      operationMap.set(`${method} ${pathKey}`, normalizedOperation)
      const primaryTag =
        Array.isArray(operation.tags) && operation.tags.length > 0 ? operation.tags[0] : 'external'
      if (!groupedOperations.has(primaryTag)) {
        groupedOperations.set(primaryTag, [])
      }
      groupedOperations
        .get(primaryTag)
        .push({ pathKey, pathItem, method, operation: normalizedOperation })
    }
  }

  const nav = tags
    .map((tag) => {
      const anchor = `section-${slugify(tag.name)}`
      return `<a href="#${escapeAttr(anchor)}">${escapeHtml(tag['x-title'] || tag.name)}</a>`
    })
    .join('')

  const quickstart = (spec['x-docs']?.quickstart || [])
    .map((entry) => renderQuickstartCard(operationMap, entry))
    .join('')

  const sections = tags
    .map((tag) => {
      const operations = groupedOperations.get(tag.name) || []
      if (operations.length === 0) return ''
      const anchor = `section-${slugify(tag.name)}`
      const cards = operations
        .sort((left, right) => {
          const leftOrder = left.operation['x-order'] || 999
          const rightOrder = right.operation['x-order'] || 999
          if (leftOrder !== rightOrder) return leftOrder - rightOrder
          return `${left.method} ${left.pathKey}`.localeCompare(`${right.method} ${right.pathKey}`)
        })
        .map((item) =>
          renderOperationCard(
            serverUrl,
            item.pathKey,
            item.pathItem,
            item.method,
            item.operation,
            tag
          )
        )
        .join('')

      return `<section class="docs-section" id="${escapeAttr(anchor)}">
        <div class="docs-section-head">
          <div>
            <p class="section-kicker">${escapeHtml(tag['x-kicker'] || 'API Group')}</p>
            <h2>${escapeHtml(tag['x-title'] || tag.name)}</h2>
            <p class="docs-section-intro">${escapeHtml(tag.description || '')}</p>
          </div>
          <div class="section-count">${escapeHtml(`${operations.length} 个接口`)}</div>
        </div>
        <div class="operations-grid">${cards}</div>
      </section>`
    })
    .join('')

  return [
    ['__API_DOCS_TITLE__', escapeHtml(spec.info?.title || 'kemail API Docs')],
    ['__API_DOCS_META_DESCRIPTION__', escapeAttr(spec.info?.description || '')],
    ['__API_DOCS_CSS__', apiDocsCssPath],
    ['__API_DOCS_DESCRIPTION__', escapeHtml(spec.info?.description || '')],
    ['__API_SERVER_URL__', escapeHtml(serverUrl)],
    ['__OPENAPI_JSON_LABEL__', escapeHtml(openapiLabel)],
    ['__API_VERSION__', escapeHtml(spec.info?.version || '')],
    ['__API_DOCS_HERO_LINKS__', renderHeroActionLinks(tags, openapiHref)],
    ['__API_DOCS_NAV__', nav],
    ['__API_DOCS_OVERVIEW_CARDS__', renderOverviewCards(spec)],
    ['__API_DOCS_QUICKSTART__', quickstart],
    ['__API_DOCS_SECTIONS__', sections],
  ].reduce((html, [placeholder, value]) => replacePlaceholder(html, placeholder, value), template)
}

function buildManageAssets() {
  ensureDir(publicAssetsDir)

  const htmlTemplate = readFile(path.join(sourceDir, 'index.template.html'))
  const fullOpenapiSpec = readJson(path.join(specsDir, 'openapi.json'))
  const publicOpenapiSpec = filterSpecByTags(fullOpenapiSpec, ['external'], {
    infoTitle: 'kemail API Docs',
    infoDescription:
      'kemail 的公开对外接口契约。公开发布的 `/openapi.json` 与 `/api-docs` 只包含第三方集成常用接口。',
    contractInfo:
      '公开 `/openapi.json` 仅包含对外集成接口；后台管理接口与内部契约请在管理员控制台内查看。',
    securityDescription:
      '统一使用 `Authorization: Bearer <TOKEN>`。公开契约中的发号、查信和删信接口都可使用只读密钥或管理员密钥；星标、标记已读、富解析、原始 MIME 与域名池管理仍需管理员密钥。',
  })
  const adminOpenapiSpec = filterSpecByTags(
    fullOpenapiSpec,
    ['external', 'admin-mail', 'admin-analytics', 'admin-domains'],
    {
      infoTitle: 'kemail Admin API Docs',
      infoDescription:
        'kemail 的完整后台接口契约，包含对外集成接口与后台管理接口。此版本只通过管理员受保护入口提供。',
      contractInfo: '完整后台契约只通过管理页中的受保护入口提供，不对公开访客直接暴露。',
    }
  )

  const cssAsset = buildHashedAsset(path.join(sourceAssetsDir, 'manage.css'), 'manage', 'css')
  const apiDocsCssAsset = buildHashedAsset(
    path.join(sourceAssetsDir, 'api-docs.css'),
    'api-docs',
    'css'
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
  const assets = [cssAsset, apiDocsCssAsset, jsAsset, chartAsset, alpineAsset]

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
    ['__MANAGE_CSS__', cssAsset.publicPath],
    ['__MANAGE_JS__', jsAsset.publicPath],
    ['__CHART_JS__', chartAsset.publicPath],
    ['__ALPINE_JS__', alpineAsset.publicPath],
  ].reduce(
    (template, [placeholder, assetPath]) => replacePlaceholder(template, placeholder, assetPath),
    htmlTemplate
  )
  writeFile(path.join(publicDir, 'index.html'), html)
  writeFile(
    path.join(publicDir, 'api-docs.html'),
    renderApiDocs(publicOpenapiSpec, apiDocsCssAsset.publicPath, {
      openapiHref: '/openapi.json',
      openapiLabel: '/openapi.json',
    })
  )
  writeFile(
    path.join(publicDir, 'admin-api-docs.html'),
    renderApiDocs(adminOpenapiSpec, apiDocsCssAsset.publicPath, {
      openapiHref: '/api/admin/openapi',
      openapiLabel: '内部 OpenAPI（管理员）',
    })
  )
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
        js: jsAsset.publicPath,
        apiDocsCss: apiDocsCssAsset.publicPath,
        chart: chartAsset.publicPath,
        alpine: alpineAsset.publicPath,
        docs: '/api-docs',
        openapi: '/openapi.json',
        adminDocs: '/api/admin/docs',
        adminOpenapi: '/api/admin/openapi',
      },
      null,
      2
    ) + '\n'
  )
}

buildManageAssets()
