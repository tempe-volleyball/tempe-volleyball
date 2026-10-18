import { describe, expect, it } from 'vitest'
import { importLosses, isUnconvertedImport } from './import-check'

describe('importLosses', () => {
  it('lists what the editor would drop or simplify, most frequent first', () => {
    const html = [
      '<div class="wp-block-columns"><div class="wp-block-column"><p class="has-text-color has-vivid-red-color">Red</p></div></div>',
      '<div class="wp-block-buttons"><div class="wp-block-button"><a class="wp-block-button__link has-background" href="/x">Go</a></div></div>',
      '<h2 id="fees">Fees</h2><video src="/a.mp4"></video><iframe title="x"></iframe>',
    ].join('')
    expect(importLosses(html).map((l) => [l.label, l.count])).toEqual([
      ['Colours, backgrounds and font sizes', 3],
      ['Videos', 1],
      ['Column layouts', 1],
      ['Button groups’ layout (centred or side by side)', 1],
      ['Anchors (links that jump to a spot on the page)', 1],
      ['Embeds from sites the editor doesn’t allow', 1],
    ])
  })

  it('has nothing to say about what the editor keeps', () => {
    const kept =
      '<p style="text-align: center">Hi <strong>there</strong> <sup>2</sup></p><figure class="wp-block-image"><img src="/media/a/800.webp" alt="x"><figcaption>Cap</figcaption></figure>' +
      '<table><tbody><tr><td>1</td></tr></tbody></table><iframe src="https://www.youtube.com/embed/x" width="100%"></iframe><h5>Small</h5>' +
      '<a href="/x">x<span class="sr-only"> (x)</span></a>'
    expect(importLosses(kept)).toEqual([])
  })

  it('knows an imported body from one saved in the editor', () => {
    expect(isUnconvertedImport({ blocks: [], html: '<p>x</p>' })).toBe(true)
    expect(isUnconvertedImport({ blocks: [{ type: 'paragraph' }], html: '<p>x</p>' })).toBe(false)
    expect(isUnconvertedImport({ blocks: [], html: '  ' })).toBe(false)
  })
})
