import { isDisplayOnly, isMapped } from './validate'
import { answerText } from './validate'
import type { FormField } from './forms'

// CSV export of one target's enrolments (Admin → Enrolments → Export). Pure, so it's tested without a database.
// Spreadsheet-safe: every cell is quoted, and text starting with = + - @ (or a tab/CR) gets a leading apostrophe so
// Excel and Sheets don't run it as a formula.

export type CsvRegistration = {
  reference: string
  status: string
  entryType: string
  teamName: string | null
  waitlistPosition: number | null
  amountCents: number | null
  paidAt: string | null
  paymentNote: string | null
  source: string
  createdAt: string
  cancelReason: string | null
  vnswConfirmed: boolean
  answers: Record<string, unknown>
  player: {
    firstName: string
    lastName: string
    email: string
    phone: string | null
    birthYear: number | null
    guardianName: string | null
    guardianEmail: string | null
    guardianPhone: string | null
    emergencyContact: string | null
  }
}

export const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replaceAll('"', '""')}"`
}

export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

const money = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2))

/** One row per enrolment, with a column per question (retired ones too, so old answers aren't lost). */
export function enrolmentsCsv(fields: readonly FormField[], rows: readonly CsvRegistration[], opts: { juniors?: boolean } = {}): string {
  const questions = fields.filter((f) => !isDisplayOnly(f.type) && !isMapped(f.type))
  const answered = new Set(rows.flatMap((r) => Object.keys(r.answers)))
  const extraKeys = [...answered].filter((k) => !questions.some((q) => q.key === k)).toSorted()
  const juniors = opts.juniors ?? rows.some((r) => r.player.guardianName || r.player.birthYear)
  const header = [
    'Reference',
    'Status',
    'Entry',
    'Team',
    'Waitlist position',
    'First name',
    'Last name',
    'Email',
    'Phone',
    ...(juniors ? ['Year of birth', 'Guardian name', 'Guardian email', 'Guardian phone'] : []),
    'Emergency contact',
    'VNSW member',
    'Amount (AUD)',
    'Paid',
    'Payment note',
    'Source',
    'Enrolled (UTC)',
    'Cancel reason',
    ...questions.map((q) => (q.retired ? `${q.label} (retired)` : q.label)),
    ...extraKeys,
  ]
  const body = rows.map((r) => [
    r.reference,
    r.status,
    r.entryType,
    r.teamName ?? '',
    r.waitlistPosition ?? '',
    r.player.firstName,
    r.player.lastName,
    r.player.email,
    r.player.phone ?? '',
    ...(juniors ? [r.player.birthYear ?? '', r.player.guardianName ?? '', r.player.guardianEmail ?? '', r.player.guardianPhone ?? ''] : []),
    r.player.emergencyContact ?? '',
    r.vnswConfirmed ? 'Yes' : '',
    money(r.amountCents),
    r.paidAt ? r.paidAt.slice(0, 10) : '',
    r.paymentNote ?? '',
    r.source,
    r.createdAt,
    r.cancelReason ?? '',
    ...questions.map((q) => answerText(q, r.answers[q.key])),
    ...extraKeys.map((k) => answerText(undefined, r.answers[k])),
  ])
  return toCsv([header, ...body])
}
