import { and, eq, inArray, sql } from 'drizzle-orm'
import { REFERENCE_ALPHABET } from '../../lib/enrolment/reference'
import { runBatch, type AppDb } from '../db'
import {
  auditLog,
  interestMembers,
  interestProgrammes,
  interests,
  players,
  seasonTeamPlayers,
  teams,
  type InterestKind,
  type InterestSource,
  type MemberDetails,
  type NewPlayer,
  type PlayerPool,
  type PlayerSource,
  type RegistrationAnswers,
  type RosterRole,
} from '../db/schema'
import { auditEntry, isUniqueFailure, type Editor } from '../content/common'

// Players and expressions of interest: the shared core (docs/interest.md). Public forms and the admin both create
// EOIs through createInterest(); people are matched to player rows with matchPeople(). A public form never
// overwrites a player row: an existing player keeps their details and the EOI keeps what was typed.

/** D1 binds at most 100 parameters per statement: rows per multi-row insert for a table with `columns` columns. */
export const rowsPerInsert = (columns: number) => Math.max(1, Math.floor(100 / columns))

export function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
const sameName = (a: { firstName: string; lastName: string }, b: { firstName: string; lastName: string }) =>
  lower(a.firstName) === lower(b.firstName) && lower(a.lastName) === lower(b.lastName)

/**
 * The player row each person is, or null for a new person, within `pool`. With an email: the same lower-cased
 * email and first and last name (case-insensitive), the oldest row if there are several, as enrolment matches.
 * Without one (team members): the same name among players on an earlier roster of a team with `teamName`. Two
 * queries at most.
 */
export async function matchPeople(
  db: AppDb,
  pool: PlayerPool,
  people: readonly Pick<MemberDetails, 'firstName' | 'lastName' | 'email'>[],
  opts: { teamName?: string | null } = {},
): Promise<(string | null)[]> {
  const emails = [...new Set(people.map((p) => lower(p.email)).filter(Boolean))]
  const byEmail = emails.length
    ? await db
        .select({
          id: players.id,
          email: players.email,
          firstName: players.firstName,
          lastName: players.lastName,
          createdAt: players.createdAt,
        })
        .from(players)
        .where(and(eq(players.pool, pool), inArray(players.email, emails)))
        .orderBy(players.createdAt, players.id)
    : []
  const needsRoster = !!opts.teamName?.trim() && people.some((p) => !lower(p.email))
  const fromRoster = needsRoster
    ? await db
        .selectDistinct({ id: players.id, firstName: players.firstName, lastName: players.lastName, createdAt: players.createdAt })
        .from(seasonTeamPlayers)
        .innerJoin(teams, eq(teams.id, seasonTeamPlayers.teamId))
        .innerJoin(players, eq(players.id, seasonTeamPlayers.playerId))
        .where(and(eq(players.pool, pool), sql`lower(trim(${teams.name})) = ${lower(opts.teamName)}`))
        .orderBy(players.createdAt, players.id)
    : []
  return people.map((p) => {
    const email = lower(p.email)
    const hit = email ? byEmail.find((r) => r.email === email && sameName(r, p)) : fromRoster.find((r) => sameName(r, p))
    return hit?.id ?? null
  })
}

/** A new player row from the details a person was sent with. */
export function newPlayerRow(
  id: string,
  pool: PlayerPool,
  d: MemberDetails,
  meta: { source: PlayerSource; at: string; actorId?: string | null },
): NewPlayer {
  return {
    id,
    pool,
    firstName: d.firstName,
    lastName: d.lastName,
    // players.email is NOT NULL: members sent without one get '' (never matched on).
    email: lower(d.email),
    phone: d.phone,
    birthYear: d.birthYear,
    gender: d.gender,
    suburb: d.suburb,
    vnswNumber: d.vnswNumber,
    guardianName: d.guardianName,
    guardianEmail: d.guardianEmail,
    guardianPhone: d.guardianPhone,
    emergencyContact: d.emergencyContact,
    source: meta.source,
    createdAt: meta.at,
    updatedAt: meta.at,
    updatedBy: meta.actorId ?? null,
  }
}

/** Blank details for people typed in with only a name. */
export const emptyDetails = (firstName: string, lastName: string, email: string | null = null): MemberDetails => ({
  firstName,
  lastName,
  email,
  phone: null,
  gender: null,
  birthYear: null,
  suburb: null,
  vnswNumber: null,
  guardianName: null,
  guardianEmail: null,
  guardianPhone: null,
  emergencyContact: null,
})

/** EOI references: "EOI-7K3Q", the enrolment alphabet (no 0/O, 1/I/L, U). */
export const INTEREST_REFERENCE_PATTERN = /^EOI-[2-9A-HJKMNP-TV-Z]{4}$/
export function newInterestReference(random: (b: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)) {
  const bytes = random(new Uint8Array(4))
  let out = 'EOI-'
  for (const b of bytes) out += REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]
  return out
}

export type CreateInterestInput = {
  kind: InterestKind
  pool: PlayerPool
  /** Team EOIs. */
  teamName: string | null
  /** The people, contact (captain) first. At least one. */
  members: MemberDetails[]
  programmeIds: string[]
  answers: RegistrationAnswers
  formId: string | null
  formVersion: number | null
  depositCents: number | null
  source: InterestSource
  note?: string | null
  /** Admin-entered EOIs: who (audited). Public ones have none. */
  actor?: Editor | null
  now: Date
}

export type CreatedInterest = {
  id: string
  reference: string
  createdAt: string
  /** Per member, in order: their player row and whether it was created now. */
  members: { playerId: string; created: boolean }[]
}

/**
 * Saves one EOI with its people and programmes in one batch: new player rows for people who aren't players yet
 * (in `pool`), the interest, its members (contact first) and one interest_programmes row per programme (status new).
 * Existing players aren't touched. Retries with a new reference on the (rare) clash.
 */
export async function createInterest(db: AppDb, input: CreateInterestInput): Promise<CreatedInterest> {
  if (input.members.length === 0) throw new Error('createInterest: no members')
  if (input.programmeIds.length === 0) throw new Error('createInterest: no programmes')
  const at = input.now.toISOString()
  const matched = await matchPeople(db, input.pool, input.members, { teamName: input.teamName })

  // Within one EOI the same new person (same email and name) typed twice is one player.
  const ids: string[] = []
  const created: boolean[] = []
  const newRows: NewPlayer[] = []
  input.members.forEach((m, i) => {
    const existing = matched[i]
    if (existing) {
      ids.push(existing)
      created.push(false)
      return
    }
    const twin = lower(m.email)
      ? input.members.findIndex((o, j) => j < i && !matched[j] && lower(o.email) === lower(m.email) && sameName(o, m))
      : -1
    if (twin >= 0) {
      ids.push(ids[twin]!)
      created.push(false)
      return
    }
    const id = crypto.randomUUID()
    ids.push(id)
    created.push(true)
    newRows.push(
      newPlayerRow(id, input.pool, m, { source: input.source === 'public' ? 'interest' : input.source, at, actorId: input.actor?.id }),
    )
  })

  const interestId = crypto.randomUUID()
  const programmeIds = [...new Set(input.programmeIds)]
  for (let attempt = 0; ; attempt++) {
    const reference = newInterestReference()
    const items = [
      ...chunk(newRows, rowsPerInsert(20)).map((rows) => db.insert(players).values(rows)),
      db.insert(interests).values({
        id: interestId,
        kind: input.kind,
        reference,
        teamName: input.teamName,
        answers: input.answers,
        formId: input.formId,
        formVersion: input.formVersion,
        depositCents: input.depositCents,
        note: input.note ?? null,
        source: input.source,
        createdAt: at,
        updatedAt: at,
        updatedBy: input.actor?.id ?? null,
      }),
      ...chunk(
        input.members.map((m, i) => ({
          interestId,
          playerId: ids[i]!,
          role: (input.kind === 'team' && i === 0 ? 'captain' : 'player') as RosterRole,
          sort: i,
          details: m,
          createdAt: at,
          updatedAt: at,
        })),
        rowsPerInsert(8),
      ).map((rows) => db.insert(interestMembers).values(rows)),
      ...chunk(
        programmeIds.map((programmeId) => ({
          interestId,
          programmeId,
          status: 'new' as const,
          createdAt: at,
          updatedAt: at,
          updatedBy: input.actor?.id ?? null,
        })),
        rowsPerInsert(8),
      ).map((rows) => db.insert(interestProgrammes).values(rows)),
      ...(input.actor
        ? [
            db
              .insert(auditLog)
              .values(
                auditEntry(
                  input.actor,
                  'interest.create',
                  { type: 'interest', id: interestId },
                  null,
                  { reference, kind: input.kind, programmeIds },
                  at,
                ),
              ),
          ]
        : []),
    ]
    try {
      await runBatch(db, items)
      return { id: interestId, reference, createdAt: at, members: ids.map((playerId, i) => ({ playerId, created: created[i]! })) }
    } catch (e) {
      if (attempt < 4 && isUniqueFailure(e, 'reference')) continue
      throw e
    }
  }
}
