// Tells the nav's "Interest" badge (App.tsx) to count new EOIs again, after anything on the Interest screens
// changes one (a status, archive, delete, an EOI added by hand).
export const INTEREST_CHANGED = 'tvb:interest-changed'
export const interestChanged = () => window.dispatchEvent(new Event(INTEREST_CHANGED))

/** The inbox URL for a programme's open EOIs (dashboard, Admin → Enrolments, programme pages link here). */
export const inboxHref = (opts: { programmeId?: string | null; since?: 'season' | 'all'; status?: string } = {}) => {
  const p = new URLSearchParams()
  if (opts.programmeId) p.set('programme', opts.programmeId)
  if (opts.status) p.set('status', opts.status)
  if (opts.since === 'season') p.set('since', 'season')
  const qs = p.toString()
  return qs ? `/interest?${qs}` : '/interest'
}
