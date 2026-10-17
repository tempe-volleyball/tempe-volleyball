/** The only host search engines may index. Everything else (staging, previews, *.workers.dev) is noindex. */
export const CANONICAL_HOST = 'www.tempevb.com'

export const isIndexable = (url: URL, siteEnv: string): boolean => siteEnv === 'production' && url.hostname === CANONICAL_HOST
