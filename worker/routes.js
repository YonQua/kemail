export const API_AUTH_LEVEL = Object.freeze({
  NONE: 'none',
  READ: 'read',
  ADMIN: 'admin',
})

export const API_RATE_LIMIT_CLASS = Object.freeze({
  NONE: 'none',
  READ: 'read',
  ADMIN_READ: 'admin-read',
  WRITE: 'write',
  ANALYSIS: 'analysis',
})

function defineRoute(definition) {
  return Object.freeze(definition)
}

const API_ROUTE_DEFINITIONS = Object.freeze([
  defineRoute({
    name: 'version',
    path: '/api/version',
    operations: {
      GET: {
        auth: API_AUTH_LEVEL.NONE,
        rateLimit: API_RATE_LIMIT_CLASS.NONE,
        handler: 'version',
      },
    },
  }),
  defineRoute({
    name: 'messages-next',
    path: '/api/messages/next',
    operations: {
      POST: {
        auth: API_AUTH_LEVEL.READ,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'messagesNext',
      },
    },
  }),
  defineRoute({
    name: 'mailboxes-create',
    path: '/api/mailboxes',
    operations: {
      POST: {
        auth: API_AUTH_LEVEL.READ,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'mailboxesCreate',
      },
    },
  }),
  defineRoute({
    name: 'admin-messages',
    path: '/api/admin/messages',
    operations: {
      GET: {
        auth: API_AUTH_LEVEL.READ,
        rateLimit: API_RATE_LIMIT_CLASS.ADMIN_READ,
        handler: 'adminMessagesList',
      },
    },
  }),
  defineRoute({
    name: 'admin-messages-read',
    path: '/api/admin/messages/read',
    operations: {
      PUT: {
        auth: API_AUTH_LEVEL.READ,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminMessagesRead',
      },
    },
  }),
  defineRoute({
    name: 'admin-messages-star',
    path: '/api/admin/messages/star',
    operations: {
      PUT: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminMessagesStar',
      },
    },
  }),
  defineRoute({
    name: 'admin-messages-delete-batch',
    path: '/api/admin/messages/delete',
    operations: {
      POST: {
        auth: API_AUTH_LEVEL.READ,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminMessagesDeleteBatch',
      },
    },
  }),
  defineRoute({
    name: 'analysis-summary',
    path: '/api/analysis/summary',
    operations: {
      GET: {
        auth: API_AUTH_LEVEL.READ,
        rateLimit: API_RATE_LIMIT_CLASS.ANALYSIS,
        handler: 'analysisSummary',
      },
    },
  }),
  defineRoute({
    name: 'analysis-trend',
    path: '/api/analysis/trend',
    operations: {
      GET: {
        auth: API_AUTH_LEVEL.READ,
        rateLimit: API_RATE_LIMIT_CLASS.ANALYSIS,
        handler: 'analysisTrend',
      },
    },
  }),
  defineRoute({
    name: 'analysis-senders',
    path: '/api/analysis/senders',
    operations: {
      GET: {
        auth: API_AUTH_LEVEL.READ,
        rateLimit: API_RATE_LIMIT_CLASS.ANALYSIS,
        handler: 'analysisSenders',
      },
    },
  }),
  defineRoute({
    name: 'admin-domains',
    path: '/api/admin/domains',
    operations: {
      GET: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.ADMIN_READ,
        handler: 'adminDomainsList',
      },
    },
  }),
  defineRoute({
    name: 'admin-openapi',
    path: '/api/admin/openapi',
    operations: {
      GET: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.ADMIN_READ,
        handler: 'adminOpenapi',
      },
    },
  }),
  defineRoute({
    name: 'admin-domains-sync',
    path: '/api/admin/domains/sync',
    operations: {
      POST: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminDomainsSync',
      },
    },
  }),
  defineRoute({
    name: 'admin-domains-batch',
    path: '/api/admin/domains/batch',
    operations: {
      POST: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminDomainsBatch',
      },
    },
  }),
  defineRoute({
    name: 'admin-governance-settings',
    path: '/api/admin/governance/settings',
    operations: {
      GET: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.ADMIN_READ,
        handler: 'adminGovernanceSettings',
      },
      PUT: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminGovernanceSettings',
      },
    },
  }),
  defineRoute({
    name: 'admin-governance-status',
    path: '/api/admin/governance/status',
    operations: {
      GET: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.ADMIN_READ,
        handler: 'adminGovernanceStatus',
      },
    },
  }),
  defineRoute({
    name: 'admin-governance-retention-run',
    path: '/api/admin/governance/retention/run',
    operations: {
      POST: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminGovernanceRetentionRun',
      },
    },
  }),
  defineRoute({
    name: 'admin-cleanup-rules',
    path: '/api/admin/cleanup-rules',
    operations: {
      GET: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.ADMIN_READ,
        handler: 'adminCleanupRules',
      },
      POST: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminCleanupRules',
      },
    },
  }),
  defineRoute({
    name: 'admin-cleanup-rules-preview',
    path: '/api/admin/cleanup-rules/preview',
    operations: {
      POST: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminCleanupRulesPreview',
      },
    },
  }),
  defineRoute({
    name: 'admin-cleanup-rules-run',
    path: '/api/admin/cleanup-rules/run',
    operations: {
      POST: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminCleanupRulesRun',
      },
    },
  }),
  defineRoute({
    name: 'admin-message-detail',
    pattern: /^\/api\/admin\/messages\/(\d+)$/,
    params: (match) => ({
      id: parseInt(match[1], 10),
    }),
    operations: {
      GET: {
        auth: API_AUTH_LEVEL.READ,
        rateLimit: API_RATE_LIMIT_CLASS.ADMIN_READ,
        handler: 'adminMessageDetail',
      },
      DELETE: {
        auth: API_AUTH_LEVEL.READ,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminMessageDetail',
      },
    },
  }),
  defineRoute({
    name: 'admin-domain-detail',
    pattern: /^\/api\/admin\/domains\/([^/]+)$/,
    params: (match) => ({
      zoneId: match[1],
    }),
    operations: {
      PUT: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminDomainDetail',
      },
    },
  }),
  defineRoute({
    name: 'admin-cleanup-rule-run',
    pattern: /^\/api\/admin\/cleanup-rules\/(\d+)\/run$/,
    params: (match) => ({
      id: parseInt(match[1], 10),
    }),
    operations: {
      POST: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminCleanupRuleRun',
      },
    },
  }),
  defineRoute({
    name: 'admin-cleanup-rule-detail',
    pattern: /^\/api\/admin\/cleanup-rules\/(\d+)$/,
    params: (match) => ({
      id: parseInt(match[1], 10),
    }),
    operations: {
      PUT: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminCleanupRuleDetail',
      },
      DELETE: {
        auth: API_AUTH_LEVEL.ADMIN,
        rateLimit: API_RATE_LIMIT_CLASS.WRITE,
        handler: 'adminCleanupRuleDetail',
      },
    },
  }),
])

function matchRouteDefinition(path, route) {
  if (typeof route.path === 'string') {
    return route.path === path ? { route, params: {} } : null
  }

  const match = route.pattern instanceof RegExp ? path.match(route.pattern) : null
  if (!match) return null
  return {
    route,
    params: typeof route.params === 'function' ? route.params(match) : {},
  }
}

export function resolveApiRoute(path, method) {
  for (const route of API_ROUTE_DEFINITIONS) {
    const matched = matchRouteDefinition(path, route)
    if (!matched) continue

    const operation = matched.route.operations?.[method] || null
    return {
      route: matched.route,
      operation,
      params: matched.params,
      allowedMethods: Object.keys(matched.route.operations || {}),
    }
  }

  return null
}
