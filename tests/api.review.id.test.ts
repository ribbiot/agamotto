/**
 * GET /api/review/[id] — ATH-30 durable replay from the reviews table.
 *
 * Completing a review and leaving /review/[id] used to lose the output: the
 * SSE route required ?prUrl= before it even looked at the DB. View Review
 * links from the queue omit that query param, so COMPLETE rows must replay
 * from stored result + pr_url.
 */

import { NextRequest } from 'next/server'

const mockGetReview = jest.fn()
const mockCreateReview = jest.fn()
const mockCompleteReview = jest.fn()
const mockFailReview = jest.fn()
const mockMarkPrReviewFailed = jest.fn()
const mockMarkPrReady = jest.fn()
const mockRunReview = jest.fn()
const mockCreateReviewContext = jest.fn()
const mockGetGitHubToken = jest.fn()
const mockGetFreshGitHubToken = jest.fn()
const mockLoadReviewSettings = jest.fn()

jest.mock('../src/memory/review-store', () => ({
  getReview: (...args: unknown[]) => mockGetReview(...args),
  createReview: (...args: unknown[]) => mockCreateReview(...args),
  completeReview: (...args: unknown[]) => mockCompleteReview(...args),
  failReview: (...args: unknown[]) => mockFailReview(...args),
}))

jest.mock('../src/agents/pr-review/coordinator', () => ({
  runReview: (...args: unknown[]) => mockRunReview(...args),
}))

jest.mock('../src/harness/context', () => ({
  createReviewContext: (...args: unknown[]) => mockCreateReviewContext(...args),
}))

jest.mock('../src/lib/supabase/server', () => ({
  getGitHubToken: (...args: unknown[]) => mockGetGitHubToken(...args),
}))

jest.mock('../src/lib/github-auth', () => ({
  getFreshGitHubToken: (...args: unknown[]) => mockGetFreshGitHubToken(...args),
  githubTokenFromFresh: (fresh: { ok: boolean; token?: string }) =>
    fresh.ok ? (fresh.token ?? null) : null,
}))

jest.mock('../src/memory/tracked-pr-store', () => ({
  markPrReviewFailed: (...args: unknown[]) => mockMarkPrReviewFailed(...args),
  markPrReady: (...args: unknown[]) => mockMarkPrReady(...args),
}))

jest.mock('../src/lib/conventions-store', () => ({
  loadReviewSettings: (...args: unknown[]) => mockLoadReviewSettings(...args),
}))

const REVIEW_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const PR_URL = 'https://github.com/acme/app/pull/42'

const COMPLETE_RESULT = {
  blockingIssues: [
    {
      id: 'f-1',
      severity: 'BLOCKING',
      title: 'missing auth check',
    },
  ],
  suggestions: [],
  nits: [],
}

function completeRow() {
  return {
    id: REVIEW_ID,
    pr_url: PR_URL,
    status: 'COMPLETE',
    result: COMPLETE_RESULT,
  }
}

async function getReviewStream(query: string) {
  const { GET } = await import('../app/api/review/[id]/route')
  const req = new NextRequest(
    `http://localhost/api/review/${REVIEW_ID}${query}`
  )
  const res = await GET(req, { params: Promise.resolve({ id: REVIEW_ID }) })
  const text = await res.text()
  return { res, text }
}

function eventsOfType(text: string, type: string): unknown[] {
  const blocks = text.split('\n\n').filter(Boolean)
  const out: unknown[] = []
  for (const block of blocks) {
    const eventMatch = block.match(/^event: (.+)$/m)
    const dataMatch = block.match(/^data: (.+)$/m)
    if (eventMatch?.[1] === type && dataMatch?.[1]) {
      out.push(JSON.parse(dataMatch[1]))
    }
  }
  return out
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetReview.mockResolvedValue(null)
  mockCreateReview.mockResolvedValue(undefined)
  mockCompleteReview.mockResolvedValue(undefined)
  mockFailReview.mockResolvedValue(undefined)
  mockMarkPrReviewFailed.mockResolvedValue(undefined)
  mockMarkPrReady.mockResolvedValue(undefined)
  mockRunReview.mockResolvedValue(COMPLETE_RESULT)
  mockCreateReviewContext.mockReturnValue({})
  mockGetGitHubToken.mockResolvedValue(null)
  mockGetFreshGitHubToken.mockResolvedValue({
    ok: false,
    error: 'NO_SESSION',
  })
  mockLoadReviewSettings.mockResolvedValue({
    conventionsDoc: undefined,
    overlays: {},
  })
})

describe('GET /api/review/[id] — ATH-30 stored replay', () => {
  it('replays a COMPLETE review from the DB when prUrl is omitted', async () => {
    mockGetReview.mockResolvedValue(completeRow())

    const { res, text } = await getReviewStream('')

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(mockRunReview).not.toHaveBeenCalled()
    expect(mockCreateReview).not.toHaveBeenCalled()

    const connected = eventsOfType(text, 'connected')
    expect(
      connected.some(e => (e as { cached?: boolean }).cached === true)
    ).toBe(true)
    expect(eventsOfType(text, 'finding')).toEqual([
      { finding: COMPLETE_RESULT.blockingIssues[0] },
    ])
    expect(eventsOfType(text, 'done')).toEqual([
      { reviewId: REVIEW_ID, extras: {} },
    ])
  })

  it('errors when prUrl is omitted and no COMPLETE row exists', async () => {
    mockGetReview.mockResolvedValue(null)

    const { text } = await getReviewStream('')

    expect(mockRunReview).not.toHaveBeenCalled()
    expect(eventsOfType(text, 'error')).toEqual([
      { error: 'prUrl query param is required' },
    ])
    expect(eventsOfType(text, 'done')).toEqual([{ reviewId: REVIEW_ID }])
  })

  it('does not re-run the pipeline for a stored ERROR review', async () => {
    mockGetReview.mockResolvedValue({
      id: REVIEW_ID,
      pr_url: PR_URL,
      status: 'ERROR',
      result: null,
    })

    const { text } = await getReviewStream('')

    expect(mockRunReview).not.toHaveBeenCalled()
    expect(mockMarkPrReviewFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'app',
        pr_number: 42,
      })
    )
    expect(eventsOfType(text, 'error')).toEqual([
      { error: 'Review failed. Check server logs for details.' },
    ])
    expect(eventsOfType(text, 'stats')).toEqual([])
  })

  it('replays token-budget overage stats for a stored TokenBudgetError', async () => {
    mockGetReview.mockResolvedValue({
      id: REVIEW_ID,
      pr_url: PR_URL,
      status: 'ERROR',
      result: null,
      error_message: 'TokenBudgetError: Token budget exceeded: 167123 > 150000',
    })

    const { text } = await getReviewStream('')

    expect(mockRunReview).not.toHaveBeenCalled()
    expect(mockMarkPrReviewFailed).toHaveBeenCalled()
    expect(eventsOfType(text, 'stats')).toEqual([
      {
        tokensUsed: 167123,
        maxTokens: 150000,
        findingsCount: 0,
        phaseDurations: {},
      },
    ])
    expect(eventsOfType(text, 'error')).toEqual([
      {
        error:
          'Token budget exceeded: 167,123 used of 150,000 (over by 17,123).',
      },
    ])
  })
})

describe('GET /api/review/[id] — live pipeline', () => {
  it('creates a row and runs the pipeline when nothing is stored', async () => {
    mockGetReview.mockResolvedValue(null)

    const { text } = await getReviewStream(
      `?prUrl=${encodeURIComponent(PR_URL)}`
    )

    expect(mockCreateReview).toHaveBeenCalledWith(REVIEW_ID, PR_URL, 'full')
    expect(mockGetFreshGitHubToken).toHaveBeenCalled()
    expect(mockCreateReviewContext).toHaveBeenCalledWith(undefined, null)
    expect(mockRunReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: REVIEW_ID, prUrl: PR_URL })
    )
    expect(mockCompleteReview).toHaveBeenCalledWith(REVIEW_ID, COMPLETE_RESULT)
    expect(mockMarkPrReady).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'app',
        pr_number: 42,
      }),
      REVIEW_ID
    )
    expect(eventsOfType(text, 'error')).toEqual([])
  })

  it('does not mark READY when completeReview fails', async () => {
    mockGetReview.mockResolvedValue(null)
    mockCompleteReview.mockRejectedValue(new Error('write failed'))

    await getReviewStream(`?prUrl=${encodeURIComponent(PR_URL)}`)

    expect(mockCompleteReview).toHaveBeenCalled()
    expect(mockMarkPrReady).not.toHaveBeenCalled()
  })

  it('logs when parsePrUrl is null so READY is not skipped silently', async () => {
    mockGetReview.mockResolvedValue(null)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const badUrl = 'https://example.com/not-a-github-pr'

    await getReviewStream(`?prUrl=${encodeURIComponent(badUrl)}`)

    expect(mockCompleteReview).toHaveBeenCalled()
    expect(mockMarkPrReady).not.toHaveBeenCalled()
    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/parsePrUrl returned null/),
      badUrl
    )
    spy.mockRestore()
  })

  it('passes a refreshed GitHub token into the review context', async () => {
    mockGetReview.mockResolvedValue(null)
    mockGetFreshGitHubToken.mockResolvedValue({
      ok: true,
      token: 'ghu_fresh',
    })

    await getReviewStream(`?prUrl=${encodeURIComponent(PR_URL)}`)

    expect(mockCreateReviewContext).toHaveBeenCalledWith(undefined, 'ghu_fresh')
  })

  it('skips createReview when a RUNNING row already exists', async () => {
    mockGetReview.mockResolvedValue({
      id: REVIEW_ID,
      pr_url: PR_URL,
      status: 'RUNNING',
      result: null,
    })

    await getReviewStream(`?prUrl=${encodeURIComponent(PR_URL)}`)

    expect(mockCreateReview).not.toHaveBeenCalled()
    expect(mockRunReview).toHaveBeenCalled()
  })

  it('emits an init error when createReview fails', async () => {
    mockGetReview.mockResolvedValue(null)
    mockCreateReview.mockRejectedValue(new Error('insert failed'))

    const { text } = await getReviewStream(
      `?prUrl=${encodeURIComponent(PR_URL)}`
    )

    expect(mockRunReview).not.toHaveBeenCalled()
    expect(eventsOfType(text, 'error')).toEqual([
      {
        error:
          'Failed to initialize review — database write error. Check server logs for details.',
      },
    ])
  })

  it('marks the review failed when runReview throws', async () => {
    mockGetReview.mockResolvedValue(null)
    mockRunReview.mockRejectedValue(new Error('pipeline exploded'))

    const { text } = await getReviewStream(
      `?prUrl=${encodeURIComponent(PR_URL)}`
    )

    expect(mockFailReview).toHaveBeenCalledWith(
      REVIEW_ID,
      'Error: pipeline exploded'
    )
    expect(mockMarkPrReviewFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'app',
        pr_number: 42,
      })
    )
    expect(eventsOfType(text, 'error')).toEqual([
      { error: 'Review pipeline failed. Check server logs for details.' },
    ])
    expect(eventsOfType(text, 'stats')).toEqual([])
  })

  it('emits token overage stats when runReview throws TokenBudgetError', async () => {
    const { TokenBudgetError } = await import('../src/harness/loop')
    mockGetReview.mockResolvedValue(null)
    mockRunReview.mockRejectedValue(
      new TokenBudgetError(167123, 150000, 1.23456)
    )

    const { text } = await getReviewStream(
      `?prUrl=${encodeURIComponent(PR_URL)}`
    )

    expect(mockFailReview).toHaveBeenCalledWith(
      REVIEW_ID,
      'TokenBudgetError: Token budget exceeded: 167123 > 150000'
    )
    expect(mockMarkPrReviewFailed).toHaveBeenCalled()
    const stats = eventsOfType(text, 'stats')
    expect(stats).toHaveLength(1)
    expect(stats[0]).toMatchObject({
      tokensUsed: 167123,
      maxTokens: 150000,
      estimatedCostUsd: 1.2346,
      findingsCount: 0,
    })
    expect(
      (stats[0] as { durationMs?: number }).durationMs
    ).toBeGreaterThanOrEqual(0)
    expect(eventsOfType(text, 'error')).toEqual([
      {
        error:
          'Token budget exceeded: 167,123 used of 150,000 (over by 17,123).',
      },
    ])
  })

  it('treats a getReview throw as no stored row', async () => {
    mockGetReview.mockRejectedValue(new Error('db down'))

    const { text } = await getReviewStream('')

    expect(mockRunReview).not.toHaveBeenCalled()
    expect(eventsOfType(text, 'error')).toEqual([
      { error: 'prUrl query param is required' },
    ])
  })

  it('passes stored conventions and overlays into runReview', async () => {
    mockGetReview.mockResolvedValue(null)
    mockLoadReviewSettings.mockResolvedValue({
      conventionsDoc: 'Prefer named exports',
      overlays: { PERFORMANCE: 'Flag useEffect fetch' },
    })

    await getReviewStream(`?prUrl=${encodeURIComponent(PR_URL)}`)

    expect(mockLoadReviewSettings).toHaveBeenCalled()
    expect(mockRunReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: REVIEW_ID,
        conventionsDoc: 'Prefer named exports',
        overlays: { PERFORMANCE: 'Flag useEffect fetch' },
      })
    )
  })

  it('still runs the pipeline when settings lookup fails', async () => {
    mockGetReview.mockResolvedValue(null)
    mockLoadReviewSettings.mockRejectedValue(new Error('settings down'))

    await getReviewStream(`?prUrl=${encodeURIComponent(PR_URL)}`)

    expect(mockRunReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: REVIEW_ID,
        conventionsDoc: undefined,
        overlays: undefined,
      })
    )
  })
})
