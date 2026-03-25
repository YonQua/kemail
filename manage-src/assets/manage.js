// Global charts
let trendChartInstance = null
let sendersChartInstance = null
const STATS_REFRESH_INTERVAL_MS = 20 * 1000
const AVATAR_TONE_CLASSES = [
  'avatar-tone-0',
  'avatar-tone-1',
  'avatar-tone-2',
  'avatar-tone-3',
  'avatar-tone-4',
  'avatar-tone-5',
  'avatar-tone-6',
  'avatar-tone-7',
  'avatar-tone-8',
  'avatar-tone-9',
  'avatar-tone-10',
  'avatar-tone-11',
]
const ACTION_LINK_PREVIEW_LIMIT = 6
const ACTION_LINK_KEEP_LIMIT = 10
const ACTION_LINK_MIN_SCORE = 6

function buildApiError(response, data, text) {
  const error = new Error(
    (data && (data.error || data.message)) || text || `Server Error: ${response?.status || 500}`
  )
  error.status = Number(response?.status || 0)
  error.code = String(data?.code || '')
  return error
}

function selectPriorityActionLinks(links) {
  if (!Array.isArray(links) || links.length === 0) return []

  const deduped = []
  const seenUrls = new Set()
  for (const link of links) {
    const safeUrl = String(link?.safe_url || '')
    if (!safeUrl || safeUrl === '#' || seenUrls.has(safeUrl)) continue
    seenUrls.add(safeUrl)
    deduped.push(link)
  }
  if (deduped.length <= ACTION_LINK_KEEP_LIMIT) return deduped

  const scored = deduped
    .map((link, index) => {
      const score = Number(link?.score)
      return {
        link,
        index,
        score: Number.isFinite(score) ? score : 0,
      }
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)

  const selected = scored
    .filter((item) => item.score >= ACTION_LINK_MIN_SCORE)
    .slice(0, ACTION_LINK_KEEP_LIMIT)

  if (selected.length >= 2) {
    return selected.map((item) => item.link)
  }

  return scored.slice(0, ACTION_LINK_KEEP_LIMIT).map((item) => item.link)
}

function safeLinkUrl(rawUrl, baseApiUrl) {
  const value = String(rawUrl || '').trim()
  if (!value) return '#'
  try {
    const parsed = new URL(value, baseApiUrl)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      return '#'
    }
    return parsed.href
  } catch (_) {
    return '#'
  }
}

function normalizeActionLinkLabel(label, url) {
  const raw = String(label || '').trim()
  if (!raw) return url || '打开链接'
  const compacted = raw
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  if (!compacted) return url || '打开链接'

  const candidates = []
  compacted
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, lineIndex) => {
      const sentenceParts = line
        .split(/[。！？!?；;]/)
        .map((part) => part.trim())
        .filter(Boolean)
      const baseParts = sentenceParts.length ? sentenceParts : [line]
      baseParts.forEach((part, partIndex) => {
        candidates.push({ text: part, lineIndex, partIndex, tokenIndex: 0 })
        if (/[\u3400-\u9fff]/.test(part) && /\s+/.test(part)) {
          part
            .split(/\s+/)
            .map((token) => token.trim())
            .filter(Boolean)
            .forEach((token, tokenIndex) => {
              candidates.push({ text: token, lineIndex, partIndex, tokenIndex: tokenIndex + 1 })
            })
        }
      })
    })

  let bestText = ''
  let bestScore = Number.NEGATIVE_INFINITY
  for (const candidate of candidates) {
    const text = candidate.text.replace(/[：:，,。！？!?;；、]+$/g, '').trim()
    if (text.length < 2) continue
    let score = 0
    if (/https?:\/\//i.test(text) || /@/.test(text)) score -= 6
    if (!/[\u3400-\u9fffA-Za-z0-9]/.test(text)) score -= 4
    if (text.length <= 18) score += 4
    else if (text.length <= 28) score += 2
    else if (text.length <= 40) score += 1
    else score -= 2

    const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length
    const cjkRatio = cjkCount / text.length
    if (cjkRatio > 0.6 && !/\s/.test(text)) score += 2
    if (cjkRatio > 0.6 && /\s/.test(text)) score -= 1
    score -= candidate.lineIndex * 0.6
    score -= candidate.partIndex * 0.2
    score -= candidate.tokenIndex * 0.1

    if (score > bestScore) {
      bestScore = score
      bestText = text
    }
  }

  if (!bestText) bestText = compacted.split('\n')[0] || ''
  if (!bestText) return url || '打开链接'
  if (bestText.length > 24) return bestText.slice(0, 24).trimEnd() + '…'
  return bestText
}

function getSafeHtmlDocument(htmlStr) {
  const safeBody = String(htmlStr || '')
  if (!safeBody) return ''

  const sanitizedBody = safeBody
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/\s+(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, ' $1="#"')
    .replace(/\s+(href|src)\s*=\s*javascript:[^\s>]+/gi, ' $1="#"')

  const normalizedBody = sanitizedBody.replace(/<a\b([^>]*?)>/gi, (_match, rawAttrs) => {
    let attrs = rawAttrs || ''
    if (/target\s*=/i.test(attrs)) {
      attrs = attrs.replace(/target\s*=\s*(['"]?)[^'"\s>]+\1?/i, 'target="_blank"')
    } else {
      attrs += ' target="_blank"'
    }
    if (/rel\s*=/i.test(attrs)) {
      const relMatch = attrs.match(/rel\s*=\s*(['"])(.*?)\1/i)
      if (relMatch) {
        const tokens = new Set(relMatch[2].split(/\s+/).filter(Boolean))
        tokens.add('noopener')
        tokens.add('noreferrer')
        const relValue = Array.from(tokens).join(' ')
        attrs = attrs.replace(/rel\s*=\s*(['"])(.*?)\1/i, `rel="${relValue}"`)
      }
    } else {
      attrs += ' rel="noopener noreferrer"'
    }
    return `<a${attrs}>`
  })

  const csp =
    "default-src 'none'; script-src 'none'; img-src https: data: cid:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; media-src https: data: cid:; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="referrer" content="no-referrer" />',
    `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    '</head>',
    `<body>${normalizedBody}</body>`,
    '</html>',
  ].join('')
}

function compactBodyTextValue(text) {
  const raw = String(text || '')
  const cleaned = raw.trim()
  return cleaned || '提取纯文本失败...'
}

function createMailAppState() {
  return {
    // Global App State
    authorized: false,
    authInput: '',
    authError: '',
    authLoading: false,
    globalNotice: '',
    globalNoticeTone: 'error',
    globalNoticeTimer: null,

    // Dashboard & layout State
    activeTab: 'inbox', // 'inbox' | 'dashboard' | 'domains'
    showDashboard: false,
    isMobileDrawerOpen: false,

    // Data State
    stats: {
      totalReceived: 0,
      currentTotal: 0,
      todayReceived: 0,
      last7DaysReceived: 0,
      unread: 0,
      starred: 0,
      end: '',
      historyStartDay: '',
      retentionDays: 0,
      dayBucketTimezone: 'UTC',
    },
    adminAccessAvailable: false,
    adminDocsOpening: false,
    managedDomains: [],
    domainsLoading: false,
    domainsSyncing: false,
    generatedEmail: '',
    generatedDomain: '',
    generatedIssuedAt: '',
    addressGenerating: false,
    generatedAddressCopyState: 'idle',
    generatedAddressCopyTimer: null,
    domainSearchQuery: '',
    domainIssuableFilter: 'all',
    selectedDomainZoneIds: [],
    domainsBatchUpdating: false,
    mails: [],
    statsNeedsRefresh: false,
    statsLastLoadedAt: 0,
    statsMigrationRequired: false,

    // List Query State
    searchAddress: '',
    filterKeyword: '',
    sortOrder: 'desc',
    filterUnread: false,
    filterStarred: false,
    selectedIds: [],
    isRefreshing: false,
    refreshHint: '',
    refreshHintTimer: null,
    mailServerTotal: 0,

    // Reader State
    activeMail: null,
    activeMailDetail: null,
    liteMailDetail: null,
    richMailDetail: null,
    detailLoading: false,
    renderMode: 'text', // 'html', 'text', 'source'
    detailRequestToken: 0,
    showAllActionLinks: false,

    // Internal
    baseApiUrl: location.origin,

    init() {
      this.authInput = ''
    },

    // --- Authentication --- //

    async login() {
      if (this.authLoading) return
      this.authError = ''
      const trimmedKey = this.authInput.trim()
      if (!trimmedKey) {
        this.authError = '请输入 API Key'
        return
      }
      this.authInput = trimmedKey
      this.authLoading = true
      try {
        // 用稳定的列表读取验证鉴权，避免统计口迁移时影响登录。
        const data = await this.apiFetch('/api/emails?limit=1&summary=1')
        this.adminAccessAvailable = Boolean(data?.permissions?.admin)
        this.authorized = true
        this.loadInitialData()
      } catch (e) {
        this.authorized = false
        this.authError = '验证失败，API Key 可能不正确'
      } finally {
        this.authLoading = false
      }
    },

    logout() {
      this.authorized = false
      this.authInput = ''
      this.authError = ''
      this.authLoading = false
      this.clearGlobalNotice()
      this.stats = {
        totalReceived: 0,
        currentTotal: 0,
        todayReceived: 0,
        last7DaysReceived: 0,
        unread: 0,
        starred: 0,
        end: '',
        historyStartDay: '',
        retentionDays: 0,
        dayBucketTimezone: 'UTC',
      }
      this.statsNeedsRefresh = false
      this.statsLastLoadedAt = 0
      this.statsMigrationRequired = false
      this.mails = []
      this.managedDomains = []
      this.adminAccessAvailable = false
      this.adminDocsOpening = false
      this.domainsLoading = false
      this.domainsSyncing = false
      this.generatedEmail = ''
      this.generatedDomain = ''
      this.generatedIssuedAt = ''
      this.addressGenerating = false
      this.generatedAddressCopyState = 'idle'
      if (this.generatedAddressCopyTimer) {
        clearTimeout(this.generatedAddressCopyTimer)
        this.generatedAddressCopyTimer = null
      }
      this.domainSearchQuery = ''
      this.domainIssuableFilter = 'all'
      this.selectedDomainZoneIds = []
      this.domainsBatchUpdating = false
      this.activeMail = null
      this.activeMailDetail = null
    },

    setAuthInput(event) {
      this.authInput = String(event?.target?.value || '')
    },

    updateSearchAddress(event) {
      this.searchAddress = String(event?.target?.value || '')
    },

    updateFilterKeyword(event) {
      this.filterKeyword = String(event?.target?.value || '')
    },
    clearFilterKeyword() {
      if (!this.filterKeyword) {
        const input = this.$refs?.filterKeywordInput
        if (input && input.value) input.value = ''
        return
      }
      this.filterKeyword = ''
      this.$nextTick(() => {
        const input = this.$refs?.filterKeywordInput
        if (input) input.value = ''
      })
    },

    updateSortOrder(event) {
      this.sortOrder = String(event?.target?.value || 'desc')
      this.fetchMails()
    },

    // --- Core API Helper --- //

    async apiFetch(path, options = {}) {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authInput}`,
      }
      const fetchOpts = { ...options, headers: { ...headers, ...(options.headers || {}) } }

      try {
        const response = await fetch(`${this.baseApiUrl}${path}`, fetchOpts)
        const text = await response.text()
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch (_) {}

        if (!response.ok) {
          throw buildApiError(response, data, text)
        }
        return data || {}
      } catch (err) {
        if (err instanceof Error) throw err
        throw new Error('网络请求失败')
      }
    },

    async fetchAuthorizedAsset(path, accept = 'text/plain, */*') {
      const headers = {
        Authorization: `Bearer ${this.authInput}`,
        Accept: accept,
      }

      try {
        const response = await fetch(`${this.baseApiUrl}${path}`, { headers })
        const text = await response.text()
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch (_) {}

        if (!response.ok) {
          throw buildApiError(response, data, text)
        }

        return {
          text,
          contentType:
            response.headers.get('content-type') || 'application/octet-stream; charset=utf-8',
        }
      } catch (err) {
        if (err instanceof Error) throw err
        throw new Error('网络请求失败')
      }
    },

    createBlobUrl(text, contentType) {
      return URL.createObjectURL(new Blob([text], { type: contentType }))
    },

    openObjectUrl(url) {
      const openedWindow = window.open(url, '_blank', 'noopener,noreferrer')
      if (!openedWindow) {
        throw new Error('浏览器阻止了新窗口，请允许当前站点打开新标签页')
      }
    },

    revokeObjectUrlLater(url, delayMs = 120000) {
      window.setTimeout(() => URL.revokeObjectURL(url), delayMs)
    },

    prepareAuthorizedHtmlDocument(html, replacements = {}) {
      const parser = new DOMParser()
      const doc = parser.parseFromString(html, 'text/html')
      const replacementEntries = Object.entries(replacements)

      doc.querySelectorAll('[href], [src]').forEach((node) => {
        ;['href', 'src'].forEach((attr) => {
          if (!node.hasAttribute(attr)) return

          const value = String(node.getAttribute(attr) || '')
          if (
            !value ||
            value.startsWith('#') ||
            value.startsWith('data:') ||
            value.startsWith('blob:')
          ) {
            return
          }

          const matchedReplacement = replacementEntries.find(([from]) => value === from)
          if (matchedReplacement) {
            node.setAttribute(attr, matchedReplacement[1])
            return
          }

          if (value.startsWith('/')) {
            node.setAttribute(attr, new URL(value, this.baseApiUrl).toString())
          }
        })
      })

      return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
    },

    async openInternalApiDocs() {
      if (!this.canUseAdminActions) {
        this.showError('当前密钥为只读，无法打开内部文档')
        return
      }
      if (this.adminDocsOpening) return
      this.adminDocsOpening = true

      let docsUrl = ''
      let openapiUrl = ''
      try {
        const [docsAsset, openapiAsset] = await Promise.all([
          this.fetchAuthorizedAsset('/api/admin/docs', 'text/html,application/xhtml+xml'),
          this.fetchAuthorizedAsset('/api/admin/openapi', 'application/json'),
        ])

        openapiUrl = this.createBlobUrl(
          openapiAsset.text,
          openapiAsset.contentType || 'application/json; charset=utf-8'
        )
        const html = this.prepareAuthorizedHtmlDocument(docsAsset.text, {
          '/api/admin/openapi': openapiUrl,
        })
        docsUrl = this.createBlobUrl(html, docsAsset.contentType || 'text/html; charset=utf-8')
        this.openObjectUrl(docsUrl)
        this.revokeObjectUrlLater(docsUrl)
        this.revokeObjectUrlLater(openapiUrl)
      } catch (e) {
        if (docsUrl) URL.revokeObjectURL(docsUrl)
        if (openapiUrl) URL.revokeObjectURL(openapiUrl)
        this.showError('打开内部 API 文档失败: ' + e.message)
      } finally {
        this.adminDocsOpening = false
      }
    },

    setGlobalNotice(message, tone = 'error') {
      const nextMessage = String(message || '').trim()
      if (!nextMessage) return

      if (this.globalNoticeTimer) {
        clearTimeout(this.globalNoticeTimer)
        this.globalNoticeTimer = null
      }

      this.globalNotice = nextMessage
      this.globalNoticeTone = tone === 'success' ? 'success' : 'error'
      this.globalNoticeTimer = setTimeout(() => {
        if (this.globalNotice === nextMessage) {
          this.globalNotice = ''
          this.globalNoticeTone = 'error'
        }
        this.globalNoticeTimer = null
      }, 5000)
    },

    showError(message) {
      this.setGlobalNotice(message, 'error')
    },

    showSuccess(message) {
      this.setGlobalNotice(message, 'success')
    },

    clearGlobalNotice() {
      this.globalNotice = ''
      this.globalNoticeTone = 'error'
      if (this.globalNoticeTimer) {
        clearTimeout(this.globalNoticeTimer)
        this.globalNoticeTimer = null
      }
    },

    get authOverlayClass() {
      return { hidden: this.authorized }
    },

    get authErrorClass() {
      return { 'is-hidden': !this.authError }
    },

    get authSubmitLabel() {
      return this.authLoading ? '登陆中...' : '进入控制台'
    },

    get internalApiDocsButtonLabel() {
      return this.adminDocsOpening ? '内部文档打开中...' : '内部文档'
    },

    // --- Dashboard & Charts --- //

    get statsTimeLabel() {
      if (!this.stats.end) return '统计时间: -'
      return `统计时间: ${this.formatDateWithTimeZone(this.stats.end)}`
    },

    get statsScopeLabel() {
      if (this.statsMigrationRequired) {
        return '数据看板统计尚未迁移，请先按 README 执行 D1 建表与 bootstrap SQL。'
      }
      const retentionDays = Number(this.stats.retentionDays || 0)
      const retentionLabel = retentionDays > 0 ? `最近 ${retentionDays} 天活表` : '当前活表'
      const timezone = this.stats.dayBucketTimezone || 'UTC'
      if (!this.stats.historyStartDay) {
        return `历史统计按 ${timezone} 日聚合，当前暂未形成历史数据；当前保留/未读/星标基于${retentionLabel}。`
      }
      return `历史统计按 ${timezone} 日聚合，自 ${this.stats.historyStartDay} 起累计；当前保留/未读/星标基于${retentionLabel}。`
    },

    markStatsDirty() {
      this.statsNeedsRefresh = true
    },

    async refreshStatsAfterMutation() {
      this.markStatsDirty()
      if (this.isDashboardTab) {
        await this.fetchStats()
      }
    },

    async loadInitialData() {
      this.fetchStats()
      this.fetchMails()
      if (this.canUseAdminActions) {
        this.fetchManagedDomains({ silentForbidden: true })
      } else {
        this.managedDomains = []
        if (this.activeTab === 'domains') {
          this.activeTab = 'inbox'
        }
      }
    },

    get canUseAdminActions() {
      return Boolean(this.adminAccessAvailable)
    },

    async fetchStats() {
      try {
        const [summaryData, trendData, senderData] = await Promise.all([
          this.apiFetch('/api/analysis/summary'),
          this.apiFetch('/api/analysis/trend?days=14'),
          this.apiFetch('/api/analysis/senders?limit=5&days=14'),
        ])

        const s = summaryData.summary || {}
        this.stats = {
          totalReceived: s.totalReceived || 0,
          currentTotal: s.currentTotal ?? s.total ?? 0,
          todayReceived: s.todayReceived ?? s.today ?? 0,
          last7DaysReceived: s.last7DaysReceived ?? s.last7Days ?? 0,
          unread: s.unread || 0,
          starred: s.starred || 0,
          end: String(s.end || ''),
          historyStartDay: String(s.historyStartDay || ''),
          retentionDays: Number(s.retentionDays || 0),
          dayBucketTimezone: String(s.dayBucketTimezone || 'UTC'),
        }
        this.statsMigrationRequired = false
        this.statsLastLoadedAt = Date.now()
        this.statsNeedsRefresh = false

        this.renderCharts(trendData.trend?.series || [], senderData.senders || [])
      } catch (e) {
        const migrationRequired =
          e?.code === 'METRICS_MIGRATION_REQUIRED' ||
          String(e?.message || '').includes('Metrics tables missing')
        this.renderCharts([], [])
        this.statsLastLoadedAt = Date.now()
        this.statsNeedsRefresh = !migrationRequired
        this.statsMigrationRequired = migrationRequired
        this.showError(
          migrationRequired
            ? '数据看板统计尚未迁移，请先执行 README 中的 D1 建表与 bootstrap SQL'
            : '统计数据加载失败'
        )
      }
    },

    switchTab(nextTab) {
      if (nextTab === 'domains' && !this.canUseAdminActions) {
        nextTab = 'inbox'
      }
      this.activeTab = nextTab
      this.showDashboard = nextTab === 'dashboard'
      if (nextTab === 'dashboard') {
        const shouldRefresh =
          this.statsNeedsRefresh ||
          Date.now() - Number(this.statsLastLoadedAt || 0) >= STATS_REFRESH_INTERVAL_MS
        if (shouldRefresh) {
          this.fetchStats()
        }
      }
    },

    get isDashboardTab() {
      return this.activeTab === 'dashboard'
    },

    get isInboxTab() {
      return this.activeTab === 'inbox'
    },

    get isDomainsTab() {
      return this.activeTab === 'domains'
    },

    get shellClass() {
      return { 'is-hidden': !this.authorized }
    },

    get dashboardPanelClass() {
      return { 'is-hidden': !this.isDashboardTab }
    },

    get domainsPanelClass() {
      return { 'is-hidden': !this.isDomainsTab }
    },

    get workspaceClass() {
      return { 'is-hidden': !this.isInboxTab }
    },

    showInboxTab() {
      this.switchTab('inbox')
    },

    showDashboardTab() {
      this.switchTab('dashboard')
    },

    showDomainsTab() {
      this.switchTab('domains')
    },

    get inboxTabClass() {
      return { active: this.activeTab === 'inbox' }
    },

    get dashboardTabClass() {
      return { active: this.activeTab === 'dashboard' }
    },

    get domainsTabClass() {
      return { active: this.activeTab === 'domains' }
    },

    renderCharts(trendSeries, sendersList) {
      const isDark =
        document.documentElement.className.includes('dark') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
      // Chart colors aware of dark mode
      const txtColor = isDark ? '#94a3b8' : '#64748b'
      const gridColor = isDark ? 'rgba(145,171,196,0.1)' : 'rgba(148,163,184,0.1)'
      const primaryColor = '#10b981'

      // Render Trend Chart
      const trendCtx = document.getElementById('trendChart')
      if (trendCtx) {
        if (trendChartInstance) trendChartInstance.destroy()
        trendChartInstance = new Chart(trendCtx, {
          type: 'line',
          data: {
            labels: trendSeries.map((s) => s.day.slice(5)),
            datasets: [
              {
                label: '收件量',
                data: trendSeries.map((s) => s.total),
                borderColor: primaryColor,
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                borderWidth: 2,
                pointRadius: 4,
                pointBackgroundColor: primaryColor,
                fill: true,
                tension: 0.3,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { color: gridColor }, ticks: { color: txtColor } },
              y: {
                beginAtZero: true,
                grid: { color: gridColor },
                ticks: { color: txtColor, stepSize: 1 },
              },
            },
          },
        })
      }

      // Render Senders Chart
      const sendersCtx = document.getElementById('sendersChart')
      if (sendersCtx) {
        if (sendersChartInstance) {
          sendersChartInstance.destroy()
          sendersChartInstance = null
        }

        if (sendersList.length === 0) {
          const context = sendersCtx.getContext('2d')
          context?.clearRect(0, 0, sendersCtx.width, sendersCtx.height)
          return
        }

        sendersChartInstance = new Chart(sendersCtx, {
          type: 'doughnut',
          data: {
            labels: sendersList.map((s) => this.formatSenderBucketLabel(s.sender)),
            datasets: [
              {
                data: sendersList.map((s) => s.total),
                backgroundColor: ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'],
                borderWidth: 0,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '70%',
            plugins: {
              legend: {
                position: 'right',
                labels: { color: txtColor, font: { size: 11 }, boxWidth: 12 },
              },
            },
          },
        })
      }
    },

    // --- Managed Domains --- //

    decorateManagedDomain(domain) {
      const normalizedStatus = String(domain?.zone_status || '')
        .trim()
        .toLowerCase()
      const syncLabel = domain?.last_synced_at
        ? this.formatDateFull(domain.last_synced_at)
        : '未同步'
      const issuableEnabled = domain?.issuable_enabled ? 1 : 0

      const zoneId = String(domain?.zone_id || '')

      return {
        ...domain,
        zone_id: zoneId,
        is_selected: this.selectedDomainZoneIds.includes(zoneId),
        zone_status_label: normalizedStatus || 'unknown',
        zone_status_class: normalizedStatus === 'active' ? 'chip-green' : 'chip-gray',
        issuable_enabled: issuableEnabled,
        issuable_label: issuableEnabled ? '已启用发放' : '未启用发放',
        issuable_class: issuableEnabled ? 'chip-green' : 'chip-gray',
        sync_label: syncLabel,
        action_label: issuableEnabled ? '停用发放' : '启用发放',
        action_class: issuableEnabled ? 'btn-danger' : 'btn-primary',
      }
    },

    setManagedDomains(domains) {
      this.managedDomains = (Array.isArray(domains) ? domains : []).map((domain) =>
        this.decorateManagedDomain(domain)
      )
      this.syncSelectedManagedDomains()
    },

    findManagedDomainByZoneId(zoneId) {
      return this.managedDomains.find((domain) => domain.zone_id === zoneId) || null
    },

    replaceManagedDomain(updatedDomain) {
      const nextDomains = this.managedDomains.map((domain) =>
        domain.zone_id === updatedDomain.zone_id
          ? this.decorateManagedDomain(updatedDomain)
          : domain
      )
      this.managedDomains = nextDomains
      this.syncSelectedManagedDomains()
    },

    syncSelectedManagedDomains() {
      const existingZoneIds = new Set(this.managedDomains.map((domain) => domain.zone_id))
      this.selectedDomainZoneIds = this.selectedDomainZoneIds.filter((zoneId) =>
        existingZoneIds.has(zoneId)
      )
      const selectedZoneIds = new Set(this.selectedDomainZoneIds)
      this.managedDomains = this.managedDomains.map((domain) => ({
        ...domain,
        is_selected: selectedZoneIds.has(domain.zone_id),
      }))
    },

    async fetchManagedDomains(options = {}) {
      this.domainsLoading = true
      try {
        const data = await this.apiFetch('/api/admin/domains')
        this.adminAccessAvailable = true
        this.setManagedDomains(data.domains || [])
      } catch (e) {
        if (options.silentForbidden && e.message === 'Admin access required') {
          this.adminAccessAvailable = false
          this.managedDomains = []
          return
        }
        this.showError('域名池加载失败: ' + e.message)
      } finally {
        this.domainsLoading = false
      }
    },

    async syncManagedDomains() {
      if (this.domainsSyncing) return
      this.domainsSyncing = true
      try {
        const data = await this.apiFetch('/api/admin/domains/sync', {
          method: 'POST',
        })
        this.adminAccessAvailable = true
        this.setManagedDomains(data.domains || [])
        this.showSuccess(`域名同步完成，共 ${data.synced_count || 0} 个 Zone`)
      } catch (e) {
        if (e.message === 'Admin access required') {
          this.adminAccessAvailable = false
          this.managedDomains = []
          return
        }
        this.showError('域名同步失败: ' + e.message)
      } finally {
        this.domainsSyncing = false
      }
    },

    updateDomainSearchQuery(event) {
      this.domainSearchQuery = String(event?.target?.value || '')
    },

    setDomainIssuableFilter(nextFilter) {
      this.domainIssuableFilter = ['all', 'enabled', 'disabled'].includes(nextFilter)
        ? nextFilter
        : 'all'
    },

    showAllManagedDomains() {
      this.setDomainIssuableFilter('all')
    },

    showEnabledManagedDomains() {
      this.setDomainIssuableFilter('enabled')
    },

    showDisabledManagedDomains() {
      this.setDomainIssuableFilter('disabled')
    },

    async toggleDomainIssuableByEvent(event) {
      const zoneId = String(event?.currentTarget?.dataset?.zoneId || '')
      if (!zoneId) return
      const domain = this.findManagedDomainByZoneId(zoneId)
      if (!domain) return
      await this.toggleDomainIssuable(domain)
    },

    async toggleDomainIssuable(domain) {
      if (!this.canUseAdminActions) {
        this.showError('当前密钥为只读，无法修改域名发放状态')
        return
      }
      const nextIssuableEnabled = domain.issuable_enabled ? 0 : 1
      try {
        const data = await this.apiFetch(
          `/api/admin/domains/${encodeURIComponent(domain.zone_id)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              issuable_enabled: nextIssuableEnabled,
              note: domain.note || '',
            }),
          }
        )
        if (data?.domain) {
          this.replaceManagedDomain(data.domain)
        }
      } catch (e) {
        this.showError('域名发放状态更新失败: ' + e.message)
      }
    },

    toggleManagedDomainSelectionByEvent(event) {
      const zoneId = String(event?.target?.dataset?.zoneId || '')
      if (!zoneId) return

      const checked = Boolean(event?.target?.checked)
      const nextSelected = new Set(this.selectedDomainZoneIds)
      if (checked) {
        nextSelected.add(zoneId)
      } else {
        nextSelected.delete(zoneId)
      }
      this.selectedDomainZoneIds = Array.from(nextSelected)
      this.syncSelectedManagedDomains()
    },

    clearSelectedManagedDomains() {
      this.selectedDomainZoneIds = []
      this.syncSelectedManagedDomains()
    },

    isAllVisibleManagedDomainsSelected() {
      const visibleZoneIds = this.filteredManagedDomains.map((domain) => domain.zone_id)
      if (!visibleZoneIds.length) return false

      const selectedZoneIds = new Set(this.selectedDomainZoneIds)
      return visibleZoneIds.every((zoneId) => selectedZoneIds.has(zoneId))
    },

    toggleSelectAllVisibleManagedDomains() {
      const visibleZoneIds = this.filteredManagedDomains.map((domain) => domain.zone_id)
      if (!visibleZoneIds.length) return

      const nextSelected = new Set(this.selectedDomainZoneIds)
      const allSelected = visibleZoneIds.every((zoneId) => nextSelected.has(zoneId))
      if (allSelected) {
        visibleZoneIds.forEach((zoneId) => nextSelected.delete(zoneId))
      } else {
        visibleZoneIds.forEach((zoneId) => nextSelected.add(zoneId))
      }
      this.selectedDomainZoneIds = Array.from(nextSelected)
      this.syncSelectedManagedDomains()
    },

    async setSelectedManagedDomainsIssuable(issuableEnabled) {
      if (this.domainsBatchUpdating || !this.selectedDomainZoneIds.length) return
      if (!this.canUseAdminActions) {
        this.showError('当前密钥为只读，无法批量修改域名发放状态')
        return
      }

      this.domainsBatchUpdating = true
      try {
        const data = await this.apiFetch('/api/admin/domains/batch', {
          method: 'POST',
          body: JSON.stringify({
            zone_ids: this.selectedDomainZoneIds,
            issuable_enabled: issuableEnabled ? 1 : 0,
          }),
        })
        this.clearSelectedManagedDomains()
        await this.fetchManagedDomains()
        this.showSuccess(
          `已${issuableEnabled ? '启用' : '停用'} ${data?.updated_count || 0} 个域名发放状态`
        )
      } catch (e) {
        this.showError(`批量${issuableEnabled ? '启用' : '停用'}失败: ${e.message}`)
      } finally {
        this.domainsBatchUpdating = false
      }
    },

    async enableSelectedManagedDomains() {
      await this.setSelectedManagedDomainsIssuable(1)
    },

    async disableSelectedManagedDomains() {
      await this.setSelectedManagedDomainsIssuable(0)
    },

    async generateManagedAddress() {
      if (this.addressGenerating) return
      if (!this.canUseAdminActions) {
        this.showError('当前密钥为只读，无法生成邮箱')
        return
      }
      this.addressGenerating = true
      try {
        const data = await this.apiFetch('/api/addresses/generate', {
          method: 'POST',
        })
        const generatedEmail = String(data?.email || '').trim()
        if (!generatedEmail) {
          throw new Error('服务端未返回完整邮箱地址')
        }
        this.generatedEmail = generatedEmail
        this.generatedDomain = String(data?.domain || generatedEmail.split('@')[1] || '')
        this.generatedIssuedAt = String(data?.issued_at || '')
        this.generatedAddressCopyState = 'idle'
        if (this.generatedAddressCopyTimer) {
          clearTimeout(this.generatedAddressCopyTimer)
          this.generatedAddressCopyTimer = null
        }
        this.scrollGeneratedAddressCardIntoView()
      } catch (e) {
        this.showError('生成邮箱失败: ' + e.message)
      } finally {
        this.addressGenerating = false
      }
    },

    copyTextToClipboard(value) {
      const text = String(value || '')
      if (!text) return Promise.reject(new Error('Empty clipboard text'))

      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text)
      }

      return new Promise((resolve, reject) => {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', 'readonly')
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        textarea.style.pointerEvents = 'none'
        document.body.appendChild(textarea)
        textarea.select()

        try {
          const success = document.execCommand('copy')
          document.body.removeChild(textarea)
          if (!success) {
            reject(new Error('Copy command rejected'))
            return
          }
          resolve()
        } catch (error) {
          document.body.removeChild(textarea)
          reject(error)
        }
      })
    },

    async copyGeneratedAddress() {
      if (!this.generatedEmail) return

      try {
        await this.copyTextToClipboard(this.generatedEmail)
        this.generatedAddressCopyState = 'done'
        if (this.generatedAddressCopyTimer) {
          clearTimeout(this.generatedAddressCopyTimer)
        }
        this.generatedAddressCopyTimer = setTimeout(() => {
          this.generatedAddressCopyState = 'idle'
          this.generatedAddressCopyTimer = null
        }, 1800)
      } catch (e) {
        this.generatedAddressCopyState = 'failed'
        this.showError('复制邮箱失败，请手动复制')
        if (this.generatedAddressCopyTimer) {
          clearTimeout(this.generatedAddressCopyTimer)
        }
        this.generatedAddressCopyTimer = setTimeout(() => {
          this.generatedAddressCopyState = 'idle'
          this.generatedAddressCopyTimer = null
        }, 1800)
      }
    },

    scrollGeneratedAddressCardIntoView() {
      this.$nextTick(() => {
        const card = document.querySelector('.generated-address-card')
        if (!card) return
        card.scrollIntoView({ block: 'start', behavior: 'smooth' })
      })
    },

    selectTextByEvent(event) {
      const target = event?.target
      if (!target || typeof target.select !== 'function') return
      target.select()
    },

    async useGeneratedAddressInInbox() {
      if (!this.generatedEmail) return
      this.searchAddress = this.generatedEmail
      this.switchTab('inbox')
      await this.fetchMails()
    },

    get domainSyncButtonLabel() {
      return this.domainsSyncing ? '同步中...' : '同步 Cloudflare Zone'
    },

    get generateAddressButtonLabel() {
      return this.addressGenerating ? '生成中...' : '生成完整邮箱'
    },

    get generateAddressButtonDisabled() {
      return this.addressGenerating || !this.hasIssuableDomains
    },

    get showManagedDomainsLocked() {
      return !this.canUseAdminActions && !this.domainsLoading
    },

    get showManagedDomainsTable() {
      return this.canUseAdminActions && this.managedDomains.length > 0
    },

    get showManagedDomainsEmpty() {
      return this.canUseAdminActions && !this.domainsLoading && this.managedDomains.length === 0
    },

    get hasIssuableDomains() {
      return this.managedDomains.some(
        (domain) => domain.issuable_enabled && domain.zone_status_label === 'active'
      )
    },

    get managedDomainsSummaryLabel() {
      if (this.domainsLoading) return '正在加载域名池...'
      if (!this.canUseAdminActions) return '当前密钥为只读，域名管理功能已锁定'
      const total = this.managedDomains.length
      const issuable = this.managedDomains.filter((domain) => domain.issuable_enabled).length
      const visible = this.filteredManagedDomains.length
      if (visible !== total) {
        return `显示 ${visible} / ${total} 个域名，已启用 ${issuable} 个`
      }
      return `共 ${total} 个域名，已启用 ${issuable} 个`
    },

    get generatedAddressAvailable() {
      return Boolean(this.generatedEmail)
    },

    get showGeneratedAddressCard() {
      return this.canUseAdminActions && this.generatedAddressAvailable
    },

    get generatedAddressMetaLabel() {
      const issuedAt = this.generatedIssuedAt ? this.formatDateFull(this.generatedIssuedAt) : '-'
      return `${this.generatedDomain || '-'} · 生成时间 ${issuedAt}`
    },

    get generatedAddressCopyLabel() {
      if (this.generatedAddressCopyState === 'done') return '已复制'
      if (this.generatedAddressCopyState === 'failed') return '复制失败'
      return '复制'
    },

    get filteredManagedDomains() {
      let domains = this.managedDomains
      const query = this.domainSearchQuery.trim().toLowerCase()
      if (query) {
        domains = domains.filter((domain) => {
          const domainName = String(domain?.domain || '').toLowerCase()
          const zoneId = String(domain?.zone_id || '').toLowerCase()
          return domainName.includes(query) || zoneId.includes(query)
        })
      }

      if (this.domainIssuableFilter === 'enabled') {
        domains = domains.filter((domain) => domain.issuable_enabled)
      } else if (this.domainIssuableFilter === 'disabled') {
        domains = domains.filter((domain) => !domain.issuable_enabled)
      }

      return domains
    },

    get hasSelectedManagedDomains() {
      return this.selectedDomainZoneIds.length > 0
    },

    get selectedManagedDomainsCount() {
      return this.selectedDomainZoneIds.length
    },

    get domainFilterAllButtonClass() {
      return { 'btn-primary': this.domainIssuableFilter === 'all' }
    },

    get domainFilterEnabledButtonClass() {
      return { 'btn-primary': this.domainIssuableFilter === 'enabled' }
    },

    get domainFilterDisabledButtonClass() {
      return { 'btn-primary': this.domainIssuableFilter === 'disabled' }
    },

    get domainSelectAllButtonClass() {
      return { 'btn-primary': this.isAllVisibleManagedDomainsSelected() }
    },

    get domainSelectAllButtonLabel() {
      return this.isAllVisibleManagedDomainsSelected() ? '取消全选' : '全选当前'
    },

    get domainsBatchActionsClass() {
      return { 'is-hidden': !this.hasSelectedManagedDomains }
    },

    get batchEnableDomainsLabel() {
      return this.domainsBatchUpdating ? '处理中...' : '批量启用发放'
    },

    get batchDisableDomainsLabel() {
      return this.domainsBatchUpdating ? '处理中...' : '批量停用发放'
    },

    // --- Mail List & Actions --- //

    async fetchMails() {
      this.isRefreshing = true
      if (this.refreshHintTimer) {
        clearTimeout(this.refreshHintTimer)
        this.refreshHintTimer = null
      }
      const refreshStartedAt = Date.now()
      this.refreshHint = '刷新中...'
      try {
        let path = '/api/emails?limit=50&summary=1'
        if (this.searchAddress) path += `&address=${encodeURIComponent(this.searchAddress)}`
        if (this.sortOrder) path += `&sort=${this.sortOrder}`

        const data = await this.apiFetch(path)
        if (typeof data?.permissions?.admin === 'boolean') {
          this.adminAccessAvailable = data.permissions.admin
        }
        this.mailServerTotal = Number(data?.result_info?.total_count || 0)
        const emails = Array.isArray(data.emails) ? data.emails : []
        this.mails = emails.map((mail) => this.decorateMailSummary(mail))
        this.clearFilterKeyword()
        this.syncActiveMailReference()
        this.refreshMailUiState()
        const elapsed = Date.now() - refreshStartedAt
        if (elapsed < 300) {
          await new Promise((resolve) => setTimeout(resolve, 300 - elapsed))
        }
        this.refreshHint = '已刷新'
        this.refreshHintTimer = setTimeout(() => {
          this.refreshHint = ''
          this.refreshHintTimer = null
        }, 1500)

        // Clear active if not in list
        if (this.activeMail && !this.findMailById(this.activeMail.id)) {
          this.clearActiveMailState()
        }
      } catch (e) {
        this.refreshHint = '刷新失败'
        this.refreshHintTimer = setTimeout(() => {
          this.refreshHint = ''
          this.refreshHintTimer = null
        }, 2000)
        this.showError('邮件列表加载失败: ' + e.message)
      } finally {
        this.isRefreshing = false
      }
    },

    get filteredMails() {
      let result = this.mails

      // Keyword filter
      if (this.filterKeyword) {
        const kw = this.filterKeyword.toLowerCase()
        result = result.filter(
          (m) =>
            m.subject?.toLowerCase().includes(kw) ||
            m.sender?.toLowerCase().includes(kw) ||
            m.recipient?.toLowerCase().includes(kw)
        )
      }

      if (this.filterUnread) {
        result = result.filter((m) => !m.is_read)
      }

      if (this.filterStarred) {
        result = result.filter((m) => m.is_starred)
      }

      return result
    },

    toggleUnreadFilter() {
      this.filterUnread = !this.filterUnread
    },
    toggleStarFilter() {
      this.filterStarred = !this.filterStarred
    },
    get unreadFilterButtonClass() {
      return { 'btn-primary': this.filterUnread }
    },
    get starFilterButtonClass() {
      return { 'btn-primary': this.filterStarred }
    },
    get mailCountLabel() {
      const hasFilters = Boolean(this.filterKeyword || this.filterUnread || this.filterStarred)
      if (hasFilters) {
        return `${this.filteredMails.length} / ${this.mails.length} / ${this.mailServerTotal} 封邮件`
      }
      return `${this.mails.length} / ${this.mailServerTotal} 封邮件`
    },
    get hasSelectedIds() {
      return this.selectedIds.length > 0
    },
    get selectedCount() {
      return this.selectedIds.length
    },
    get isFilteredMailsEmpty() {
      return this.filteredMails.length === 0
    },
    get batchActionsClass() {
      return { 'is-hidden': !this.hasSelectedIds }
    },
    get globalNoticeClass() {
      return {
        'is-hidden': !this.globalNotice,
        success: this.globalNoticeTone === 'success',
        error: this.globalNoticeTone !== 'success',
      }
    },
    isAllVisibleSelected() {
      const visibleIds = this.filteredMails.map((m) => String(m.id))
      if (!visibleIds.length) return false
      const selected = new Set(this.selectedIds.map((id) => String(id)))
      return visibleIds.every((id) => selected.has(id))
    },
    get selectAllButtonClass() {
      return { 'btn-primary': this.isAllVisibleSelected() }
    },
    get selectAllButtonLabel() {
      return this.isAllVisibleSelected() ? '取消全选' : '全选当前'
    },
    get refreshButtonLabel() {
      return this.isRefreshing ? '刷新中...' : '刷新列表'
    },
    get refreshHintClass() {
      return { visible: Boolean(this.refreshHint) }
    },
    clearSelectedIds() {
      this.selectedIds = []
      this.refreshMailUiState()
    },
    toggleSelectAllVisible() {
      const visibleIds = this.filteredMails.map((m) => String(m.id))
      if (!visibleIds.length) return
      const selected = new Set(this.selectedIds.map((id) => String(id)))
      const allSelected = visibleIds.every((id) => selected.has(id))
      if (allSelected) {
        this.selectedIds = this.selectedIds.filter((id) => !visibleIds.includes(String(id)))
        return
      }
      visibleIds.forEach((id) => selected.add(id))
      this.selectedIds = Array.from(selected)
      this.refreshMailUiState()
    },

    // Avatar Logic
    getAvatarInitial(sender) {
      if (!sender) return '?'
      const name = this.extractName(sender).trim()
      return name ? name.charAt(0).toUpperCase() : '?'
    },

    getAvatarToneClass(sender) {
      if (!sender) return AVATAR_TONE_CLASSES[0]
      let hash = 0
      for (let i = 0; i < sender.length; i++) hash = sender.charCodeAt(i) + ((hash << 5) - hash)
      return AVATAR_TONE_CLASSES[Math.abs(hash) % AVATAR_TONE_CLASSES.length]
    },

    extractName(senderStr) {
      if (!senderStr) return '-'
      const match = senderStr.match(/^"?([^"]+)"?\s*<.*>$/) || senderStr.match(/^([^<]+)<.*>$/)
      return match ? match[1].trim() : senderStr.split('@')[0]
    },

    formatSenderBucketLabel(senderStr) {
      const text = String(senderStr || '').trim()
      if (!text) return '未知'
      if (text.includes('<')) return this.extractName(text)
      return text
    },

    decorateMailSummary(mail) {
      const senderName = this.extractName(mail.sender)
      const initial = senderName && senderName !== '-' ? senderName.charAt(0).toUpperCase() : '?'
      return {
        ...mail,
        sender_name: senderName,
        received_label: this.formatDate(mail.received_at),
        subject_label: mail?.subject || '无主题',
        preview_label: mail?.preview || '暂无预览文本...',
        avatar_initial: initial,
        avatar_class: this.getAvatarToneClass(mail.sender),
        card_class: {},
        star_button_class: {},
        star_fill: 'none',
        is_selected: false,
      }
    },

    decorateMailDetail(detail) {
      const attachments = Array.isArray(detail?.attachments)
        ? detail.attachments.map((att) => ({
            ...att,
            filename_label: att?.filename || '未命名附件',
            size_label: this.formatBytes(att?.size || 0),
          }))
        : []

      const rawActionLinks = Array.isArray(detail?.action_links)
        ? detail.action_links.map((link) => ({
            ...link,
            label_text: normalizeActionLinkLabel(link?.label, link?.url),
            safe_url: safeLinkUrl(link?.url, this.baseApiUrl),
          }))
        : []
      const actionLinks = selectPriorityActionLinks(rawActionLinks)

      return {
        ...detail,
        attachments,
        action_links: actionLinks,
        subject_label: detail?.subject || '无主题',
        received_full_label: this.formatDateFull(detail?.received_at),
        body_text_label: compactBodyTextValue(detail?.body_text),
        body_source_label:
          detail?.body_source || '在加载富解析后方可查看原始代码（或通过/source API）。',
        safe_body_html: getSafeHtmlDocument(detail?.body_html),
      }
    },

    refreshMailUiState() {
      const activeMailId = this.activeMail ? this.activeMail.id : null
      const selectedIds = new Set(this.selectedIds.map((id) => String(id)))
      this.mails.forEach((mail) => {
        mail.card_class = {
          active: Boolean(activeMailId && activeMailId === mail.id),
          unread: !mail.is_read,
        }
        mail.star_button_class = { starred: Boolean(mail.is_starred) }
        mail.star_fill = mail.is_starred ? 'currentColor' : 'none'
        mail.is_selected = selectedIds.has(String(mail.id))
      })
    },

    resetDetailScroll() {
      requestAnimationFrame(() => {
        const container = document.querySelector('.detail-body')
        if (container) container.scrollTop = 0
      })
    },

    findMailById(id) {
      return this.mails.find((mail) => mail.id === id) || null
    },

    readMailIdFromEvent(event) {
      const rawId = event?.currentTarget?.dataset?.mailId || ''
      const id = Number.parseInt(rawId, 10)
      return Number.isFinite(id) && id > 0 ? id : null
    },

    syncActiveMailReference() {
      if (!this.activeMail) return
      const nextActiveMail = this.findMailById(this.activeMail.id)
      if (nextActiveMail) {
        this.activeMail = nextActiveMail
      }
    },

    clearActiveMailState() {
      this.activeMail = null
      this.activeMailDetail = null
      this.liteMailDetail = null
      this.richMailDetail = null
      this.isMobileDrawerOpen = false
      this.showAllActionLinks = false
    },

    // --- Reader logic --- //

    async openMailByEvent(event) {
      const mailId = this.readMailIdFromEvent(event)
      if (!mailId) return
      const mail = this.findMailById(mailId)
      if (!mail) return
      await this.openMail(mail)
    },

    async openMail(mail) {
      const requestToken = ++this.detailRequestToken
      this.activeMail = this.findMailById(mail.id) || mail
      this.clearFilterKeyword()
      this.refreshMailUiState()
      this.detailLoading = true
      this.isMobileDrawerOpen = true // Open drawer on mobile

      try {
        const data = await this.apiFetch(`/api/emails/${mail.id}`)
        if (
          requestToken !== this.detailRequestToken ||
          !this.activeMail ||
          this.activeMail.id !== mail.id
        ) {
          return
        }
        const preparedDetail = this.decorateMailDetail(data.email || {})
        this.liteMailDetail = preparedDetail
        this.richMailDetail = preparedDetail.rich_enabled ? preparedDetail : null
        this.activeMailDetail = preparedDetail
        this.showAllActionLinks = false
        this.renderMode = this.activeMailDetail.body_html ? 'html' : 'text'
        this.resetDetailScroll()

        await this.markMailAsReadIfAllowed(mail.id)
      } catch (e) {
        if (requestToken !== this.detailRequestToken) return
        this.showError('邮件详情加载失败')
        this.activeMailDetail = null
      } finally {
        if (requestToken === this.detailRequestToken) {
          this.detailLoading = false
        }
      }
    },

    async markMailAsReadIfAllowed(mailId) {
      if (!this.canUseAdminActions) return
      const mail = this.findMailById(mailId)
      if (!mail || mail.is_read) return

      try {
        await this.apiFetch('/api/emails/read', {
          method: 'PUT',
          body: JSON.stringify({ ids: [mailId], read: 1 }),
        })
        this.markAsReadLocal(mailId)
        await this.refreshStatsAfterMutation()
      } catch (e) {
        if (e.message === 'Admin access required') {
          return
        }
        this.showError('标记阅读失败')
      }
    },

    async loadRichDetail() {
      if (!this.activeMail) return
      if (!this.canUseAdminActions) {
        this.showError('当前密钥为只读，无法请求富解析')
        return
      }
      const activeMailId = this.activeMail.id
      const requestToken = ++this.detailRequestToken
      this.detailLoading = true
      try {
        const data = await this.apiFetch(`/api/emails/${activeMailId}?rich=1`)
        if (
          requestToken !== this.detailRequestToken ||
          !this.activeMail ||
          this.activeMail.id !== activeMailId
        ) {
          return
        }
        if (data && data.email) {
          const preparedDetail = this.decorateMailDetail(data.email)
          this.activeMailDetail = preparedDetail
          this.richMailDetail = preparedDetail
          this.showAllActionLinks = false
          this.renderMode = this.activeMailDetail.body_html ? 'html' : 'text'
          this.resetDetailScroll()
        }
      } catch (e) {
        if (requestToken !== this.detailRequestToken) return
        this.showError('请求富解析失败')
      } finally {
        if (requestToken === this.detailRequestToken) {
          this.detailLoading = false
        }
      }
    },
    hasRichDetail() {
      return Boolean(this.richMailDetail && this.richMailDetail.rich_enabled)
    },
    switchToLite() {
      if (!this.liteMailDetail) return
      this.activeMailDetail = this.liteMailDetail
      this.showAllActionLinks = false
      this.renderMode = 'text'
      this.resetDetailScroll()
    },
    switchToRich() {
      if (this.richMailDetail) {
        this.activeMailDetail = this.richMailDetail
        this.showAllActionLinks = false
        this.renderMode = this.activeMailDetail.body_html ? 'html' : 'text'
        this.resetDetailScroll()
        return
      }
      this.loadRichDetail()
    },

    closeMobileDrawer() {
      this.isMobileDrawerOpen = false
    },

    get detailPanelClass() {
      return { 'drawer-open': this.isMobileDrawerOpen }
    },

    get showDetailEmptyState() {
      return !this.activeMailDetail && !this.detailLoading
    },

    get showDetailContent() {
      return Boolean(this.activeMailDetail && !this.detailLoading)
    },

    get detailChipClass() {
      return this.activeMailDetail && this.activeMailDetail.rich_enabled
        ? 'chip-green'
        : 'chip-gray'
    },

    get detailChipLabel() {
      return this.activeMailDetail && this.activeMailDetail.rich_enabled
        ? '富解析完成'
        : '精简摘要视图'
    },

    get showSwitchToLiteButton() {
      return Boolean(this.activeMailDetail && this.activeMailDetail.rich_enabled)
    },

    get showSwitchToRichButton() {
      return Boolean(
        this.canUseAdminActions &&
        this.activeMailDetail &&
        !this.activeMailDetail.rich_enabled &&
        this.hasRichDetail()
      )
    },

    get showLoadRichButton() {
      return Boolean(
        this.canUseAdminActions &&
        this.activeMailDetail &&
        !this.activeMailDetail.rich_enabled &&
        this.activeMailDetail.rich_available &&
        !this.hasRichDetail()
      )
    },

    get detailSubjectLabel() {
      return this.activeMailDetail?.subject_label || '无主题'
    },

    get hasAttachments() {
      return Boolean(this.activeMailDetail?.attachments?.length)
    },

    get hasActionLinks() {
      return Boolean(this.actionLinks.length)
    },

    get actionLinks() {
      return Array.isArray(this.activeMailDetail?.action_links)
        ? this.activeMailDetail.action_links
        : []
    },

    get hasOverflowActionLinks() {
      return this.actionLinks.length > ACTION_LINK_PREVIEW_LIMIT
    },

    get visibleActionLinks() {
      if (this.showAllActionLinks || !this.hasOverflowActionLinks) return this.actionLinks
      return this.actionLinks.slice(0, ACTION_LINK_PREVIEW_LIMIT)
    },

    get toggleActionLinksLabel() {
      if (this.showAllActionLinks) return '收起快捷操作点'
      const extraCount = this.actionLinks.length - ACTION_LINK_PREVIEW_LIMIT
      return `显示更多 (${extraCount})`
    },

    toggleActionLinksExpand() {
      if (!this.hasOverflowActionLinks) return
      this.showAllActionLinks = !this.showAllActionLinks
    },

    get detailHasHtmlBody() {
      return Boolean(this.activeMailDetail?.body_html)
    },

    get detailHasRawSource() {
      return Boolean(this.activeMailDetail?.raw_available)
    },

    get hasDetailActions() {
      return Boolean(this.activeMailDetail)
    },

    get htmlRenderModeButtonClass() {
      return { 'btn-primary': this.renderMode === 'html' }
    },

    get textRenderModeButtonClass() {
      return { 'btn-primary': this.renderMode === 'text' }
    },

    get sourceRenderModeButtonClass() {
      return { 'btn-primary': this.renderMode === 'source' }
    },

    setRenderModeHtml() {
      this.renderMode = 'html'
      this.resetDetailScroll()
    },

    setRenderModeText() {
      this.renderMode = 'text'
      this.resetDetailScroll()
    },

    setRenderModeSource() {
      this.renderMode = 'source'
      this.resetDetailScroll()
    },

    get showHtmlView() {
      return Boolean(this.renderMode === 'html' && this.activeMailDetail?.body_html)
    },

    get showTextView() {
      return Boolean(
        this.renderMode === 'text' ||
        (this.renderMode === 'html' && !this.activeMailDetail?.body_html)
      )
    },

    get showSourceView() {
      return Boolean(this.renderMode === 'source' && this.activeMailDetail?.raw_available)
    },

    get bodyTextLabel() {
      return this.activeMailDetail?.body_text_label || '提取纯文本失败...'
    },

    get bodySourceLabel() {
      return (
        this.activeMailDetail?.body_source_label ||
        '在加载富解析后方可查看原始代码（或通过/source API）。'
      )
    },

    // --- Batch actions --- //

    async toggleStarByEvent(event) {
      const mailId = this.readMailIdFromEvent(event)
      if (!mailId) return
      const mail = this.findMailById(mailId)
      if (!mail) return
      await this.toggleStar(mail)
    },

    async toggleStar(mail) {
      if (!this.canUseAdminActions) {
        this.showError('当前密钥为只读，无法修改星标')
        return
      }
      const nextStar = !mail.is_starred
      const id = mail.id
      try {
        mail.is_starred = nextStar
        this.refreshMailUiState()
        // If active detail is open, mirror state
        if (this.activeMailDetail && this.activeMailDetail.id === id) {
          this.activeMailDetail.is_starred = nextStar
        }
        await this.apiFetch('/api/emails/star', {
          method: 'PUT',
          body: JSON.stringify({ ids: [id], starred: nextStar ? 1 : 0 }),
        })
        await this.refreshStatsAfterMutation()
      } catch (e) {
        mail.is_starred = !nextStar
        this.refreshMailUiState()
        this.showError('星标修改失败')
      }
    },

    toggleMailSelectionByEvent(event) {
      const mailId = this.readMailIdFromEvent(event)
      if (!mailId) return
      const checked = Boolean(event?.target?.checked)
      const mailIdText = String(mailId)
      const selected = new Set(this.selectedIds.map((id) => String(id)))
      if (checked) {
        selected.add(mailIdText)
      } else {
        selected.delete(mailIdText)
      }
      this.selectedIds = Array.from(selected)
      this.refreshMailUiState()
    },

    async deleteActiveMail() {
      if (!this.activeMailDetail) return
      if (!confirm('确定删除这封邮件吗？')) return

      const id = this.activeMailDetail.id
      try {
        await this.apiFetch(`/api/emails/${id}`, { method: 'DELETE' })
        this.mails = this.mails.filter((m) => m.id !== id)
        this.clearFilterKeyword()
        this.clearActiveMailState()
        this.refreshMailUiState()
        await this.refreshStatsAfterMutation()
        this.showSuccess('邮件已删除')
      } catch (e) {
        this.showError('删除失败')
      }
    },

    async deleteSelected() {
      if (!this.selectedIds.length) return
      if (!confirm(`确定批量删除这 ${this.selectedIds.length} 封邮件吗？`)) return

      const ids = this.selectedIds
        .map((id) => parseInt(String(id || ''), 10))
        .filter((id) => Number.isFinite(id) && id > 0)
      if (!ids.length) return
      try {
        const result = await this.apiFetch('/api/emails/delete', {
          method: 'POST',
          body: JSON.stringify({ ids }),
        })
        const deleted =
          Array.isArray(result.deleted) && result.deleted.length > 0 ? result.deleted : ids
        const deletedIds = new Set(deleted.map((id) => Number(id)))
        this.mails = this.mails.filter((m) => !deletedIds.has(m.id))
        if (this.activeMail && deletedIds.has(this.activeMail.id)) {
          this.clearActiveMailState()
        }
        this.clearFilterKeyword()
        this.selectedIds = []
        this.refreshMailUiState()
        await this.refreshStatsAfterMutation()
        const missing = Array.isArray(result.missing) ? result.missing : []
        if (missing.length > 0) {
          this.showSuccess(`已删除 ${deletedIds.size} 封，${missing.length} 封已不存在`)
        } else {
          this.showSuccess(`已删除 ${deletedIds.size} 封邮件`)
        }
      } catch (e) {
        this.showError('部分删除失败，请重试')
      }
    },

    async markSelectedAsRead() {
      if (!this.selectedIds.length) return
      if (!this.canUseAdminActions) {
        this.showError('当前密钥为只读，无法批量标记已读')
        return
      }
      const ids = [...this.selectedIds]
      try {
        await this.apiFetch('/api/emails/read', {
          method: 'PUT',
          body: JSON.stringify({ ids: ids, read: 1 }),
        })
        ids.forEach((id) => this.markAsReadLocal(id))
        this.selectedIds = []
        await this.refreshStatsAfterMutation()
      } catch (e) {
        this.showError('标记阅读失败')
      }
    },

    markAsReadLocal(id) {
      const mail = this.mails.find((m) => m.id === id)
      if (mail) mail.is_read = 1
      if (this.activeMailDetail && this.activeMailDetail.id === id) {
        this.activeMailDetail.is_read = 1
      }
      this.refreshMailUiState()
    },

    // --- Utils --- //

    formatDate(ds) {
      if (!ds) return '-'
      const d = new Date(ds)
      const now = new Date()
      // If today, show time, else show date
      if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      }
      return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
    },

    formatDateFull(ds) {
      if (!ds) return '-'
      return new Date(ds).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    },

    formatDateWithTimeZone(ds) {
      if (!ds) return '-'
      return new Date(ds).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      })
    },

    formatBytes(bytes) {
      if (bytes === 0) return '0 B'
      const k = 1024
      const sizes = ['B', 'KB', 'MB', 'GB']
      const i = Math.floor(Math.log(bytes) / Math.log(k))
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
    },
  }
}

function registerMailAppComponent() {
  if (!window.Alpine || typeof window.Alpine.data !== 'function') {
    return false
  }
  window.Alpine.data('mailApp', createMailAppState)
  return true
}

if (!registerMailAppComponent()) {
  document.addEventListener(
    'alpine:init',
    () => {
      registerMailAppComponent()
    },
    { once: true }
  )
}
