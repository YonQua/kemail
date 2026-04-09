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
const GOVERNANCE_REFRESH_INTERVAL_MS = 20 * 1000
const DEFAULT_GOVERNANCE_RETENTION_DAYS = 3

function createDefaultGovernanceSettings() {
  return {
    retention_enabled: true,
    retention_days: DEFAULT_GOVERNANCE_RETENTION_DAYS,
  }
}

function createDefaultGovernanceStatus() {
  return {
    retention: {
      enabled: 1,
      retention_days: DEFAULT_GOVERNANCE_RETENTION_DAYS,
      last_run_at: '',
      last_deleted_count: 0,
      last_error: '',
    },
    rules: {
      total_rules: 0,
      enabled_rules: 0,
      last_run_at: '',
      last_deleted_count: 0,
      last_rule_count: 0,
      last_error: '',
    },
    scheduled: {
      last_run_at: '',
      last_error: '',
    },
  }
}

function createEmptyCleanupRuleDraft() {
  return {
    id: 0,
    name: '',
    enabled: true,
    recipient: '',
    sender_contains: '',
    subject_contains: '',
    note: '',
  }
}

function toPositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeGovernanceSettings(settings = {}) {
  return {
    retention_enabled: !(
      settings?.retention_enabled === 0 || settings?.retention_enabled === false
    ),
    retention_days: toPositiveInt(settings?.retention_days, DEFAULT_GOVERNANCE_RETENTION_DAYS),
  }
}

function normalizeGovernanceStatus(status = {}, settings = createDefaultGovernanceSettings()) {
  return {
    retention: {
      enabled:
        status?.retention?.enabled === 0 || status?.retention?.enabled === false
          ? 0
          : settings.retention_enabled
            ? 1
            : 0,
      retention_days: toPositiveInt(
        status?.retention?.retention_days,
        settings.retention_days || DEFAULT_GOVERNANCE_RETENTION_DAYS
      ),
      last_run_at: String(status?.retention?.last_run_at || ''),
      last_deleted_count: Number(status?.retention?.last_deleted_count || 0),
      last_error: String(status?.retention?.last_error || ''),
    },
    rules: {
      total_rules: Number(status?.rules?.total_rules || 0),
      enabled_rules: Number(status?.rules?.enabled_rules || 0),
      last_run_at: String(status?.rules?.last_run_at || ''),
      last_deleted_count: Number(status?.rules?.last_deleted_count || 0),
      last_rule_count: Number(status?.rules?.last_rule_count || 0),
      last_error: String(status?.rules?.last_error || ''),
    },
    scheduled: {
      last_run_at: String(status?.scheduled?.last_run_at || ''),
      last_error: String(status?.scheduled?.last_error || ''),
    },
  }
}

function normalizeCleanupRuleDraft(rule = {}) {
  return {
    id: Number(rule?.id || 0),
    name: String(rule?.name || ''),
    enabled: !(rule?.enabled === 0 || rule?.enabled === false),
    recipient: String(rule?.recipient || ''),
    sender_contains: String(rule?.sender_contains || ''),
    subject_contains: String(rule?.subject_contains || ''),
    note: String(rule?.note || ''),
  }
}

function normalizeCleanupRuleRecord(rule = {}) {
  const draft = normalizeCleanupRuleDraft(rule)
  return {
    ...draft,
    enabled: draft.enabled ? 1 : 0,
    last_run_at: String(rule?.last_run_at || ''),
    last_match_count: Number(rule?.last_match_count || 0),
    last_deleted_count: Number(rule?.last_deleted_count || 0),
    total_deleted_count: Number(rule?.total_deleted_count || 0),
    last_error: String(rule?.last_error || ''),
    created_at: String(rule?.created_at || ''),
    updated_at: String(rule?.updated_at || ''),
  }
}

function buildCleanupRulePayload(rule = {}) {
  const draft = normalizeCleanupRuleDraft(rule)
  return {
    name: draft.name.trim(),
    enabled: draft.enabled ? 1 : 0,
    recipient: draft.recipient.trim(),
    sender_contains: draft.sender_contains.trim(),
    subject_contains: draft.subject_contains.trim(),
    note: draft.note.trim(),
  }
}

function buildCleanupRuleMatcherSummary(rule = {}) {
  const payload = buildCleanupRulePayload(rule)
  const parts = []
  if (payload.recipient) parts.push(`收件人 = ${payload.recipient}`)
  if (payload.sender_contains) parts.push(`发件人包含 \"${payload.sender_contains}\"`)
  if (payload.subject_contains) parts.push(`主题包含 \"${payload.subject_contains}\"`)
  return parts.length ? parts.join(' · ') : '未设置匹配条件'
}

function isGovernanceMigrationError(error) {
  return (
    error?.code === 'GOVERNANCE_MIGRATION_REQUIRED' ||
    String(error?.message || '').includes('Governance tables missing')
  )
}

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
    activeTab: 'inbox', // 'inbox' | 'dashboard' | 'domains' | 'governance' | 'docs'
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
    docsMode: 'public',
    docsLoading: false,
    docsError: '',
    docsSpecs: {
      public: null,
      admin: null,
    },
    docsRenderedMode: '',
    docsRequestToken: 0,
    governanceLoaded: false,
    governanceLoading: false,
    governanceNeedsRefresh: false,
    governanceLastLoadedAt: 0,
    governanceMigrationRequired: false,
    governanceSettings: createDefaultGovernanceSettings(),
    governanceStatus: createDefaultGovernanceStatus(),
    cleanupRules: [],
    governanceSettingsSaving: false,
    governanceRetentionRunning: false,
    governanceRulesRunning: false,
    governanceRuleActionId: 0,
    governanceRuleActionType: '',
    governanceFormOpen: false,
    governanceFormMode: 'create',
    governanceForm: createEmptyCleanupRuleDraft(),
    governanceFormSubmitting: false,
    governancePreviewLoading: false,
    governancePreviewRequested: false,
    governancePreviewMatchCount: null,
    governancePreviewError: '',

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
    detailLoading: false,
    renderMode: 'text', // 'html', 'text', 'source'
    detailRequestToken: 0,
    showAllActionLinks: false,

    // Internal
    baseApiUrl: location.origin,

    init() {
      this.authInput = ''
      this.resetGovernanceState()
    },

    resetGovernanceState() {
      this.governanceLoaded = false
      this.governanceLoading = false
      this.governanceNeedsRefresh = false
      this.governanceLastLoadedAt = 0
      this.governanceMigrationRequired = false
      this.governanceSettings = createDefaultGovernanceSettings()
      this.governanceStatus = createDefaultGovernanceStatus()
      this.cleanupRules = []
      this.governanceSettingsSaving = false
      this.governanceRetentionRunning = false
      this.governanceRulesRunning = false
      this.governanceRuleActionId = 0
      this.governanceRuleActionType = ''
      this.governanceFormOpen = false
      this.governanceFormMode = 'create'
      this.governanceForm = createEmptyCleanupRuleDraft()
      this.governanceFormSubmitting = false
      this.governancePreviewLoading = false
      this.governancePreviewRequested = false
      this.governancePreviewMatchCount = null
      this.governancePreviewError = ''
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
        // 用内部消息列表验证鉴权，同时读取当前 key 是否具备管理员能力。
        const data = await this.apiFetch('/api/admin/messages?limit=1')
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
      this.docsMode = 'public'
      this.docsLoading = false
      this.docsError = ''
      this.docsSpecs = { public: null, admin: null }
      this.docsRenderedMode = ''
      this.docsRequestToken += 1
      this.resetGovernanceState()
      this.activeTab = 'inbox'
      this.activeMail = null
      this.activeMailDetail = null
      const docsRoot = this.$refs?.docsRoot
      if (docsRoot) docsRoot.innerHTML = ''
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

    async fetchDocsSpec(mode) {
      const path = mode === 'admin' ? '/api/admin/openapi' : '/api-docs-spec.json'
      return this.apiFetch(path, {
        headers: {
          Accept: 'application/json',
        },
      })
    },

    async ensureDocsModeLoaded(mode = this.docsMode) {
      if (mode === 'admin' && !this.canUseAdminActions) {
        this.docsMode = 'public'
        this.showError('当前密钥为只读，无法查看内部接口文档')
        mode = 'public'
      }

      const requestToken = ++this.docsRequestToken
      this.docsLoading = true
      this.docsError = ''

      try {
        if (!this.docsSpecs[mode]) {
          const spec = await this.fetchDocsSpec(mode)
          if (requestToken !== this.docsRequestToken) return
          this.docsSpecs[mode] = spec
        }
        await this.renderDocsMode(mode, requestToken)
        if (requestToken !== this.docsRequestToken) return
      } catch (e) {
        if (requestToken !== this.docsRequestToken) return
        this.docsRenderedMode = ''
        this.docsError = `文档加载失败: ${e.message}`
        const docsRoot = this.$refs?.docsRoot
        if (docsRoot) docsRoot.innerHTML = ''
        this.showError(this.docsError)
      } finally {
        if (requestToken !== this.docsRequestToken) return
        this.docsLoading = false
      }
    },

    async renderDocsMode(mode = this.docsMode, requestToken = this.docsRequestToken) {
      const spec = this.docsSpecs[mode]
      if (!spec) return

      await new Promise((resolve) => this.$nextTick(resolve))
      if (requestToken !== this.docsRequestToken) return
      const docsRoot = this.$refs?.docsRoot
      if (!docsRoot) return

      if (!window.KemailDocsView || typeof window.KemailDocsView.renderInto !== 'function') {
        throw new Error('文档渲染器未加载')
      }

      window.KemailDocsView.renderInto(docsRoot, spec, {
        embedded: true,
        mode,
        serverUrl: this.baseApiUrl,
        machineHref: mode === 'admin' ? '' : '/openapi.json',
        machineLabel: mode === 'admin' ? '' : '/openapi.json',
        title: mode === 'admin' ? '内部接口文档' : '公开接口文档',
        description: spec?.info?.description || '',
      })
      if (requestToken !== this.docsRequestToken) return
      this.docsRenderedMode = mode
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
        this.fetchGovernanceData({ force: false, showNotice: false })
      } else {
        this.managedDomains = []
        if (this.activeTab === 'domains' || this.activeTab === 'governance') {
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
          currentTotal: s.currentTotal || 0,
          todayReceived: s.todayReceived || 0,
          last7DaysReceived: s.last7DaysReceived || 0,
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
      if ((nextTab === 'domains' || nextTab === 'governance') && !this.canUseAdminActions) {
        nextTab = 'inbox'
      }
      this.activeTab = nextTab
      if (nextTab === 'dashboard') {
        const shouldRefresh =
          this.statsNeedsRefresh ||
          Date.now() - Number(this.statsLastLoadedAt || 0) >= STATS_REFRESH_INTERVAL_MS
        if (shouldRefresh) {
          this.fetchStats()
        }
      }
    },

    async showDocsTab() {
      this.switchTab('docs')
      await this.ensureDocsModeLoaded(this.docsMode)
    },

    async showDocsPublicMode() {
      this.docsMode = 'public'
      if (!this.isDocsTab) {
        await this.showDocsTab()
        return
      }
      await this.ensureDocsModeLoaded('public')
    },

    async showDocsAdminMode() {
      if (!this.canUseAdminActions) {
        this.showError('当前密钥为只读，无法查看内部接口文档')
        return
      }
      this.docsMode = 'admin'
      if (!this.isDocsTab) {
        await this.showDocsTab()
        return
      }
      await this.ensureDocsModeLoaded('admin')
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

    get isGovernanceTab() {
      return this.activeTab === 'governance'
    },

    get isDocsTab() {
      return this.activeTab === 'docs'
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

    get governancePanelClass() {
      return { 'is-hidden': !this.isGovernanceTab }
    },

    get docsPanelClass() {
      return { 'is-hidden': !this.isDocsTab }
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

    async showGovernanceTab() {
      this.switchTab('governance')
      await this.fetchGovernanceData({ force: false, showNotice: true })
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

    get governanceTabClass() {
      return { active: this.activeTab === 'governance' }
    },

    get docsTabClass() {
      return { active: this.activeTab === 'docs' }
    },

    get docsSummaryLabel() {
      if (this.docsLoading) return '正在准备文档...'
      if (this.docsMode === 'admin') return '当前查看内部接口文档'
      return '当前查看公开主链接口文档'
    },

    get docsSubnoteLabel() {
      if (this.docsMode === 'admin') {
        return '内部接口文档包含公开主链、调试回溯和后台能力，仅管理员密钥可见。'
      }
      return '公开接口文档只保留推荐给第三方自动化与 AI 的主链能力；机器契约继续单独保留。'
    },

    get docsPublicModeButtonClass() {
      return {
        'btn-primary': this.docsMode === 'public',
        'btn-secondary': this.docsMode !== 'public',
      }
    },

    get showDocsMachineLink() {
      return this.docsMode === 'public'
    },

    get docsMachineLinkHref() {
      return '/openapi.json'
    },

    get docsMachineLinkCode() {
      return '/openapi.json'
    },

    get docsAdminModeButtonClass() {
      return {
        'btn-primary': this.docsMode === 'admin',
        'btn-secondary': this.docsMode !== 'admin',
      }
    },

    get showDocsErrorState() {
      return Boolean(this.docsError) && !this.docsLoading
    },

    get showDocsContentState() {
      return !this.docsLoading && !this.docsError && this.docsRenderedMode === this.docsMode
    },

    get docsContentClass() {
      return this.showDocsContentState ? '' : 'is-hidden'
    },

    // --- Governance --- //

    get governanceRetentionState() {
      return this.governanceStatus?.retention || createDefaultGovernanceStatus().retention
    },

    get governanceRulesState() {
      return this.governanceStatus?.rules || createDefaultGovernanceStatus().rules
    },

    get governanceScheduledState() {
      return this.governanceStatus?.scheduled || createDefaultGovernanceStatus().scheduled
    },

    get showGovernanceMigrationState() {
      return this.governanceMigrationRequired
    },

    get showGovernanceLoadingState() {
      return !this.governanceMigrationRequired && this.governanceLoading && !this.governanceLoaded
    },

    get showGovernanceBodyState() {
      return !this.governanceMigrationRequired
    },

    get showGovernanceFormModal() {
      return this.governanceFormOpen
    },

    decorateCleanupRule(rule) {
      const record = normalizeCleanupRuleRecord(rule)
      const enabled = record.enabled ? 1 : 0
      const lastRunAt = record.last_run_at
      const lastError = String(record.last_error || '').trim()

      return {
        ...record,
        id_label: `#${record.id}`,
        enabled,
        matcher_summary: buildCleanupRuleMatcherSummary(record),
        last_run_at: lastRunAt,
        last_run_label: lastRunAt ? this.formatDateFull(lastRunAt) : '未执行',
        last_error: lastError,
        note_label: record.note || '未填写备注',
        last_result_label: `命中 ${record.last_match_count} · 删除 ${record.last_deleted_count}`,
        enabled_label: enabled ? '已启用' : '已停用',
        run_action_label: '执行规则',
      }
    },

    setCleanupRules(rules) {
      this.cleanupRules = (Array.isArray(rules) ? rules : []).map((rule) =>
        this.decorateCleanupRule(rule)
      )
    },

    findCleanupRuleById(id) {
      return this.cleanupRules.find((rule) => rule.id === Number(id || 0)) || null
    },

    clearGovernancePreview() {
      this.governancePreviewLoading = false
      this.governancePreviewRequested = false
      this.governancePreviewMatchCount = null
      this.governancePreviewError = ''
    },

    markGovernanceDirty() {
      this.governanceNeedsRefresh = true
    },

    consumeGovernanceError(error, options = {}) {
      if (isGovernanceMigrationError(error)) {
        this.governanceLoaded = true
        this.governanceMigrationRequired = true
        this.governanceSettings = createDefaultGovernanceSettings()
        this.governanceStatus = createDefaultGovernanceStatus()
        this.cleanupRules = []
        if (options.showNotice) {
          this.showError('邮件治理表尚未初始化，请先执行 README 中的 D1 migration SQL')
        }
        return true
      }

      if (String(error?.message || '') === 'Admin access required') {
        this.adminAccessAvailable = false
        this.resetGovernanceState()
        if (this.activeTab === 'governance') {
          this.activeTab = 'inbox'
        }
        if (options.showNotice !== false) {
          this.showError(options.adminMessage || '当前密钥不支持邮件治理')
        }
        return true
      }

      return false
    },

    async fetchGovernanceData(options = {}) {
      if (!this.canUseAdminActions) return
      const force = options.force === true
      const showNotice = options.showNotice === true
      const shouldReuse =
        !force &&
        this.governanceLoaded &&
        !this.governanceNeedsRefresh &&
        Date.now() - Number(this.governanceLastLoadedAt || 0) < GOVERNANCE_REFRESH_INTERVAL_MS

      if (shouldReuse || this.governanceLoading) return

      this.governanceLoading = true
      try {
        const [settingsData, statusData, rulesData] = await Promise.all([
          this.apiFetch('/api/admin/governance/settings'),
          this.apiFetch('/api/admin/governance/status'),
          this.apiFetch('/api/admin/cleanup-rules'),
        ])

        const settings = normalizeGovernanceSettings(settingsData?.settings || {})
        this.governanceSettings = settings
        this.governanceStatus = normalizeGovernanceStatus(statusData?.status || {}, settings)
        this.setCleanupRules(rulesData?.rules || [])
        this.governanceLoaded = true
        this.governanceMigrationRequired = false
        this.governanceNeedsRefresh = false
        this.governanceLastLoadedAt = Date.now()
      } catch (error) {
        this.governanceLoaded = true
        this.governanceLastLoadedAt = Date.now()
        if (this.consumeGovernanceError(error, { showNotice })) return
        if (showNotice) {
          this.showError('邮件治理数据加载失败: ' + error.message)
        }
      } finally {
        this.governanceLoading = false
      }
    },

    async refreshGovernancePanel() {
      await this.fetchGovernanceData({ force: true, showNotice: true })
    },

    setGovernanceRuleAction(ruleId, actionType) {
      this.governanceRuleActionId = Number(ruleId || 0)
      this.governanceRuleActionType = String(actionType || '')
    },

    clearGovernanceRuleAction() {
      this.governanceRuleActionId = 0
      this.governanceRuleActionType = ''
    },

    updateGovernanceRetentionEnabledByEvent(event) {
      this.governanceSettings.retention_enabled = Boolean(event?.target?.checked)
    },

    updateGovernanceRetentionDaysByEvent(event) {
      const rawValue = String(event?.target?.value ?? '').trim()
      this.governanceSettings.retention_days = rawValue === '' ? '' : rawValue
    },

    updateGovernanceFormFieldByEvent(event) {
      const fieldName = String(event?.target?.dataset?.governanceField || '')
      if (!fieldName || !Object.prototype.hasOwnProperty.call(this.governanceForm, fieldName))
        return

      if (fieldName === 'enabled') {
        this.governanceForm.enabled = Boolean(event?.target?.checked)
      } else {
        this.governanceForm[fieldName] = String(event?.target?.value ?? '')
      }
      this.clearGovernancePreview()
    },

    resolveCleanupRuleFromEvent(event) {
      const ruleId = Number(
        event?.currentTarget?.dataset?.ruleId || event?.target?.dataset?.ruleId || 0
      )
      return ruleId > 0 ? this.findCleanupRuleById(ruleId) : null
    },

    validateGovernanceRulePayload(payload, options = {}) {
      const requireName = options.requireName !== false
      if (requireName && !payload.name) {
        return '请输入规则名称'
      }
      if (!payload.recipient && !payload.sender_contains && !payload.subject_contains) {
        return '至少填写一个匹配条件'
      }
      return ''
    },

    openCreateGovernanceRuleForm() {
      this.resetGovernanceForm()
      this.governanceFormOpen = true
    },

    startEditingCleanupRule(rule) {
      const target = typeof rule === 'number' ? this.findCleanupRuleById(rule) : rule
      if (!target) return
      this.governanceFormMode = 'edit'
      this.governanceForm = normalizeCleanupRuleDraft(target)
      this.governanceFormOpen = true
      this.clearGovernancePreview()
    },

    startEditingCleanupRuleByEvent(event) {
      const target = this.resolveCleanupRuleFromEvent(event)
      if (!target) return
      this.startEditingCleanupRule(target)
    },

    resetGovernanceForm() {
      this.governanceFormMode = 'create'
      this.governanceForm = createEmptyCleanupRuleDraft()
      this.clearGovernancePreview()
    },

    closeGovernanceFormModal() {
      if (this.governanceFormSubmitting) return
      this.governanceFormOpen = false
      this.resetGovernanceForm()
    },

    async syncGovernanceAffectedData(options = {}) {
      this.markGovernanceDirty()
      const tasks = []
      if (options.refreshGovernance !== false) {
        tasks.push(this.fetchGovernanceData({ force: true, showNotice: false }))
      }
      if (options.refreshMails !== false) {
        tasks.push(this.fetchMails())
      }
      if (options.refreshStats !== false) {
        tasks.push(this.refreshStatsAfterMutation())
      }
      await Promise.all(tasks)
    },

    async saveGovernanceSettings() {
      if (!this.canUseAdminActions || this.governanceSettingsSaving) return

      const retentionDays = toPositiveInt(
        this.governanceSettings.retention_days,
        DEFAULT_GOVERNANCE_RETENTION_DAYS
      )
      if (retentionDays < 1) {
        this.showError('保留天数必须是大于 0 的整数')
        return
      }

      this.governanceSettingsSaving = true
      try {
        const data = await this.apiFetch('/api/admin/governance/settings', {
          method: 'PUT',
          body: JSON.stringify({
            retention_enabled: this.governanceSettings.retention_enabled ? 1 : 0,
            retention_days: retentionDays,
          }),
        })
        this.governanceSettings = normalizeGovernanceSettings(data?.settings || {})
        await Promise.all([
          this.fetchGovernanceData({ force: true, showNotice: false }),
          this.refreshStatsAfterMutation(),
        ])
        this.showSuccess('保留策略已保存')
      } catch (error) {
        if (this.consumeGovernanceError(error, { showNotice: true })) return
        this.showError('保留策略保存失败: ' + error.message)
      } finally {
        this.governanceSettingsSaving = false
      }
    },

    async runRetentionCleanup() {
      if (!this.canUseAdminActions || this.governanceRetentionRunning) return
      if (!confirm('确定立即执行旧邮件保留清理吗？会删除超过保留天数的邮件。')) return

      this.governanceRetentionRunning = true
      try {
        const data = await this.apiFetch('/api/admin/governance/retention/run', {
          method: 'POST',
        })
        const result = data?.result || {}
        await this.syncGovernanceAffectedData()
        if (result?.skipped) {
          this.showSuccess('旧邮件保留清理已执行，当前策略处于关闭状态')
        } else {
          this.showSuccess(`旧邮件保留清理完成，删除 ${result?.deleted_count || 0} 封邮件`)
        }
      } catch (error) {
        if (this.consumeGovernanceError(error, { showNotice: true })) return
        this.showError('旧邮件保留清理失败: ' + error.message)
      } finally {
        this.governanceRetentionRunning = false
      }
    },

    async previewGovernanceRule() {
      if (!this.canUseAdminActions || this.governancePreviewLoading) return

      const payload = buildCleanupRulePayload(this.governanceForm)
      const validationError = this.validateGovernanceRulePayload(payload, { requireName: false })
      this.governancePreviewRequested = true
      this.governancePreviewMatchCount = null
      this.governancePreviewError = validationError
      if (validationError) return

      this.governancePreviewLoading = true
      try {
        const data = await this.apiFetch('/api/admin/cleanup-rules/preview', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        this.governancePreviewMatchCount = Number(data?.preview?.match_count || 0)
        this.governancePreviewError = ''
      } catch (error) {
        if (this.consumeGovernanceError(error, { showNotice: true })) return
        this.governancePreviewMatchCount = null
        this.governancePreviewError = error.message || '预览失败'
      } finally {
        this.governancePreviewLoading = false
      }
    },

    async submitGovernanceRuleForm() {
      if (!this.canUseAdminActions || this.governanceFormSubmitting) return

      const payload = buildCleanupRulePayload(this.governanceForm)
      const validationError = this.validateGovernanceRulePayload(payload)
      if (validationError) {
        this.governancePreviewRequested = true
        this.governancePreviewMatchCount = null
        this.governancePreviewError = validationError
        this.showError(validationError)
        return
      }

      const ruleId = Number(this.governanceForm.id || 0)
      const isEdit = this.governanceFormMode === 'edit' && ruleId > 0
      const requestPath = isEdit ? `/api/admin/cleanup-rules/${ruleId}` : '/api/admin/cleanup-rules'
      const requestMethod = isEdit ? 'PUT' : 'POST'

      this.governanceFormSubmitting = true
      try {
        await this.apiFetch(requestPath, {
          method: requestMethod,
          body: JSON.stringify(payload),
        })
        await this.fetchGovernanceData({ force: true, showNotice: false })
        this.governanceFormOpen = false
        this.resetGovernanceForm()
        this.showSuccess(isEdit ? '清理规则已更新' : '清理规则已创建')
      } catch (error) {
        if (this.consumeGovernanceError(error, { showNotice: true })) return
        this.showError(`${isEdit ? '更新' : '创建'}清理规则失败: ${error.message}`)
      } finally {
        this.governanceFormSubmitting = false
      }
    },

    async toggleCleanupRuleEnabled(rule) {
      if (!this.canUseAdminActions) return
      if (this.governanceRuleActionId) return
      const target = this.findCleanupRuleById(rule?.id || 0) || rule
      if (!target) return

      const nextEnabled = target.enabled ? 0 : 1
      this.setGovernanceRuleAction(target.id, 'toggle')
      try {
        await this.apiFetch(`/api/admin/cleanup-rules/${target.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            enabled: nextEnabled,
          }),
        })
        if (Number(this.governanceForm.id || 0) === target.id) {
          this.governanceForm.enabled = Boolean(nextEnabled)
        }
        await this.fetchGovernanceData({ force: true, showNotice: false })
        this.showSuccess(`规则已${nextEnabled ? '启用' : '停用'}`)
      } catch (error) {
        if (this.consumeGovernanceError(error, { showNotice: true })) return
        this.showError(`规则${nextEnabled ? '启用' : '停用'}失败: ${error.message}`)
      } finally {
        this.clearGovernanceRuleAction()
      }
    },

    async toggleCleanupRuleEnabledByEvent(event) {
      const target = this.resolveCleanupRuleFromEvent(event)
      if (!target) return
      await this.toggleCleanupRuleEnabled(target)
    },

    async deleteCleanupRule(rule) {
      if (!this.canUseAdminActions) return
      if (this.governanceRuleActionId) return
      const target = this.findCleanupRuleById(rule?.id || 0) || rule
      if (!target) return
      if (!confirm(`确定删除规则“${target.name}”吗？`)) return

      this.setGovernanceRuleAction(target.id, 'delete')
      try {
        await this.apiFetch(`/api/admin/cleanup-rules/${target.id}`, {
          method: 'DELETE',
        })
        if (Number(this.governanceForm.id || 0) === target.id) {
          this.resetGovernanceForm()
        }
        await this.fetchGovernanceData({ force: true, showNotice: false })
        this.showSuccess('清理规则已删除')
      } catch (error) {
        if (this.consumeGovernanceError(error, { showNotice: true })) return
        this.showError('删除清理规则失败: ' + error.message)
      } finally {
        this.clearGovernanceRuleAction()
      }
    },

    async deleteCleanupRuleByEvent(event) {
      const target = this.resolveCleanupRuleFromEvent(event)
      if (!target) return
      await this.deleteCleanupRule(target)
    },

    async runCleanupRule(rule) {
      if (!this.canUseAdminActions) return
      if (this.governanceRuleActionId) return
      const target = this.findCleanupRuleById(rule?.id || 0) || rule
      if (!target) return
      if (!confirm(`确定立即执行规则“${target.name}”吗？会删除命中的非星标邮件。`)) return

      this.setGovernanceRuleAction(target.id, 'run')
      try {
        const data = await this.apiFetch(`/api/admin/cleanup-rules/${target.id}/run`, {
          method: 'POST',
        })
        const result = data?.result || {}
        await this.syncGovernanceAffectedData()
        this.showSuccess(
          `规则已执行，命中 ${result?.match_count || 0} 封，删除 ${result?.deleted_count || 0} 封`
        )
      } catch (error) {
        if (this.consumeGovernanceError(error, { showNotice: true })) return
        this.showError('执行清理规则失败: ' + error.message)
      } finally {
        this.clearGovernanceRuleAction()
      }
    },

    async runCleanupRuleByEvent(event) {
      const target = this.resolveCleanupRuleFromEvent(event)
      if (!target) return
      await this.runCleanupRule(target)
    },

    async runAllCleanupRules() {
      if (!this.canUseAdminActions || this.governanceRulesRunning) return
      if (!this.hasEnabledCleanupRules) {
        this.showError('当前没有启用中的清理规则')
        return
      }
      if (!confirm('确定立即执行全部启用规则吗？会删除命中的非星标邮件。')) return

      this.governanceRulesRunning = true
      try {
        const data = await this.apiFetch('/api/admin/cleanup-rules/run', {
          method: 'POST',
        })
        const result = data?.result || {}
        await this.syncGovernanceAffectedData()
        const errorCount = Array.isArray(result?.errors) ? result.errors.length : 0
        const message = `已执行 ${result?.rule_count || 0} 条规则，删除 ${result?.deleted_count || 0} 封邮件`
        if (errorCount > 0) {
          this.showError(`${message}，其中 ${errorCount} 条执行失败`)
        } else {
          this.showSuccess(message)
        }
      } catch (error) {
        if (this.consumeGovernanceError(error, { showNotice: true })) return
        this.showError('执行全部规则失败: ' + error.message)
      } finally {
        this.governanceRulesRunning = false
      }
    },

    get governanceSummaryLabel() {
      if (this.governanceMigrationRequired) return '邮件治理表尚未初始化'
      if (this.governanceLoading && !this.governanceLoaded) return '正在加载邮件治理配置...'
      const rulesState = this.governanceRulesState
      const totalRules = Number(rulesState.total_rules || this.cleanupRules.length || 0)
      const enabledRules = Number(
        rulesState.enabled_rules || this.cleanupRules.filter((rule) => rule.enabled).length
      )
      const retentionDays = Number(this.governanceSettings.retention_days || 0)
      const retentionLabel = this.governanceSettings.retention_enabled
        ? `保留 ${retentionDays} 天`
        : '保留策略已关闭'
      return `规则 ${enabledRules}/${totalRules} 启用 · ${retentionLabel}`
    },

    get governancePageTitleLabel() {
      return '邮件治理'
    },

    get governancePageSubtitleLabel() {
      return '邮件治理：统一管理旧邮件保留策略与广告/摘要邮件自动清理规则。'
    },

    get governanceRefreshButtonLabel() {
      return this.governanceLoading ? '刷新中...' : '刷新治理数据'
    },

    get governanceSaveSettingsLabel() {
      return this.governanceSettingsSaving ? '保存中...' : '保存保留策略'
    },

    get governanceRetentionRunLabel() {
      return this.governanceRetentionRunning ? '执行中...' : '立即清理过期邮件'
    },

    get governanceFormSubmitLabel() {
      if (this.governanceFormSubmitting) {
        return this.governanceFormMode === 'edit' ? '保存中...' : '创建中...'
      }
      return this.governanceFormMode === 'edit' ? '保存规则' : '创建规则'
    },

    get governancePreviewButtonLabel() {
      return this.governancePreviewLoading ? '预览中...' : '预览命中数'
    },

    get governancePreviewClass() {
      return {
        success: this.governancePreviewRequested && !this.governancePreviewError,
        error: Boolean(this.governancePreviewError),
      }
    },

    get governancePreviewLabel() {
      if (this.governancePreviewLoading) return '正在计算命中数量...'
      if (this.governancePreviewError) return `预览失败: ${this.governancePreviewError}`
      if (this.governancePreviewRequested) {
        return `预计命中 ${Number(this.governancePreviewMatchCount || 0)} 封非星标邮件`
      }
      return '保存前可先预览当前条件会命中多少封非星标邮件。'
    },

    get governanceRetentionStatusChipLabel() {
      return this.governanceSettings.retention_enabled ? '已启用' : '已关闭'
    },

    get governanceRulesStatusChipClass() {
      if (this.governanceRulesState.last_error) return 'chip-red'
      if (this.hasEnabledCleanupRules) return 'chip-green'
      return 'chip-gray'
    },

    get governanceRulesStatusChipLabel() {
      if (this.governanceRulesState.last_error) return '部分失败'
      if (this.hasEnabledCleanupRules) return '可执行'
      return '暂无启用规则'
    },

    get governancePanelContentClass() {
      return { 'is-loading': this.governanceLoading }
    },

    get governanceRetentionLastRunLabel() {
      return this.governanceRetentionState.last_run_at
        ? this.formatDateFull(this.governanceRetentionState.last_run_at)
        : '未执行'
    },

    get governanceRulesLastRunLabel() {
      return this.governanceRulesState.last_run_at
        ? this.formatDateFull(this.governanceRulesState.last_run_at)
        : '未执行'
    },

    get governanceScheduledLastRunLabel() {
      return this.governanceScheduledState.last_run_at
        ? this.formatDateFull(this.governanceScheduledState.last_run_at)
        : '未执行'
    },

    get governanceRetentionExecutionSummary() {
      if (!this.governanceRetentionState.last_run_at) {
        return '旧邮件保留清理尚未手工执行；系统会继续按已配置的 cron 调度运行。'
      }
      return `最近一次旧邮件保留清理于 ${this.governanceRetentionLastRunLabel} 执行，删除 ${this.governanceRetentionState.last_deleted_count} 封过期邮件。`
    },

    get governanceScheduledExecutionSummary() {
      if (!this.governanceScheduledState.last_run_at) {
        return 'scheduled() 还没有留下执行记录。'
      }
      return `系统最近一次调度于 ${this.governanceScheduledLastRunLabel} 执行。`
    },

    get governanceRulesExecutionSummary() {
      if (!this.governanceRulesState.last_run_at) {
        return `当前共 ${this.governanceRulesState.total_rules} 条规则，启用 ${this.governanceRulesState.enabled_rules} 条。`
      }
      return `最近一轮规则批量执行于 ${this.governanceRulesLastRunLabel} 完成，执行 ${this.governanceRulesState.last_rule_count} 条规则，删除 ${this.governanceRulesState.last_deleted_count} 封邮件。`
    },

    get governanceRulesCountLabel() {
      return `共 ${this.governanceRulesState.total_rules} 条规则，启用 ${this.governanceRulesState.enabled_rules} 条。`
    },

    get showGovernanceRulesEmpty() {
      return !this.governanceLoading && !this.cleanupRules.length
    },

    get showGovernanceRulesTable() {
      return !this.showGovernanceRulesEmpty
    },

    get hasEnabledCleanupRules() {
      return this.cleanupRules.some((rule) => rule.enabled)
    },

    get governanceRunAllRulesDisabled() {
      return this.governanceLoading || this.governanceRulesRunning || !this.hasEnabledCleanupRules
    },

    get runAllCleanupRulesLabel() {
      return this.governanceRulesRunning ? '执行中...' : '执行全部启用规则'
    },

    get governanceOpenRuleModalLabel() {
      return '新增规则'
    },

    get governanceModalTitleLabel() {
      return this.governanceFormMode === 'edit' ? '编辑清理规则' : '新增清理规则'
    },

    get governanceModalSubtitleLabel() {
      return '匹配条件按 AND 组合，系统自动跳过星标邮件。保存前可先预览命中数量。'
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
      this.addressGenerating = true
      try {
        const data = await this.apiFetch('/api/mailboxes', {
          method: 'POST',
        })
        const mailbox = data?.mailbox || {}
        const generatedEmail = String(mailbox?.address || '').trim()
        if (!generatedEmail) {
          throw new Error('服务端未返回完整邮箱地址')
        }
        this.generatedEmail = generatedEmail
        this.generatedDomain = String(mailbox?.domain || generatedEmail.split('@')[1] || '')
        this.generatedIssuedAt = String(mailbox?.issued_at || '')
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
      return this.generatedAddressAvailable
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
        let path = '/api/admin/messages?limit=50'
        if (this.searchAddress) path += `&address=${encodeURIComponent(this.searchAddress)}`
        if (this.sortOrder) path += `&sort=${this.sortOrder}`

        const data = await this.apiFetch(path)
        if (typeof data?.permissions?.admin === 'boolean') {
          this.adminAccessAvailable = data.permissions.admin
        }
        this.mailServerTotal = Number(data?.result_info?.total_count || 0)
        const messages = Array.isArray(data.messages) ? data.messages : []
        this.mails = messages.map((mail) => this.decorateMailSummary(mail))
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

      const rawActionLinks = Array.isArray(detail?.artifacts?.links)
        ? detail.artifacts.links.map((link) => ({
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
        content_text_label: compactBodyTextValue(detail?.content?.text),
        content_source_label:
          detail?.content?.source || (detail?.source_available ? '原始 MIME 为空。' : '当前邮件未保存原始 MIME。'),
        safe_content_html: getSafeHtmlDocument(detail?.content?.html),
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
        const data = await this.apiFetch(`/api/admin/messages/${mail.id}`)
        if (
          requestToken !== this.detailRequestToken ||
          !this.activeMail ||
          this.activeMail.id !== mail.id
        ) {
          return
        }
        const preparedDetail = this.decorateMailDetail(data.message || {})
        this.activeMailDetail = preparedDetail
        this.showAllActionLinks = false
        this.renderMode = this.activeMailDetail.content?.html ? 'html' : 'text'
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
      const mail = this.findMailById(mailId)
      if (!mail || mail.is_read) return

      try {
        await this.apiFetch('/api/admin/messages/read', {
          method: 'PUT',
          body: JSON.stringify({ ids: [mailId], read: 1 }),
        })
        this.markAsReadLocal(mailId)
        await this.refreshStatsAfterMutation()
      } catch (e) {
        if (e.message === 'Admin access required' || e.message === 'Unauthorized') {
          return
        }
        this.showError('标记阅读失败')
      }
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
      const status = String(this.activeMailDetail?.parse_status || '')
      return status === 'parsed' || status === 'parsed_source_truncated'
        ? 'chip-green'
        : 'chip-gray'
    },

    get detailChipLabel() {
      const status = String(this.activeMailDetail?.parse_status || '')
      if (status === 'parsed') return '完整解析'
      if (status === 'parsed_source_truncated') return '已解析，原文未保存'
      if (status === 'parse_skipped') return '未完整解析，保留原文'
      if (status === 'parse_skipped_source_truncated') return '未完整解析'
      if (status === 'too_large') return '原文过大'
      return '邮件详情'
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
      return Boolean(this.activeMailDetail?.content?.html)
    },

    get detailHasRawSource() {
      return Boolean(this.activeMailDetail?.source_available)
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
      return Boolean(this.renderMode === 'html' && this.activeMailDetail?.content?.html)
    },

    get showTextView() {
      return Boolean(
        this.renderMode === 'text' ||
        (this.renderMode === 'html' && !this.activeMailDetail?.content?.html)
      )
    },

    get showSourceView() {
      return Boolean(this.renderMode === 'source' && this.activeMailDetail?.source_available)
    },

    get contentTextLabel() {
      return this.activeMailDetail?.content_text_label || '提取纯文本失败...'
    },

    get contentSourceLabel() {
      return this.activeMailDetail?.content_source_label || '当前邮件未保存原始 MIME。'
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
        await this.apiFetch('/api/admin/messages/star', {
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
        await this.apiFetch(`/api/admin/messages/${id}`, { method: 'DELETE' })
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
        const result = await this.apiFetch('/api/admin/messages/delete', {
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
        await this.apiFetch('/api/admin/messages/read', {
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
