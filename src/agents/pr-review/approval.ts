import { AGAMOTTO_REVIEW_FOOTER } from '../../lib/github-conversation'
import { formatConfidencePercent } from '../../lib/confidence-bar'
import {
  ReviewSection,
  defaultAlignmentText,
  defaultListText,
  defaultPreambleText,
  listItemsFromText,
  resolveSection,
} from '../../lib/review-sections'
import type {
  PRReview,
  Finding,
  FindingDecision,
  ReviewSubmission,
  SectionDecision,
} from './schema'

// ── Types ─────────────────────────────────────────────────────────────────────

export type DecisionAction = 'ACCEPT' | 'REJECT' | 'EDIT'

export interface ApprovalState {
  reviewId: string
  decisions: Record<string, FindingDecision>
  submitting: boolean
  submitted: boolean
  result: ReviewSubmission | null
}

// ── Initial state ─────────────────────────────────────────────────────────────

/**
 * Build the initial decision map from a PRReview.
 * BLOCKINGs and SUGGESTIONs default to ACCEPT; NITs default to REJECT
 * (matching the approval UI checkbox spec).
 */
export function buildInitialDecisions(
  review: PRReview
): Record<string, FindingDecision> {
  const allFindings = [
    ...review.blockingIssues,
    ...review.suggestions,
    ...review.nits,
  ]
  return Object.fromEntries(
    allFindings.map(f => [
      f.id,
      {
        findingId: f.id,
        action: (f.severity === 'NIT' ? 'REJECT' : 'ACCEPT') as DecisionAction,
        editedBody: undefined,
      },
    ])
  )
}

export function buildInitialState(review: PRReview): ApprovalState {
  return {
    reviewId: review.reviewId,
    decisions: buildInitialDecisions(review),
    submitting: false,
    submitted: false,
    result: null,
  }
}

// ── State transitions ─────────────────────────────────────────────────────────

export function toggleDecision(
  state: ApprovalState,
  findingId: string
): ApprovalState {
  const current = state.decisions[findingId]
  if (!current) return state
  // Toggle between ACCEPT and REJECT only; EDIT is a separate explicit action
  // and must not be clobbered by a checkbox click.
  const next: DecisionAction = current.action === 'REJECT' ? 'ACCEPT' : 'REJECT'
  return {
    ...state,
    decisions: {
      ...state.decisions,
      [findingId]: { ...current, action: next },
    },
  }
}

export function editFinding(
  state: ApprovalState,
  findingId: string,
  editedBody: string
): ApprovalState {
  const current = state.decisions[findingId]
  if (!current) return state
  return {
    ...state,
    decisions: {
      ...state.decisions,
      [findingId]: { ...current, action: 'EDIT', editedBody },
    },
  }
}

// ── Submission ────────────────────────────────────────────────────────────────

/**
 * Build the final ReviewSubmission from the current approval state.
 * All decisions (ACCEPT, REJECT, EDIT) are included — callers such as
 * formatGitHubComment filter out REJECTs themselves.
 *
 * `postToGitHub` is outcome, not intent: true only when the GitHub comment
 * actually landed (or DRY_RUN). A failed post still saves decisions as false.
 */
export function buildSubmission(
  state: ApprovalState,
  postToGitHub: boolean,
  sections?: SectionDecision[]
): ReviewSubmission {
  return {
    reviewId: state.reviewId,
    decisions: Object.values(state.decisions),
    ...(sections && sections.length > 0 ? { sections } : {}),
    postToGitHub,
  }
}

// ── Summary helpers ───────────────────────────────────────────────────────────

export interface ApprovalSummary {
  total: number
  accepted: number
  rejected: number
  edited: number
  blockingAccepted: number
}

export function summariseDecisions(
  review: PRReview,
  state: ApprovalState
): ApprovalSummary {
  const allFindings = [
    ...review.blockingIssues,
    ...review.suggestions,
    ...review.nits,
  ]
  const byId = new Map<string, Finding>(allFindings.map(f => [f.id, f]))

  let accepted = 0
  let rejected = 0
  let edited = 0
  let blockingAccepted = 0

  for (const decision of Object.values(state.decisions)) {
    if (decision.action === 'ACCEPT') {
      accepted++
      const finding = byId.get(decision.findingId)
      if (finding?.severity === 'BLOCKING') blockingAccepted++
    } else if (decision.action === 'REJECT') {
      rejected++
    } else {
      edited++
      accepted++ // edited = included
    }
  }

  return {
    total: allFindings.length,
    accepted,
    rejected,
    edited,
    blockingAccepted,
  }
}

function appendListSection(
  lines: string[],
  heading: string,
  resolved: { included: boolean; text: string }
): void {
  if (!resolved.included) return
  const items = listItemsFromText(resolved.text)
  if (items.length === 0) return
  lines.push(heading)
  items.forEach(item => lines.push(`- ${item}`))
  lines.push('')
}

function formatFindingHeading(
  title: string,
  finding: Pick<Finding, 'file' | 'line' | 'confidence'>
): string {
  const loc = `${finding.file}${finding.line ? `:${finding.line}` : ''}`
  return `\n**${title}** (\`${loc}\`, ${formatConfidencePercent(finding.confidence)} confidence)`
}

/**
 * Format a ReviewSubmission into a GitHub-ready markdown comment body.
 * Used by the finalize route when postToGitHub=true.
 */
export function formatGitHubComment(
  review: PRReview,
  submission: ReviewSubmission
): string {
  const accepted = submission.decisions.filter(d => d.action !== 'REJECT')
  const allFindings = [
    ...review.blockingIssues,
    ...review.suggestions,
    ...review.nits,
  ]
  const byId = new Map<string, Finding>(allFindings.map(f => [f.id, f]))
  const sections = submission.sections
  const preamble = resolveSection(
    ReviewSection.PREAMBLE,
    defaultPreambleText(review),
    sections
  )

  const lines: string[] = [`## AI PR Review — ${review.verdict}`, '']
  if (preamble.included && preamble.text) {
    lines.push(preamble.text, '')
  }
  appendListSection(
    lines,
    '### Acceptance Criteria alignment',
    resolveSection(
      ReviewSection.TICKET_ALIGNMENT,
      defaultAlignmentText(review.ticketAlignment),
      sections
    )
  )

  if (review.blockingIssues.length > 0) {
    lines.push('### 🔴 Blocking Issues')
    for (const d of accepted) {
      const f = byId.get(d.findingId)
      if (!f || f.severity !== 'BLOCKING') continue
      const title = d.editedTitle ?? f.title
      const body = d.editedBody ?? f.body
      lines.push(formatFindingHeading(title, f))
      lines.push(body)
      if (f.suggestedFix) lines.push(`\n> Suggested fix: ${f.suggestedFix}`)
    }
    lines.push('')
  }

  if (review.suggestions.length > 0) {
    lines.push('### ⚠️ Suggestions')
    for (const d of accepted) {
      const f = byId.get(d.findingId)
      if (!f || f.severity !== 'SUGGESTION') continue
      const title = d.editedTitle ?? f.title
      const body = d.editedBody ?? f.body
      lines.push(formatFindingHeading(title, f))
      lines.push(body)
    }
    lines.push('')
  }

  const acceptedNits = accepted.filter(d => {
    const f = byId.get(d.findingId)
    return f?.severity === 'NIT'
  })
  if (acceptedNits.length > 0) {
    lines.push('### 💬 Nits')
    for (const d of acceptedNits) {
      const f = byId.get(d.findingId)!
      const title = d.editedTitle ?? f.title
      const body = d.editedBody ?? f.body
      lines.push(formatFindingHeading(title, f))
      lines.push(body)
      if (f.suggestedFix) lines.push(`\n> Suggested fix: ${f.suggestedFix}`)
    }
    lines.push('')
  }

  appendListSection(
    lines,
    '### ✅ What Looks Good',
    resolveSection(
      ReviewSection.WHAT_LOOKS_GOOD,
      defaultListText(review.whatLooksGood),
      sections
    )
  )
  appendListSection(
    lines,
    '### Questions',
    resolveSection(
      ReviewSection.QUESTIONS,
      defaultListText(review.questions),
      sections
    )
  )
  appendListSection(
    lines,
    '### 🧪 Testing Recommendations',
    resolveSection(
      ReviewSection.TESTING_RECOMMENDATIONS,
      defaultListText(review.testingRecommendations),
      sections
    )
  )

  lines.push('---')
  lines.push(AGAMOTTO_REVIEW_FOOTER)

  return lines.join('\n')
}

/**
 * Format a clean LGTM approval comment for a PR that had no findings.
 */
export function formatApprovalComment(
  review: PRReview,
  sections?: SectionDecision[]
): string {
  const preamble = resolveSection(
    ReviewSection.PREAMBLE,
    defaultPreambleText(review),
    sections
  )
  const lines: string[] = []
  lines.push('## AI PR Review — APPROVED ✅')
  lines.push('')
  lines.push(
    'No blocking issues or suggestions found. This PR looks good to merge.'
  )
  lines.push('')

  if (preamble.included && preamble.text) {
    lines.push(preamble.text)
    lines.push('')
  }
  appendListSection(
    lines,
    '### Acceptance Criteria alignment',
    resolveSection(
      ReviewSection.TICKET_ALIGNMENT,
      defaultAlignmentText(review.ticketAlignment),
      sections
    )
  )

  appendListSection(
    lines,
    '### ✅ What Looks Good',
    resolveSection(
      ReviewSection.WHAT_LOOKS_GOOD,
      defaultListText(review.whatLooksGood),
      sections
    )
  )
  appendListSection(
    lines,
    '### Questions',
    resolveSection(
      ReviewSection.QUESTIONS,
      defaultListText(review.questions),
      sections
    )
  )
  appendListSection(
    lines,
    '### 🧪 Testing Recommendations',
    resolveSection(
      ReviewSection.TESTING_RECOMMENDATIONS,
      defaultListText(review.testingRecommendations),
      sections
    )
  )

  lines.push('---')
  lines.push(AGAMOTTO_REVIEW_FOOTER)

  return lines.join('\n')
}
