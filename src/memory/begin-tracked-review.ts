/**
 * Mint a reviews row and flip the queue to IN_REVIEW.
 * Shared by POST /api/review/start and webhook auto-start (ATH-58).
 */
import { parsePrUrl } from '../lib/queue'
import { createReview } from './review-store'
import { markPrInReview } from './tracked-pr-store'

export async function beginTrackedReview(
  reviewId: string,
  prUrl: string,
  mode: 'full' | 'quick'
): Promise<void> {
  let reviewRowCreated = false
  try {
    await createReview(reviewId, prUrl, mode)
    reviewRowCreated = true
  } catch (err) {
    console.error('[beginTrackedReview] createReview failed:', err)
  }

  const prParsed = parsePrUrl(prUrl)
  if (!prParsed) return
  try {
    await markPrInReview(prParsed, reviewRowCreated ? reviewId : null)
  } catch (err) {
    console.error(
      '[beginTrackedReview] tracked_prs IN_REVIEW upsert failed:',
      err
    )
  }
}
