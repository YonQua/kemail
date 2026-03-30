;(function () {
  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
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

  function toPythonLiteral(value, indent = 0) {
    const space = ' '.repeat(indent)
    const childSpace = ' '.repeat(indent + 4)

    if (value === null) return 'None'
    if (value === true) return 'True'
    if (value === false) return 'False'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'string') return JSON.stringify(value)
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
          ([key, item]) =>
            `${childSpace}${JSON.stringify(key)}: ${toPythonLiteral(item, indent + 4)}`
        )
        .join(',\n')}\n${space}}`
    }
    return JSON.stringify(String(value))
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
          <td><span class="docs-view__param-name">${escapeHtml(parameter.name)}</span></td>
          <td>${parameter.required ? '<span class="docs-view__pill docs-view__pill--required">必填</span>' : '可选'}</td>
          <td>${escapeHtml(schemaType)}</td>
          <td>${escapeHtml(example)}</td>
          <td>${escapeHtml(parameter.description || '')}</td>
        </tr>`
      })
      .join('')

    return `<section class="docs-view__block">
      <h4>${locationLabel}</h4>
      <div class="docs-view__table-wrap">
        <table class="docs-view__table">
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
      </div>
    </section>`
  }

  function renderCodeBlock(code, copyLabel = '复制') {
    return `<div class="docs-view__code-wrap">
      <button type="button" class="docs-view__copy-btn" data-copy-text="${encodeURIComponent(code)}">${escapeHtml(copyLabel)}</button>
      <pre class="docs-view__code-block"><code>${escapeHtml(code)}</code></pre>
    </div>`
  }

  function renderRequestBody(operation) {
    const requestBody = operation?.requestBody
    if (!requestBody?.content?.['application/json']) return ''

    const media = requestBody.content['application/json']
    const example = readMediaExample(media)
    const description = requestBody.description || 'JSON 请求体'

    return `<section class="docs-view__block">
      <h4>请求体</h4>
      <p class="docs-view__callout">${escapeHtml(description)}${requestBody.required ? '（必填）' : '（可选）'}</p>
      ${example == null ? '' : renderCodeBlock(prettyJson(example), '复制示例')}
    </section>`
  }

  let codeExampleCounter = 0

  function renderCodeExamples(serverUrl, pathKey, pathItem, operation) {
    const url = buildResolvedOperationUrl(serverUrl, pathKey, pathItem, operation)
    const requestBody = getRequestBodyExample(operation)
    const exampleId = `code-example-${++codeExampleCounter}`
    const examples = [
      {
        key: 'curl',
        label: 'cURL',
        copyLabel: '复制 cURL',
        code: buildCurlExample(operation.method, url, requestBody),
      },
      {
        key: 'python',
        label: 'Python',
        copyLabel: '复制 Python',
        code: buildPythonExample(operation.method, url, requestBody),
      },
      {
        key: 'javascript',
        label: 'JavaScript',
        copyLabel: '复制 JS',
        code: buildJsExample(operation.method, url, requestBody),
      },
    ]

    return `<section class="docs-view__block">
      <h4>调用示例</h4>
      <div class="docs-view__code-examples" data-code-example="${escapeHtml(exampleId)}">
        <div class="docs-view__code-tabs" role="tablist" aria-label="调用示例语言">
          ${examples
            .map(
              (item, index) => `<button
                type="button"
                class="docs-view__code-tab${index === 0 ? ' is-active' : ''}"
                role="tab"
                aria-selected="${index === 0 ? 'true' : 'false'}"
                data-code-lang="${escapeHtml(item.key)}"
              >${escapeHtml(item.label)}</button>`
            )
            .join('')}
        </div>
        <div class="docs-view__code-panels">
          ${examples
            .map(
              (item, index) => `<div
                class="docs-view__code-panel${index === 0 ? ' is-active' : ''}"
                data-code-panel="${escapeHtml(item.key)}"
                ${index === 0 ? '' : 'hidden'}
              >${renderCodeBlock(item.code, item.copyLabel)}</div>`
            )
            .join('')}
        </div>
      </div>
    </section>`
  }

  function renderResponseExample(operation) {
    const example = getSuccessResponseExample(operation)
    if (example == null) return ''

    return `<section class="docs-view__block">
      <h4>成功返回示例</h4>
      ${renderCodeBlock(prettyJson(example), '复制返回')}
    </section>`
  }

  function renderErrorResponses(operation) {
    const errors = getErrorResponses(operation)
    if (errors.length === 0) return ''

    return `<section class="docs-view__block">
      <h4>常见错误</h4>
      <div class="docs-view__response-list">
        ${errors
          .map(
            (item) =>
              `<div class="docs-view__response-item"><strong>${escapeHtml(item.status)}</strong><span>${escapeHtml(item.description)}</span></div>`
          )
          .join('')}
      </div>
    </section>`
  }

  function permissionLabel(operation) {
    const permission = operation['x-permission'] || 'read'
    if (permission === 'public') return '公开接口'
    if (permission === 'admin') return '管理员密钥'
    return '只读或管理员密钥'
  }

  function scopeLabel(operation) {
    return operation['x-scope'] === 'admin' ? '后台管理' : '对外集成'
  }

  function renderOperationCard(serverUrl, pathKey, pathItem, method, operation) {
    const parameters = getOperationParameters(pathItem, operation)
    const successResponse = getSuccessResponse(operation)
    const successStatus = successResponse ? successResponse[0] : '200'

    return `<article class="docs-view__operation-card" id="${escapeHtml(`operation-${method}-${slugify(pathKey)}`)}">
      <div class="docs-view__operation-topline">
        <span class="docs-view__pill docs-view__pill--method">${escapeHtml(method.toUpperCase())}</span>
        <span class="docs-view__pill docs-view__pill--scope">${escapeHtml(scopeLabel(operation))}</span>
        <span class="docs-view__pill docs-view__pill--permission">${escapeHtml(permissionLabel(operation))}</span>
      </div>
      <h3 class="docs-view__operation-path">${escapeHtml(pathKey)}</h3>
      <p class="docs-view__operation-summary">${escapeHtml(operation.summary || '')}</p>
      <div class="docs-view__meta-grid">
        <div class="docs-view__meta-box">
          <span>接口说明</span>
          <strong>${escapeHtml(operation.description || '未补充额外说明')}</strong>
        </div>
        <div class="docs-view__meta-box">
          <span>成功响应</span>
          <strong>${escapeHtml(successStatus)}</strong>
        </div>
        <div class="docs-view__meta-box">
          <span>契约来源</span>
          <strong>${escapeHtml(operation.operationId || '') || '-'}</strong>
        </div>
      </div>
      ${renderParameterTable(parameters, 'path')}
      ${renderParameterTable(parameters, 'query')}
      ${renderRequestBody(operation)}
      ${renderCodeExamples(serverUrl, pathKey, pathItem, operation)}
      ${renderResponseExample(operation)}
      ${renderErrorResponses(operation)}
    </article>`
  }

  function renderOverviewCards(spec, options) {
    const securityDescription =
      spec.components?.securitySchemes?.BearerAuth?.description || '统一使用 Bearer API Key'
    const responseEnvelope =
      spec['x-docs']?.responseEnvelope ||
      '所有接口默认返回 `{ ok: true, ... }` 或 `{ ok: false, error: "..." }`'
    const contractInfo =
      spec['x-docs']?.contractInfo || '推荐把 `/openapi.json` 作为 AI 与第三方工具的单一契约源'

    return [
      {
        kicker: options.mode === 'admin' ? '内部模式' : '公开模式',
        title: options.mode === 'admin' ? '当前查看内部接口文档' : '当前查看公开主链接口',
        description:
          options.mode === 'admin'
            ? '此视图包含公开主链、调试回溯与后台管理能力，仅管理员密钥可见。'
            : '此视图只保留最推荐给第三方自动化与 AI 的主链能力。',
      },
      {
        kicker: '鉴权',
        title: '统一使用 Bearer API Key',
        description: securityDescription,
      },
      {
        kicker: '契约入口',
        title: '人类文档与机器契约分层提供',
        description: contractInfo || responseEnvelope,
      },
    ]
      .map(
        (item) => `<article class="docs-view__overview-card">
          <span>${escapeHtml(item.kicker)}</span>
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.description)}</p>
        </article>`
      )
      .join('')
  }

  function renderQuickstartCards(operationMap, spec) {
    const quickstart = Array.isArray(spec['x-docs']?.quickstart) ? spec['x-docs'].quickstart : []
    if (quickstart.length === 0) return ''

    return `<section class="docs-view__section">
      <div class="docs-view__section-head">
        <div>
          <p class="docs-view__section-kicker">Quick Start</p>
          <h2>最常见调用流程</h2>
          <p class="docs-view__section-intro">先跑通主链，再根据侧栏进入具体接口。</p>
        </div>
      </div>
      <div class="docs-view__quickstart-grid">
        ${quickstart
          .map((entry) => {
            const operation = operationMap.get(
              `${String(entry.method || '').toLowerCase()} ${entry.path}`
            )
            if (!operation) return ''
            return `<article class="docs-view__quickstart-card">
              <span>${escapeHtml(entry.kicker || '推荐流程')}</span>
              <strong>${escapeHtml(entry.title || operation.summary || '')}</strong>
              <p>${escapeHtml(entry.description || operation.description || '')}</p>
              <code>${escapeHtml(`${String(entry.method || '').toUpperCase()} ${entry.path}`)}</code>
            </article>`
          })
          .join('')}
      </div>
    </section>`
  }

  function renderEmbeddedQuickstart(operationMap, spec) {
    const quickstart = Array.isArray(spec['x-docs']?.quickstart) ? spec['x-docs'].quickstart : []
    if (quickstart.length === 0) return ''

    const items = quickstart
      .map((entry) => {
        const operation = operationMap.get(
          `${String(entry.method || '').toLowerCase()} ${entry.path}`
        )
        if (!operation) return ''
        const anchor = `operation-${String(entry.method || '').toLowerCase()}-${slugify(entry.path)}`
        return `<a class="docs-view__guide-step" href="#${escapeHtml(anchor)}">
          <span>${escapeHtml(entry.kicker || '推荐流程')}</span>
          <strong>${escapeHtml(entry.title || operation.summary || '')}</strong>
          <code>${escapeHtml(`${String(entry.method || '').toUpperCase()} ${entry.path}`)}</code>
        </a>`
      })
      .join('')

    if (!items) return ''

    return `<section class="docs-view__embedded-guide">
      <div class="docs-view__embedded-guide-head">
        <p class="docs-view__section-kicker">Quick Start</p>
        <h3>推荐流程</h3>
      </div>
      <div class="docs-view__embedded-guide-steps">${items}</div>
    </section>`
  }

  function renderSections(spec, options) {
    const tags = Array.isArray(spec.tags) ? spec.tags : []
    const operationMap = new Map()
    const groupedOperations = new Map(tags.map((tag) => [tag.name, []]))

    for (const [pathKey, pathItem] of Object.entries(spec.paths || {})) {
      for (const [method, operation] of Object.entries(pathItem || {})) {
        if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue
        const normalizedOperation = { ...operation, method }
        operationMap.set(`${method} ${pathKey}`, normalizedOperation)
        const primaryTag =
          Array.isArray(operation.tags) && operation.tags.length > 0
            ? operation.tags[0]
            : 'external-core'
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
        const label = tag['x-title'] || tag.name
        return `<a href="#${escapeHtml(anchor)}">${escapeHtml(label)}</a>`
      })
      .join('')

    const sections = tags
      .map((tag) => {
        const operations = groupedOperations.get(tag.name) || []
        if (operations.length === 0) return ''

        const cards = operations
          .sort((left, right) => {
            const leftOrder = left.operation['x-order'] || 999
            const rightOrder = right.operation['x-order'] || 999
            if (leftOrder !== rightOrder) return leftOrder - rightOrder
            return `${left.method} ${left.pathKey}`.localeCompare(
              `${right.method} ${right.pathKey}`
            )
          })
          .map((item) =>
            renderOperationCard(
              options.serverUrl,
              item.pathKey,
              item.pathItem,
              item.method,
              item.operation
            )
          )
          .join('')

        return `<section class="docs-view__section" id="${escapeHtml(`section-${slugify(tag.name)}`)}">
          <div class="docs-view__section-head">
            <div>
              <p class="docs-view__section-kicker">${escapeHtml(tag['x-kicker'] || 'API Group')}</p>
              <h2>${escapeHtml(tag['x-title'] || tag.name)}</h2>
              <p class="docs-view__section-intro">${escapeHtml(tag.description || '')}</p>
            </div>
            <div class="docs-view__section-count">${escapeHtml(`${operations.length} 个接口`)}</div>
          </div>
          <div class="docs-view__operations-grid">${cards}</div>
        </section>`
      })
      .join('')

    return {
      nav,
      sections,
      quickstart: renderQuickstartCards(operationMap, spec),
      embeddedQuickstart: renderEmbeddedQuickstart(operationMap, spec),
      tags,
    }
  }

  function renderDocsView(spec, rawOptions = {}) {
    const options = {
      embedded: false,
      mode: 'public',
      serverUrl:
        rawOptions.serverUrl ||
        window.location.origin ||
        spec.servers?.[0]?.url ||
        'https://mail.example.com',
      machineHref: rawOptions.machineHref || '',
      machineLabel: rawOptions.machineLabel || '',
      title: rawOptions.title || spec.info?.title || 'kemail API Docs',
      description: rawOptions.description || spec.info?.description || '',
      ...rawOptions,
    }

    const rendered = renderSections(spec, options)
    const heroActions = []
    if (options.machineHref && options.machineLabel) {
      heroActions.push(
        `<a class="docs-view__hero-link docs-view__hero-link--primary" href="${escapeHtml(options.machineHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(options.machineLabel)}</a>`
      )
    }
    rendered.nav &&
      heroActions.push(
        `<a class="docs-view__hero-link" href="#${escapeHtml(rendered.nav.includes('href="#') ? rendered.nav.match(/href="#([^"]+)/)?.[1] || '' : '')}">跳到接口分组</a>`
      )

    if (options.embedded) {
      const embeddedNav = (rendered.tags || [])
        .map((tag) => {
          const anchor = `section-${slugify(tag.name)}`
          return `<a class="docs-view__embedded-nav-link" href="#${escapeHtml(anchor)}">${escapeHtml(tag['x-title'] || tag.name)}</a>`
        })
        .join('')

      return `<div class="docs-view docs-view--embedded">
        ${embeddedNav ? `<nav class="docs-view__embedded-nav">${embeddedNav}</nav>` : ''}
        ${rendered.embeddedQuickstart}
        <div class="docs-view__embedded-sections">${rendered.sections}</div>
      </div>`
    }

    return `<div class="docs-view ${options.embedded ? 'docs-view--embedded' : 'docs-view--standalone'}">
      <header class="docs-view__hero">
        <div class="docs-view__hero-copy">
          <p class="docs-view__eyebrow">Contract-first Reference</p>
          <h1>${escapeHtml(options.title)}</h1>
          <p class="docs-view__hero-description">${escapeHtml(options.description)}</p>
          <div class="docs-view__hero-actions">${heroActions.join('')}</div>
        </div>
        <div class="docs-view__hero-meta">
          <div class="docs-view__hero-card">
            <span>Base URL</span>
            <strong>${escapeHtml(options.serverUrl)}</strong>
          </div>
          <div class="docs-view__hero-card">
            <span>模式</span>
            <strong>${escapeHtml(options.mode === 'admin' ? '内部接口' : '公开接口')}</strong>
          </div>
          <div class="docs-view__hero-card">
            <span>版本</span>
            <strong>${escapeHtml(spec.info?.version || '')}</strong>
          </div>
        </div>
      </header>
      <div class="docs-view__layout">
        <aside class="docs-view__sidebar">
          <div class="docs-view__sidebar-card">
            <p class="docs-view__sidebar-title">快速导航</p>
            <nav>${rendered.nav || '<span class="docs-view__sidebar-empty">暂无分组</span>'}</nav>
          </div>
        </aside>
        <div class="docs-view__content">
          <section class="docs-view__section docs-view__section--overview">
            <div class="docs-view__section-head">
              <div>
                <p class="docs-view__section-kicker">Overview</p>
                <h2>接入前先看这 3 件事</h2>
              </div>
            </div>
            <div class="docs-view__overview-grid">${renderOverviewCards(spec, options)}</div>
          </section>
          ${rendered.quickstart}
          ${rendered.sections}
        </div>
      </div>
    </div>`
  }

  function bindCopyButtons(root) {
    root.querySelectorAll('.docs-view__copy-btn').forEach((button) => {
      if (button.dataset.bound === '1') return
      button.dataset.bound = '1'
      button.addEventListener('click', async () => {
        const encoded = button.getAttribute('data-copy-text') || ''
        const text = decodeURIComponent(encoded)
        const originalLabel = button.textContent || '复制'
        try {
          await navigator.clipboard.writeText(text)
          button.textContent = '已复制'
        } catch (_) {
          button.textContent = '复制失败'
        }
        window.setTimeout(() => {
          button.textContent = originalLabel
        }, 1500)
      })
    })
  }

  function bindCodeTabs(root) {
    root.querySelectorAll('.docs-view__code-examples').forEach((group) => {
      if (group.dataset.bound === '1') return
      group.dataset.bound = '1'

      const tabs = [...group.querySelectorAll('.docs-view__code-tab')]
      const panels = [...group.querySelectorAll('.docs-view__code-panel')]

      tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
          const nextLang = tab.dataset.codeLang || ''
          tabs.forEach((item) => {
            const isActive = item === tab
            item.classList.toggle('is-active', isActive)
            item.setAttribute('aria-selected', isActive ? 'true' : 'false')
          })
          panels.forEach((panel) => {
            const isActive = panel.dataset.codePanel === nextLang
            panel.classList.toggle('is-active', isActive)
            panel.hidden = !isActive
          })
        })
      })
    })
  }

  function renderInto(root, spec, options = {}) {
    if (!root) return
    root.innerHTML = renderDocsView(spec, options)
    bindCodeTabs(root)
    bindCopyButtons(root)
  }

  async function loadJson(url) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    })

    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch (_) {
      throw new Error('文档规格不是合法 JSON')
    }

    if (!response.ok) {
      throw new Error((data && data.error) || `HTTP ${response.status}`)
    }

    return data || {}
  }

  function renderState(root, title, description) {
    root.innerHTML = `<section class="docs-view docs-view--standalone">
      <div class="docs-view__state">
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(description)}</p>
      </div>
    </section>`
  }

  async function mountStandaloneDocs() {
    const root = document.getElementById('docs-root')
    const bootstrapNode = document.getElementById('kemail-docs-bootstrap')
    if (!root || !bootstrapNode) return

    let bootstrap = null
    try {
      bootstrap = JSON.parse(bootstrapNode.textContent || '{}')
    } catch (_) {
      renderState(root, '文档加载失败', '启动配置不是合法 JSON')
      return
    }

    renderState(root, '加载文档中...', '正在准备当前页面的接口文档。')

    try {
      const spec = bootstrap.spec || (bootstrap.specUrl ? await loadJson(bootstrap.specUrl) : null)
      if (!spec) {
        throw new Error('缺少文档规格数据源')
      }

      renderInto(root, spec, {
        embedded: false,
        mode: bootstrap.mode || 'public',
        title: bootstrap.title || spec.info?.title || 'kemail API Docs',
        description: bootstrap.description || spec.info?.description || '',
        machineHref: bootstrap.machineHref || '',
        machineLabel: bootstrap.machineLabel || '',
        serverUrl: window.location.origin,
      })
    } catch (error) {
      renderState(root, '文档加载失败', error instanceof Error ? error.message : '未知错误')
    }
  }

  window.KemailDocsView = {
    renderInto,
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountStandaloneDocs, { once: true })
  } else {
    mountStandaloneDocs()
  }
})()
