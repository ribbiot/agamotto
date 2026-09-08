/**
 * Format the GitHub review comment from the approval UI's current Include/edit
 * state, so Copy review matches what finalize would post — without submitting.
 */

import {
  formatApprovalComment,
  formatGitHubComment,
} from '../agents/pr-review/approval'
import { FINDING_CATEGORIES } from '../agents/pr-review/schema'
import type {
  Finding,
  FindingDecision,
  PRReview,
  ReviewSubmission,
} from '../agents/pr-review/schema'
import {
  ReviewSection,
  hydrateSectionUi,
  sectionDecisionsFromUi,
  type ReviewCommentExtras,
  type UiSectionDecision,
} from './review-sections'

export type { ReviewCommentExtras, UiSectionDecision }

const KNOWN_CATEGORIES: ReadonlySet<Finding['category']> = new Set(
  FINDING_CATEGORIES
)

export type UiFinding = {
  id: string
  severity: Finding['severity']
  category: string
  categories?: string[]
  file: string
  line?: number
  title: string
  body: string
  confidence: number
  suggestedFix?: string
}

export type UiFindingDecision = {
  findingId: string
  accepted: boolean
  editedTitle?: string
  editedBody?: string
}

export function findingReviewAction(decision: {
  accepted: boolean
  editedTitle?: string
  editedBody?: string
}): FindingDecision['action'] {
  if (!decision.accepted) return 'REJECT'
  if (decision.editedTitle || decision.editedBody) return 'EDIT'
  return 'ACCEPT'
}

export function finalizeDecisionsFromUi(
  decisions: Record<string, UiFindingDecision>
): ReviewSubmission['decisions'] {
  return Object.values(decisions).map(d => ({
    findingId: d.findingId,
    action: findingReviewAction(d),
    editedTitle: d.editedTitle,
    editedBody: d.editedBody,
  }))
}

function asFindingCategory(value: string): Finding['category'] {
  return KNOWN_CATEGORIES.has(value as Finding['category'])
    ? (value as Finding['category'])
    : 'CORRECTNESS'
}

function toFinding(f: UiFinding): Finding {
  return {
    id: f.id,
    severity: f.severity,
    category: asFindingCategory(f.category),
    categories: f.categories?.map(asFindingCategory),
    file: f.file,
    line: f.line,
    title: f.title,
    body: f.body,
    confidence: f.confidence,
    suggestedFix: f.suggestedFix,
  }
}

function isAccepted(
  findingId: string,
  decisions: Record<string, UiFindingDecision>
): boolean {
  return decisions[findingId]?.accepted ?? true
}

function deriveVerdict(
  findings: Finding[],
  decisions: Record<string, UiFindingDecision>
): PRReview['verdict'] {
  if (findings.length === 0) return 'APPROVE'
  const hasAcceptedBlocking = findings.some(
    f => f.severity === 'BLOCKING' && isAccepted(f.id, decisions)
  )
  return hasAcceptedBlocking ? 'REQUEST_CHANGES' : 'COMMENT'
}

export function formatReviewCommentFromUi(opts: {
  reviewId: string
  findings: UiFinding[]
  decisions: Record<string, UiFindingDecision>
  extras?: ReviewCommentExtras
  sections?: Record<ReviewSection, UiSectionDecision>
}): string {
  const findings = opts.findings.map(toFinding)
  const extras = opts.extras ?? {}
  const review: PRReview = {
    reviewId: opts.reviewId,
    prUrl: '',
    summary: extras.summary ?? '',
    fileCoverage: [],
    ticketAlignment: extras.ticketAlignment ?? [],
    whatLooksGood: extras.whatLooksGood ?? [],
    blockingIssues: findings.filter(f => f.severity === 'BLOCKING'),
    suggestions: findings.filter(f => f.severity === 'SUGGESTION'),
    nits: findings.filter(f => f.severity === 'NIT'),
    questions: extras.questions ?? [],
    testingRecommendations: extras.testingRecommendations ?? [],
    verdict: extras.verdict ?? deriveVerdict(findings, opts.decisions),
    verdictSummary: extras.verdictSummary ?? '',
    confidence: 1,
  }
  const sectionDecisions = sectionDecisionsFromUi({
    ...hydrateSectionUi(extras),
    ...opts.sections,
  })

  if (findings.length === 0) {
    return formatApprovalComment(review, sectionDecisions)
  }

  const submission: ReviewSubmission = {
    reviewId: opts.reviewId,
    postToGitHub: false,
    decisions: findings.map(f => {
      const d = opts.decisions[f.id]
      return {
        findingId: f.id,
        action: findingReviewAction({
          accepted: isAccepted(f.id, opts.decisions),
          editedTitle: d?.editedTitle,
          editedBody: d?.editedBody,
        }),
        editedTitle: d?.editedTitle,
        editedBody: d?.editedBody,
      }
    }),
    sections: sectionDecisions,
  }

  return formatGitHubComment(review, submission)
}
