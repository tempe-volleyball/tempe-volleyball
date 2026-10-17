import { addDays, parseISO } from './dates'

/** NSW public holidays. Suggestions only — the organiser confirms each one. */
const NSW: Record<string, string> = {
  '2026-01-01': "New Year's Day",
  '2026-01-26': 'Australia Day',
  '2026-04-03': 'Good Friday',
  '2026-04-04': 'Easter Saturday',
  '2026-04-05': 'Easter Sunday',
  '2026-04-06': 'Easter Monday',
  '2026-04-25': 'Anzac Day',
  '2026-06-08': "King's Birthday",
  '2026-10-05': 'Labour Day',
  '2026-12-25': 'Christmas Day',
  '2026-12-26': 'Boxing Day',
  '2026-12-28': 'Boxing Day (observed)',
  '2027-01-01': "New Year's Day",
  '2027-01-26': 'Australia Day',
  '2027-03-26': 'Good Friday',
  '2027-03-27': 'Easter Saturday',
  '2027-03-28': 'Easter Sunday',
  '2027-03-29': 'Easter Monday',
  '2027-04-25': 'Anzac Day',
  '2027-06-14': "King's Birthday",
  '2027-10-04': 'Labour Day',
  '2027-12-25': 'Christmas Day',
  '2027-12-26': 'Boxing Day',
  '2027-12-27': 'Christmas Day (observed)',
  '2027-12-28': 'Boxing Day (observed)',
}

/** Public holidays that land on the game night within the next `weeks` weeks of the start date. */
export function holidaysOnGameNights(startDate: string, weeks: number): { date: string; reason: string }[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || isNaN(parseISO(startDate).getTime())) return []
  const out: { date: string; reason: string }[] = []
  for (let i = 0; i < weeks; i++) {
    const d = addDays(startDate, i * 7)
    if (NSW[d]) out.push({ date: d, reason: NSW[d] })
  }
  return out
}
