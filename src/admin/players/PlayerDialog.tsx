import { useState } from 'react'
import { Link } from 'wouter'
import { GENDER_OPTIONS } from '../../lib/enrolment/forms'
import { api, ApiError } from '../api'
import type { PlayerDetail } from '../../server/players/admin'
import { Button, Dialog, Field, Notice, Select, TextArea, errorMessage } from '../ui'
import { fullName, type Pool } from './shared'

// Add a player by hand, or edit one (docs/api/players.md). Competition players may have no email (team members
// often don't); training players need one, because enrolment matches them by it.

type Player = PlayerDetail['player']

const FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'gender',
  'birthYear',
  'suburb',
  'vnswNumber',
  'guardianName',
  'guardianEmail',
  'guardianPhone',
  'emergencyContact',
  'notes',
] as const
type FieldKey = (typeof FIELDS)[number]
type Form = Record<FieldKey, string>

const formOf = (p: Player | undefined): Form =>
  Object.fromEntries(FIELDS.map((k) => [k, p?.[k] === null || p?.[k] === undefined ? '' : String(p[k])])) as Form

type Duplicate = { id: string; firstName: string; lastName: string; email: string }

export function PlayerDialog({
  pool,
  player,
  onCancel,
  onSaved,
}: {
  pool: Pool
  player?: Player
  onCancel: () => void
  onSaved: (p: PlayerDetail) => void
}) {
  const [loaded] = useState(() => formOf(player))
  const [form, setForm] = useState<Form>(loaded)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dupes, setDupes] = useState<Duplicate[] | null>(null)
  const [showGuardian, setShowGuardian] = useState(!!(player?.guardianName || player?.guardianEmail || player?.guardianPhone))
  const set = (k: FieldKey, v: string) => setForm((f) => ({ ...f, [k]: v }))
  const editing = !!player

  const body = () => {
    const out: Record<string, unknown> = {}
    for (const k of FIELDS) {
      if (editing && form[k] === loaded[k]) continue
      const v = form[k].trim()
      out[k] = k === 'birthYear' ? (v ? Number(v) : null) : v === '' ? null : v
    }
    return out
  }

  const save = async (force = false) => {
    setBusy(true)
    setError(null)
    try {
      const saved = editing
        ? await api<PlayerDetail>(`/api/admin/players/${encodeURIComponent(player.id)}`, {
            method: 'PATCH',
            body: { baseUpdatedAt: player.updatedAt, ...body() },
          })
        : await api<PlayerDetail>('/api/admin/players', { body: { pool, ...body(), email: form.email.trim(), force } })
      onSaved(saved)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'duplicate' && Array.isArray(e.details.duplicates)) {
        setDupes(e.details.duplicates as Duplicate[])
      } else setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Dialog title={editing ? `Edit ${fullName(player)}` : `Add a ${pool} player`} onCancel={onCancel} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        {dupes && (
          <Notice kind="warning">
            <p className="font-semibold">There’s already a player with that name:</p>
            <ul className="mt-1 list-disc pl-5">
              {dupes.map((d) => (
                <li key={d.id}>
                  <Link href={`/players/${pool}/${d.id}`} className="text-brand underline">
                    {fullName(d)}
                  </Link>
                  {d.email ? ` (${d.email})` : ' (no email)'}
                </li>
              ))}
            </ul>
            <p className="mt-2">Open them instead, or add this one if it’s someone else.</p>
            <div className="mt-2">
              <Button variant="secondary" className="px-3 py-1 text-xs" busy={busy} onClick={() => void save(true)}>
                Add anyway
              </Button>
            </div>
          </Notice>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required maxLength={80} value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
          <Field label="Last name" required maxLength={80} value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
          <Field
            label={pool === 'training' ? 'Email' : 'Email (optional)'}
            type="email"
            required={pool === 'training'}
            maxLength={254}
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            hint={pool === 'training' ? 'Enrolment matches training players by email.' : 'Team members may not have one.'}
          />
          <Field label="Phone" type="tel" maxLength={30} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          <Select label="Gender" value={form.gender} onChange={(e) => set('gender', e.target.value)}>
            <option value="">Not given</option>
            {GENDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Field
            label="Year of birth"
            inputMode="numeric"
            pattern="[0-9]{4}"
            maxLength={4}
            placeholder="1995"
            value={form.birthYear}
            onChange={(e) => set('birthYear', e.target.value)}
          />
          <Field label="Suburb" maxLength={80} value={form.suburb} onChange={(e) => set('suburb', e.target.value)} />
          <Field
            label="VNSW number"
            maxLength={30}
            value={form.vnswNumber}
            onChange={(e) => set('vnswNumber', e.target.value)}
            hint="Volleyball NSW membership (rego) number."
          />
          <div className="sm:col-span-2">
            <Field
              label="Emergency contact"
              maxLength={200}
              value={form.emergencyContact}
              onChange={(e) => set('emergencyContact', e.target.value)}
              hint="Name and phone."
            />
          </div>
        </div>
        <div>
          <button
            type="button"
            className="text-brand text-sm font-semibold underline"
            aria-expanded={showGuardian}
            onClick={() => setShowGuardian((s) => !s)}
          >
            {showGuardian ? 'Hide parent or guardian' : 'Under 18? Parent or guardian…'}
          </button>
          {showGuardian && (
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <Field
                label="Guardian name"
                maxLength={120}
                value={form.guardianName}
                onChange={(e) => set('guardianName', e.target.value)}
              />
              <Field
                label="Guardian email"
                type="email"
                maxLength={254}
                value={form.guardianEmail}
                onChange={(e) => set('guardianEmail', e.target.value)}
              />
              <Field
                label="Guardian phone"
                type="tel"
                maxLength={30}
                value={form.guardianPhone}
                onChange={(e) => set('guardianPhone', e.target.value)}
              />
            </div>
          )}
        </div>
        <TextArea
          label="Notes (for the admins)"
          rows={3}
          maxLength={2000}
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {editing ? 'Save' : 'Add player'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
