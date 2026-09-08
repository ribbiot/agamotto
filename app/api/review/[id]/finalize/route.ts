import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  getReview,
  setReviewSubmission,
} from '../../../../../src/memory/review-store'
import { createMemoryStore } from '../../../../../src/memory/index'
import {
  formatGitHubComment,
  formatApprovalComment,
  buildSubmission,
} from '../../../../../src/agents/pr-review/approval'
import { createOctokit } from '../../../../../src/tools/github'
import { githubCommentPosted } from '../../../../../src/lib/finalize-comment'
import {
  GitHubAuthError,
  GITHUB_SESSION_EXPIRED_MESSAGE,
  getFreshGitHubToken,
  githubTokenFromFresh,
} from '../../../../../src/lib/github-auth'
import { githubLoginFromUser } from '../../../../../src/lib/github-users'
import { parsePrUrl } from '../../../../../src/lib/queue'
import { reviewHistoryMetadata } from '../../../../../src/lib/review-history-payload'
import { createSupabaseServerClient } from '../../../../../src/lib/supabase/server'
import { markPrReviewed } from '../../../../../src/memory/tracked-pr-store'
import {
  SectionDecisionSchema,
  type FindingDecision,
} from '../../../../../src/agents/pr-review/schema'

// ── Schemas ───────────────────────────────────────────────────────────────────

const FindingDecisionInput = z.object({
  findingId: z.string(),
  action: z.enum(['ACCEPT', 'REJECT', 'EDIT']),
  editedTitle: z.string().optional(),
  editedBody: z.string().optional(),
})

const FinalizeBody = z.object({
  decisions: z.array(FindingDecisionInput).default([]),
  sections: z.array(SectionDecisionSchema).optional(),
  postComment: z.boolean().default(false),
  approve: z.boolean().default(false),
})

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postGithubPrComment(opts: {
  sessionExpiredComment: { error: string } | null
  githubToken: string | null
  prUrlParts: RegExpMatchArray | null
  commentBody: string
}): Promise<unknown> {
  const withBody = (result: Record<string, unknown>) => ({
    ...result,
    body: opts.commentBody,
  })

  if (opts.sessionExpiredComment) {
    console.error(
      '[finalize] GitHub comment post failed:',
      opts.sessionExpiredComment.error
    )
    return withBody(opts.sessionExpiredComment)
  }

  const octokit = createOctokit(opts.githubToken)
  if (!octokit) {
    return withBody({
      skipped: true,
      reason: 'GITHUB_TOKEN not configured',
    })
  }
  if (!opts.prUrlParts) {
    return withBody({
      skipped: true,
      reason: 'Could not parse prUrl for GitHub API',
    })
  }
  if (process.env.DRY_RUN === 'true') {
    return withBody({ dryRun: true })
  }
  try {
    const { data } = await octokit.issues.createComment({
      owner: opts.prUrlParts[1],
      repo: opts.prUrlParts[2],
      issue_number: Number(opts.prUrlParts[3]),
      body: opts.commentBody,
    })
    return withBody({ id: data.id, url: data.html_url })
  } catch (err) {
    console.error('[finalize] GitHub comment post failed:', err)
    return withBody({ error: String(err) })
  }
}

async function sessionGithubLogin(): Promise<string | undefined> {
  try {
    const supabase = await createSupabaseServerClient()
    const { data, error } = await supabase.auth.getUser()
    if (error) return undefined
    return githubLoginFromUser(data.user)
  } catch {
    return undefined
  }
}

/**
 * Mark the corresponding tracked_pr as REVIEWED and record which review
 * produced it. Awaited before the response is sent so the transition is
 * guaranteed to complete (important in serverless environments).
 *
 * `review_count` is incremented by the `tracked_prs_on_reviewed` DB trigger.
 */
async function markTrackedPrReviewed(
  prUrl: string,
  reviewId: string
): Promise<void> {
  const parsed = parsePrUrl(prUrl)
  if (!parsed) return
  try {
    await markPrReviewed(parsed, reviewId)
  } catch (err) {
    console.error('[finalize] tracked_prs REVIEWED transition failed:', err)
  }
}

// ── POST /api/review/[id]/finalize ────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: reviewId } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = FinalizeBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 }
    )
  }

  const {
    decisions: rawDecisions,
    sections: rawSections,
    postComment,
    approve,
  } = parsed.data
  const sectionsPatch =
    rawSections && rawSections.length > 0 ? { sections: rawSections } : {}

  // ── Load PRReview from Supabase ───────────────────────────────────────────
  let reviewRow
  try {
    reviewRow = await getReview(reviewId)
  } catch (err) {
    console.error(`[finalize/${reviewId}] getReview failed:`, err)
    return NextResponse.json(
      { error: 'Failed to load review.' },
      { status: 500 }
    )
  }
  if (!reviewRow || reviewRow.status !== 'COMPLETE' || !reviewRow.result) {
    return NextResponse.json(
      { error: 'Review not found or not yet complete.' },
      { status: 404 }
    )
  }
  const review = reviewRow.result
  const prUrl = reviewRow.pr_url

  // ── Mutual-exclusivity guards ─────────────────────────────────────────────
  // totalFindings includes all severities (blocking + suggestions + nits),
  // matching the UI's `total === 0` condition in ReviewShell which also counts
  // all findings. Both gates are intentionally strict: the Approve CTA only
  // appears and succeeds when the review is completely clean.
  const totalFindings =
    (review.blockingIssues?.length ?? 0) +
    (review.suggestions?.length ?? 0) +
    (review.nits?.length ?? 0)

  // Prevent a false LGTM comment being posted to a review that has findings.
  if (approve && totalFindings > 0) {
    return NextResponse.json(
      {
        error:
          'Cannot approve a review that has findings. Submit decisions instead.',
      },
      { status: 400 }
    )
  }

  // Prevent the normal submission path from silently succeeding with no decisions.
  // Error message is context-aware: if the review has no findings, guide caller
  // toward approve:true; if it has findings, guide them to supply decisions.
  if (!approve && rawDecisions.length === 0) {
    return NextResponse.json(
      {
        error:
          totalFindings === 0
            ? 'This review has no findings. Use approve:true to post a clean LGTM.'
            : 'decisions must not be empty for a findings submission.',
      },
      { status: 400 }
    )
  }

  // ── Two fully separate paths — approve (clean review) vs. submit (findings) ──

  const prUrlParts = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!prUrlParts) {
    console.warn(
      `[finalize/${reviewId}] prUrl could not be parsed — history metadata will be degraded. prUrl: ${prUrl}`
    )
  }
  const memory = createMemoryStore()
  const githubLogin = await sessionGithubLogin()
  const historyMetadata = reviewHistoryMetadata({
    prUrl,
    parsed: parsePrUrl(prUrl),
    prTitle: review.summary.slice(0, 80),
    githubLogin,
  })
  const persistHistory = (payload: unknown): Promise<void> =>
    memory
      .storeReview(payload, historyMetadata)
      .catch(err => console.error('[finalize] storeReview failed:', err))

  const freshGithub = await getFreshGitHubToken()
  const githubToken = githubTokenFromFresh(freshGithub)
  const sessionExpiredComment =
    !freshGithub.ok && freshGithub.error === GitHubAuthError.REFRESH_FAILED
      ? { error: GITHUB_SESSION_EXPIRED_MESSAGE }
      : null

  if (approve) {
    // ── Approve path: no findings, post LGTM comment ────────────────────────
    let commentResult: unknown = null
    if (postComment) {
      commentResult = await postGithubPrComment({
        sessionExpiredComment,
        githubToken,
        prUrlParts,
        commentBody: formatApprovalComment(review, rawSections),
      })
    }
    const approvalSubmission = {
      ...buildSubmission(
        {
          reviewId,
          decisions: {},
          submitting: false,
          submitted: true,
          result: null,
        },
        githubCommentPosted(postComment, commentResult)
      ),
      ...sectionsPatch,
    }
    await persistHistory({ review, submission: approvalSubmission })

    try {
      await setReviewSubmission(reviewId, approvalSubmission)
    } catch (err) {
      console.error('[finalize] setReviewSubmission failed:', err)
      return NextResponse.json(
        { error: 'Failed to persist submission — please retry.' },
        { status: 500 }
      )
    }
    await markTrackedPrReviewed(prUrl, reviewId)
    return NextResponse.json({
      reviewId,
      status: 'approved',
      comment: commentResult,
      ...(prUrlParts
        ? {}
        : {
            warning:
              'prUrl could not be parsed — history metadata stored with placeholder values',
          }),
    })
  }

  // ── Submit path: build decision map, persist, post findings comment ────────
  const decisionMap: Record<string, FindingDecision> = {}
  for (const d of rawDecisions) {
    decisionMap[d.findingId] = {
      findingId: d.findingId,
      action: d.action,
      editedTitle: d.editedTitle,
      editedBody: d.editedBody,
    }
  }

  const approvalState = {
    reviewId,
    decisions: decisionMap,
    submitting: false,
    submitted: true,
    result: null,
  }
  const accepted = rawDecisions.filter(d => d.action !== 'REJECT').length
  const rejected = rawDecisions.filter(d => d.action === 'REJECT').length

  let commentResult: unknown = null
  if (postComment) {
    commentResult = await postGithubPrComment({
      sessionExpiredComment,
      githubToken,
      prUrlParts,
      commentBody: formatGitHubComment(review, {
        reviewId,
        decisions: Object.values(decisionMap),
        postToGitHub: false,
        ...sectionsPatch,
      }),
    })
  }
  const submission = {
    ...buildSubmission(
      approvalState,
      githubCommentPosted(postComment, commentResult)
    ),
    ...sectionsPatch,
  }

  await persistHistory({ review, submission })

  try {
    await setReviewSubmission(reviewId, submission)
  } catch (err) {
    console.error('[finalize] setReviewSubmission failed:', err)
    return NextResponse.json(
      { error: 'Failed to persist submission — please retry.' },
      { status: 500 }
    )
  }
  await markTrackedPrReviewed(prUrl, reviewId)
  return NextResponse.json({
    reviewId,
    status: 'finalized',
    summary: { totalDecisions: rawDecisions.length, accepted, rejected },
    comment: commentResult,
    ...(prUrlParts
      ? {}
      : {
          warning:
            'prUrl could not be parsed — history metadata stored with placeholder values',
        }),
  })
}
