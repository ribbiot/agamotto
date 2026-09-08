import { AutoStartDecision } from '../src/lib/auto-start'

const mockBegin = jest.fn().mockResolvedValue(undefined)
const mockExecute = jest.fn().mockResolvedValue(undefined)

jest.mock('../src/memory/begin-tracked-review', () => ({
  beginTrackedReview: (...args: unknown[]) => mockBegin(...args),
}))

jest.mock('../src/lib/execute-review-pipeline', () => ({
  executeReviewPipeline: (...args: unknown[]) => mockExecute(...args),
}))

import {
  discardReviewEmit,
  resetAutoStartedPrUrls,
  tryAutoStartOpenedReview,
} from '../src/lib/auto-start-review'

const PR_URL = 'https://github.com/acme/app/pull/42'

const originalAllowed = process.env.ALLOWED_GITHUB_USERS
const originalGithubToken = process.env.GITHUB_TOKEN

beforeEach(() => {
  jest.clearAllMocks()
  resetAutoStartedPrUrls()
  mockBegin.mockResolvedValue(undefined)
  mockExecute.mockResolvedValue(undefined)
  delete process.env.ALLOWED_GITHUB_USERS
  process.env.GITHUB_TOKEN = 'ghs_service'
})

afterAll(() => {
  if (originalAllowed === undefined) delete process.env.ALLOWED_GITHUB_USERS
  else process.env.ALLOWED_GITHUB_USERS = originalAllowed
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalGithubToken
})

describe('tryAutoStartOpenedReview', () => {
  it('exposes a no-op emit so webhook runs do not post or stream', () => {
    expect(() => discardReviewEmit('finding', { id: 'x' })).not.toThrow()
  })

  it('starts the pipeline with GITHUB_TOKEN and does not post', async () => {
    const decision = await tryAutoStartOpenedReview({
      prUrl: PR_URL,
      prAuthor: 'dev',
      existingStatus: null,
      lastReviewId: null,
    })

    expect(decision).toBe(AutoStartDecision.START)
    expect(mockBegin).toHaveBeenCalledWith(expect.any(String), PR_URL, 'full')
    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        prUrl: PR_URL,
        mode: 'full',
        githubToken: 'ghs_service',
      })
    )
  })

  it('logs when the detached pipeline rejects', async () => {
    mockExecute.mockRejectedValue(new Error('boom'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})

    await tryAutoStartOpenedReview({
      prUrl: PR_URL,
      prAuthor: 'dev',
      existingStatus: null,
      lastReviewId: null,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/pipeline failed/),
      expect.any(Error)
    )
    spy.mockRestore()
  })

  it('skips when GITHUB_TOKEN is unset', async () => {
    delete process.env.GITHUB_TOKEN

    const decision = await tryAutoStartOpenedReview({
      prUrl: PR_URL,
      prAuthor: 'dev',
      existingStatus: null,
      lastReviewId: null,
    })

    expect(decision).toBe(AutoStartDecision.SKIP_NO_TOKEN)
    expect(mockBegin).not.toHaveBeenCalled()
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('skips when a run is already IN_REVIEW', async () => {
    const decision = await tryAutoStartOpenedReview({
      prUrl: PR_URL,
      prAuthor: 'dev',
      existingStatus: 'IN_REVIEW',
      lastReviewId: 'rev-1',
    })

    expect(decision).toBe(AutoStartDecision.SKIP_IN_REVIEW)
    expect(mockBegin).not.toHaveBeenCalled()
  })

  it('skips when the author is not on ALLOWED_GITHUB_USERS', async () => {
    process.env.ALLOWED_GITHUB_USERS = 'alice'

    const decision = await tryAutoStartOpenedReview({
      prUrl: PR_URL,
      prAuthor: 'dev',
      existingStatus: null,
      lastReviewId: null,
    })

    expect(decision).toBe(AutoStartDecision.SKIP_AUTHOR_NOT_ALLOWED)
    expect(mockBegin).not.toHaveBeenCalled()
  })

  it('skips a second in-process start for the same PR URL', async () => {
    let release: () => void = () => {}
    mockBegin.mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve(undefined)
        })
    )

    const first = tryAutoStartOpenedReview({
      prUrl: PR_URL,
      prAuthor: 'dev',
      existingStatus: null,
      lastReviewId: null,
    })
    await Promise.resolve()
    await Promise.resolve()

    const second = await tryAutoStartOpenedReview({
      prUrl: PR_URL,
      prAuthor: 'dev',
      existingStatus: null,
      lastReviewId: null,
    })
    expect(second).toBe(AutoStartDecision.SKIP_ALREADY_STARTED)
    expect(mockBegin).toHaveBeenCalledTimes(1)

    release()
    await expect(first).resolves.toBe(AutoStartDecision.START)
  })
})
