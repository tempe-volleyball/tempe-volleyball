// Email templates. Each renders a subject, a plain-text body and a small HTML body from its data.
// Keep them plain: no images or tracking, so they're light and land in the inbox.

export type TemplateData = {
  /** A sign-in code (Better Auth emailOTP). */
  'auth.otp': { otp: string }
  /** A sign-in link (Better Auth magicLink). */
  'auth.magic_link': { url: string }
  /** An invitation to become an admin user. */
  'admin.invite': { url: string; role: string; invitedBy: string; expiresAt: string }
}

export type TemplateName = keyof TemplateData

export const templateNames = ['auth.otp', 'auth.magic_link', 'admin.invite'] as const satisfies readonly TemplateName[]

/**
 * Templates whose payload is a secret (codes, sign-in links, invite links). Their payload is kept only while the
 * email can still be sent, cleared on every final state, and never logged in production.
 */
export const SENSITIVE_TEMPLATES: ReadonlySet<TemplateName> = new Set(['auth.otp', 'auth.magic_link', 'admin.invite'])

/**
 * Sign-in emails. Always send-now-or-never (the code expires in minutes), never stored with their payload, limited
 * per recipient, and counted against their own share of the daily cap.
 */
export const AUTH_TEMPLATES: ReadonlySet<TemplateName> = new Set(['auth.otp', 'auth.magic_link'])

export const isSensitiveTemplate = (name: string) => (SENSITIVE_TEMPLATES as ReadonlySet<string>).has(name)
export const isAuthTemplate = (name: string) => (AUTH_TEMPLATES as ReadonlySet<string>).has(name)

export type RenderedEmail = { subject: string; text: string; html: string }

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
}

export const isTemplateName = (name: string): name is TemplateName => (templateNames as readonly string[]).includes(name)

export function renderEmail<K extends TemplateName>(template: K, data: TemplateData[K]): RenderedEmail {
  return (renderers[template] as (d: TemplateData[K]) => RenderedEmail)(data)
}
