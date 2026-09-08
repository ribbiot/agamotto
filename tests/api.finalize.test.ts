/**
 * Unit tests for POST /api/review/[id]/finalize
 *
 * Focuses on the paths changed in ATH-22:
 *   - setReviewSubmission failure → 500 (approve path)
 *   - setReviewSubmission failure → 500 (submit path)
 *
 * Also covers: 400 invalid JSON, 422 validation failure, 404 review not found,
 * 400 approve-with-findings, 400 empty-decisions guard.
 */

import { NextRequest } from 'next/server'
import {
  buildSubmission,
  formatGitHubComment,
} from '../src/agents/pr-review/approval'

// ── Mock review-store ─────────────────────────────────────────────────────────

const mockGetReview = jest.fn()
const mockSetReviewSubmission = jest.fn()

jest.mock('../src/memory/review-store', () => ({
  getReview: (...args: unknown[]) => mockGetReview(...args),
  setReviewSubmission: (...args: unknown[]) => mockSetReviewSubmission(...args),
}))

// ── Mock memory store (storeReview best-effort) ───────────────────────────────

const mockStoreReview = jest.fn().mockResolvedValue(undefined)

jest.mock('../src/memory/index', () => ({
  createMemoryStore: () => ({ storeReview: mockStoreReview }),
}))

// ── Mock Supabase server (getGitHubToken + service role for tracked_prs) ──────

jest.mock('../src/lib/supabase/server', () => ({
  getGitHubToken: jest.fn().mockResolvedValue(null),
  GH_TOKEN_COOKIE: 'gh_provider_token',
  GH_REFRESH_COOKIE: 'gh_provider_refresh_token',
}))

const mockGetFreshGitHubToken = jest.fn()
jest.mock('../src/lib/github-auth', () => {
  const actual = jest.requireActual(
    '../src/lib/github-auth'
  ) as typeof import('../src/lib/github-auth')
  return {
    ...actual,
    getFreshGitHubToken: (...args: unknown[]) =>
      mockGetFreshGitHubToken(...args),
  }
})

const mockMarkPrReviewed = jest.fn().mockResolvedValue(undefined)
jest.mock('../src/memory/tracked-pr-store', () => ({
  markPrReviewed: (...args: unknown[]) => mockMarkPrReviewed(...args),
}))

// ── Mock approval helpers ─────────────────────────────────────────────────────

jest.mock('../src/agents/pr-review/approval', () => ({
  buildSubmission: jest.fn().mockReturnValue({ postToGitHub: false }),
  formatGitHubComment: jest.fn().mockReturnValue('## Review\n'),
  formatApprovalComment: jest.fn().mockReturnValue('LGTM!'),
}))

// ── Mock Octokit (comment posting) ────────────────────────────────────────────

const mockCreateComment = jest.fn()
const mockCreateOctokit = jest.fn().mockReturnValue(null)

jest.mock('../src/tools/github', () => ({
  createOctokit: (...args: unknown[]) => mockCreateOctokit(...args),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const REVIEW_ID = 'review-abc-123'
const PR_URL = 'https://github.com/atharrison/gauntlet-harness/pull/18'

function makeCompleteReview(findings = false) {
  return {
    status: 'COMPLETE',
    pr_url: PR_URL,
    result: {
      summary: 'Test review summary',
      blockingIssues: findings
        ? [{ id: 'f1', title: 'Bug', severity: 'BLOCKING' }]
        : [],
      suggestions: [],
      nits: [],
    },
  }
}

async function callFinalize(reviewId: string, body: unknown) {
  const { POST } = await import('../app/api/review/[id]/finalize/route')
  const req = new NextRequest(
    `http://localhost/api/review/${reviewId}/finalize`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }
  )
  return POST(req, { params: Promise.resolve({ id: reviewId }) })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()
  mockMarkPrReviewed.mockResolvedValue(undefined)
  mockStoreReview.mockResolvedValue(undefined)
  mockCreateOctokit.mockReturnValue(null)
  mockGetFreshGitHubToken.mockResolvedValue({
    ok: false,
    error: 'NO_SESSION',
  })
  delete process.env.DRY_RUN
})

describe('POST /api/review/[id]/finalize — input validation', () => {
  it('returns 400 for invalid JSON body', async () => {
    const { POST } = await import('../app/api/review/[id]/finalize/route')
    const req = new NextRequest(
      `http://localhost/api/review/${REVIEW_ID}/finalize`,
      {
        method: 'POST',
        body: 'not-json',
        headers: { 'Content-Type': 'text/plain' },
      }
    )
    const res = await POST(req, { params: Promise.resolve({ id: REVIEW_ID }) })
    expect(res.status).toBe(400)
  })

  it('returns 422 for schema validation failure', async () => {
    const res = await callFinalize(REVIEW_ID, { decisions: 'bad' })
    expect(res.status).toBe(422)
  })

  it('returns 500 when getReview throws', async () => {
    mockGetReview.mockRejectedValue(new Error('db down'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await callFinalize(REVIEW_ID, { decisions: [], approve: true })
    expect(res.status).toBe(500)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('returns 404 when review not found', async () => {
    mockGetReview.mockResolvedValue(null)
    const res = await callFinalize(REVIEW_ID, { decisions: [], approve: true })
    expect(res.status).toBe(404)
  })

  it('returns 400 when approve=true but review has findings', async () => {
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    const res = await callFinalize(REVIEW_ID, { decisions: [], approve: true })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/approve/i)
  })

  it('returns 400 when submit path has empty decisions and review has findings', async () => {
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    const res = await callFinalize(REVIEW_ID, { decisions: [] })
    expect(res.status).toBe(400)
  })

  it('returns 400 when submit path has empty decisions on a clean review', async () => {
    mockGetReview.mockResolvedValue(makeCompleteReview(false))
    const res = await callFinalize(REVIEW_ID, { decisions: [] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/approve:true/)
  })
})

describe('POST /api/review/[id]/finalize — approve path', () => {
  it('returns 200 on successful clean approval', async () => {
    mockGetReview.mockResolvedValue(makeCompleteReview(false))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    const res = await callFinalize(REVIEW_ID, { approve: true, decisions: [] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('approved')
    expect(mockMarkPrReviewed).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'atharrison',
        repo: 'gauntlet-harness',
        pr_number: 18,
      }),
      REVIEW_ID
    )
  })

  it('returns 500 when setReviewSubmission throws (approve path)', async () => {
    mockGetReview.mockResolvedValue(makeCompleteReview(false))
    mockSetReviewSubmission.mockRejectedValue(new Error('DB write failed'))
    const res = await callFinalize(REVIEW_ID, { approve: true, decisions: [] })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/persist/i)
    expect(mockMarkPrReviewed).not.toHaveBeenCalled()
  })
})

describe('POST /api/review/[id]/finalize — submit path', () => {
  const decisions = [{ findingId: 'f1', action: 'ACCEPT' }]

  it('returns 200 on successful findings submission', async () => {
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    const res = await callFinalize(REVIEW_ID, { decisions })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('finalized')
    expect(mockMarkPrReviewed).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'atharrison',
        repo: 'gauntlet-harness',
        pr_number: 18,
      }),
      REVIEW_ID
    )
  })

  it('returns 500 when setReviewSubmission throws (submit path)', async () => {
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    mockSetReviewSubmission.mockRejectedValue(new Error('Supabase timeout'))
    const res = await callFinalize(REVIEW_ID, { decisions })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/persist/i)
    expect(mockMarkPrReviewed).not.toHaveBeenCalled()
  })

  it('still returns 200 when markPrReviewed fails (best-effort)', async () => {
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    mockMarkPrReviewed.mockRejectedValue(new Error('db down'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await callFinalize(REVIEW_ID, { decisions })
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('still returns 200 when storeReview fails (best-effort)', async () => {
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    mockStoreReview.mockRejectedValue(new Error('history write failed'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await callFinalize(REVIEW_ID, { decisions })
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('skips GitHub comment when postComment is true but Octokit is unavailable', async () => {
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    const res = await callFinalize(REVIEW_ID, {
      decisions,
      postComment: true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.comment).toEqual({
      skipped: true,
      reason: 'GITHUB_TOKEN not configured',
      body: '## Review\n',
    })
  })
})

describe('POST /api/review/[id]/finalize — GitHub comment + tracked_prs edges', () => {
  it('does not call markPrReviewed when prUrl is not a GitHub PR', async () => {
    const review = makeCompleteReview(false)
    review.pr_url = 'https://example.com/not-a-pr'
    mockGetReview.mockResolvedValue(review)
    mockSetReviewSubmission.mockResolvedValue(undefined)
    mockCreateOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    })
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await callFinalize(REVIEW_ID, {
      approve: true,
      decisions: [],
      postComment: true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(mockMarkPrReviewed).not.toHaveBeenCalled()
    expect(body.comment).toEqual({
      skipped: true,
      reason: 'Could not parse prUrl for GitHub API',
      body: 'LGTM!',
    })
    expect(body.warning).toMatch(/prUrl could not be parsed/)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('posts an approval comment on DRY_RUN without calling GitHub', async () => {
    process.env.DRY_RUN = 'true'
    mockCreateOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    })
    mockGetReview.mockResolvedValue(makeCompleteReview(false))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    const res = await callFinalize(REVIEW_ID, {
      approve: true,
      decisions: [],
      postComment: true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.comment).toEqual({ dryRun: true, body: 'LGTM!' })
    expect(mockCreateComment).not.toHaveBeenCalled()
  })

  it('posts a findings comment via Octokit on the submit path', async () => {
    mockCreateOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    })
    mockCreateComment.mockResolvedValue({
      data: { id: 99, html_url: 'https://github.com/comment/99' },
    })
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    const res = await callFinalize(REVIEW_ID, {
      decisions: [{ findingId: 'f1', action: 'ACCEPT' }],
      postComment: true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.comment).toEqual({
      id: 99,
      url: 'https://github.com/comment/99',
      body: '## Review\n',
    })
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'atharrison',
        repo: 'gauntlet-harness',
        issue_number: 18,
      })
    )
  })

  it('records a comment error when Octokit throws', async () => {
    mockCreateOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    })
    mockCreateComment.mockRejectedValue(new Error('rate limited'))
    mockGetReview.mockResolvedValue(makeCompleteReview(false))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await callFinalize(REVIEW_ID, {
      approve: true,
      decisions: [],
      postComment: true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.comment.error).toMatch(/rate limited/)
    expect(body.comment.body).toBe('LGTM!')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('does not post when GitHub token refresh fails (approve path)', async () => {
    const { GitHubAuthError, GITHUB_SESSION_EXPIRED_MESSAGE } =
      await import('../src/lib/github-auth')
    mockGetFreshGitHubToken.mockResolvedValue({
      ok: false,
      error: GitHubAuthError.REFRESH_FAILED,
    })
    mockGetReview.mockResolvedValue(makeCompleteReview(false))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await callFinalize(REVIEW_ID, {
      approve: true,
      decisions: [],
      postComment: true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.comment).toEqual({
      error: GITHUB_SESSION_EXPIRED_MESSAGE,
      body: 'LGTM!',
    })
    expect(mockCreateOctokit).not.toHaveBeenCalled()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('does not post when GitHub token refresh fails (submit path)', async () => {
    const { GitHubAuthError, GITHUB_SESSION_EXPIRED_MESSAGE } =
      await import('../src/lib/github-auth')
    mockGetFreshGitHubToken.mockResolvedValue({
      ok: false,
      error: GitHubAuthError.REFRESH_FAILED,
    })
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await callFinalize(REVIEW_ID, {
      decisions: [{ findingId: 'f1', action: 'ACCEPT' }],
      postComment: true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.comment).toEqual({
      error: GITHUB_SESSION_EXPIRED_MESSAGE,
      body: '## Review\n',
    })
    expect(mockCreateOctokit).not.toHaveBeenCalled()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('passes the refreshed token to Octokit', async () => {
    mockGetFreshGitHubToken.mockResolvedValue({
      ok: true,
      token: 'ghu_fresh',
    })
    mockCreateOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    })
    mockCreateComment.mockResolvedValue({
      data: { id: 7, html_url: 'https://github.com/comment/7' },
    })
    mockGetReview.mockResolvedValue(makeCompleteReview(false))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    const res = await callFinalize(REVIEW_ID, {
      approve: true,
      decisions: [],
      postComment: true,
    })
    expect(res.status).toBe(200)
    expect(mockCreateOctokit).toHaveBeenCalledWith('ghu_fresh')
  })

  it('persists postToGitHub=true only after GitHub accepts the comment', async () => {
    mockCreateOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    })
    mockCreateComment.mockResolvedValue({
      data: { id: 99, html_url: 'https://github.com/comment/99' },
    })
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    await callFinalize(REVIEW_ID, {
      decisions: [{ findingId: 'f1', action: 'ACCEPT' }],
      postComment: true,
    })
    expect(buildSubmission).toHaveBeenCalledWith(expect.anything(), true)
  })

  it('persists postToGitHub=false when the GitHub post fails', async () => {
    mockCreateOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    })
    mockCreateComment.mockRejectedValue(new Error('rate limited'))
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await callFinalize(REVIEW_ID, {
      decisions: [{ findingId: 'f1', action: 'ACCEPT' }],
      postComment: true,
    })
    spy.mockRestore()
    expect(buildSubmission).toHaveBeenCalledWith(expect.anything(), false)
  })

  it('persists postToGitHub=false when token refresh fails (save still happens)', async () => {
    const { GitHubAuthError } = await import('../src/lib/github-auth')
    mockGetFreshGitHubToken.mockResolvedValue({
      ok: false,
      error: GitHubAuthError.REFRESH_FAILED,
    })
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await callFinalize(REVIEW_ID, {
      decisions: [{ findingId: 'f1', action: 'ACCEPT' }],
      postComment: true,
    })
    spy.mockRestore()
    expect(buildSubmission).toHaveBeenCalledWith(expect.anything(), false)
  })

  it('persists postToGitHub=true for DRY_RUN posts', async () => {
    process.env.DRY_RUN = 'true'
    mockCreateOctokit.mockReturnValue({
      issues: { createComment: mockCreateComment },
    })
    mockGetReview.mockResolvedValue(makeCompleteReview(false))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    await callFinalize(REVIEW_ID, {
      approve: true,
      decisions: [],
      postComment: true,
    })
    expect(buildSubmission).toHaveBeenCalledWith(expect.anything(), true)
  })

  it('passes section decisions into formatGitHubComment', async () => {
    mockGetReview.mockResolvedValue(makeCompleteReview(true))
    mockSetReviewSubmission.mockResolvedValue(undefined)
    await callFinalize(REVIEW_ID, {
      decisions: [{ findingId: 'f1', action: 'ACCEPT' }],
      postComment: true,
      sections: [
        { section: 'PREAMBLE', action: 'REJECT' },
        {
          section: 'WHAT_LOOKS_GOOD',
          action: 'EDIT',
          editedBody: 'Nice tests',
        },
      ],
    })
    expect(formatGitHubComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sections: [
          { section: 'PREAMBLE', action: 'REJECT' },
          {
            section: 'WHAT_LOOKS_GOOD',
            action: 'EDIT',
            editedBody: 'Nice tests',
          },
        ],
      })
    )
  })
})
