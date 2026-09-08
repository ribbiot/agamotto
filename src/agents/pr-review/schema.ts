import { z } from 'zod'
import { GithubCommentKind } from '../../lib/github-conversation'

// ── Finding ───────────────────────────────────────────────────────────────────

/** The five review domains. A finding's category is the agent that raised it. */
export const FINDING_CATEGORIES = [
  'STYLE',
  'CONVENTIONS',
  'CORRECTNESS',
  'SECURITY',
  'PERFORMANCE',
] as const

export const FindingCategorySchema = z.enum(FINDING_CATEGORIES)
export type FindingCategory = z.infer<typeof FindingCategorySchema>

export const FindingSchema = z.object({
  id: z.string(),
  severity: z.enum(['BLOCKING', 'SUGGESTION', 'NIT']),
  category: FindingCategorySchema,
  /**
   * Every agent that independently raised this defect, in merge order (ATH-50).
   * Agents run in parallel and overlap constantly, so convergence is real
   * evidence — three specialists flagging one line is the strongest triage
   * signal a review produces. Populated by `mergeResults`; absent on findings
   * that predate multi-attribution, where `[category]` is the equivalent.
   */
  categories: z.array(FindingCategorySchema).optional(),
  file: z.string(),
  line: z.number().int().positive().optional(),
  title: z.string(),
  body: z.string(),
  confidence: z.number().min(0).max(1),
  suggestedFix: z.string().optional(),
})
export type Finding = z.infer<typeof FindingSchema>

/** All agents credited with a finding, tolerating pre-ATH-50 stored reviews. */
export function findingCategories(finding: {
  category: string
  categories?: string[]
}): string[] {
  return finding.categories?.length ? finding.categories : [finding.category]
}

// ── FileCoverage ──────────────────────────────────────────────────────────────

export const FileCoverageSchema = z.object({
  file: z.string(),
  status: z.enum(['READ', 'SKIPPED', 'TRUNCATED']),
  reason: z.string().optional(),
  linesRead: z.number().int().nonnegative().optional(),
  linesTotal: z.number().int().nonnegative().optional(),
})
export type FileCoverage = z.infer<typeof FileCoverageSchema>

// ── PriorRound ────────────────────────────────────────────────────────────────
// Compact findings from an earlier COMPLETE review of the same PR.

export const PriorFindingSchema = z.object({
  severity: z.enum(['BLOCKING', 'SUGGESTION', 'NIT']),
  category: FindingCategorySchema,
  file: z.string(),
  line: z.number().int().positive().optional(),
  title: z.string(),
  action: z.enum(['ACCEPT', 'REJECT', 'EDIT']).optional(),
})
export type PriorFinding = z.infer<typeof PriorFindingSchema>

export const PriorRoundSchema = z.object({
  reviewId: z.string(),
  reviewedAt: z.string(),
  summary: z.string(),
  findings: z.array(PriorFindingSchema),
})
export type PriorRound = z.infer<typeof PriorRoundSchema>

// ── GithubConversation ────────────────────────────────────────────────────────
// Compacted GitHub comments for this PR. Injected by the coordinator.

export const GithubConversationItemSchema = z.object({
  kind: z.nativeEnum(GithubCommentKind),
  id: z.number().int(),
  author: z.string().optional(),
  createdAt: z.string(),
  body: z.string(),
  path: z.string().optional(),
  line: z.number().int().optional(),
})
export type GithubConversationItem = z.infer<
  typeof GithubConversationItemSchema
>

export const GithubConversationPackSchema = z.object({
  items: z.array(GithubConversationItemSchema),
  omitted: z.boolean(),
})
export type GithubConversationPack = z.infer<
  typeof GithubConversationPackSchema
>

// ── AlignmentItem ─────────────────────────────────────────────────────────────

export const AlignmentItemSchema = z.object({
  requirement: z.string(),
  met: z.boolean(),
  location: z.string().optional(),
})
export type AlignmentItem = z.infer<typeof AlignmentItemSchema>

// ── EnrichedContext ───────────────────────────────────────────────────────────
// Output of the Context Agent — shared input to all domain agents.

export const EnrichedContextSchema = z.object({
  prUrl: z.string().url(),
  prTitle: z.string(),
  prAuthor: z.string(),
  prBranch: z.string(),
  /**
   * Ground-truth source from GitHub, overwritten by the coordinator (ATH-50).
   * Optional on parse so the context agent can omit them; defaults keep
   * downstream types as `string` / arrays.
   */
  diff: z.string().optional().default(''),
  filesChanged: z.array(z.string()).optional().default([]),
  fileCoverage: z.array(FileCoverageSchema).optional().default([]),
  ticketId: z.string().optional(),
  ticketSummary: z.string().optional(),
  ticketAcceptanceCriteria: z.array(z.string()).optional(),
  pastReviewSummaries: z.array(z.string()).optional(),
  memories: z.array(z.string()).optional(),
  /** Earlier COMPLETE reviews of this same PR, oldest first. Injected by the coordinator. */
  priorRounds: z.array(PriorRoundSchema).optional(),
  /**
   * Compacted GitHub conversation for this PR. Injected by the coordinator;
   * the context agent must omit this field from its JSON.
   */
  githubConversation: GithubConversationPackSchema.optional(),
  externalContextCalls: z.number().int().nonnegative(),
})
export type EnrichedContext = z.infer<typeof EnrichedContextSchema>

// ── DomainResult ──────────────────────────────────────────────────────────────
// Output of a single domain agent (single-shot structured output).

export const DomainResultSchema = z.object({
  domain: z.enum([
    'STYLE',
    'CONVENTIONS',
    'CORRECTNESS',
    'SECURITY',
    'PERFORMANCE',
  ]),
  findings: z.array(FindingSchema),
  confidence: z.number().min(0).max(1),
  tokensUsed: z.number().int().nonnegative(),
  cost: z.number().nonnegative().default(0),
  durationMs: z.number().int().nonnegative(),
})
export type DomainResult = z.infer<typeof DomainResultSchema>

// ── PRReview ──────────────────────────────────────────────────────────────────
// Final merged output from the Coordinator — validated before entering the approval loop.

export const PRReviewSchema = z.object({
  reviewId: z.string(),
  prUrl: z.string().url(),
  summary: z.string(),
  fileCoverage: z.array(FileCoverageSchema),
  ticketAlignment: z.array(AlignmentItemSchema),
  whatLooksGood: z.array(z.string()),
  blockingIssues: z.array(FindingSchema),
  suggestions: z.array(FindingSchema),
  nits: z.array(FindingSchema),
  questions: z.array(z.string()),
  testingRecommendations: z.array(z.string()),
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
  verdictSummary: z.string(),
  confidence: z.number().min(0).max(1),
})
export type PRReview = z.infer<typeof PRReviewSchema>

// ── FindingDecision ───────────────────────────────────────────────────────────
// Approval loop: what the reviewer decided for each finding.

export const FindingDecisionSchema = z.object({
  findingId: z.string(),
  action: z.enum(['ACCEPT', 'REJECT', 'EDIT']),
  editedTitle: z.string().optional(),
  editedBody: z.string().optional(),
})
export type FindingDecision = z.infer<typeof FindingDecisionSchema>

/** Non-finding blocks on the posted GitHub comment (ATH-29). */
export enum ReviewSection {
  PREAMBLE = 'PREAMBLE',
  TICKET_ALIGNMENT = 'TICKET_ALIGNMENT',
  WHAT_LOOKS_GOOD = 'WHAT_LOOKS_GOOD',
  QUESTIONS = 'QUESTIONS',
  TESTING_RECOMMENDATIONS = 'TESTING_RECOMMENDATIONS',
}

export const ReviewSectionSchema = z.enum([
  ReviewSection.PREAMBLE,
  ReviewSection.TICKET_ALIGNMENT,
  ReviewSection.WHAT_LOOKS_GOOD,
  ReviewSection.QUESTIONS,
  ReviewSection.TESTING_RECOMMENDATIONS,
])

export const SectionDecisionSchema = z.object({
  section: ReviewSectionSchema,
  action: z.enum(['ACCEPT', 'REJECT', 'EDIT']),
  editedBody: z.string().optional(),
})
export type SectionDecision = z.infer<typeof SectionDecisionSchema>

// ── ReviewSubmission ──────────────────────────────────────────────────────────
// Full approval loop output — decisions + whether the GitHub comment landed.

export const ReviewSubmissionSchema = z.object({
  reviewId: z.string(),
  decisions: z.array(FindingDecisionSchema),
  /** Absent on submissions stored before ATH-29. */
  sections: z.array(SectionDecisionSchema).optional(),
  postToGitHub: z.boolean(),
})
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>

// ── CheckpointRecord ──────────────────────────────────────────────────────────
// Persisted to Supabase after each checkpoint stage passes.

export const CheckpointStageSchema = z.enum([
  'INPUT',
  'CONTEXT',
  'DOMAIN',
  'OUTPUT',
  'FINALIZE',
])
export type CheckpointStage = z.infer<typeof CheckpointStageSchema>

export const CheckpointRecordSchema = z.object({
  reviewId: z.string(),
  stage: CheckpointStageSchema,
  agentName: z.string().optional(),
  status: z.enum(['PASS', 'FAIL']),
  payload: z.unknown(),
  createdAt: z.string(),
})
export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>
