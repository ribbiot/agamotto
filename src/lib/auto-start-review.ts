/**
 * ATH-58 webhook auto-start: first `opened` pass only.
 * Completes to READY — never posts. Diff fetch uses GITHUB_TOKEN.
 */
import { v4 as uuidv4 } from 'uuid'
import {
  AutoStartDecision,
  decideAutoStart,
  githubTokenFromEnv,
} from './auto-start'
import {
  executeReviewPipeline,
  type ReviewPipelineEmit,
} from './execute-review-pipeline'
import { isAllowedGithubLogin } from './github-users'
import { beginTrackedReview } from '../memory/begin-tracked-review'

/** Webhook auto-start has no SSE client — findings persist via completeReview. */
export const discardReviewEmit: ReviewPipelineEmit = () => {}

/**
 * In-process guard for duplicate `opened` deliveries on this Railway instance.
 * Concurrent handlers can all pre-fetch last_review_id=null; the first one to
 * pass decideAutoStart claims the URL so a second pipeline is not minted.
 */
const autoStartedPrUrls = new Set<string>()

export type TryAutoStartOpenedReviewOpts = {
  prUrl: string
  prAuthor: string | null
  existingStatus: string | null
  lastReviewId: string | null
}

/** Test-only: clears the in-process duplicate-opened guard. */
export function resetAutoStartedPrUrls(): void {
  autoStartedPrUrls.clear()
}

export async function tryAutoStartOpenedReview(
  opts: TryAutoStartOpenedReviewOpts
): Promise<AutoStartDecision> {
  const githubToken = githubTokenFromEnv()
  const authorAllowed = isAllowedGithubLogin(
    opts.prAuthor,
    process.env.ALLOWED_GITHUB_USERS
  )

  const decision = decideAutoStart({
    action: 'opened',
    autoStartEnabled: true,
    existingStatus: opts.existingStatus,
    lastReviewId: opts.lastReviewId,
    authorLogin: opts.prAuthor,
    authorAllowed,
    hasGithubToken: githubToken !== null,
  })

  if (decision !== AutoStartDecision.START || !githubToken) {
    if (decision !== AutoStartDecision.START) {
      console.info(`[auto-start] skip ${opts.prUrl}: ${decision}`)
    }
    return decision
  }

  if (autoStartedPrUrls.has(opts.prUrl)) {
    console.info(
      `[auto-start] skip ${opts.prUrl}: ${AutoStartDecision.SKIP_ALREADY_STARTED}`
    )
    return AutoStartDecision.SKIP_ALREADY_STARTED
  }
  autoStartedPrUrls.add(opts.prUrl)

  const reviewId = uuidv4()
  // Await the row mint so last_review_id + IN_REVIEW land before the webhook
  // returns. Duplicate `opened` deliveries then skip. The pipeline itself is
  // detached — do not await it.
  await beginTrackedReview(reviewId, opts.prUrl, 'full')
  void executeReviewPipeline({
    reviewId,
    prUrl: opts.prUrl,
    mode: 'full',
    githubToken,
    emit: discardReviewEmit,
  }).catch(err => {
    console.error(`[auto-start] pipeline failed for ${opts.prUrl}:`, err)
  })
  return AutoStartDecision.START
}
