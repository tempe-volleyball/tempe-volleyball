// Email templates. Each renders a subject, a plain-text body and a small HTML body from its data.
// Keep them plain: no images or tracking, so they're light and land in the inbox.

export type TemplateData = {
  /** A sign-in code (Better Auth emailOTP). */
  'auth.otp': { otp: string }
  /** A sign-in link (Better Auth magicLink). */
  'auth.magic_link': { url: string }
  /** An invitation to become an admin user. */
  'admin.invite': { url: string; role: string; invitedBy: string; expiresAt: string }
  /** An enrolment that has a spot. `amount` is formatted AUD ("$120.00"); PayID details when there's a fee. */
  'enrolment.confirmed': EnrolmentEmail & {
    teamName?: string | null
    amount?: string | null
    payid?: { name: string; payId: string; instructions: string } | null
    message?: string | null
  }
  /** Full: on the waitlist. `position` is 1-based (null if unknown). */
  'enrolment.waitlisted': EnrolmentEmail & { position: number | null; teamName?: string | null }
  /** A freed spot, held until expiresAt (UTC ISO). The link accepts or declines it, so it's sensitive. */
  'enrolment.offer': EnrolmentEmail & {
    url: string
    expiresAt: string
    teamName?: string | null
    /** Which offer this is, so the mailer can start the hold when the email actually goes (mailer.ts OfferHold). */
    hold?: { type: 'registration' | 'group'; id: string; offeredAt: string; hours: number; latest?: string | null }
  }
  /** Cancelled by the organiser, declined, or an offer that lapsed. */
  'enrolment.cancelled': EnrolmentEmail & { reason?: string | null; teamName?: string | null }
  /**
   * A public entry waiting for its address to be confirmed: the link (sensitive) holds no spot until it's clicked,
   * before expiresAt (UTC ISO). No reference yet: it's only given once the address is confirmed.
   */
  'enrolment.confirm_email': Omit<EnrolmentEmail, 'reference'> & {
    url: string
    expiresAt: string
    teamName?: string | null
    /** Which entry, so the mailer can start its deadline when the email actually goes (mailer.ts PendingHold). */
    pending?: { id: string; hours: number }
  }
  /** Someone submitted the form again for an entry that already exists: its reference and where it stands. */
  'enrolment.already': EnrolmentEmail & { state: 'confirmed' | 'waitlist' | 'offered'; position?: number | null; teamName?: string | null }
  /** A new contact-form message, to the organiser: replying goes straight to the sender (reply-to). */
  'contact.notify': ContactEmail & { url: string; receivedAt: string }
  /** The optional automatic reply to the sender (Settings → Contact form), with a copy of their message. */
  'contact.ack': ContactEmail & { text: string }
  /**
   * An expression of interest, to the address typed on the form (Settings → Interest → acknowledge). That address
   * isn't verified, so this lists only fixed facts (the programmes, the entry type, the reference, the deposit and
   * PayID) and the first name, shortened: nothing else anyone typed (docs/api/interest.md).
   */
  'interest.ack': InterestAckEmail
  /** A new expression of interest, to the organiser: replying goes to the contact (reply-to). */
  'interest.notify': InterestEmail & { email: string; phone: string; url: string; receivedAt: string }
}

/** What the EOI notification shows (the acknowledgement takes a few of these). `deposit` is formatted AUD ("$50"); PayID details when one applies. */
export type InterestEmail = {
  name: string
  reference: string
  kind: 'player' | 'team'
  teamName?: string | null
  programmes: string[]
  /** Each answer as "label: value" lines, in form order (choices as their labels). */
  answers: { label: string; value: string }[]
  /** Team members besides the contact, one line each ("Jo Park, jo@example.com"). */
  members?: string[]
  deposit?: string | null
  payid?: { name: string; payId: string; instructions: string } | null
}

/** The acknowledgement's data: no free text from the form but the (shortened) first name. */
export type InterestAckEmail = Pick<InterestEmail, 'name' | 'reference' | 'kind' | 'programmes' | 'deposit' | 'payid'> & {
  /** Settings → Interest's thank-you text, and the form's confirmation text (both set by the organiser). */
  text: string
  message?: string | null
}

/** The most of a first name the acknowledgement shows. */
export const ACK_NAME_MAX = 30

/** What both contact emails show: who wrote, their address, the topic and the message. */
export type ContactEmail = { name: string; email: string; topic: string; message: string; page?: string | null }

/** What every enrolment email shows: who, what (programme and session/term/season/event) and the reference. */
export type EnrolmentEmail = { name: string; programme: string; target: string; reference: string }

export type TemplateName = keyof TemplateData

export const templateNames = [
  'auth.otp',
  'auth.magic_link',
  'admin.invite',
  'enrolment.confirmed',
  'enrolment.waitlisted',
  'enrolment.offer',
  'enrolment.cancelled',
  'enrolment.confirm_email',
  'enrolment.already',
  'contact.notify',
  'contact.ack',
  'interest.ack',
  'interest.notify',
] as const satisfies readonly TemplateName[]

/**
 * Templates whose payload is a secret (codes, sign-in links, invite links). Their payload is kept only while the
 * email can still be sent, cleared on every final state, and never logged in production.
 */
export const SENSITIVE_TEMPLATES: ReadonlySet<TemplateName> = new Set([
  'auth.otp',
  'auth.magic_link',
  'admin.invite',
  'enrolment.offer',
  'enrolment.confirm_email',
])

/**
 * Sign-in emails. Always send-now-or-never (the code expires in minutes), never stored with their payload, limited
 * per recipient, and counted against their own share of the daily cap.
 */
export const AUTH_TEMPLATES: ReadonlySet<TemplateName> = new Set(['auth.otp', 'auth.magic_link'])

export const isSensitiveTemplate = (name: string) => (SENSITIVE_TEMPLATES as ReadonlySet<string>).has(name)
export const isAuthTemplate = (name: string) => (AUTH_TEMPLATES as ReadonlySet<string>).has(name)

/** `replyTo`: where a reply goes instead of the no-reply sender (a contact message's sender). */
export type RenderedEmail = { subject: string; text: string; html: string; replyTo?: string }

const escapeHtml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const layout = (bodyHtml: string) =>
  `<!doctype html><html><body style="margin:0;padding:24px;background:#e4e4e4;font-family:Arial,Helvetica,sans-serif;color:#222">` +
  `<div style="max-width:480px;margin:0 auto;background:#fff;border-top:4px solid #ffa800;padding:24px">` +
  `<p style="margin:0 0 16px;font-weight:bold;color:#104293;text-transform:uppercase;letter-spacing:1px">Tempe Volleyball</p>` +
  bodyHtml +
  `</div></body></html>`

const button = (url: string, label: string) =>
  `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#104293;color:#fff;padding:12px 20px;text-decoration:none;font-weight:bold">${escapeHtml(label)}</a></p>`

const IGNORE = "If you didn't ask for this, you can ignore this email."

const sydneyWhen = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso))

/** "TNL Q4 2026" or "Scrim & Coached Training: Tue 21 Oct", without repeating the programme name. */
const whatText = (d: Pick<EnrolmentEmail, 'programme' | 'target'>) =>
  d.target && d.target !== d.programme ? `${d.programme}: ${d.target}` : d.programme

const refLine = (d: EnrolmentEmail) => `Your reference is ${d.reference}.`
const refHtml = (d: EnrolmentEmail) =>
  `<p>Your reference is <b style="font-size:18px;letter-spacing:1px">${escapeHtml(d.reference)}</b>.</p>`
const teamPart = (teamName: string | null | undefined) => (teamName ? ` (team ${teamName})` : '')
const QUESTIONS = 'Questions? Just reply to this email.'

const enrolmentRenderers: { [K in Extract<TemplateName, `enrolment.${string}`>]: (data: TemplateData[K]) => RenderedEmail } = {
  'enrolment.confirmed': (d) => {
    const what = whatText(d)
    const pay =
      d.amount && d.payid?.payId
        ? {
            text: `\nThe fee is ${d.amount}. Pay by PayID to ${d.payid.payId}${d.payid.name ? ` (${d.payid.name})` : ''}. ${d.payid.instructions}\n`,
            html:
              `<p>The fee is <b>${escapeHtml(d.amount)}</b>. Pay by PayID to <b>${escapeHtml(d.payid.payId)}</b>` +
              `${d.payid.name ? ` (${escapeHtml(d.payid.name)})` : ''}. ${escapeHtml(d.payid.instructions)}</p>`,
          }
        : d.amount
          ? {
              text: `\nThe fee is ${d.amount}. We'll be in touch about payment.\n`,
              html: `<p>The fee is <b>${escapeHtml(d.amount)}</b>. We'll be in touch about payment.</p>`,
            }
          : { text: '', html: '' }
    const message = d.message
      ? { text: `\n${d.message}\n`, html: `<p>${escapeHtml(d.message).replaceAll('\n', '<br>')}</p>` }
      : { text: '', html: '' }
    return {
      subject: `You're enrolled: ${what}`,
      text: `Hi ${d.name},\n\nYou're enrolled in ${what}${teamPart(d.teamName)}. ${refLine(d)}\n${pay.text}${message.text}\n${QUESTIONS}\n`,
      html: layout(
        `<p>Hi ${escapeHtml(d.name)},</p><p>You're enrolled in <b>${escapeHtml(what)}</b>${escapeHtml(teamPart(d.teamName))}.</p>${refHtml(d)}` +
          `${pay.html}${message.html}<p style="color:#555;font-size:13px">${QUESTIONS}</p>`,
      ),
    }
  },
  'enrolment.waitlisted': (d) => {
    const what = whatText(d)
    const pos = d.position ? ` You're number ${d.position} on the list.` : ''
    const next = "If a spot opens up we'll email you an offer, which you'll need to accept within the time it gives."
    return {
      subject: `You're on the waitlist: ${what}`,
      text: `Hi ${d.name},\n\n${what} is full, so you're on the waitlist${teamPart(d.teamName)}.${pos} ${refLine(d)}\n\n${next}\n\n${QUESTIONS}\n`,
      html: layout(
        `<p>Hi ${escapeHtml(d.name)},</p><p><b>${escapeHtml(what)}</b> is full, so you're on the waitlist${escapeHtml(teamPart(d.teamName))}.${escapeHtml(pos)}</p>` +
          `${refHtml(d)}<p>${next}</p><p style="color:#555;font-size:13px">${QUESTIONS}</p>`,
      ),
    }
  },
  'enrolment.offer': (d) => {
    const what = whatText(d)
    const until = sydneyWhen(d.expiresAt)
    return {
      subject: `A spot is free: ${what}`,
      text: `Hi ${d.name},\n\nA spot has opened up in ${what}${teamPart(d.teamName)} and it's yours if you want it. ${refLine(d)}\n\nAccept or decline here:\n${d.url}\n\nThe offer is held until ${until}; after that it goes to the next person on the waitlist.\n`,
      html: layout(
        `<p>Hi ${escapeHtml(d.name)},</p><p>A spot has opened up in <b>${escapeHtml(what)}</b>${escapeHtml(teamPart(d.teamName))} and it's yours if you want it.</p>` +
          `${refHtml(d)}${button(d.url, 'Accept or decline')}<p>The offer is held until <b>${escapeHtml(until)}</b>; after that it goes to the next person on the waitlist.</p>`,
      ),
    }
  },
  'enrolment.confirm_email': (d) => {
    const what = whatText(d)
    const until = sydneyWhen(d.expiresAt)
    const why = "We ask so that nobody can take a spot with someone else's email address."
    return {
      subject: `Confirm your enrolment: ${what}`,
      text: `Hi ${d.name},\n\nThanks for enrolling in ${what}${teamPart(d.teamName)}. Please confirm your email address to finish; until then no spot is held for you.\n\nConfirm here:\n${d.url}\n\nThe link works until ${until}. ${why}\n\n${IGNORE}\n`,
      html: layout(
        `<p>Hi ${escapeHtml(d.name)},</p><p>Thanks for enrolling in <b>${escapeHtml(what)}</b>${escapeHtml(teamPart(d.teamName))}. Please confirm your email address to finish; until then no spot is held for you.</p>` +
          `${button(d.url, 'Confirm my enrolment')}<p>The link works until <b>${escapeHtml(until)}</b>. ${escapeHtml(why)}</p><p style="color:#555;font-size:13px">${IGNORE}</p>`,
      ),
    }
  },
  'enrolment.already': (d) => {
    const what = whatText(d)
    const where =
      d.state === 'waitlist'
        ? `You're on the waitlist${d.position ? ` (number ${d.position})` : ''}.`
        : d.state === 'offered'
          ? "You've been offered a spot: use the link in the offer email to accept it."
          : 'Your spot is confirmed.'
    return {
      subject: `You're already enrolled: ${what}`,
      text: `Hi ${d.name},\n\nSomeone (probably you) just filled in the form for ${what}${teamPart(d.teamName)} again, but you're already entered, so nothing has changed. ${where} ${refLine(d)}\n\n${QUESTIONS}\n`,
      html: layout(
        `<p>Hi ${escapeHtml(d.name)},</p><p>Someone (probably you) just filled in the form for <b>${escapeHtml(what)}</b>${escapeHtml(teamPart(d.teamName))} again, but you're already entered, so nothing has changed. ${escapeHtml(where)}</p>` +
          `${refHtml(d)}<p style="color:#555;font-size:13px">${QUESTIONS}</p>`,
      ),
    }
  },
  'enrolment.cancelled': (d) => {
    const what = whatText(d)
    const reason = d.reason ? ` ${d.reason}` : ''
    return {
      subject: `Enrolment cancelled: ${what}`,
      text: `Hi ${d.name},\n\nYour enrolment in ${what}${teamPart(d.teamName)} (reference ${d.reference}) has been cancelled.${reason}\n\n${QUESTIONS}\n`,
      html: layout(
        `<p>Hi ${escapeHtml(d.name)},</p><p>Your enrolment in <b>${escapeHtml(what)}</b>${escapeHtml(teamPart(d.teamName))} (reference ${escapeHtml(d.reference)}) has been cancelled.${escapeHtml(reason)}</p>` +
          `<p style="color:#555;font-size:13px">${QUESTIONS}</p>`,
      ),
    }
  },
}

/** A message as plain text, quoted, and as HTML paragraphs (escaped, line breaks kept). */
const quoteText = (m: string) =>
  m
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
const messageHtml = (m: string) =>
  `<div style="border-left:4px solid #ffa800;padding:4px 12px;margin:12px 0;white-space:pre-wrap">${escapeHtml(m)}</div>`

const contactRenderers: { [K in Extract<TemplateName, `contact.${string}`>]: (data: TemplateData[K]) => RenderedEmail } = {
  'contact.notify': (d) => {
    const about = d.topic ? ` about ${d.topic}` : ''
    const received = sydneyWhen(d.receivedAt)
    const from = d.page ? ` on ${d.page}` : ''
    return {
      subject: `Message from ${d.name}${d.topic ? ` (${d.topic})` : ''}`,
      replyTo: d.email,
      text: `${d.name} <${d.email}> sent a message${about} through the website${from} (${received}).\n\n${quoteText(d.message)}\n\nReply to this email to answer them, or open it in the admin:\n${d.url}\n`,
      html: layout(
        `<p><b>${escapeHtml(d.name)}</b> &lt;${escapeHtml(d.email)}&gt; sent a message${escapeHtml(about)} through the website${escapeHtml(from)} (${escapeHtml(received)}).</p>` +
          `${messageHtml(d.message)}<p>Reply to this email to answer them.</p>${button(d.url, 'Open in the admin')}`,
      ),
    }
  },
  'contact.ack': (d) => ({
    subject: 'We got your message',
    text: `Hi ${d.name},\n\n${d.text}\n\nYour message:\n${quoteText(d.message)}\n\n${IGNORE}\n`,
    html: layout(
      `<p>Hi ${escapeHtml(d.name)},</p><p style="white-space:pre-wrap">${escapeHtml(d.text)}</p><p>Your message:</p>${messageHtml(d.message)}` +
        `<p style="color:#555;font-size:13px">${IGNORE}</p>`,
    ),
  }),
}

/** What the notification lists: programmes, team, members and answers, as text lines and HTML. */
function interestSummary(d: InterestEmail) {
  const rows: [string, string][] = [
    ['Entry', d.kind === 'team' ? 'A team' : 'A player (to be placed in a team)'],
    [d.programmes.length === 1 ? 'Programme' : 'Programmes', d.programmes.join(', ')],
    ...(d.kind === 'team' && d.teamName ? ([['Team', d.teamName]] as [string, string][]) : []),
    ...d.answers.map((a): [string, string] => [a.label, a.value]),
  ]
  const members = d.members ?? []
  const text =
    rows.map(([k, v]) => `${k}: ${v}`).join('\n') + (members.length ? `\nTeam members:\n${members.map((m) => `- ${m}`).join('\n')}` : '')
  const html =
    `<table style="border-collapse:collapse;margin:12px 0;font-size:14px">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><th style="text-align:left;vertical-align:top;padding:4px 12px 4px 0;color:#555">${escapeHtml(k)}</th><td style="padding:4px 0;white-space:pre-wrap">${escapeHtml(v)}</td></tr>`,
      )
      .join('') +
    `</table>` +
    (members.length
      ? `<p style="margin:12px 0 4px"><b>Team members</b></p><ul>${members.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
      : '')
  return { text, html }
}

/** The deposit line of the acknowledgement, with the reference as the payment description. */
function depositPart(d: Pick<InterestEmail, 'deposit' | 'kind' | 'payid' | 'reference'>) {
  if (!d.deposit) return { text: '', html: '' }
  const who = d.kind === 'team' ? 'per team' : ''
  const amount = `${d.deposit}${who ? ` ${who}` : ''}`
  if (d.payid?.payId)
    return {
      text: `\nThe deposit is ${amount}. Pay it by PayID to ${d.payid.payId}${d.payid.name ? ` (${d.payid.name})` : ''}, with ${d.reference} as the payment description.${d.payid.instructions ? ` ${d.payid.instructions}` : ''}\n`,
      html:
        `<p>The deposit is <b>${escapeHtml(amount)}</b>. Pay it by PayID to <b>${escapeHtml(d.payid.payId)}</b>${d.payid.name ? ` (${escapeHtml(d.payid.name)})` : ''}, ` +
        `with <b>${escapeHtml(d.reference)}</b> as the payment description.${d.payid.instructions ? ` ${escapeHtml(d.payid.instructions)}` : ''}</p>`,
    }
  return {
    text: `\nThe deposit is ${amount}. We'll tell you how to pay it when we're in touch.\n`,
    html: `<p>The deposit is <b>${escapeHtml(amount)}</b>. We'll tell you how to pay it when we're in touch.</p>`,
  }
}

const interestRenderers: { [K in Extract<TemplateName, `interest.${string}`>]: (data: TemplateData[K]) => RenderedEmail } = {
  'interest.ack': (d) => {
    const pay = depositPart(d)
    const message = d.message
      ? { text: `\n${d.message}\n`, html: `<p style="white-space:pre-wrap">${escapeHtml(d.message)}</p>` }
      : { text: '', html: '' }
    // Fixed facts only: the address isn't verified, so nothing typed on the form is echoed but a short first name.
    const name = d.name.replace(/\s+/g, ' ').trim().slice(0, ACK_NAME_MAX)
    const rows: [string, string][] = [
      ['Entry', d.kind === 'team' ? 'A team' : 'A player (to be placed in a team)'],
      [d.programmes.length === 1 ? 'Programme' : 'Programmes', d.programmes.join(', ')],
    ]
    const sumText = rows.map(([k, v]) => `${k}: ${v}`).join('\n')
    const sumHtml =
      `<table style="border-collapse:collapse;margin:12px 0;font-size:14px">` +
      rows
        .map(
          ([k, v]) =>
            `<tr><th style="text-align:left;vertical-align:top;padding:4px 12px 4px 0;color:#555">${escapeHtml(k)}</th><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`,
        )
        .join('') +
      `</table>`
    return {
      subject: `We've got your details (${d.reference})`,
      text: `Hi ${name},\n\n${d.text}\n\nYour reference is ${d.reference}.\n${pay.text}${message.text}\n${sumText}\n\n${QUESTIONS}\n\n${IGNORE}\n`,
      html: layout(
        `<p>Hi ${escapeHtml(name)},</p><p style="white-space:pre-wrap">${escapeHtml(d.text)}</p>` +
          `<p>Your reference is <b style="font-size:18px;letter-spacing:1px">${escapeHtml(d.reference)}</b>.</p>${pay.html}${message.html}` +
          `${sumHtml}<p style="color:#555;font-size:13px">${QUESTIONS} ${IGNORE}</p>`,
      ),
    }
  },
  'interest.notify': (d) => {
    const sum = interestSummary(d)
    const received = sydneyWhen(d.receivedAt)
    const who = d.kind === 'team' && d.teamName ? `${d.teamName} (team, captain ${d.name})` : `${d.name} (player)`
    const deposit = d.deposit ? `Deposit owed: ${d.deposit}.` : 'No deposit.'
    return {
      subject: `Expression of interest: ${who} (${d.reference})`,
      replyTo: d.email,
      text: `${who} sent an expression of interest through the website (${received}). Reference ${d.reference}.\n\nContact: ${d.name} <${d.email}>, ${d.phone}\n${sum.text}\n\n${deposit}\n\nReply to this email to answer them, or open it in the admin:\n${d.url}\n`,
      html: layout(
        `<p><b>${escapeHtml(who)}</b> sent an expression of interest through the website (${escapeHtml(received)}). Reference <b>${escapeHtml(d.reference)}</b>.</p>` +
          `<p>Contact: ${escapeHtml(d.name)} &lt;${escapeHtml(d.email)}&gt;, ${escapeHtml(d.phone)}</p>${sum.html}<p>${escapeHtml(deposit)}</p>` +
          `<p>Reply to this email to answer them.</p>${button(d.url, 'Open in the admin')}`,
      ),
    }
  },
}

const renderers: { [K in TemplateName]: (data: TemplateData[K]) => RenderedEmail } = {
  'auth.otp': ({ otp }) => ({
    subject: `${otp} is your Tempe Volleyball sign-in code`,
    text: `Your sign-in code is ${otp}\n\nIt expires in 5 minutes.\n\n${IGNORE}\n`,
    html: layout(
      `<p>Your sign-in code is</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:8px 0 16px">${escapeHtml(otp)}</p>` +
        `<p>It expires in 5 minutes.</p><p style="color:#555;font-size:13px">${IGNORE}</p>`,
    ),
  }),
  'auth.magic_link': ({ url }) => ({
    subject: 'Your Tempe Volleyball sign-in link',
    text: `Sign in to the Tempe Volleyball admin:\n${url}\n\nThe link works once and expires in 5 minutes.\n\n${IGNORE}\n`,
    html: layout(
      `<p>Click to sign in to the Tempe Volleyball admin.</p>${button(url, 'Sign in')}` +
        `<p>The link works once and expires in 5 minutes.</p><p style="color:#555;font-size:13px">${IGNORE}</p>`,
    ),
  }),
  'admin.invite': ({ url, role, invitedBy, expiresAt }) => {
    const until = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'full' }).format(new Date(expiresAt))
    return {
      subject: `You're invited to the Tempe Volleyball admin`,
      text: `${invitedBy} has invited you to the Tempe Volleyball admin as ${role}.\n\nAccept the invite:\n${url}\n\nThe invite expires on ${until}.\n`,
      html: layout(
        `<p>${escapeHtml(invitedBy)} has invited you to the Tempe Volleyball admin as <b>${escapeHtml(role)}</b>.</p>${button(url, 'Accept invite')}` +
          `<p>The invite expires on ${escapeHtml(until)}.</p>`,
      ),
    }
  },
  ...enrolmentRenderers,
  ...contactRenderers,
  ...interestRenderers,
}

export const isTemplateName = (name: string): name is TemplateName => (templateNames as readonly string[]).includes(name)

export function renderEmail<K extends TemplateName>(template: K, data: TemplateData[K]): RenderedEmail {
  return (renderers[template] as (d: TemplateData[K]) => RenderedEmail)(data)
}
