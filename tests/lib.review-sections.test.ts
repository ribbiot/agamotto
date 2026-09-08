/**
 * ATH-29: preamble / what-looks-good / testing as include+edit sections.
 */

import {
  ReviewSection,
  defaultPreambleText,
  defaultListText,
  defaultAlignmentText,
  listItemsFromText,
  resolveSection,
  hydrateSectionUi,
  sectionDecisionsFromUi,
  extrasFromReview,
  sectionHasContent,
  displayedSectionText,
  findingShadeKey,
  sectionShadeKey,
  visibleReviewSections,
  reviewShadeKeys,
  collapsedShadeMap,
  allCardsCollapsed,
  IncludeAllState,
  includeAllState,
  type UiSectionDecision,
} from '../src/lib/review-sections'

describe('defaultPreambleText', () => {
  it('joins verdictSummary and summary with a blank line', () => {
    expect(
      defaultPreambleText({
        verdictSummary: 'Fix the blocker.',
        summary: 'Good PR overall.',
      })
    ).toBe('Fix the blocker.\n\nGood PR overall.')
  })

  it('omits blank parts', () => {
    expect(defaultPreambleText({ summary: 'Only summary' })).toBe(
      'Only summary'
    )
    expect(defaultPreambleText({ verdictSummary: 'Only verdict' })).toBe(
      'Only verdict'
    )
    expect(defaultPreambleText({})).toBe('')
  })
})

describe('defaultListText / listItemsFromText', () => {
  it('joins list items with newlines', () => {
    expect(defaultListText(['Clean names', 'Tests'])).toBe('Clean names\nTests')
  })

  it('strips markdown bullets when parsing edited text', () => {
    expect(listItemsFromText('- Clean names\n* Tests\n\nKeep going')).toEqual([
      'Clean names',
      'Tests',
      'Keep going',
    ])
  })
})

describe('defaultAlignmentText', () => {
  it('formats met and unmet requirements', () => {
    expect(
      defaultAlignmentText([
        {
          requirement: 'Save without posting',
          met: true,
          location: 'finalize',
        },
        { requirement: 'Auto-start on webhook', met: false },
      ])
    ).toBe('[x] Save without posting — finalize\n[ ] Auto-start on webhook')
  })

  it('omits blank requirements', () => {
    expect(defaultAlignmentText([{ requirement: '  ', met: true }])).toBe('')
  })
})

describe('resolveSection', () => {
  const text = 'Fix the blocker.\n\nGood PR.'

  it('includes non-empty default text when there is no decision', () => {
    expect(resolveSection(ReviewSection.PREAMBLE, text, undefined)).toEqual({
      included: true,
      text,
    })
  })

  it('omits empty default text when there is no decision', () => {
    expect(resolveSection(ReviewSection.PREAMBLE, '', undefined)).toEqual({
      included: false,
      text: '',
    })
  })

  it('omits the section when REJECT', () => {
    expect(
      resolveSection(ReviewSection.PREAMBLE, text, [
        { section: ReviewSection.PREAMBLE, action: 'REJECT' },
      ])
    ).toEqual({ included: false, text })
  })

  it('uses editedBody when EDIT', () => {
    expect(
      resolveSection(ReviewSection.WHAT_LOOKS_GOOD, 'old', [
        {
          section: ReviewSection.WHAT_LOOKS_GOOD,
          action: 'EDIT',
          editedBody: 'rewritten',
        },
      ])
    ).toEqual({ included: true, text: 'rewritten' })
  })

  it('uses default text when EDIT has no editedBody', () => {
    expect(
      resolveSection(ReviewSection.PREAMBLE, text, [
        { section: ReviewSection.PREAMBLE, action: 'EDIT' },
      ])
    ).toEqual({ included: true, text })
  })

  it('treats blank EDIT editedBody as the default text', () => {
    expect(
      resolveSection(ReviewSection.PREAMBLE, text, [
        {
          section: ReviewSection.PREAMBLE,
          action: 'EDIT',
          editedBody: '   ',
        },
      ])
    ).toEqual({ included: true, text })
    expect(
      resolveSection(ReviewSection.PREAMBLE, text, [
        {
          section: ReviewSection.PREAMBLE,
          action: 'EDIT',
          editedBody: '',
        },
      ])
    ).toEqual({ included: true, text })
  })

  it('excludes ACCEPT when default text is empty', () => {
    expect(
      resolveSection(ReviewSection.PREAMBLE, '', [
        { section: ReviewSection.PREAMBLE, action: 'ACCEPT' },
      ])
    ).toEqual({ included: false, text: '' })
  })
})

describe('hydrateSectionUi / sectionDecisionsFromUi', () => {
  const extras = {
    summary: 'Good PR',
    verdictSummary: 'Ship after nits.',
    whatLooksGood: ['Clear names'],
    testingRecommendations: ['Run npm test'],
    questions: ['Why this approach?'],
    ticketAlignment: [
      { requirement: 'Save without posting', met: true, location: 'finalize' },
    ],
  }

  it('defaults every non-empty section to included', () => {
    const ui = hydrateSectionUi(extras)
    expect(ui[ReviewSection.PREAMBLE]).toEqual({
      section: ReviewSection.PREAMBLE,
      accepted: true,
    })
    expect(ui[ReviewSection.WHAT_LOOKS_GOOD].accepted).toBe(true)
    expect(ui[ReviewSection.TESTING_RECOMMENDATIONS].accepted).toBe(true)
    expect(ui[ReviewSection.QUESTIONS].accepted).toBe(true)
    expect(ui[ReviewSection.TICKET_ALIGNMENT].accepted).toBe(true)
  })

  it('defaults empty sections to excluded', () => {
    const ui = hydrateSectionUi({ summary: 'Only preamble' })
    expect(ui[ReviewSection.PREAMBLE].accepted).toBe(true)
    expect(ui[ReviewSection.WHAT_LOOKS_GOOD].accepted).toBe(false)
    expect(ui[ReviewSection.TESTING_RECOMMENDATIONS].accepted).toBe(false)
    expect(ui[ReviewSection.QUESTIONS].accepted).toBe(false)
    expect(ui[ReviewSection.TICKET_ALIGNMENT].accepted).toBe(false)
  })

  it('overlays saved submission decisions', () => {
    const ui = hydrateSectionUi(extras, {
      sections: [
        { section: 'PREAMBLE', action: 'REJECT' },
        {
          section: 'WHAT_LOOKS_GOOD',
          action: 'EDIT',
          editedBody: 'Nice tests',
        },
        { section: 'TESTING_RECOMMENDATIONS', action: 'REJECT' },
        { section: 'QUESTIONS', action: 'REJECT' },
        { section: 'TICKET_ALIGNMENT', action: 'REJECT' },
      ],
    })
    expect(ui[ReviewSection.PREAMBLE].accepted).toBe(false)
    expect(ui[ReviewSection.WHAT_LOOKS_GOOD]).toEqual({
      section: ReviewSection.WHAT_LOOKS_GOOD,
      accepted: true,
      editedBody: 'Nice tests',
    })
    expect(ui[ReviewSection.TESTING_RECOMMENDATIONS].accepted).toBe(false)
    expect(ui[ReviewSection.QUESTIONS].accepted).toBe(false)
    expect(ui[ReviewSection.TICKET_ALIGNMENT].accepted).toBe(false)
  })

  it('ignores junk section rows and non-object submissions', () => {
    expect(
      hydrateSectionUi(extras, null)[ReviewSection.PREAMBLE].accepted
    ).toBe(true)
    expect(hydrateSectionUi(extras, [])[ReviewSection.PREAMBLE].accepted).toBe(
      true
    )
    const ui = hydrateSectionUi(extras, {
      sections: [
        null,
        ['nope'],
        { section: 'UNKNOWN', action: 'ACCEPT' },
        { section: 'PREAMBLE', action: 'NOPE' },
        { section: 'PREAMBLE', action: 'ACCEPT' },
      ],
    })
    expect(ui[ReviewSection.PREAMBLE].accepted).toBe(true)
  })

  it('keeps defaults for sections omitted from a valid overlay', () => {
    const ui = hydrateSectionUi(extras, {
      sections: [{ section: 'WHAT_LOOKS_GOOD', action: 'REJECT' }],
    })
    expect(ui[ReviewSection.PREAMBLE].accepted).toBe(true)
    expect(ui[ReviewSection.WHAT_LOOKS_GOOD].accepted).toBe(false)
    expect(ui[ReviewSection.TESTING_RECOMMENDATIONS].accepted).toBe(true)
  })

  it('maps UI include/edit state into finalize section decisions', () => {
    expect(
      sectionDecisionsFromUi({
        [ReviewSection.PREAMBLE]: {
          section: ReviewSection.PREAMBLE,
          accepted: false,
        },
        [ReviewSection.WHAT_LOOKS_GOOD]: {
          section: ReviewSection.WHAT_LOOKS_GOOD,
          accepted: true,
          editedBody: 'Nice tests',
        },
        [ReviewSection.TESTING_RECOMMENDATIONS]: {
          section: ReviewSection.TESTING_RECOMMENDATIONS,
          accepted: true,
        },
        [ReviewSection.TICKET_ALIGNMENT]: {
          section: ReviewSection.TICKET_ALIGNMENT,
          accepted: true,
        },
        [ReviewSection.QUESTIONS]: {
          section: ReviewSection.QUESTIONS,
          accepted: false,
        },
      })
    ).toEqual([
      { section: ReviewSection.PREAMBLE, action: 'REJECT' },
      { section: ReviewSection.TICKET_ALIGNMENT, action: 'ACCEPT' },
      {
        section: ReviewSection.WHAT_LOOKS_GOOD,
        action: 'EDIT',
        editedBody: 'Nice tests',
      },
      { section: ReviewSection.QUESTIONS, action: 'REJECT' },
      {
        section: ReviewSection.TESTING_RECOMMENDATIONS,
        action: 'ACCEPT',
      },
    ])
  })

  it('fills missing UI keys from empty defaults', () => {
    const decisions = sectionDecisionsFromUi({
      [ReviewSection.PREAMBLE]: {
        section: ReviewSection.PREAMBLE,
        accepted: true,
      },
    } as Record<ReviewSection, UiSectionDecision>)
    expect(
      decisions.find(d => d.section === ReviewSection.WHAT_LOOKS_GOOD)
    ).toEqual({
      section: ReviewSection.WHAT_LOOKS_GOOD,
      action: 'REJECT',
    })
  })
})

describe('extrasFromReview', () => {
  it('picks the comment fields a live done event needs', () => {
    expect(
      extrasFromReview({
        summary: 'Good PR',
        verdict: 'COMMENT',
        verdictSummary: 'A few nits',
        whatLooksGood: ['Tests'],
        testingRecommendations: ['Run npm test'],
        questions: ['Why this approach?'],
        ticketAlignment: [
          {
            requirement: 'Save without posting',
            met: true,
            location: 'finalize',
          },
          { requirement: 'skip me' },
          { requirement: '  ', met: true },
          { requirement: 'Whitespace loc', met: false, location: '  ' },
          [],
          null,
        ],
      })
    ).toEqual({
      summary: 'Good PR',
      verdict: 'COMMENT',
      verdictSummary: 'A few nits',
      whatLooksGood: ['Tests'],
      testingRecommendations: ['Run npm test'],
      questions: ['Why this approach?'],
      ticketAlignment: [
        {
          requirement: 'Save without posting',
          met: true,
          location: 'finalize',
        },
        { requirement: 'Whitespace loc', met: false },
      ],
    })
  })

  it('keeps only string list items', () => {
    expect(
      extrasFromReview({
        whatLooksGood: ['ok', 1, null],
        testingRecommendations: ['run tests', false],
        questions: ['keep', 2],
      })
    ).toEqual({
      whatLooksGood: ['ok'],
      testingRecommendations: ['run tests'],
      questions: ['keep'],
    })
  })

  it('returns an empty extras object for junk payloads', () => {
    expect(extrasFromReview(null)).toEqual({})
    expect(extrasFromReview('nope')).toEqual({})
    expect(extrasFromReview(['x'])).toEqual({})
    expect(
      extrasFromReview({
        verdict: 'NOPE',
        verdictSummary: 12,
        whatLooksGood: 'nope',
        testingRecommendations: { x: 1 },
        questions: { q: 1 },
        ticketAlignment: 'nope',
      })
    ).toEqual({})
    expect(extrasFromReview({ ticketAlignment: [] })).toEqual({})
  })
})

describe('sectionHasContent / displayedSectionText', () => {
  const extras = {
    summary: 'Good PR',
    whatLooksGood: ['Clear names'],
  }

  it('is true when generated or edited text exists', () => {
    expect(sectionHasContent(ReviewSection.PREAMBLE, extras)).toBe(true)
    expect(sectionHasContent(ReviewSection.WHAT_LOOKS_GOOD, extras)).toBe(true)
    expect(sectionHasContent(ReviewSection.QUESTIONS, extras)).toBe(false)
    expect(sectionHasContent(ReviewSection.TICKET_ALIGNMENT, extras)).toBe(
      false
    )
    expect(
      sectionHasContent(ReviewSection.TESTING_RECOMMENDATIONS, extras)
    ).toBe(false)
    expect(
      sectionHasContent(ReviewSection.TESTING_RECOMMENDATIONS, extras, {
        section: ReviewSection.TESTING_RECOMMENDATIONS,
        accepted: true,
        editedBody: 'added later',
      })
    ).toBe(true)
  })

  it('prefers edited body for display', () => {
    expect(
      displayedSectionText(ReviewSection.PREAMBLE, extras, {
        section: ReviewSection.PREAMBLE,
        accepted: true,
        editedBody: 'rewritten',
      })
    ).toBe('rewritten')
    expect(displayedSectionText(ReviewSection.PREAMBLE, extras)).toBe('Good PR')
    expect(displayedSectionText(ReviewSection.WHAT_LOOKS_GOOD, extras)).toBe(
      'Clear names'
    )
    expect(
      displayedSectionText(ReviewSection.TESTING_RECOMMENDATIONS, extras)
    ).toBe('')
    expect(
      displayedSectionText(ReviewSection.TICKET_ALIGNMENT, {
        ticketAlignment: [
          {
            requirement: 'Save without posting',
            met: true,
            location: 'finalize',
          },
        ],
      })
    ).toBe('[x] Save without posting — finalize')
    expect(
      displayedSectionText(ReviewSection.QUESTIONS, {
        questions: ['Why this approach?'],
      })
    ).toBe('Why this approach?')
  })
})

describe('shade keys / include-all', () => {
  it('builds finding and section shade keys', () => {
    expect(findingShadeKey('abc')).toBe('finding:abc')
    expect(sectionShadeKey(ReviewSection.PREAMBLE)).toBe('section:PREAMBLE')
  })

  it('lists visible sections and their shade keys', () => {
    const extras = {
      summary: 'Preamble body',
      whatLooksGood: ['Tests'],
    }
    const sections = hydrateSectionUi(extras)
    expect(visibleReviewSections(extras, sections)).toEqual([
      ReviewSection.PREAMBLE,
      ReviewSection.WHAT_LOOKS_GOOD,
    ])
    expect(
      reviewShadeKeys(['f1'], visibleReviewSections(extras, sections))
    ).toEqual(['finding:f1', 'section:PREAMBLE', 'section:WHAT_LOOKS_GOOD'])
  })

  it('collapses every card key and detects the all-collapsed state', () => {
    const keys = ['finding:f1', 'section:PREAMBLE']
    const collapsed = collapsedShadeMap(keys)
    expect(collapsed).toEqual({ 'finding:f1': true, 'section:PREAMBLE': true })
    expect(allCardsCollapsed(collapsed, keys)).toBe(true)
    expect(allCardsCollapsed({}, keys)).toBe(false)
    expect(allCardsCollapsed(collapsed, [])).toBe(false)
  })

  it('classifies include-all from finding and section flags', () => {
    expect(includeAllState([])).toBe(IncludeAllState.NONE)
    expect(includeAllState([false, false])).toBe(IncludeAllState.NONE)
    expect(includeAllState([true, true])).toBe(IncludeAllState.ALL)
    expect(includeAllState([true, false])).toBe(IncludeAllState.MIXED)
  })
})
