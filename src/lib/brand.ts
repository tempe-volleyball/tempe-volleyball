// The header images (docs/public-site.md, "Images"). scripts/brand-images.ts writes these files into
// public/images from the originals in scripts/brand/ at these widths.

export const HERO_WIDTHS = [640, 960, 1280, 1500] as const
export const LOGO_WIDTHS = [160, 240, 320, 480] as const
/** The hero original is 1500 x 541. */
export const HERO_SIZE = { width: 1500, height: 541 } as const
/** The trimmed logo is 756 x 954 (portrait: the ball, the wordmark and the Sydney Uni badge). */
export const LOGO_SIZE = { width: 756, height: 954 } as const

type Format = 'avif' | 'webp'

const srcset = (name: string, widths: readonly number[], format: Format) =>
  widths.map((w) => `/images/${name}-${w}.${format} ${w}w`).join(', ')

export const heroSrcset = (format: Format) => srcset('hero', HERO_WIDTHS, format)
export const logoSrcset = (format: Format) => srcset('logo', LOGO_WIDTHS, format)
export const HERO_FALLBACK = '/images/hero-1280.webp'
export const LOGO_FALLBACK = '/images/logo-240.webp'
/** The hero spans the viewport at every width. */
export const HERO_SIZES = '100vw'
/** The logo's rendered width: 84px on phones, 112px on tablets, 136px from 1024px (see SiteHeader). */
export const LOGO_SIZES = '(min-width: 64rem) 136px, (min-width: 40rem) 112px, 84px'
