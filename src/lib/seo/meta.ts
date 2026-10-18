import { DEFAULT_DESCRIPTION } from '../content'
import { SOCIAL_FILE } from '../content/media'
import type { SeoSettings } from '../content/settings'

// The head's meta logic (src/components/Seo.astro): which description and sharing image a page ends up with.
// Pure, so the precedence is tested: the page's own fields, then its generated text, then Site settings, then the
// built-in defaults (docs/public-site.md "SEO").

/** The built-in sharing image (scripts/seo/og-image.ts makes it from the hero photo and the logo). */
export const DEFAULT_SOCIAL_IMAGE = {
  path: '/images/og-default.jpg',
  width: 1200,
  height: 630,
  alt: 'Tempe Volleyball: players at the net, with the club logo',
} as const

/** The logo for JSON-LD (Google wants a crawlable image at least 112 px square). */
export const LOGO_PATH = '/images/logo-400.webp'

/** The sharing-size URL of a media item (served by src/pages/media/[id]/[file].ts). */
export const socialImagePath = (mediaId: string) => `/media/${mediaId}/${SOCIAL_FILE}`

export type SocialImage = { path: string; width?: number; height?: number; alt?: string }

/**
 * The page's sharing image: the first media id given (page/post/programme/category image, most specific first),
 * else an explicit path, else the Site settings image, else the built-in one.
 */
export function pickSocialImage(
  ids: readonly (string | null | undefined)[],
  seo: Pick<SeoSettings, 'imageId'>,
  { path, alt }: { path?: string | null | undefined; alt?: string | undefined } = {},
): SocialImage {
  const id = ids.find((x): x is string => !!x)
  if (id) return { path: socialImagePath(id), ...(alt ? { alt } : {}) }
  if (path) return { path, ...(alt ? { alt } : {}) }
  if (seo.imageId) return { path: socialImagePath(seo.imageId), ...(alt ? { alt } : {}) }
  return { ...DEFAULT_SOCIAL_IMAGE }
}

/** pickSocialImage() as an absolute URL, for JSON-LD `image`. */
export const socialImageUrl = (origin: string | URL, ids: readonly (string | null | undefined)[], seo: Pick<SeoSettings, 'imageId'>) =>
  new URL(pickSocialImage(ids, seo).path, origin).href

/** The page's description, or the Site settings default when the page could only offer the built-in fallback. */
export const siteDescription = (description: string, seo: Pick<SeoSettings, 'description'>) =>
  description === DEFAULT_DESCRIPTION && seo.description ? seo.description : description

/** The <meta name="robots"> content for a page: only pages that opt out say anything (headers cover non-production). */
export const robotsMeta = (noindex: boolean | undefined) => (noindex ? 'noindex, follow' : null)
