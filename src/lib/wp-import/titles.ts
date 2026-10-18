import { decodeEntities, titleCase } from './text'

// SportsPress event titles carried data the new model keeps in fields: finals stages, placeholder sides
// ("(LOSER SF1)"), duty teams, byes and skipped weeks. These parse them. Placeholder teams come through the API as
// team id -1, so for finals the title is the only record of who played or was meant to.

/** One side of a match (or the duty team) as typed in a title: a team name, a placeholder label, or both. */
export type SideText = { team?: string; label?: string; note?: string }

export type ParsedTitle =
  | { kind: 'match'; stageTitle: string | null; home: SideText; away: SideText; duty: SideText | null; notes: string[] }
  | { kind: 'bye'; teams: string[] }
  | { kind: 'skip'; note: string }

const ROUNDS: Record<string, string> = {
  'preliminary semi final': 'PSF',
  'semi final': 'SF',
  'grand final': 'GF',
  'qualifying final': 'QF',
  'elimination final': 'EF',
  psf: 'PSF',
  pf: 'PSF',
  sf: 'SF',
  qf: 'QF',
  ef: 'EF',
  gf: 'GF',
}

const LABEL_RE =
  /^(?:(winner|loser|w|l)\s*(preliminary semi final|semi final|grand final|qualifying final|elimination final|psf|sf|qf|ef|pf|gf)\s*(\d)?|(\d+)(st|nd|rd|th))(?![a-z])/i

/**
 * A placeholder label at the start of `s`, normalised to the fixtures library's spelling ("2nd", "Winner SF1",
 * "Loser GF"), plus whatever follows it ("WSF1 HIT FOR BRAINS" -> label "Winner SF1", rest "HIT FOR BRAINS").
 */
export function parseLabel(s: string): { label: string; rest: string } | null {
  const t = s.trim()
  const m = LABEL_RE.exec(t)
  if (!m) return null
  const rest = t.slice(m[0].length).trim()
  if (m[4]) return { label: `${Number(m[4])}${m[5]!.toLowerCase()}`, rest }
  const who = m[1]!.toLowerCase().startsWith('w') ? 'Winner' : 'Loser'
  const round = ROUNDS[m[2]!.toLowerCase().replace(/\s+/g, ' ')]!
  return { label: `${who} ${round}${m[3] ?? ''}`, rest }
}

/**
 * SportsPress team posts that were really placeholders in finals or byes ("BYE", "Grand Final", "3rd Place",
 * "Winner SF1", "2nd", "TBC"), not teams. The importer leaves them out when no game or season uses them.
 */
export function isPlaceholderTeamName(name: string): boolean {
  const t = name.trim().replace(/\s+/g, ' ')
  if (/^(bye|tbc|tba|tbd|finals?|grand final|semi ?finals?( \d)?|3rd place( play-?off)?|preliminary semi ?final( \d)?)$/i.test(t))
    return true
  const l = parseLabel(t)
  return !!l && !l.rest
}

/** "RICE SPICE ELITE (3RD)", "(LOSER SF1)", "(WSF1 HIT FOR BRAINS)", "LSF2 BENCHIES", "LOSER GF" … */
export function parseSide(text: string): SideText {
  const t = text
    .trim()
    .replace(/^[–—-]\s*/, '')
    .trim()
  const side: SideText = {}
  const m = /^(.*?)\s*\(([^)]*)\)\s*(.*)$/.exec(t)
  if (m) {
    const before = m[1]!.trim()
    const inner = m[2]!.trim()
    const after = m[3]!.trim()
    const l = parseLabel(inner)
    if (l) {
      side.label = l.label
      if (l.rest) side.team = l.rest
    } else if (!before) {
      side.team = inner
    } else {
      side.note = inner
    }
    if (before) {
      const lb = !side.label ? parseLabel(before) : null
      if (lb) {
        side.label = lb.label
        if (lb.rest) side.team = lb.rest
      } else {
        side.team = before
      }
    }
    if (after) side.note = side.note ? `${side.note} ${after}` : after
    return side
  }
  const l = parseLabel(t)
  if (l) return l.rest ? { label: l.label, team: l.rest } : { label: l.label }
  return t ? { team: t } : {}
}

/** "3RD PLACE PLAYOFF" -> "3rd Place" (the fixtures library's name), "SEMI FINAL 1" -> "Semi Final 1". */
export function normaliseStage(raw: string): string {
  const t = titleCase(raw.trim())
  return /^3rd place( play-?off)?$/i.test(t) ? '3rd Place' : t
}

const DASH = String.raw`\s+[–—-]\s+`
const STAGED = new RegExp(String.raw`^(.+?)${DASH}(.+?\s+vs\.?\s+.+?)(?:${DASH}duty\b\s*[–—-]?\s*(.+))?$`, 'i')
const UNSTAGED = new RegExp(String.raw`^(.+?\s+vs\.?\s+.+?)(?:${DASH}duty\b\s*[–—-]?\s*(.+))?$`, 'i')

/** Annotations typed after team names in regular matches: "***EARLY SESSION***", "(ICE COLD DOUBLE HEADER)". */
function stripNotes(s: string, notes: string[]): string {
  return s
    .replace(/\*{2,}\s*([^*]+?)\s*\*{2,}/g, (_, n: string) => {
      notes.push(titleCase(n))
      return ' '
    })
    .replace(/\(([^)]*double header[^)]*)\)/gi, (_, n: string) => {
      notes.push(titleCase(n))
      return ' '
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parses a SportsPress event title (raw, with HTML entities) into what it says. */
export function parseEventTitle(rawTitle: string): ParsedTitle {
  const title = decodeEntities(rawTitle).replace(/\s+/g, ' ').trim()

  const bye = /^byes?\b\s*[–—-]?\s*(.*)$/i.exec(title)
  if (bye) {
    const teams = bye[1]!
      .split(/\s*&\s*|\s+and\s+/i)
      .map((t) => t.replace(/\([^)]*\)/g, '').trim())
      .filter(Boolean)
    return { kind: 'bye', teams }
  }

  if (!/\svs\.?\s/i.test(title)) {
    const note = title.replace(/\*+/g, ' ').replace(/\s+/g, ' ').trim()
    return { kind: 'skip', note }
  }

  const notes: string[] = []
  const staged = STAGED.exec(title)
  // A stage needs a dash before the match-up; "A vs B" with nothing before it is a regular match.
  if (staged && !/\svs\.?\s/i.test(staged[1]!)) {
    const [home = '', away = ''] = staged[2]!.split(/\s+vs\.?\s+/i)
    return {
      kind: 'match',
      stageTitle: normaliseStage(staged[1]!),
      home: parseSide(home),
      away: parseSide(away),
      duty: staged[3] ? parseSide(staged[3]) : null,
      notes,
    }
  }
  const plain = UNSTAGED.exec(title)!
  const [home = '', away = ''] = stripNotes(plain[1]!, notes).split(/\s+vs\.?\s+/i)
  return {
    kind: 'match',
    stageTitle: null,
    home: parseSide(home),
    away: parseSide(away),
    duty: plain[2] ? parseSide(plain[2]) : null,
    notes,
  }
}
