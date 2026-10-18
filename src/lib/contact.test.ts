import { describe, expect, it } from 'vitest'
import { isHoneypotFilled, messagesCsv, replyMailto, validateContact } from './contact'

const TOPICS = ['General', 'Juniors']

describe('validateContact', () => {
  it('tidies a good message and matches the topic case-insensitively', () => {
    const r = validateContact(
      {
        name: '  Pat   Lee ',
        email: ' Pat@Example.COM ',
        topic: 'juniors',
        message: 'Hi there\r\n\r\n\r\n\r\n\r\nBye  \n',
        pagePath: '/contact',
      },
      TOPICS,
    )
    expect(r).toEqual({
      ok: true,
      value: { name: 'Pat Lee', email: 'pat@example.com', topic: 'Juniors', message: 'Hi there\n\n\nBye', pagePath: '/contact' },
    })
  })

  it('names every missing or bad field', () => {
    const r = validateContact({ name: '', email: 'nope', topic: 'Other', message: ' ' }, TOPICS)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(Object.keys(r.errors).toSorted()).toEqual(['email', 'message', 'name', 'topic'])
  })

  it('ignores the topic when there are no topics, and caps the lengths', () => {
    expect(validateContact({ name: 'A', email: 'a@b.co', topic: 'Anything', message: 'x' }, [])).toMatchObject({
      ok: true,
      value: { topic: '' },
    })
    const long = validateContact({ name: 'A'.repeat(101), email: 'a@b.co', message: 'x'.repeat(5001) }, [])
    expect(long.ok ? null : Object.keys(long.errors).toSorted()).toEqual(['message', 'name'])
  })

  it('keeps only a same-site page path', () => {
    const v = (pagePath: unknown) => {
      const r = validateContact({ name: 'A', email: 'a@b.co', message: 'x', pagePath }, [])
      return r.ok ? r.value.pagePath : 'invalid'
    }
    expect(v('/juniors')).toBe('/juniors')
    expect(v('//evil.example/')).toBeNull()
    expect(v('https://evil.example/')).toBeNull()
    expect(v(42)).toBeNull()
  })
})

describe('isHoneypotFilled', () => {
  it('is true only when the hidden field has something in it', () => {
    expect(isHoneypotFilled({})).toBe(false)
    expect(isHoneypotFilled({ website: '' })).toBe(false)
    expect(isHoneypotFilled({ website: '  ' })).toBe(false)
    expect(isHoneypotFilled({ website: 'http://spam' })).toBe(true)
  })
})

describe('messagesCsv', () => {
  it('writes Sydney times and spreadsheet-safe cells', () => {
    const csv = messagesCsv([
      {
        createdAt: '2026-10-19T03:05:00.000Z',
        name: 'Pat',
        email: 'pat@example.com',
        topic: 'General',
        status: 'handled',
        message: '=HYPERLINK("x")\nsecond line',
        pagePath: '/contact',
        handledAt: '2026-10-19T04:00:00.000Z',
        note: null,
      },
    ])
    const [head, row] = csv.trimEnd().split('\r\n')
    expect(head).toBe('"Received","Name","Email","Topic","Status","Message","Page","Handled","Note"')
    expect(row).toContain('"2026-10-19 14:05"')
    expect(row).toContain(`"'=HYPERLINK(""x"")\nsecond line"`)
  })
})

describe('replyMailto', () => {
  it('replies to the sender with the topic and the message quoted', () => {
    const href = replyMailto({ name: 'Pat Lee', email: 'pat+vb@example.com', topic: 'Juniors', message: 'Line 1\nLine 2' })
    expect(href.startsWith('mailto:pat%2Bvb@example.com?subject=')).toBe(true)
    const url = new URL(href)
    expect(url.searchParams.get('subject')).toBe('Re: Juniors – your message to Tempe Volleyball')
    expect(url.searchParams.get('body')).toBe('Hi Pat,\n\n\n\n> Line 1\n> Line 2\n')
  })
})
