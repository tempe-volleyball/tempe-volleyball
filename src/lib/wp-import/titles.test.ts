import { describe, expect, it } from 'vitest'
import { isPlaceholderTeamName, normaliseStage, parseEventTitle, parseLabel, parseSide } from './titles'

describe('parseLabel', () => {
  it.each([
    ['2ND', '2nd', ''],
    ['1st', '1st', ''],
    ['8TH', '8th', ''],
    ['LOSER SF1', 'Loser SF1', ''],
    ['Winner Semi Final', 'Winner SF', ''],
    ['LOSER GRAND FINAL', 'Loser GF', ''],
    ['WSF1 HIT FOR BRAINS', 'Winner SF1', 'HIT FOR BRAINS'],
    ['LSF2 BENCHIES', 'Loser SF2', 'BENCHIES'],
    ['WINNER PSF2', 'Winner PSF2', ''],
    ['LOSER PF1', 'Loser PSF1', ''],
    ['WINNER QF1', 'Winner QF1', ''],
    ['WINNER EF2', 'Winner EF2', ''],
  ])('%s', (text, label, rest) => {
    expect(parseLabel(text)).toEqual({ label, rest })
  })

  it('does not read team names as labels', () => {
    expect(parseLabel('LEFT HANDERS')).toBeNull()
    expect(parseLabel('WILL WORK FOR SETS')).toBeNull()
    expect(parseLabel('LSFC')).toBeNull()
  })
})

describe('parseSide', () => {
  it('reads team names, labels and both', () => {
    expect(parseSide('(LOSER SF1)')).toEqual({ label: 'Loser SF1' })
    expect(parseSide('RICE SPICE ELITE (3RD)')).toEqual({ team: 'RICE SPICE ELITE', label: '3rd' })
    expect(parseSide('(WSF1 HIT FOR BRAINS)')).toEqual({ team: 'HIT FOR BRAINS', label: 'Winner SF1' })
    expect(parseSide('LOSER GF')).toEqual({ label: 'Loser GF' })
    expect(parseSide('LSF2 BENCHIES')).toEqual({ team: 'BENCHIES', label: 'Loser SF2' })
    expect(parseSide('– PIGHUT (4TH)')).toEqual({ team: 'PIGHUT', label: '4th' })
    expect(parseSide('KY & CO')).toEqual({ team: 'KY & CO' })
  })

  it('keeps trailing text as a note', () => {
    expect(parseSide('NIKOLOVS (1st) have bye to Grand Final')).toEqual({ team: 'NIKOLOVS', label: '1st', note: 'have bye to Grand Final' })
  })
})

describe('normaliseStage', () => {
  it('uses the fixtures library names', () => {
    expect(normaliseStage('3RD PLACE PLAYOFF')).toBe('3rd Place')
    expect(normaliseStage('SEMI FINAL 1')).toBe('Semi Final 1')
    expect(normaliseStage('GRAND FINAL')).toBe('Grand Final')
    expect(normaliseStage('PRELIMINARY SEMI FINAL 2')).toBe('Preliminary Semi Final 2')
  })
})

describe('parseEventTitle', () => {
  it('parses the finals placeholder example from PLAN.md', () => {
    expect(parseEventTitle('3RD PLACE PLAYOFF &#8211; (LOSER SF1) vs (LOSER SF2) &#8211; DUTY LOSER GF')).toEqual({
      kind: 'match',
      stageTitle: '3rd Place',
      home: { label: 'Loser SF1' },
      away: { label: 'Loser SF2' },
      duty: { label: 'Loser GF' },
      notes: [],
    })
  })

  it('parses finals with team names, labels and duty teams', () => {
    expect(parseEventTitle('GRAND FINAL &#8211; MM7 (1ST) vs FIRE FERRETS (2ND) &#8211; DUTY HITTERS ONLY (4TH)')).toEqual({
      kind: 'match',
      stageTitle: 'Grand Final',
      home: { team: 'MM7', label: '1st' },
      away: { team: 'FIRE FERRETS', label: '2nd' },
      duty: { team: 'HITTERS ONLY', label: '4th' },
      notes: [],
    })
    const gf = parseEventTitle('GRAND FINAL &#8211; (WSF1 HIT FOR BRAINS) vs (WSF2 KBU) &#8211; Duty LSF2 BENCHIES')
    expect(gf).toMatchObject({
      home: { team: 'HIT FOR BRAINS', label: 'Winner SF1' },
      away: { team: 'KBU', label: 'Winner SF2' },
      duty: { team: 'BENCHIES', label: 'Loser SF2' },
    })
    const dashDuty = parseEventTitle(
      'GRAND FINAL &#8211; HIT FOR BRAINS (WINNER SF1) vs BENCHIES (WINNER SF2) &#8211; DUTY &#8211; SUPER 6 (LOSER SF2)',
    )
    expect(dashDuty).toMatchObject({ duty: { team: 'SUPER 6', label: 'Loser SF2' } })
    expect(parseEventTitle('SEMI FINAL 2 &#8211; KY &#038; CO (1ST) vs INNER WEST IBISES (4TH) &#8211; DUTY LOSER SF1')).toMatchObject({
      stageTitle: 'Semi Final 2',
      home: { team: 'KY & CO', label: '1st' },
      duty: { label: 'Loser SF1' },
    })
  })

  it('parses finals without a duty part', () => {
    expect(parseEventTitle('Semi Final &#8211; DOMO (2nd) vs INCLUSIVE LEARNERS (3rd)')).toMatchObject({
      stageTitle: 'Semi Final',
      duty: null,
    })
  })

  it('parses regular matches and their annotations', () => {
    expect(parseEventTitle('ICE COLD vs BACKCOURT LIBEROS')).toEqual({
      kind: 'match',
      stageTitle: null,
      home: { team: 'ICE COLD' },
      away: { team: 'BACKCOURT LIBEROS' },
      duty: null,
      notes: [],
    })
    expect(parseEventTitle('TWINKLE TOES vs FIRE FERRETS   ***EARLY SESSION***')).toMatchObject({
      away: { team: 'FIRE FERRETS' },
      notes: ['Early Session'],
    })
    expect(parseEventTitle('AIM BOT (AIM BOT DOUBLE HEADER) vs BIG DIG ENERGY')).toMatchObject({
      home: { team: 'AIM BOT' },
      away: { team: 'BIG DIG ENERGY' },
      notes: ['Aim Bot Double Header'],
    })
  })

  it('recognises byes and skipped weeks', () => {
    expect(parseEventTitle('BYE &#8211; ICE COLD')).toEqual({ kind: 'bye', teams: ['ICE COLD'] })
    expect(parseEventTitle('BYES &#8211; TOP SPIN &#038; RICE SPICE')).toEqual({ kind: 'bye', teams: ['TOP SPIN', 'RICE SPICE'] })
    expect(parseEventTitle('BYES &#8211; WILL WORK FOR SETS and HELLS KITCHEN')).toEqual({
      kind: 'bye',
      teams: ['WILL WORK FOR SETS', 'HELLS KITCHEN'],
    })
    expect(parseEventTitle('BYES &#8211; BENCHWARMERS (WINNER QF1) &#038; ICE BOT (WINNER QF2)')).toEqual({
      kind: 'bye',
      teams: ['BENCHWARMERS', 'ICE BOT'],
    })
    expect(parseEventTitle('*** NO MATCHES DUE TO COURT MAINTENANCE ***')).toEqual({
      kind: 'skip',
      note: 'NO MATCHES DUE TO COURT MAINTENANCE',
    })
    expect(parseEventTitle('** EASTER SUNDAY &#8211; NO MATCHES **')).toEqual({ kind: 'skip', note: 'EASTER SUNDAY – NO MATCHES' })
    expect(parseEventTitle('NO GAMES THIS WEEK')).toEqual({ kind: 'skip', note: 'NO GAMES THIS WEEK' })
  })
})

describe('isPlaceholderTeamName', () => {
  it('spots the SportsPress placeholder teams and leaves real names alone', () => {
    for (const n of ['BYE', 'Grand Final', '3rd Place', '3RD PLACE PLAYOFF', 'Semi Final 1', 'Winner SF1', 'LOSER GF', '2nd', 'TBC'])
      expect({ n, placeholder: isPlaceholderTeamName(n) }).toEqual({ n, placeholder: true })
    for (const n of ['ICE COLD', 'Byers', '3rd Degree Burns', 'WSF1 HIT FOR BRAINS', 'Finals Fever'])
      expect({ n, placeholder: isPlaceholderTeamName(n) }).toEqual({ n, placeholder: false })
  })
})
