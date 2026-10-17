import { describe, expect, it } from 'vitest'
import { mediaKey, mediaResponse } from './media'

const ID = 'fd020f84-7385-81ed-a76f-dce8e841c83d'

describe('mediaKey', () => {
  it('maps variant and original URLs to R2 keys', () => {
    expect(mediaKey(ID, '800.webp')).toBe(`media/${ID}/800.webp`)
    expect(mediaKey(ID.toUpperCase(), 'original.PDF')).toBe(`media/${ID}/original.pdf`)
  })

  it('rejects anything else without touching R2', () => {
    expect(mediaKey('../secrets', '800.webp')).toBeNull()
    expect(mediaKey(ID, '../../x')).toBeNull()
    expect(mediaKey(ID, '800.png')).toBeNull()
    expect(mediaKey(ID, 'original')).toBeNull()
  })
})

const body = () => new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array([1, 2, 3])), c.close()) })

describe('mediaResponse', () => {
  it('404s a missing object', () => {
    expect(mediaResponse(null, null).status).toBe(404)
  })

  it('serves the file with immutable caching and its type', async () => {
    const r = mediaResponse(
      { key: `media/${ID}/800.webp`, httpEtag: '"e1"', size: 3, httpMetadata: { contentType: 'image/webp' }, body: body() },
      null,
    )
    expect(r.status).toBe(200)
    expect(r.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(r.headers.get('Content-Type')).toBe('image/webp')
    expect(r.headers.get('ETag')).toBe('"e1"')
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('answers 304 when the ETag matches or R2 skipped the body', () => {
    const obj = { key: `media/${ID}/400.webp`, httpEtag: '"e1"', size: 3 }
    expect(mediaResponse({ ...obj, body: body() }, '"e0", "e1"').status).toBe(304)
    expect(mediaResponse(obj, null).status).toBe(304)
  })

  it('guesses the type from the extension and sandboxes PDFs', () => {
    const r = mediaResponse({ key: `media/${ID}/original.pdf`, httpEtag: '"p"', size: 3, body: body() }, null)
    expect(r.headers.get('Content-Type')).toBe('application/pdf')
    expect(r.headers.get('Content-Security-Policy')).toContain('sandbox')
  })
})
