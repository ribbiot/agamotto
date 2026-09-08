import { runCheckpoint } from '../../harness/checkpoints'
import type { ReviewContext } from '../../harness/context'
import { PRReviewSchema, type PRReview, type EnrichedContext } from './schema'
import { runContextAgent } from './context-agent'
import { runCorrectnessAgent } from './correctness-agent'
import { runSecurityAgent } from './security-agent'
import { runConventionsAgent } from './conventions-agent'
import { runPerformanceAgent } from './performance-agent'
import { runStyleAgent } from './style-agent'
import { mergeResults, bucketFindings } from './merge'
import { coordinatorSummaryPrompt } from './prompts'
import {
  applyFindingQualityFilters,
  prepareFindingsForMerge,
} from '../../lib/finding-quality'
import { withSpan } from '../../harness/observability'
import { listCompleteReviewsForPr } from '../../memory/review-store'
import { fetchPrConversation, fetchPrFiles } from '../../tools/github'
import { parsePrUrl } from '../../lib/queue'
import {
  assembleGroundTruthDiff,
  formatGroundTruthActivity,
  type GroundTruthDiff,
} from '../../lib/ground-truth-diff'
import {
  MAX_PRIOR_ROUNDS,
  formatPriorRounds,
  priorRoundStats,
  formatPriorRoundsActivity,
  type PriorRound,
} from '../../lib/prior-rounds'
import {
  EMPTY_GITHUB_CONVERSATION,
  formatContextJsonForAgents,
  formatGithubConversation,
  formatGithubConversationActivity,
  formatGithubConversationFetchFailed,
  githubConversationStats,
  type GithubConversationPack,
} from '../../lib/github-conversation'
import type { Octokit } from '@octokit/rest'
import { OverlayAgent, type AgentOverlays } from '../../lib/overlays'
import { extrasFromReview } from '../../lib/review-sections'

// ── Public interface ──────────────────────────────────────────────────────────

export type ReviewEmitter = (event: string, data: unknown) => void

export interface RunReviewOptions {
  reviewId: string
  prUrl: string
  /** 'quick' skips the context agent and runs only the domain agents (no context gathering) */
  mode?: 'full' | 'quick'
  /** Team conventions doc from Supabase settings. Falls back to built-in defaults when absent. */
  conventionsDoc?: string
  /** Per-agent operator overlays from Settings. Empty/absent = shipped defaults. */
  overlays?: Partial<AgentOverlays>
  context: ReviewContext
  emit?: ReviewEmitter
}

/**
 * The Coordinator orchestrates the full multi-agent review:
 *
 *  Phase 1: Context Agent (full loop, tool calls) → EnrichedContext
 *  Phase 2: Domain agents in parallel (correctness + security + conventions + performance + style)
 *  Phase 3: Merge + deduplicate findings
 *  Phase 4: Coordinator summary LLM call → PRReview
 *
 * Progress events are emitted via the `emit` callback so the SSE route
 * can stream them to the browser.
 */
export async function runReview(options: RunReviewOptions): Promise<PRReview> {
  const {
    reviewId,
    prUrl,
    mode = 'full',
    context: _context,
    emit: _emit = () => {},
  } = options

  return withSpan(
    'harness.review',
    { 'review.id': reviewId, 'pr.url': prUrl, 'review.mode': mode },
    span => _runReview(options, span)
  )
}

async function _runReview(
  options: RunReviewOptions,
  rootSpan: import('@opentelemetry/api').Span
): Promise<PRReview> {
  const {
    reviewId,
    prUrl,
    mode = 'full',
    context,
    emit = () => {},
    conventionsDoc,
    overlays,
  } = options
  const { deps } = context

  const runStart = Date.now()
  let totalTokens = 0
  let totalCost = 0
  const phaseDurations: Record<string, number> = {}

  const priorRounds = await loadPriorRounds(prUrl, reviewId)
  const { roundCount, findingCount: priorFindingCount } =
    priorRoundStats(priorRounds)
  const priorLabel = formatPriorRoundsActivity(roundCount, priorFindingCount)
  console.log(
    JSON.stringify({
      prior_rounds_loaded: {
        reviewId,
        prUrl,
        roundCount,
        findingCount: priorFindingCount,
        titles: priorRounds.flatMap(r => r.findings.map(f => f.title)),
      },
    })
  )
  emit('progress', {
    tool: 'prior_rounds',
    args: { roundCount, findingCount: priorFindingCount },
    label: priorLabel,
  })

  // ── INPUT checkpoint ──────────────────────────────────────────────────────
  const inputStart = Date.now()
  await withSpan(
    'harness.review.input',
    { 'review.id': reviewId },
    async () => {
      await runCheckpoint({
        reviewId,
        stage: 'INPUT',
        store: deps.checkpoints,
        check: () =>
          Promise.resolve({
            pass: Boolean(prUrl),
            payload: { prUrl, mode },
            error: prUrl ? undefined : 'prUrl is required',
          }),
      })
    }
  )
  emit('checkpoint', { stage: 'INPUT', status: 'PASS', reviewId })
  phaseDurations.INPUT = Date.now() - inputStart

  // ── Phase 1: Context Agent ────────────────────────────────────────────────
  let enrichedContext: EnrichedContext
  const contextStart = Date.now()

  if (mode === 'quick') {
    // Minimal context from URL alone — skip the full agent loop
    enrichedContext = {
      prUrl,
      prTitle: 'Quick review',
      prAuthor: 'unknown',
      prBranch: 'unknown',
      diff: '',
      filesChanged: [],
      fileCoverage: [],
      ticketId: undefined,
      ticketSummary: undefined,
      ticketAcceptanceCriteria: [],
      pastReviewSummaries: [],
      memories: [],
      priorRounds,
      githubConversation: EMPTY_GITHUB_CONVERSATION,
      externalContextCalls: 0,
    }
  } else {
    const githubConversationPromise = loadGithubConversation(
      context.octokit,
      prUrl,
      reviewId
    )
    // Started before the context agent so the fetch overlaps the tool loop, and
    // applied after it so the model's transcription can never win.
    const groundTruthPromise = loadGroundTruthDiff(
      context.octokit,
      prUrl,
      reviewId
    )
    const ctxResult = await withSpan(
      'harness.review.context',
      { 'review.id': reviewId },
      async span => {
        const r = await runCheckpoint({
          reviewId,
          stage: 'CONTEXT',
          store: deps.checkpoints,
          check: async () => {
            const result = await runContextAgent({
              prUrl,
              reviewId,
              context,
              emit,
              priorRounds,
              overlay: overlays?.[OverlayAgent.CONTEXT],
            })
            return {
              pass: true,
              payload: result,
            }
          },
        })
        span.setAttributes({
          'tokens.context': r.tokensUsed,
          'files.changed': r.context.filesChanged.length,
          'external.calls': r.context.externalContextCalls,
        })
        return r
      }
    )
    const { pack: githubConversation, failed: githubFailed } =
      await githubConversationPromise
    const { itemCount, omitted } = githubConversationStats(githubConversation)
    const githubLabel = githubFailed
      ? formatGithubConversationFetchFailed()
      : formatGithubConversationActivity(githubConversation)
    console.log(
      JSON.stringify({
        github_conversation_loaded: {
          reviewId,
          itemCount,
          omitted,
          failed: githubFailed,
        },
      })
    )
    emit('progress', {
      tool: 'github_conversation',
      args: { itemCount, omitted, failed: githubFailed },
      label: githubLabel,
    })
    const groundTruth = await groundTruthPromise
    if (groundTruth) {
      emit('progress', {
        tool: 'ground_truth_diff',
        args: {
          files: groundTruth.filesChanged.length,
          truncated: groundTruth.fileCoverage.filter(
            c => c.status === 'TRUNCATED'
          ).length,
          skipped: groundTruth.fileCoverage.filter(c => c.status === 'SKIPPED')
            .length,
        },
        label: formatGroundTruthActivity(groundTruth),
      })
    }

    enrichedContext = {
      ...ctxResult.context,
      ...(groundTruth ?? {}),
      priorRounds,
      githubConversation,
    }
    totalTokens += ctxResult.tokensUsed
    totalCost += ctxResult.cost
    emit('checkpoint', { stage: 'CONTEXT', status: 'PASS', reviewId })
  }
  phaseDurations.CONTEXT = Date.now() - contextStart

  // ── Phase 2: Domain agents (parallel) ────────────────────────────────────
  const domainStart = Date.now()
  // Emit checkpoint events immediately; hold finding events until after merge
  // so the IDs the client receives match the merged PRReview exactly.
  const [
    correctnessResult,
    securityResult,
    conventionsResult,
    performanceResult,
    styleResult,
  ] = await withSpan(
    'harness.review.domain',
    { 'review.id': reviewId },
    async span => {
      const results = await Promise.all([
        runCorrectnessAgent({
          enrichedContext,
          model: deps.model,
          overlay: overlays?.[OverlayAgent.CORRECTNESS],
        }).then(r => {
          emit('checkpoint', {
            stage: 'DOMAIN',
            agentName: 'correctness',
            status: 'PASS',
            reviewId,
          })
          return r
        }),
        runSecurityAgent({
          enrichedContext,
          model: deps.model,
          overlay: overlays?.[OverlayAgent.SECURITY],
        }).then(r => {
          emit('checkpoint', {
            stage: 'DOMAIN',
            agentName: 'security',
            status: 'PASS',
            reviewId,
          })
          return r
        }),
        runConventionsAgent({
          enrichedContext,
          model: deps.model,
          conventionsDoc,
        }).then(r => {
          emit('checkpoint', {
            stage: 'DOMAIN',
            agentName: 'conventions',
            status: 'PASS',
            reviewId,
          })
          return r
        }),
        runPerformanceAgent({
          enrichedContext,
          model: deps.model,
          overlay: overlays?.[OverlayAgent.PERFORMANCE],
        }).then(r => {
          emit('checkpoint', {
            stage: 'DOMAIN',
            agentName: 'performance',
            status: 'PASS',
            reviewId,
          })
          return r
        }),
        runStyleAgent({
          enrichedContext,
          model: deps.model,
          overlay: overlays?.[OverlayAgent.STYLE],
        }).then(r => {
          emit('checkpoint', {
            stage: 'DOMAIN',
            agentName: 'style',
            status: 'PASS',
            reviewId,
          })
          return r
        }),
      ])
      span.setAttributes({
        'tokens.correctness': results[0].tokensUsed,
        'tokens.security': results[1].tokensUsed,
        'tokens.conventions': results[2].tokensUsed,
        'tokens.performance': results[3].tokensUsed,
        'tokens.style': results[4].tokensUsed,
        'findings.raw': results.reduce((n, r) => n + r.findings.length, 0),
      })
      return results
    }
  )
  totalTokens +=
    correctnessResult.tokensUsed +
    securityResult.tokensUsed +
    conventionsResult.tokensUsed +
    performanceResult.tokensUsed +
    styleResult.tokensUsed
  totalCost +=
    correctnessResult.cost +
    securityResult.cost +
    conventionsResult.cost +
    performanceResult.cost +
    styleResult.cost
  phaseDurations.DOMAIN = Date.now() - domainStart

  // ── Phase 3: Merge ────────────────────────────────────────────────────────
  const mergedFindings = applyFindingQualityFilters(
    mergeResults(
      prepareFindingsForMerge([
        correctnessResult,
        securityResult,
        conventionsResult,
        performanceResult,
        styleResult,
      ])
    ),
    enrichedContext
  )
  const { blockingIssues, suggestions, nits } = bucketFindings(mergedFindings)

  // Emit findings after merge so client IDs are stable and match the PRReview
  mergedFindings.forEach(f => emit('finding', { finding: f }))

  // ── Phase 4: Coordinator summary ──────────────────────────────────────────
  const outputStart = Date.now()
  const review: PRReview = await withSpan(
    'harness.review.output',
    { 'review.id': reviewId },
    async span => {
      const summaryRaw = await deps.model.chat(
        [
          {
            role: 'user',
            content: coordinatorSummaryPrompt(
              formatContextJsonForAgents(enrichedContext),
              JSON.stringify(mergedFindings, null, 2)
            ),
          },
        ],
        []
      )
      totalTokens +=
        summaryRaw.usage.inputTokens + summaryRaw.usage.outputTokens
      totalCost += summaryRaw.cost

      const summaryData = parseSummary(summaryRaw.text, enrichedContext)

      // ── OUTPUT checkpoint ───────────────────────────────────────────────
      const r = await runCheckpoint({
        reviewId,
        stage: 'OUTPUT',
        store: deps.checkpoints,
        check: () => {
          const parsed = PRReviewSchema.safeParse({
            reviewId,
            prUrl,
            summary: summaryData.summary,
            fileCoverage: enrichedContext.fileCoverage,
            ticketAlignment: summaryData.ticketAlignment,
            whatLooksGood: summaryData.whatLooksGood,
            blockingIssues,
            suggestions,
            nits,
            questions: summaryData.questions,
            testingRecommendations: summaryData.testingRecommendations,
            verdict: summaryData.verdict,
            verdictSummary: summaryData.verdictSummary,
            confidence:
              (correctnessResult.confidence +
                securityResult.confidence +
                conventionsResult.confidence +
                performanceResult.confidence +
                styleResult.confidence) /
              5,
          })
          return Promise.resolve({
            pass: parsed.success,
            payload: parsed.success ? parsed.data : ({} as PRReview),
            error: parsed.success ? undefined : parsed.error.message,
          })
        },
      })
      span.setAttributes({
        'tokens.summary':
          summaryRaw.usage.inputTokens + summaryRaw.usage.outputTokens,
        'review.verdict': summaryData.verdict,
      })
      return r
    }
  )
  phaseDurations.OUTPUT = Date.now() - outputStart

  const durationMs = Date.now() - runStart
  const findingsCount = mergedFindings.length
  const estimatedCostUsd = Math.round(totalCost * 10000) / 10000

  // ── Stamp root span with final aggregated stats ───────────────────────────
  rootSpan.setAttributes({
    'tokens.total': totalTokens,
    'cost.usd': estimatedCostUsd,
    'findings.count': findingsCount,
    'prior.rounds': roundCount,
    'prior.findings': priorFindingCount,
    'duration.ms': durationMs,
    'review.verdict': review.verdict,
  })

  // ── Emit observability stats ──────────────────────────────────────────────
  emit('stats', {
    tokensUsed: totalTokens,
    estimatedCostUsd,
    durationMs,
    findingsCount,
    priorRounds: roundCount,
    priorFindings: priorFindingCount,
    phaseDurations,
  })

  emit('checkpoint', { stage: 'OUTPUT', status: 'PASS', reviewId })
  emit('done', { reviewId, extras: extrasFromReview(review) })

  // ── Structured completion log (Railway-friendly) ──────────────────────────
  console.log(
    JSON.stringify({
      harness_run_complete: {
        reviewId,
        prUrl,
        tokensUsed: totalTokens,
        estimatedCostUsd,
        durationMs,
        findingsCount,
        priorRounds: roundCount,
        priorFindings: priorFindingCount,
        phaseDurations,
      },
    })
  )

  return review
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface SummaryData {
  summary: string
  whatLooksGood: string[]
  questions: string[]
  testingRecommendations: string[]
  verdict: PRReview['verdict']
  verdictSummary: string
  ticketAlignment: PRReview['ticketAlignment']
}

function parseSummary(text: string, ctx: EnrichedContext): SummaryData {
  const cleaned = text
    .replace(/^```(?:json)?\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim()

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const raw = JSON.parse(jsonMatch[0])
      return {
        summary: String(raw.summary ?? ''),
        whatLooksGood: Array.isArray(raw.whatLooksGood)
          ? raw.whatLooksGood
          : [],
        questions: Array.isArray(raw.questions) ? raw.questions : [],
        testingRecommendations: Array.isArray(raw.testingRecommendations)
          ? raw.testingRecommendations
          : [],
        verdict: isVerdict(raw.verdict) ? raw.verdict : 'COMMENT',
        verdictSummary: String(raw.verdictSummary ?? ''),
        ticketAlignment: Array.isArray(raw.ticketAlignment)
          ? raw.ticketAlignment
          : [],
      }
    } catch {
      // fall through
    }
  }

  return {
    summary: `Review of ${ctx.prUrl}`,
    whatLooksGood: [],
    questions: [],
    testingRecommendations: [],
    verdict: 'COMMENT',
    verdictSummary: 'Could not generate summary.',
    ticketAlignment: [],
  }
}

function isVerdict(v: unknown): v is PRReview['verdict'] {
  return v === 'APPROVE' || v === 'REQUEST_CHANGES' || v === 'COMMENT'
}

/**
 * Load compact prior-round findings for this PR. Empty on first review or
 * if the reviews table is unreachable — never fail the pipeline.
 */
async function loadPriorRounds(
  prUrl: string,
  reviewId: string
): Promise<PriorRound[]> {
  try {
    const rows = await listCompleteReviewsForPr(prUrl, {
      excludeId: reviewId,
      limit: MAX_PRIOR_ROUNDS,
    })
    return formatPriorRounds(rows)
  } catch (err) {
    console.warn(`[coordinator][${reviewId}] prior rounds load failed:`, err)
    return []
  }
}

/**
 * Load compacted GitHub conversation for this PR. Empty on missing token,
 * unparseable URL, or API failure — never fail the pipeline.
 */
/**
 * Fetch the PR's diff and file list straight from GitHub so the domain agents
 * read the real patches rather than the context agent's transcription of them.
 *
 * Returns null on any failure, in which case the context agent's own values
 * stand — a degraded review beats no review, and the pre-ATH-50 behaviour is
 * exactly that fallback.
 */
async function loadGroundTruthDiff(
  octokit: Octokit | null,
  prUrl: string,
  reviewId: string
): Promise<GroundTruthDiff | null> {
  if (!octokit) {
    console.warn(
      `[coordinator][${reviewId}] ground-truth diff skipped: no GitHub token`
    )
    return null
  }
  try {
    const parsed = parsePrUrl(prUrl)
    if (!parsed) return null
    const files = await fetchPrFiles(octokit, parsed)
    if (files.length === 0) return null
    return assembleGroundTruthDiff(files)
  } catch (err) {
    console.warn(
      `[coordinator][${reviewId}] ground-truth diff load failed:`,
      err
    )
    return null
  }
}

async function loadGithubConversation(
  octokit: Octokit | null,
  prUrl: string,
  reviewId: string
): Promise<{ pack: GithubConversationPack; failed: boolean }> {
  if (!octokit) {
    console.warn(
      `[coordinator][${reviewId}] GitHub conversation skipped: no GitHub token`
    )
    return { pack: EMPTY_GITHUB_CONVERSATION, failed: true }
  }
  try {
    const parsed = parsePrUrl(prUrl)
    if (!parsed) {
      return { pack: EMPTY_GITHUB_CONVERSATION, failed: true }
    }
    const result = await fetchPrConversation(octokit, parsed)
    if (result.error) {
      console.warn(
        `[coordinator][${reviewId}] GitHub conversation load failed:`,
        result.error
      )
      return { pack: EMPTY_GITHUB_CONVERSATION, failed: true }
    }
    return { pack: formatGithubConversation(result.items), failed: false }
  } catch (err) {
    console.warn(
      `[coordinator][${reviewId}] GitHub conversation load failed:`,
      err
    )
    return { pack: EMPTY_GITHUB_CONVERSATION, failed: true }
  }
}
