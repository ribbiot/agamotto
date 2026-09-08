import { defaultFindingAccepted } from './finding-quality'
import {
  extrasFromReview,
  hydrateSectionUi,
  type ReviewCommentExtras,
  type UiSectionDecision,
} from './review-sections'
import { ReviewSection } from '../agents/pr-review/schema'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

/**
 * Hydrate the review UI from a stored COMPLETE reviews.result.
 * Used when opening View Review so the page never looks like a live pipeline.
 */

/** One finding as persisted on `reviews.result` (blocking / suggestion / nit). */
export interface StoredFinding {
  id: string
  severity: 'BLOCKING' | 'SUGGESTION' | 'NIT'
  category: string
  /** Absent on reviews stored before multi-attribution (ATH-50). */
  categories?: string[]
  file: string
  line?: number
  title: string
  body: string
  confidence: number
  suggestedFix?: string
}

/** Subset of `PRReview` needed to paint the approval UI without re-running agents. */
export interface StoredReviewPayload {
  blockingIssues?: StoredFinding[]
  suggestions?: StoredFinding[]
  nits?: StoredFinding[]
  summary?: string
  verdict?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  verdictSummary?: string
  whatLooksGood?: string[]
  questions?: string[]
  testingRecommendations?: string[]
  ticketAlignment?: {
    requirement: string
    met: boolean
    location?: string
  }[]
}

export type StoredUiDecision = {
  findingId: string
  accepted: boolean
  editedTitle?: string
  editedBody?: string
}

/** Initial ReviewShell state for a COMPLETE stored review. */
export interface StoredReviewUiState {
  status: 'done'
  isCachedReview: true
  findings: StoredFinding[]
  decisions: Record<string, StoredUiDecision>
  extras: ReviewCommentExtras
  sections: Record<ReviewSection, UiSectionDecision>
  phaseStatuses: Record<'INPUT' | 'CONTEXT' | 'DOMAIN' | 'OUTPUT', 'done'>
  activity: { type: 'phase'; text: string }[]
  postedToGitHub: boolean
}

function includedFromAction(action: unknown): boolean | undefined {
  if (action === 'REJECT') return false
  if (action === 'ACCEPT' || action === 'EDIT') return true
  return undefined
}

function decisionsFromSubmission(
  findings: StoredFinding[],
  submission: unknown
): Record<string, StoredUiDecision> {
  const overlay = new Map<string, StoredUiDecision>()
  const rec = asRecord(submission)
  const list = rec?.decisions
  if (Array.isArray(list)) {
    for (const item of list) {
      const row = asRecord(item)
      if (!row || typeof row.findingId !== 'string') continue
      const accepted = includedFromAction(row.action)
      if (accepted === undefined) continue
      const decision: StoredUiDecision = {
        findingId: row.findingId,
        accepted,
      }
      if (typeof row.editedTitle === 'string' && row.editedTitle.length > 0) {
        decision.editedTitle = row.editedTitle
      }
      if (typeof row.editedBody === 'string' && row.editedBody.length > 0) {
        decision.editedBody = row.editedBody
      }
      overlay.set(row.findingId, decision)
    }
  }

  const decisions: Record<string, StoredUiDecision> = {}
  for (const finding of findings) {
    const saved = overlay.get(finding.id)
    decisions[finding.id] = saved ?? {
      findingId: finding.id,
      accepted: defaultFindingAccepted(finding),
    }
  }
  return decisions
}

/**
 * Map a stored review payload into ReviewShell initial state.
 * Returns null when there is no result to hydrate (live pipeline should run).
 * When `submission` has decisions, Include toggles use those instead of defaults.
 */
export function storedReviewUiState(
  result: StoredReviewPayload | null | undefined,
  submission?: unknown
): StoredReviewUiState | null {
  if (result == null) return null

  const findings = [
    ...(result.blockingIssues ?? []),
    ...(result.suggestions ?? []),
    ...(result.nits ?? []),
  ]

  const extras = extrasFromReview(result)

  return {
    status: 'done',
    isCachedReview: true,
    findings,
    decisions: decisionsFromSubmission(findings, submission),
    extras,
    sections: hydrateSectionUi(extras, submission),
    phaseStatuses: {
      INPUT: 'done',
      CONTEXT: 'done',
      DOMAIN: 'done',
      OUTPUT: 'done',
    },
    activity: [
      { type: 'phase', text: '⚡ Loaded saved review' },
      { type: 'phase', text: '🎉 Review complete' },
    ],
    postedToGitHub: asRecord(submission)?.postToGitHub === true,
  }
}
