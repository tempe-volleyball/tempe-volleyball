import { mediaOriginalUrl, mediaVariantUrl } from './routes'

// Rewriting WordPress upload links in imported page/post HTML to the new media routes.

/** What a WordPress upload URL resolved to. `variants` are the WebP widths stored; [] for non-images (PDFs). */
export type ResolvedMedia = { id: string; variants: number[]; ext: string }

/** Matches absolute, protocol-relative and root-relative links into wp-content/uploads. */
export const UPLOAD_URL_RE = /(?:https?:)?(?:\/\/(?:www\.)?tempevb\.com)?\/wp-content\/uploads\/[^"'\s)<>]+/gi

/** "photo-300x200.jpg", "photo-scaled.jpg", "photo.jpg" all name the same original: its key "2023/09/photo.jpg". */
export function uploadKey(url: string): string | null {
  const m = /\/wp-content\/uploads\/([^?#"'\s)<>]+)/i.exec(url)
  if (!m) return null
  let path: string
  try {
    path = decodeURI(m[1]!)
  } catch {
    path = m[1]!
  }
  return path.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, '$1').replace(/-scaled(\.[a-z0-9]+)$/i, '$1')
}

/** The default variant for an <img src>: 800 px if there is one, else the largest. */
export const defaultWidth = (variants: number[]) => (variants.includes(800) ? 800 : Math.max(...variants))

const largest = (m: ResolvedMedia) => (m.variants.length ? mediaVariantUrl(m.id, Math.max(...m.variants)) : mediaOriginalUrl(m.id, m.ext))

export type RewriteResult = { html: string; used: Set<string>; unresolved: Set<string> }

/**
 * Rewrites <img> tags that point at uploads to src (800 px) + srcset (every width) on /media/<id>/<w>.webp, and
 * any other upload link (lightbox hrefs, PDFs) to the largest variant or the original file.
 */
export function rewriteUploads(html: string, resolve: (url: string) => ResolvedMedia | null): RewriteResult {
  const used = new Set<string>()
  const unresolved = new Set<string>()
  const lookup = (url: string) => {
    const m = resolve(url)
    if (m) used.add(m.id)
    else unresolved.add(url)
    return m
  }

  let out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\ssrc\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2]
    if (!src || !src.match(UPLOAD_URL_RE)) return tag
    const m = lookup(src)
    if (!m || m.variants.length === 0) return tag
    const srcset = [...m.variants]
      .sort((a, b) => a - b)
      .map((w) => `${mediaVariantUrl(m.id, w)} ${w}w`)
      .join(', ')
    return tag
      .replace(/\s(srcset|sizes)\s*=\s*(["']).*?\2/gi, '')
      .replace(
        /\ssrc\s*=\s*(["']).*?\1/i,
        ` src="${mediaVariantUrl(m.id, defaultWidth(m.variants))}" srcset="${srcset}" sizes="(max-width: 800px) 100vw, 800px"`,
      )
  })

  out = out.replace(UPLOAD_URL_RE, (url) => {
    const m = lookup(url)
    return m ? largest(m) : url
  })
  return { html: out, used, unresolved }
}
