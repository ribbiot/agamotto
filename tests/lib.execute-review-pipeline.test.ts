const mockRunReview = jest.fn()
const mockCreateReviewContext = jest.fn()
const mockCompleteReview = jest.fn()
const mockFailReview = jest.fn()
const mockMarkPrReady = jest.fn()
const mockMarkPrReviewFailed = jest.fn()
const mockLoadReviewSettings = jest.fn()

jest.mock('../src/agents/pr-review/coordinator', () => ({
  runReview: (...args: unknown[]) => mockRunReview(...args),
}))

jest.mock('../src/harness/context', () => ({
  createReviewContext: (...args: unknown[]) => mockCreateReviewContext(...args),
}))

jest.mock('../src/memory/review-store', () => ({
  completeReview: (...args: unknown[]) => mockCompleteReview(...args),
  failReview: (...args: unknown[]) => mockFailReview(...args),
}))

jest.mock('../src/memory/tracked-pr-store', () => ({
  markPrReady: (...args: unknown[]) => mockMarkPrReady(...args),
  markPrReviewFailed: (...args: unknown[]) => mockMarkPrReviewFailed(...args),
}))

jest.mock('../src/lib/conventions-store', () => ({
  loadReviewSettings: (...args: unknown[]) => mockLoadReviewSettings(...args),
}))

import {
  executeReviewPipeline,
  waitForInflightPipeline,
} from '../src/lib/execute-review-pipeline'

const REVIEW_ID = 'rev-inflight'
const PR_URL = 'https://github.com/acme/app/pull/7'

beforeEach(() => {
  jest.clearAllMocks()
  mockCreateReviewContext.mockReturnValue({})
  mockLoadReviewSettings.mockResolvedValue({
    conventionsDoc: undefined,
    overlays: {},
  })
  mockCompleteReview.mockResolvedValue(undefined)
  mockFailReview.mockResolvedValue(undefined)
  mockMarkPrReady.mockResolvedValue(undefined)
  mockMarkPrReviewFailed.mockResolvedValue(undefined)
  mockRunReview.mockResolvedValue({
    blockingIssues: [],
    suggestions: [],
    nits: [],
  })
})

describe('executeReviewPipeline', () => {
  it('reuses the in-flight promise for the same reviewId', async () => {
    let release: () => void = () => {}
    mockRunReview.mockReturnValue(
      new Promise(resolve => {
        release = () =>
          resolve({ blockingIssues: [], suggestions: [], nits: [] })
      })
    )

    const first = executeReviewPipeline({
      reviewId: REVIEW_ID,
      prUrl: PR_URL,
      mode: 'full',
      githubToken: 'ghu_a',
      emit: () => {},
    })
    const second = executeReviewPipeline({
      reviewId: REVIEW_ID,
      prUrl: PR_URL,
      mode: 'full',
      githubToken: 'ghu_b',
      emit: () => {},
    })

    expect(second).toBe(first)
    expect(waitForInflightPipeline(REVIEW_ID)).toBe(first)

    for (let i = 0; i < 20 && mockRunReview.mock.calls.length === 0; i++) {
      await Promise.resolve()
    }
    expect(mockRunReview).toHaveBeenCalledTimes(1)

    release()
    await first
    expect(waitForInflightPipeline(REVIEW_ID)).toBeUndefined()
  })

  it('logs when markPrReady fails after COMPLETE', async () => {
    mockMarkPrReady.mockRejectedValue(new Error('ready failed'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await executeReviewPipeline({
      reviewId: 'rev-ready',
      prUrl: PR_URL,
      mode: 'full',
      githubToken: 'ghu_a',
      emit: () => {},
    })
    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/markPrReady failed/),
      expect.any(Error)
    )
    spy.mockRestore()
  })

  it('skips queue failure updates when the PR URL does not parse', async () => {
    mockRunReview.mockRejectedValue(new Error('boom'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const emit = jest.fn()
    await executeReviewPipeline({
      reviewId: 'rev-bad-url',
      prUrl: 'https://example.com/not-a-pr',
      mode: 'full',
      githubToken: 'ghu_a',
      emit,
    })
    expect(mockMarkPrReviewFailed).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('error', expect.any(Object))
    spy.mockRestore()
  })

  it('swallows failReview errors after a pipeline throw', async () => {
    mockRunReview.mockRejectedValue(new Error('boom'))
    mockFailReview.mockRejectedValue(new Error('fail write'))
    mockMarkPrReviewFailed.mockRejectedValue(new Error('queue write'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const emit = jest.fn()
    await executeReviewPipeline({
      reviewId: 'rev-fail',
      prUrl: PR_URL,
      mode: 'full',
      githubToken: 'ghu_a',
      emit,
    })
    expect(emit).toHaveBeenCalledWith('error', {
      error: 'Review pipeline failed. Check server logs for details.',
    })
    spy.mockRestore()
  })
})
