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
}

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
}

export const isTemplateName = (name: string): name is TemplateName => (templateNames as readonly string[]).includes(name)

export function renderEmail<K extends TemplateName>(template: K, data: TemplateData[K]): RenderedEmail {
  return (renderers[template] as (d: TemplateData[K]) => RenderedEmail)(data)
}
