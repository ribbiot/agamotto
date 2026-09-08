/**
 * Run the review pipeline and persist COMPLETE → READY (or ERROR).
 *
 * Used by the SSE route (live emit) and webhook auto-start (noop emit).
 * Does not finalize and does not post to GitHub (ATH-57 / ATH-58).
 */
import { createReviewContext } from '../harness/context'
import { runReview } from '../agents/pr-review/coordinator'
import { completeReview, failReview } from '../memory/review-store'
import { markPrReviewFailed, markPrReady } from '../memory/tracked-pr-store'
import { parsePrUrl } from './queue'
import { loadReviewSettings } from './conventions-store'
import type { AgentOverlays } from './overlays'
import {
  pipelineFailureErrorMessage,
  tokenBudgetOverageFromError,
  tokenBudgetStats,
} from './review-run-stats'

export type ReviewPipelineEmit = (event: string, data: unknown) => void

export type ExecuteReviewPipelineOpts = {
  reviewId: string
  prUrl: string
  mode: 'full' | 'quick'
  githubToken: string | null
  emit: ReviewPipelineEmit
}

/** Same-process dedupe (webhook + SSE). One Railway replica — not a distributed lock. */
const inflight = new Map<string, Promise<void>>()

export function waitForInflightPipeline(
  reviewId: string
): Promise<void> | undefined {
  return inflight.get(reviewId)
}

async function runPipeline(opts: ExecuteReviewPipelineOpts): Promise<void> {
  const { reviewId, prUrl, mode, githubToken, emit } = opts
  const pipelineStarted = Date.now()
  try {
    const context = createReviewContext(undefined, githubToken)
    let conventionsDoc: string | undefined
    let overlays: AgentOverlays | undefined
    try {
      const settings = await loadReviewSettings()
      conventionsDoc = settings.conventionsDoc
      overlays = settings.overlays
    } catch (err) {
      console.error(`[review/${reviewId}] loadReviewSettings failed:`, err)
    }
    const review = await runReview({
      reviewId,
      prUrl,
      mode,
      conventionsDoc,
      overlays,
      context,
      emit,
    })
    try {
      await completeReview(reviewId, review)
      const parsed = parsePrUrl(prUrl)
      if (parsed) {
        await markPrReady(parsed, reviewId).catch(err =>
          console.error(`[review/${reviewId}] markPrReady failed:`, err)
        )
      } else {
        console.error(
          `[review/${reviewId}] parsePrUrl returned null — skipping READY:`,
          prUrl
        )
      }
    } catch (err) {
      console.error(`[review/${reviewId}] completeReview failed:`, err)
    }
  } catch (err) {
    console.error(`[review/${reviewId}] runReview failed:`, err)
    await failReview(reviewId, String(err)).catch(() => {})
    const parsed = parsePrUrl(prUrl)
    if (parsed) await markPrReviewFailed(parsed).catch(() => {})
    const overage = tokenBudgetOverageFromError(err)
    if (overage) {
      emit(
        'stats',
        tokenBudgetStats(overage, {
          includeCost: true,
          durationMs: Date.now() - pipelineStarted,
        })
      )
    }
    emit('error', { error: pipelineFailureErrorMessage(err) })
    emit('done', { reviewId })
  }
}

/** Dedupes concurrent kicks of the same reviewId (webhook + live SSE). */
export function executeReviewPipeline(
  opts: ExecuteReviewPipelineOpts
): Promise<void> {
  const existing = inflight.get(opts.reviewId)
  if (existing) return existing
  const running = runPipeline(opts).finally(() => {
    if (inflight.get(opts.reviewId) === running) inflight.delete(opts.reviewId)
  })
  inflight.set(opts.reviewId, running)
  return running
}
