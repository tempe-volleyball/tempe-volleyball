import { and, asc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm'
import { defaultFields, DEFAULT_FORM_FIELDS } from '../../lib/enrolment/defaults'
import type { FormField } from '../../lib/enrolment/forms'
import { checkFormFields } from '../../lib/enrolment/validate'
import { programmePath } from '../../lib/programmes'
import { tags, type PurgeTargets } from '../cache'
import { audit, conflict, invalid, notFound, optionalText, requiredText, type Editor } from '../content/common'
import { runBatch, type AppDb } from '../db'
import { enrolmentForms, products, programmeKinds, programmes, registrations, type EnrolmentForm, type ProgrammeKind } from '../db/schema'

// Enrolment forms (enrolment_forms): the extra questions a programme asks. Admin and owner only. A programme names
// its default form (leagues.enrolment_form_id); one season, session, term or event can override it (products.form_id).
// Every save bumps `version`; field keys are permanent (checkFormFields refuses to drop one; retire it instead).

export type FormSummary = Pick<EnrolmentForm, 'id' | 'name' | 'description' | 'version' | 'archivedAt' | 'updatedAt'> & {
  questions: number
  programmes: { id: string; name: string; kind: ProgrammeKind }[]
  overrides: number
  registrations: number
}

export type FormsList = {
  forms: FormSummary[]
  /** Starting questions per programme kind. */
  templates: Record<ProgrammeKind, FormField[]>
  /** Every programme, for "Default form for". */
  programmes: { id: string; name: string; kind: ProgrammeKind; status: string; enrolmentFormId: string | null }[]
}

const countByForm = (rows: { formId: string | null; n: number }[]) => new Map(rows.map((r) => [r.formId, Number(r.n)]))

export async function listForms(db: AppDb): Promise<FormsList> {
  const [forms, progs, overrides, regs] = await Promise.all([
    db.select().from(enrolmentForms).orderBy(asc(enrolmentForms.name)).all(),
    db
      .select({
        id: programmes.id,
        name: programmes.name,
        kind: programmes.kind,
        status: programmes.status,
        enrolmentFormId: programmes.enrolmentFormId,
      })
      .from(programmes)
      .orderBy(asc(programmes.sort), asc(programmes.name))
      .all(),
    db
      .select({ formId: products.formId, n: sql<number>`count(*)` })
      .from(products)
      .where(isNotNull(products.formId))
      .groupBy(products.formId)
      .all(),
    db
      .select({ formId: registrations.formId, n: sql<number>`count(*)` })
      .from(registrations)
      .where(isNotNull(registrations.formId))
      .groupBy(registrations.formId)
      .all(),
  ])
  const o = countByForm(overrides)
  const r = countByForm(regs)
  return {
    forms: forms.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      version: f.version,
      archivedAt: f.archivedAt,
      updatedAt: f.updatedAt,
      questions: f.fields.filter((x) => !x.retired && x.type !== 'heading' && x.type !== 'paragraph').length,
      programmes: progs.filter((p) => p.enrolmentFormId === f.id).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      overrides: o.get(f.id) ?? 0,
      registrations: r.get(f.id) ?? 0,
    })),
    templates: structuredClone(DEFAULT_FORM_FIELDS),
    programmes: progs,
  }
}

export async function getForm(db: AppDb, id: string) {
  const form = await db.select().from(enrolmentForms).where(eq(enrolmentForms.id, id)).get()
  if (!form) throw notFound('form')
  return form
}

export type FormInput = {
  name?: unknown
  description?: unknown
  fields?: unknown
  confirmationText?: unknown
  /** Create only: start from this kind's default questions. */
  template?: unknown
  /** Update only: archive (true) or restore (false). */
  archived?: unknown
  baseUpdatedAt?: unknown
}

const confirmation = (v: unknown) => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw invalid('The confirmation message must be text.')
  const s = v.trim()
  if (s.length > 2000) throw invalid('The confirmation message is too long (at most 2,000 characters).')
  return s || null
}

export async function createForm(db: AppDb, actor: Editor, input: FormInput, now = new Date()) {
  const name = requiredText(input.name, 'Name', 120)
  let fields: FormField[] = []
  if (input.fields !== undefined) {
    const checked = checkFormFields(input.fields)
    if (!checked.ok) throw invalid(checked.message)
    fields = checked.fields
  } else if (input.template !== undefined && input.template !== null) {
    if (!(programmeKinds as readonly unknown[]).includes(input.template)) throw invalid('Unknown template.')
    fields = defaultFields(input.template as ProgrammeKind)
  }
  const at = now.toISOString()
  const id = crypto.randomUUID()
  const row = {
    id,
    name,
    description: optionalText(input.description, 'Description', 500),
    fields,
    version: 1,
    confirmationText: confirmation(input.confirmationText),
    createdAt: at,
    updatedAt: at,
    updatedBy: actor.id,
  }
  await runBatch(db, [
    db.insert(enrolmentForms).values(row),
    audit(db, actor, 'form.create', { type: 'form', id }, null, { name, questions: fields.length }, at),
  ])
  return getForm(db, id)
}

/** Pages showing a form: /enrol and the pages of every programme using it (default or via an instance). */
async function formPurge(db: AppDb, formId: string): Promise<PurgeTargets> {
  const rows = await db
    .selectDistinct({ kind: programmes.kind, slug: programmes.slug })
    .from(programmes)
    .leftJoin(products, eq(products.programmeId, programmes.id))
    .where(sql`${programmes.enrolmentFormId} = ${formId} or ${products.formId} = ${formId}`)
    .all()
  return { tags: [tags.page('/enrol'), ...rows.map((r) => tags.page(programmePath(r.kind, r.slug)))] }
}

export async function updateForm(db: AppDb, actor: Editor, id: string, input: FormInput, now = new Date()) {
  const form = await getForm(db, id)
  if (typeof input.baseUpdatedAt === 'string' && input.baseUpdatedAt !== form.updatedAt)
    throw conflict('Someone else saved this form since you opened it. Reload to see their changes, then make yours again.')
  const set: Partial<EnrolmentForm> = {}
  if (input.name !== undefined) set.name = requiredText(input.name, 'Name', 120)
  if (input.description !== undefined) set.description = optionalText(input.description, 'Description', 500)
  if (input.confirmationText !== undefined) set.confirmationText = confirmation(input.confirmationText)
  if (input.fields !== undefined) {
    const checked = checkFormFields(input.fields, form.fields)
    if (!checked.ok) throw invalid(checked.message)
    set.fields = checked.fields
  }
  if (input.archived !== undefined) {
    if (input.archived === true && !form.archivedAt) {
      const inUse = await db.select({ id: programmes.id }).from(programmes).where(eq(programmes.enrolmentFormId, id)).limit(1).get()
      if (inUse) throw conflict('Programmes still use this form. Give them another form first.')
      set.archivedAt = now.toISOString()
    } else if (input.archived === false) set.archivedAt = null
  }
  if (Object.keys(set).length === 0) return { result: form, purge: {} as PurgeTargets }
  const at = now.toISOString()
  const [rows] = (await runBatch(db, [
    db
      .update(enrolmentForms)
      .set({ ...set, version: sql`${enrolmentForms.version} + 1`, updatedAt: at, updatedBy: actor.id })
      .where(and(eq(enrolmentForms.id, id), eq(enrolmentForms.updatedAt, form.updatedAt)))
      .returning(),
    audit(
      db,
      actor,
      'form.update',
      { type: 'form', id },
      { version: form.version, fields: set.fields ? form.fields.length : undefined, name: set.name ? form.name : undefined },
      {
        version: form.version + 1,
        fields: set.fields?.length,
        name: set.name,
        archived: set.archivedAt !== undefined ? !!set.archivedAt : undefined,
      },
      at,
    ),
  ])) as [EnrolmentForm[]]
  if (!rows?.[0]) throw conflict('Someone else saved this form just now. Reload and try again.')
  return { result: rows[0], purge: await formPurge(db, id) }
}

/** Deletes a form nothing has used. Once anyone has answered it, or anything points at it, archive it instead. */
export async function deleteForm(db: AppDb, actor: Editor, id: string, now = new Date()) {
  const form = await getForm(db, id)
  const [answered, programme, override] = await Promise.all([
    db.select({ id: registrations.id }).from(registrations).where(eq(registrations.formId, id)).limit(1).get(),
    db.select({ id: programmes.id }).from(programmes).where(eq(programmes.enrolmentFormId, id)).limit(1).get(),
    db.select({ id: products.id }).from(products).where(eq(products.formId, id)).limit(1).get(),
  ])
  if (answered) throw conflict('People have answered this form, so it can only be archived (their answers keep its questions).')
  if (programme || override) throw conflict('Programmes or sessions still use this form. Give them another form first.')
  const at = now.toISOString()
  await runBatch(db, [
    db.delete(enrolmentForms).where(eq(enrolmentForms.id, id)),
    audit(db, actor, 'form.delete', { type: 'form', id }, { name: form.name }, null, at),
  ])
}

/**
 * Makes this form the default for exactly these programmes: listed ones get it, programmes that had it and aren't
 * listed go back to the kind's default questions. One audit entry (form.update) lists the programmes before and after.
 */
export async function setFormProgrammes(db: AppDb, actor: Editor, id: string, input: { programmeIds?: unknown }, now = new Date()) {
  const form = await getForm(db, id)
  if (!Array.isArray(input.programmeIds) || input.programmeIds.some((p) => typeof p !== 'string') || input.programmeIds.length > 80)
    throw invalid('Choose the programmes.')
  const ids = [...new Set(input.programmeIds as string[])]
  if (ids.length > 0 && form.archivedAt) throw invalid('This form is archived. Restore it first.')
  const current = await db
    .select({ id: programmes.id, kind: programmes.kind, slug: programmes.slug, enrolmentFormId: programmes.enrolmentFormId })
    .from(programmes)
    .where(
      ids.length > 0 ? sql`${programmes.enrolmentFormId} = ${id} or ${inArray(programmes.id, ids)}` : eq(programmes.enrolmentFormId, id),
    )
    .all()
  const known = new Set(current.map((p) => p.id))
  if (ids.some((p) => !known.has(p))) throw invalid('One of those programmes no longer exists.')
  const adding = current.filter((p) => ids.includes(p.id) && p.enrolmentFormId !== id)
  const removing = current.filter((p) => !ids.includes(p.id) && p.enrolmentFormId === id)
  if (adding.length === 0 && removing.length === 0) return { purge: {} as PurgeTargets }
  const at = now.toISOString()
  await runBatch(db, [
    ...(adding.length > 0
      ? [
          db
            .update(programmes)
            .set({ enrolmentFormId: id, updatedAt: at, updatedBy: actor.id })
            .where(
              inArray(
                programmes.id,
                adding.map((p) => p.id),
              ),
            ),
        ]
      : []),
    ...(removing.length > 0
      ? [
          db
            .update(programmes)
            .set({ enrolmentFormId: null, updatedAt: at, updatedBy: actor.id })
            .where(and(eq(programmes.enrolmentFormId, id), notInArray(programmes.id, ids.length > 0 ? ids : [''])))
            .returning({ id: programmes.id }),
        ]
      : []),
    audit(
      db,
      actor,
      'form.update',
      { type: 'form', id },
      { programmes: current.filter((p) => p.enrolmentFormId === id).map((p) => p.id) },
      { programmes: ids, added: adding.map((p) => p.id), removed: removing.map((p) => p.id) },
      at,
    ),
  ])
  return {
    purge: {
      tags: [tags.page('/enrol'), ...[...adding, ...removing].map((p) => tags.page(programmePath(p.kind, p.slug)))],
    } as PurgeTargets,
  }
}
