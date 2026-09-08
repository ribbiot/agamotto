import { storedReviewUiState } from '../src/lib/stored-review-ui'

const blocking = {
  id: 'b-1',
  severity: 'BLOCKING' as const,
  category: 'CORRECTNESS',
  file: 'a.ts',
  title: 'missing check',
  body: 'add a check',
  confidence: 0.9,
}

const lowConfidence = {
  id: 'b-low',
  severity: 'BLOCKING' as const,
  category: 'CORRECTNESS',
  file: 'a.ts',
  title: 'hedged blocker',
  body: 'maybe not',
  confidence: 0.65,
}

const nit = {
  id: 'n-1',
  severity: 'NIT' as const,
  category: 'STYLE',
  file: 'a.ts',
  title: 'naming',
  body: 'rename',
  confidence: 0.5,
}

describe('storedReviewUiState', () => {
  it('returns null when there is no stored result', () => {
    expect(storedReviewUiState(null)).toBeNull()
    expect(storedReviewUiState(undefined)).toBeNull()
  })

  it('hydrates findings, default decisions, and a completed pipeline', () => {
    const state = storedReviewUiState({
      blockingIssues: [blocking, lowConfidence],
      suggestions: [],
      nits: [nit],
    })

    expect(state).not.toBeNull()
    expect(state!.status).toBe('done')
    expect(state!.isCachedReview).toBe(true)
    expect(state!.findings).toEqual([blocking, lowConfidence, nit])
    expect(state!.decisions).toEqual({
      'b-1': { findingId: 'b-1', accepted: true },
      'b-low': { findingId: 'b-low', accepted: false },
      'n-1': { findingId: 'n-1', accepted: false },
    })
    expect(state!.phaseStatuses).toEqual({
      INPUT: 'done',
      CONTEXT: 'done',
      DOMAIN: 'done',
      OUTPUT: 'done',
    })
    expect(state!.activity.map(a => a.text)).toEqual([
      '⚡ Loaded saved review',
      '🎉 Review complete',
    ])
  })

  it('treats missing finding arrays as empty', () => {
    const state = storedReviewUiState({})
    expect(state!.findings).toEqual([])
    expect(state!.decisions).toEqual({})
    expect(state!.status).toBe('done')
    expect(state!.postedToGitHub).toBe(false)
  })

  it('hydrates comment extras and section Include state', () => {
    const state = storedReviewUiState(
      {
        summary: 'Good PR',
        verdictSummary: 'Ship after nits.',
        whatLooksGood: ['Clear names'],
        testingRecommendations: ['Run npm test'],
        questions: ['Why this approach?'],
        ticketAlignment: [{ requirement: 'Save without posting', met: true }],
      },
      {
        sections: [
          { section: 'PREAMBLE', action: 'REJECT' },
          {
            section: 'WHAT_LOOKS_GOOD',
            action: 'EDIT',
            editedBody: 'Nice tests',
          },
        ],
      }
    )
    expect(state!.extras.summary).toBe('Good PR')
    expect(state!.sections.PREAMBLE.accepted).toBe(false)
    expect(state!.sections.WHAT_LOOKS_GOOD).toEqual({
      section: 'WHAT_LOOKS_GOOD',
      accepted: true,
      editedBody: 'Nice tests',
    })
    expect(state!.sections.TESTING_RECOMMENDATIONS.accepted).toBe(true)
    expect(state!.sections.QUESTIONS.accepted).toBe(true)
    expect(state!.sections.TICKET_ALIGNMENT.accepted).toBe(true)
    expect(state!.extras.questions).toEqual(['Why this approach?'])
  })

  it('overlays Include toggles from a saved submission', () => {
    const state = storedReviewUiState(
      {
        blockingIssues: [blocking, lowConfidence],
        suggestions: [],
        nits: [nit],
      },
      {
        postToGitHub: false,
        decisions: [
          { findingId: 'b-1', action: 'REJECT' },
          {
            findingId: 'b-low',
            action: 'EDIT',
            editedTitle: 'rewritten',
            editedBody: 'fixed body',
          },
          { findingId: 'n-1', action: 'ACCEPT' },
        ],
      }
    )
    expect(state!.decisions).toEqual({
      'b-1': { findingId: 'b-1', accepted: false },
      'b-low': {
        findingId: 'b-low',
        accepted: true,
        editedTitle: 'rewritten',
        editedBody: 'fixed body',
      },
      'n-1': { findingId: 'n-1', accepted: true },
    })
    expect(state!.postedToGitHub).toBe(false)
  })

  it('marks postedToGitHub when the submission was posted', () => {
    const state = storedReviewUiState(
      { blockingIssues: [blocking] },
      {
        postToGitHub: true,
        decisions: [{ findingId: 'b-1', action: 'ACCEPT' }],
      }
    )
    expect(state!.postedToGitHub).toBe(true)
    expect(state!.decisions['b-1'].accepted).toBe(true)
  })

  it('ignores submission rows without a usable action', () => {
    const state = storedReviewUiState(
      { blockingIssues: [blocking] },
      { decisions: [{ findingId: 'b-1', action: 'NOPE' }, { findingId: 1 }] }
    )
    expect(state!.decisions['b-1'].accepted).toBe(true)
  })
})
