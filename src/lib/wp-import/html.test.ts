import { describe, expect, it } from 'vitest'
import { rewriteUploads, uploadKey, type ResolvedMedia } from './html'

const U = 'https://www.tempevb.com/wp-content/uploads'

describe('uploadKey', () => {
  it('maps sized and scaled copies to the original', () => {
    expect(uploadKey(`${U}/2023/09/photo-300x200.jpg`)).toBe('2023/09/photo.jpg')
    expect(uploadKey(`${U}/2023/09/photo-scaled.jpg`)).toBe('2023/09/photo.jpg')
    expect(uploadKey(`${U}/2023/09/photo.jpg?x=1`)).toBe('2023/09/photo.jpg')
    expect(uploadKey('https://example.com/a.jpg')).toBeNull()
  })
})

describe('rewriteUploads', () => {
  const media: Record<string, ResolvedMedia> = {
    '2023/09/photo.jpg': { id: 'm1', variants: [400, 800, 1600], ext: 'jpg' },
    '2023/09/small.png': { id: 'm2', variants: [400], ext: 'png' },
    '2023/09/rules.pdf': { id: 'm3', variants: [], ext: 'pdf' },
  }
  const resolve = (url: string) => media[uploadKey(url) ?? ''] ?? null

  it('rewrites img src and srcset to WebP variants', () => {
    const html = `<a href="${U}/2023/09/photo.jpg"><img loading="lazy" width="300" height="200" src="${U}/2023/09/photo-300x200.jpg" alt="Team" srcset="${U}/2023/09/photo-300x200.jpg 300w, ${U}/2023/09/photo-1024x683.jpg 1024w" sizes="(max-width: 300px) 100vw, 300px"></a>`
    const r = rewriteUploads(html, resolve)
    expect(r.html).toBe(
      '<a href="/media/m1/1600.webp"><img loading="lazy" width="300" height="200" src="/media/m1/800.webp" srcset="/media/m1/400.webp 400w, /media/m1/800.webp 800w, /media/m1/1600.webp 1600w" sizes="(max-width: 800px) 100vw, 800px" alt="Team"></a>',
    )
    expect([...r.used]).toEqual(['m1'])
    expect(r.unresolved.size).toBe(0)
  })

  it('uses the largest variant when there is no 800 and the original for PDFs', () => {
    const r = rewriteUploads(`<img src="${U}/2023/09/small.png"><a href="${U}/2023/09/rules.pdf">Rules</a>`, resolve)
    expect(r.html).toContain('src="/media/m2/400.webp"')
    expect(r.html).toContain('href="/media/m3/original.pdf"')
  })

  it('leaves unknown uploads alone and reports them', () => {
    const html = `<img src="${U}/2020/01/gone.jpg">`
    const r = rewriteUploads(html, resolve)
    expect(r.html).toBe(html)
    expect([...r.unresolved]).toEqual([`${U}/2020/01/gone.jpg`])
  })
})
