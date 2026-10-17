import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DESCRIPTION,
  describeHtml,
  describeVagueLinks,
  documentTitle,
  fixEmbeds,
  fixHeadings,
  formatPostDate,
  htmlToText,
  metaDescription,
  prepareHtml,
  truncateWords,
} from './content'

describe('fixHeadings', () => {
  it('turns body H1s into H2s and closes them to match', () => {
    expect(fixHeadings('<h1 class="x">A</h1><p>b</p>')).toBe('<h2 class="x">A</h2><p>b</p>')
  })

  it('never skips a level after the page title', () => {
    expect(fixHeadings('<h4>A</h4><h4>B</h4><h2>C</h2><h5>D</h5>')).toBe('<h2>A</h2><h2>B</h2><h2>C</h2><h3>D</h3>')
  })

  it('keeps a sensible nesting as is', () => {
    const html = '<h2>A</h2><h3>B</h3><h3>C</h3><h2>D</h2>'
    expect(fixHeadings(html)).toBe(html)
  })
})

describe('describeVagueLinks', () => {
  const titles = new Map([
    ['/2023-enrolment', 'Enrolment'],
    ['/contact', 'CONTACT'],
  ])

  it('adds the target page title as hidden text to "here" links (trailing slash and all)', () => {
    expect(describeVagueLinks('Register <a href="/2023-enrolment/">here</a>', titles)).toBe(
      'Register <a href="/2023-enrolment/">here<span class="sr-only"> (Enrolment)</span></a>',
    )
    expect(describeVagueLinks('<a href="/contact">click here</a>', titles)).toContain('(CONTACT)')
  })

  it('names the site for external links and leaves descriptive or unknown links alone', () => {
    expect(describeVagueLinks('<a href="https://www.revolutionise.com.au/x">here</a>', titles)).toContain('(revolutionise.com.au)')
    expect(describeVagueLinks('<a href="/contact">Contact us</a>', titles)).toBe('<a href="/contact">Contact us</a>')
    expect(describeVagueLinks('<a href="/unknown">here</a>', titles)).toBe('<a href="/unknown">here</a>')
    expect(describeVagueLinks('<a href="https://[bad">here</a>', titles)).toBe('<a href="https://[bad">here</a>')
  })

  it('escapes titles', () => {
    expect(describeVagueLinks('<a href="/a">here</a>', new Map([['/a', 'A & <B>']]))).toContain('A &amp; &lt;B&gt;')
  })
})

describe('fixEmbeds', () => {
  it('titles iframes and lazy-loads them', () => {
    expect(fixEmbeds('<iframe src="https://docs.google.com/forms/d/e/x/viewform"></iframe>')).toBe(
      '<iframe src="https://docs.google.com/forms/d/e/x/viewform" title="Google Form" loading="lazy"></iframe>',
    )
    expect(fixEmbeds('<iframe title="Map" src="x" loading="eager">')).toBe('<iframe title="Map" src="x" loading="eager">')
  })

  it('lazy-loads images and gives them an alt', () => {
    expect(fixEmbeds('<img src="/media/a/800.webp" />')).toBe('<img src="/media/a/800.webp" loading="lazy" decoding="async" alt="" />')
    expect(fixEmbeds('<img alt="x" loading="eager" src="y">')).toBe('<img alt="x" loading="eager" src="y" decoding="async">')
  })
})

describe('prepareHtml', () => {
  it('applies all three', () => {
    const out = prepareHtml('<h1>T</h1><a href="/c">here</a><img src="i">', { titles: new Map([['/c', 'C']]) })
    expect(out).toBe('<h2>T</h2><a href="/c">here<span class="sr-only"> (C)</span></a><img src="i" loading="lazy" decoding="async" alt="">')
  })
})

describe('metaDescription', () => {
  it('falls back for missing, short or placeholder descriptions', () => {
    expect(metaDescription(null)).toBe(DEFAULT_DESCRIPTION)
    expect(metaDescription('Loading…')).toBe(DEFAULT_DESCRIPTION)
    expect(metaDescription('Too short')).toBe(DEFAULT_DESCRIPTION)
  })

  it('keeps a good one, collapsing whitespace, and trims long ones to 155 characters at a word', () => {
    expect(metaDescription('  Founded in 2005 Tempe Volleyball is one of the earliest\n social leagues.  ')).toBe(
      'Founded in 2005 Tempe Volleyball is one of the earliest social leagues.',
    )
    const long = metaDescription('word '.repeat(60))
    expect(long.length).toBeLessThanOrEqual(155)
    expect(long.endsWith('word…')).toBe(true)
  })

  it('uses the body text when nothing usable is stored', () => {
    const bodyHtml = '<p><strong>Contact</strong><br><a href="mailto:m@x.com">m@x.com</a> or phone Michael on 0414 911 544.</p>'
    expect(metaDescription(null, { bodyHtml })).toBe('Contact m@x.com or phone Michael on 0414 911 544.')
    expect(metaDescription('', { bodyHtml: '<p>Hi</p>' })).toBe(DEFAULT_DESCRIPTION)
    expect(metaDescription('A description typed by the admin, long enough to use.', { bodyHtml })).toBe(
      'A description typed by the admin, long enough to use.',
    )
  })
})

describe('htmlToText', () => {
  it('puts spaces at block boundaries and <br>, not inside inline formatting', () => {
    expect(
      htmlToText('<p class="x">Tempe Volleyball Super League(TVSL)</p>\n\n<p>Division 3 Men<br>Division 3 Women</p><h1>Overview</h1>'),
    ).toBe('Tempe Volleyball Super League(TVSL) Division 3 Men Division 3 Women Overview')
    expect(htmlToText('<p>Play <strong>nice</strong>ly, <a href="/r">read</a> the rules</p><ul><li>one</li><li>two</li></ul>')).toBe(
      'Play nicely, read the rules one two',
    )
    expect(htmlToText('<td>A</td><td>B</td><div>C</div><hr>D')).toBe('A B C D')
  })
  it('drops iframe fallback text, scripts, comments and shortcodes, and decodes entities', () => {
    expect(
      htmlToText(
        '<!--StartFragment--><p>Fill in the form&nbsp;below.</p><iframe src="x">Loading…</iframe>[sp_table id="1"]<p>Fish &amp; chips &#8211; Q4</p>',
      ),
    ).toBe('Fill in the form below. Fish & chips – Q4')
    expect(htmlToText('<script>alert(1)</script><style>p{}</style>ok')).toBe('ok')
  })
})

describe('truncateWords and describeHtml', () => {
  it('cuts on a word boundary and adds an ellipsis', () => {
    const s =
      'The league is designed to support teams progressing beyond social-level volleyball into a more structured and competitive environment, while aligning with Volleyball NSW.'
    const out = truncateWords(s)
    expect(out.length).toBeLessThanOrEqual(155)
    expect(out).toBe(
      'The league is designed to support teams progressing beyond social-level volleyball into a more structured and competitive environment, while aligning with…',
    )
    expect(truncateWords('short one')).toBe('short one')
    expect(truncateWords(`see ${'x'.repeat(200)}`, 20)).toBe(`see ${'x'.repeat(15)}…`)
  })
  it('describeHtml is null for HTML without text', () => {
    expect(describeHtml('<p> </p><iframe src="x">Loading…</iframe>')).toBeNull()
    expect(describeHtml('<p>Contact</p><p>m@x.com</p>')).toBe('Contact m@x.com')
  })
})

describe('documentTitle', () => {
  it('appends the site name once', () => {
    expect(documentTitle('About Tempe VB')).toBe('About Tempe VB | Tempe Volleyball')
    expect(documentTitle('Welcome to Tempe Volleyball!')).toBe('Welcome to Tempe Volleyball!')
  })

  it('tames shouting titles but keeps acronyms', () => {
    expect(documentTitle('CONTACT')).toBe('Contact | Tempe Volleyball')
    expect(documentTitle('SCRIM & COACHED TRAINING SESSIONS')).toBe('Scrim & Coached Training Sessions | Tempe Volleyball')
    expect(documentTitle('FAQ')).toBe('FAQ | Tempe Volleyball')
    expect(documentTitle('JUNIOR DEVELOPMENT PROGRAM (JDP) OF THE CLUB')).toBe(
      'Junior Development Program (JDP) of the Club | Tempe Volleyball',
    )
  })
})

describe('formatPostDate', () => {
  it('uses the Sydney date', () => {
    // 11:30 UTC on 11 Dec is 22:30 in Sydney (AEDT), still the 11th; 14:00 UTC is the 12th.
    expect(formatPostDate('2023-12-11T11:30:00.000Z')).toBe('11 December 2023')
    expect(formatPostDate('2023-12-11T14:00:00.000Z')).toBe('12 December 2023')
  })
})
