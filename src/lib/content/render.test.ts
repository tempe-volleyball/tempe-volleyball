import { describe, expect, it } from 'vitest'
import { blocksText, checkBlocks, mediaIdsInHtml, renderBlocks, safeEmbedSrc, safeHref, safeSrcset, type JsonNode } from './render'

const p = (...content: JsonNode[]): JsonNode => ({ type: 'paragraph', content })
const t = (text: string, marks?: JsonNode['marks']): JsonNode => ({ type: 'text', text, ...(marks ? { marks } : {}) })

describe('renderBlocks', () => {
  it('renders the basic blocks', () => {
    const html = renderBlocks([
      { type: 'heading', attrs: { level: 2 }, content: [t('Rules')] },
      p(t('Play '), t('nice', [{ type: 'bold' }, { type: 'italic' }]), t('.')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one'))] }] },
      { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p(t('three'))] }] },
      { type: 'blockquote', content: [p(t('q'))] },
      { type: 'horizontalRule' },
      p(t('a'), { type: 'hardBreak' }, t('b')),
    ])
    expect(html).toBe(
      '<h2>Rules</h2><p>Play <em><strong>nice</strong></em>.</p><ul><li><p>one</p></li></ul><ol start="3"><li><p>three</p></li></ol>' +
        '<blockquote><p>q</p></blockquote><hr><p>a<br>b</p>',
    )
  })

  it('escapes text and attributes', () => {
    expect(renderBlocks([p(t('<script>alert("x")</script> & \'y\''))])).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;</p>',
    )
    const html = renderBlocks([{ type: 'image', attrs: { src: '/media/a/800.webp', alt: '"><img src=x onerror=alert(1)>' } }])
    expect(html).toContain('alt="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"')
    expect(html).not.toContain('<img src=x')
  })

  it('drops unknown nodes but keeps their text, and ignores unknown marks and attributes', () => {
    const html = renderBlocks([
      { type: 'script', content: [t('kept text')] },
      p({ type: 'text', text: 'x', marks: [{ type: 'onclick' }, { type: 'textStyle', attrs: { color: 'red' } }] }),
      { type: 'paragraph', attrs: { onclick: 'alert(1)', class: 'evil', style: 'background:url(x)' }, content: [t('y')] },
    ])
    expect(html).toBe('kept text<p>x</p><p>y</p>')
  })

  it('only allows safe link targets', () => {
    const link = (href: string) => renderBlocks([p(t('l', [{ type: 'link', attrs: { href } }]))])
    expect(link('javascript:alert(1)')).toBe('<p>l</p>')
    expect(link(' JaVa\tScRiPt:alert(1)')).toBe('<p>l</p>')
    expect(link('data:text/html,<b>')).toBe('<p>l</p>')
    expect(link('//evil.example')).toBe('<p>l</p>')
    expect(link('/about')).toBe('<p><a href="/about">l</a></p>')
    expect(link('https://example.com/?a=1&b=2')).toBe('<p><a href="https://example.com/?a=1&amp;b=2" rel="noopener">l</a></p>')
    expect(link('mailto:tempevb@gmail.com')).toBe('<p><a href="mailto:tempevb@gmail.com">l</a></p>')
    expect(renderBlocks([p(t('l', [{ type: 'link', attrs: { href: 'https://x.com', target: '_blank' } }]))])).toBe(
      '<p><a href="https://x.com" target="_blank" rel="noopener">l</a></p>',
    )
  })

  it('puts a link outside the other marks so one <a> spans formatted text', () => {
    expect(renderBlocks([p(t('x', [{ type: 'link', attrs: { href: '/a' } }, { type: 'bold' }]))])).toBe(
      '<p><a href="/a"><strong>x</strong></a></p>',
    )
  })

  it('renders images with a checked srcset and lazy loading', () => {
    const html = renderBlocks([
      {
        type: 'image',
        attrs: {
          src: '/media/abc/800.webp',
          srcset: '/media/abc/400.webp 400w, /media/abc/800.webp 800w',
          alt: 'Players',
          width: 800,
          height: 600,
        },
      },
    ])
    expect(html).toBe(
      '<img src="/media/abc/800.webp" srcset="/media/abc/400.webp 400w, /media/abc/800.webp 800w" sizes="(max-width: 800px) 100vw, 800px" alt="Players" width="800" height="600" loading="lazy" decoding="async">',
    )
    expect(renderBlocks([{ type: 'image', attrs: { src: 'javascript:alert(1)' } }])).toBe('')
    expect(renderBlocks([{ type: 'image', attrs: { src: 'http://insecure.example/x.png' } }])).toBe('')
    expect(renderBlocks([{ type: 'image', attrs: { src: '/x.png', srcset: 'javascript:x 1x' } }])).not.toContain('srcset')
  })

  it('renders embeds only from allowed hosts', () => {
    expect(renderBlocks([{ type: 'embed', attrs: { src: 'https://www.youtube.com/embed/abc', title: 'Video' } }])).toContain(
      '<iframe src="https://www.youtube.com/embed/abc" title="Video"',
    )
    expect(renderBlocks([{ type: 'embed', attrs: { src: 'https://evil.example/embed' } }])).toBe('')
    expect(renderBlocks([{ type: 'embed', attrs: { src: 'javascript:alert(1)' } }])).toBe('')
  })

  it('renders tables with spans', () => {
    const html = renderBlocks([
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2 }, content: [p(t('Night'))] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [p(t('Thu'))] }] },
        ],
      },
    ])
    expect(html).toBe(
      '<div class="table-wrap"><table><tbody><tr><th colspan="2"><p>Night</p></th></tr><tr><td><p>Thu</p></td></tr></tbody></table></div>',
    )
  })

  it('demotes h1 to h2 (the page title is the only h1) and keeps text alignment', () => {
    expect(renderBlocks([{ type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: [t('x')] }])).toBe(
      '<h2 style="text-align: center">x</h2>',
    )
    expect(renderBlocks([{ type: 'paragraph', attrs: { textAlign: 'expression(alert(1))' }, content: [t('x')] }])).toBe('<p>x</p>')
  })
})

describe('url checks', () => {
  it('safeHref', () => {
    expect(safeHref('#top')).toBe('#top')
    expect(safeHref('tel:0414911544')).toBe('tel:0414911544')
    expect(safeHref('vbscript:x')).toBeNull()
    expect(safeHref('/\\evil.example')).toBeNull()
    expect(safeHref(42)).toBeNull()
  })
  it('safeSrcset', () => {
    expect(safeSrcset('/a.webp 1x, /b.webp 2x')).toBe('/a.webp 1x, /b.webp 2x')
    expect(safeSrcset('/a.webp 400w, data:x 800w')).toBeNull()
  })
  it('safeEmbedSrc', () => {
    expect(safeEmbedSrc('https://www.google.com/maps/embed?pb=1')).toBe('https://www.google.com/maps/embed?pb=1')
    expect(safeEmbedSrc('http://www.youtube.com/embed/x')).toBeNull()
  })
  it('safeEmbedSrc allows Google Maps embeds only on Google hosts', () => {
    const old = 'https://maps.google.com.au/maps?f=d&source=s_d&saddr=Holbeach+Ave&hl=en&output=embed'
    expect(safeEmbedSrc(old)).toBe(old)
    expect(safeEmbedSrc('https://maps.google.com/maps?q=Tempe&output=embed')).not.toBeNull()
    expect(safeEmbedSrc('https://www.google.com.au/maps/embed?pb=!1m18')).not.toBeNull()
    expect(safeEmbedSrc('https://www.google.com/maps/embed/v1/place?q=x')).not.toBeNull()
    expect(safeEmbedSrc('https://www.google.com.au/maps?q=x&output=embed')).not.toBeNull()
    // Not embeds, or not maps
    expect(safeEmbedSrc('https://maps.google.com.au/maps?q=Tempe')).toBeNull()
    expect(safeEmbedSrc('https://www.google.com/search?q=x&output=embed')).toBeNull()
    expect(safeEmbedSrc('https://www.google.com/url?q=https://evil.example')).toBeNull()
    expect(safeEmbedSrc('https://www.google.com/mapsx?output=embed')).toBeNull()
    expect(safeEmbedSrc('https://maps.google.com.au.evil.example/maps?output=embed')).toBeNull()
    expect(safeEmbedSrc('https://user@www.google.com/maps/embed?pb=1')).toBeNull()
    expect(safeEmbedSrc('http://maps.google.com.au/maps?output=embed')).toBeNull()
    // Other embed hosts are unchanged
    expect(safeEmbedSrc('https://docs.google.com/forms/d/e/x/viewform?embedded=true')).not.toBeNull()
    expect(safeEmbedSrc('https://www.youtube-nocookie.com/embed/abc')).not.toBeNull()
  })
  it('renders an old Google Maps embed', () => {
    const src = 'https://maps.google.com.au/maps?q=Holbeach+Ave&output=embed'
    expect(renderBlocks([{ type: 'embed', attrs: { src, width: 425, height: 350 } }])).toContain(
      'src="https://maps.google.com.au/maps?q=Holbeach+Ave&amp;output=embed"',
    )
  })
})

describe('checkBlocks', () => {
  it('accepts editor JSON', () => {
    expect(checkBlocks([p(t('x'))]).ok).toBe(true)
    expect(checkBlocks([]).ok).toBe(true)
  })
  it('rejects malformed bodies', () => {
    expect(checkBlocks('<p>x</p>').ok).toBe(false)
    expect(checkBlocks([{ text: 'no type' }]).ok).toBe(false)
    expect(checkBlocks([{ type: 'paragraph', content: 'x' }]).ok).toBe(false)
    expect(checkBlocks([{ type: 'text', text: 5 }]).ok).toBe(false)
    expect(checkBlocks([null]).ok).toBe(false)
  })
  it('rejects very deep or very large bodies', () => {
    let deep: JsonNode = t('x')
    for (let i = 0; i < 60; i++) deep = { type: 'blockquote', content: [deep] }
    expect(checkBlocks([deep]).ok).toBe(false)
    expect(checkBlocks(Array.from({ length: 31_000 }, () => ({ type: 'horizontalRule' }))).ok).toBe(false)
  })
  it('renders a large page quickly', () => {
    const blocks = Array.from({ length: 2000 }, (_, i) => p(t(`Paragraph ${i} with `), t('bold', [{ type: 'bold' }]), t(' text.')))
    const start = performance.now()
    checkBlocks(blocks)
    renderBlocks(blocks)
    expect(performance.now() - start).toBeLessThan(50)
  })
})

describe('helpers', () => {
  it('blocksText', () => {
    expect(blocksText([{ type: 'heading', content: [t('Hi')] }, p(t('there'))])).toBe('Hi there')
  })
  it('mediaIdsInHtml', () => {
    const id = '0b5a3c4e-1d2f-8a3b-9c4d-5e6f7a8b9c0d'
    expect([...mediaIdsInHtml(`<img src="/media/${id}/800.webp" srcset="/media/${id}/400.webp 400w">`)]).toEqual([id])
  })
})
