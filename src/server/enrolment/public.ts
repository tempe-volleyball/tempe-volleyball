import { eq, inArray } from 'drizzle-orm'
import { defaultFields, entryTypesFor } from '../../lib/enrolment/defaults'
import { activeFields, type FormEntryType, type FormField } from '../../lib/enrolment/forms'
import type { TargetKind } from '../../lib/enrolment/targets'
import type { AppDb } from '../db'
import { enrolmentForms, products, programmes, type ProgrammeKind } from '../db/schema'
import { effective, programmeColumns } from './core'
import { listTargets, type TargetSummary } from './admin'

// What public pages need to show enrolment: which targets are open now, and the props for the <EnrolmentForm>
// island (src/components/enrolment/EnrolmentForm.tsx). The form definition isn't personal, so pages showing it can
// be cached at the edge; the answers only ever go to POST /api/enrol (never cached, never in a URL).

/** One thing that can be chosen on the form (a season, a session, a term or an event). */
export type PublicTarget = {
  kind: TargetKind
  id: string
  label: string
  startsOn: string | null
  /** Which entry of `forms` this target uses. */
  formKey: string
  entryTypes: FormEntryType[]
  /** AUD cents per person; null = no fee shown. */
  amountCents: number | null
  /** Spots left for individuals / teams (null = no cap). */
  spotsLeft: number | null
  teamSpotsLeft: number | null
  /** New entries go onto the waitlist (full, or people already waiting). */
  waitlistOnly: boolean
  /** Full and no waitlist: can't be chosen. */
  full: boolean
}

export type EnrolmentFormProps = {
  programme: { id: string; name: string; code: string; kind: ProgrammeKind }
  /** Open targets, soonest first. Empty = nothing open (the component shows `closedText`). */
  targets: PublicTarget[]
  /** Questions by formKey (active questions only). */
  forms: Record<string, FormField[]>
  /** Turnstile site key. Null = enrolment unavailable (production without keys). */
  turnstileSiteKey: string | null
  /** Where the form posts (default /api/enrol). */
  endpoint?: string
  /** Shown when nothing is open. */
  closedText?: string
}

export type OpenProgramme = { programme: TargetSummary['programme']; targets: TargetSummary[] }

/** Everything open for enrolment now, grouped by programme (for /enrol). One call, about nine D1 queries. */
export async function listOpenEnrolments(db: AppDb, now = new Date(), opts: { programmeId?: string } = {}): Promise<OpenProgramme[]> {
  const targets = (await listTargets(db, opts, now)).filter((t) => t.open)
  const byProgramme = new Map<string, OpenProgramme>()
  for (const t of targets.toSorted((a, b) => (a.startsOn ?? '').localeCompare(b.startsOn ?? ''))) {
    let p = byProgramme.get(t.programme.id)
    if (!p) byProgramme.set(t.programme.id, (p = { programme: t.programme, targets: [] }))
    p.targets.push(t)
  }
  return [...byProgramme.values()]
}

/**
 * The props for one programme's enrolment form, or null if the programme has nothing open. Pass the Turnstile
 * site key from turnstileKeys(env)?.siteKey (null in production without keys: the form says it's unavailable).
 */
export async function loadEnrolmentForm(
  db: AppDb,
  programmeId: string,
  turnstileSiteKey: string | null,
  now = new Date(),
): Promise<EnrolmentFormProps | null> {
  const [open] = await listOpenEnrolments(db, now, { programmeId })
  if (!open) return null
  const productIds = open.targets.map((t) => t.productId).filter((id): id is string => !!id)
  const [progRow, productRows] = await Promise.all([
    db.select(programmeColumns).from(programmes).where(eq(programmes.id, programmeId)).get(),
    productIds.length > 0
      ? db
          .select()
          .from(products)
          .where(inArray(products.id, productIds.slice(0, 90)))
          .all()
      : Promise.resolve([]),
  ])
  if (!progRow) return null
  const productById = new Map(productRows.map((p) => [p.id, p]))
  const formIds = new Set<string>()
  const effs = open.targets.map((t) => {
    const eff = effective(progRow, (t.productId && productById.get(t.productId)) || null)
    if (eff.formId) formIds.add(eff.formId)
    return eff
  })
  const formRows =
    formIds.size > 0
      ? await db
          .select()
          .from(enrolmentForms)
          .where(inArray(enrolmentForms.id, [...formIds]))
          .all()
      : []
  const forms: Record<string, FormField[]> = {}
  const keyFor = (formId: string | null) => {
    const row = formId ? formRows.find((f) => f.id === formId) : undefined
    const key = row ? row.id : 'default'
    if (!(key in forms)) forms[key] = activeFields(row ? row.fields : defaultFields(progRow.kind))
    return key
  }
  const targets: PublicTarget[] = open.targets.map((t, i) => {
    const eff = effs[i]!
    const spotsLeft = t.caps.players === null ? null : Math.max(0, t.caps.players - t.counts.players)
    const teamSpotsLeft = t.caps.teams === null ? null : Math.max(0, t.caps.teams - t.counts.teams)
    const noRoom = spotsLeft === 0 || teamSpotsLeft === 0 || t.counts.waitlist > 0 || t.counts.teamsWaitlist > 0
    return {
      kind: t.ref.kind,
      id: t.ref.id,
      label: t.label,
      startsOn: t.startsOn,
      formKey: keyFor(eff.formId),
      entryTypes: entryTypesFor(progRow.kind, eff),
      amountCents: eff.amountCents,
      spotsLeft,
      teamSpotsLeft,
      waitlistOnly: noRoom && eff.waitlistEnabled,
      full: noRoom && !eff.waitlistEnabled,
    }
  })
  return {
    programme: { id: progRow.id, name: progRow.name, code: progRow.code, kind: progRow.kind },
    targets,
    forms,
    turnstileSiteKey,
  }
}
