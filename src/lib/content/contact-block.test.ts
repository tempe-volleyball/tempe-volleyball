import { describe, expect, it } from 'vitest'
import { checkSetting, DEFAULT_SETTINGS } from './settings'
import { dataBlockRefs, normaliseDataBlocks, parseContactFormAttrs, renderContactForm, type ContactBlockData } from './data-blocks'
import { renderBlocks } from './render'

const DATA: ContactBlockData = {
  enabled: true,
  topics: ['General', 'Juniors'],
  siteKey: '1x00000000000000000000AA',
  privacyHref: '/privacy',
  contact: { name: 'Michael', email: 'tempevb@gmail.com', phone: '0414 911 544' },
}

describe('Contact form block', () => {
  it('normalises its attrs and writes no page_data_refs', () => {
    expect(parseContactFormAttrs({ title: '  Ask us  ', defaultTopic: 'Juniors', showTopic: 'yes', junk: 1 })).toEqual({
      title: 'Ask us',
      defaultTopic: 'Juniors',
      showTopic: true,
      submitLabel: null,
    })
    const blocks = normaliseDataBlocks([{ type: 'contactForm', attrs: { submitLabel: 'Send' } }])
    expect(blocks).toEqual([{ type: 'contactForm', attrs: { title: null, defaultTopic: null, showTopic: true, submitLabel: 'Send' } }])
    expect(dataBlockRefs(blocks)).toEqual([])
    // Stored HTML has no form (it's rendered from live settings at view time).
    expect(renderBlocks(blocks)).toBe('')
  })

  it('renders the fields, the topics with the block’s starting topic, the honeypot and the privacy link', () => {
    const html = renderContactForm(parseContactFormAttrs({ title: 'Send us a message', defaultTopic: 'juniors' }), DATA, 2)
    expect(html).toContain('<h2>Send us a message</h2>')
    expect(html).toContain('data-contact-form data-sitekey="1x00000000000000000000AA" action="/api/contact"')
    for (const f of ['name', 'email', 'topic', 'message']) expect(html).toContain(`id="cf2-${f}" name="${f}"`)
    expect(html).toContain('<option selected>Juniors</option>')
    expect(html).not.toContain('Choose one…')
    expect(html).toContain('name="website" tabindex="-1"')
    expect(html).toContain('<a href="/privacy">privacy policy</a>')
    expect(html).toContain('<noscript>')
  })

  it('asks for a topic only when there are topics and the block wants one, and escapes what it prints', () => {
    const noTopic = renderContactForm(parseContactFormAttrs({ showTopic: false }), DATA)
    expect(noTopic).not.toContain('name="topic"')
    const none = renderContactForm(parseContactFormAttrs({}), { ...DATA, topics: [], privacyHref: null })
    expect(none).not.toContain('name="topic"')
    expect(none).not.toContain('privacy policy')
    const odd = renderContactForm(parseContactFormAttrs({ submitLabel: '<b>Go</b>' }), { ...DATA, topics: ['A & B'] })
    expect(odd).toContain('&lt;b&gt;Go&lt;/b&gt;')
    expect(odd).toContain('<option>A &amp; B</option>')
    expect(odd).toContain('<option value="">Choose one…</option>')
  })

  it('shows the contact details instead when the form is off or Turnstile isn’t set up', () => {
    for (const data of [
      { ...DATA, enabled: false },
      { ...DATA, siteKey: null },
    ]) {
      const html = renderContactForm(parseContactFormAttrs({}), data)
      expect(html).not.toContain('<form')
      expect(html).toContain('<a href="mailto:tempevb@gmail.com">tempevb@gmail.com</a>')
      expect(html).toContain('<a href="tel:+61414911544">0414 911 544</a>')
    }
  })
})

describe('contact form and privacy settings', () => {
  it('tidies topics and addresses, and bounds the numbers', () => {
    const r = checkSetting('contactForm', {
      ...DEFAULT_SETTINGS.contactForm,
      topics: [' General ', 'general', '', 'Juniors  league'],
      notifyEmails: ['A@Example.com', 'a@example.com'],
      notifyPerDay: '5',
      autoReplyText: '',
    })
    expect(r).toEqual({
      ok: true,
      value: {
        ...DEFAULT_SETTINGS.contactForm,
        topics: ['General', 'Juniors league'],
        notifyEmails: ['a@example.com'],
        notifyPerDay: 5,
        autoReplyText: DEFAULT_SETTINGS.contactForm.autoReplyText,
      },
    })
    expect(checkSetting('contactForm', { notifyEmails: ['nope'] })).toMatchObject({ ok: false })
    expect(checkSetting('contactForm', { retentionDays: 7 })).toMatchObject({ ok: false })
    expect(checkSetting('contactForm', { topics: Array.from({ length: 21 }, (_, i) => `T${i}`) })).toMatchObject({ ok: false })
  })

  it('takes a page path for the privacy policy', () => {
    expect(checkSetting('privacy', { pagePath: '/about/privacy' })).toEqual({ ok: true, value: { pagePath: '/about/privacy' } })
    expect(checkSetting('privacy', { pagePath: '' })).toEqual({ ok: true, value: { pagePath: '/privacy' } })
    for (const bad of ['privacy', '/privacy/', '//x', 'https://x.com/privacy'])
      expect(checkSetting('privacy', { pagePath: bad })).toMatchObject({ ok: false })
  })
})
