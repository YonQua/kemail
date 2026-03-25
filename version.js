import packageMeta from './package.json' with { type: 'json' }

export const APP_VERSION = String(packageMeta.version || '0.0.0')
export const APP_RELEASE_TAG = `v${APP_VERSION}`
