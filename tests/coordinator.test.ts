import type { Octokit } from '@octokit/rest'
import { runReview } from '../src/agents/pr-review/coordinator'
import type { ReviewContext } from '../src/harness/context'
import type { ModelClient, ModelReply } from '../src/harness/models'
import { InMemoryCheckpointStore } from '../src/harness/checkpoints'
import type { ToolRegistry } from '../src/harness/tools'
import { dispatch } from '../src/harness/tools'
import { listCompleteReviewsForPr } from '../src/memory/review-store'
import { fetchPrConversation, fetchPrFiles } from '../src/tools/github'
import { runContextAgent } from '../src/agents/pr-review/context-agent'
import {
  GithubCommentKind,
  GithubCommentSource,
} from '../src/lib/github-conversation'

jest.mock('../src/memory/review-store', () => ({
  listCompleteReviewsForPr: jest.fn().mockResolvedValue([]),
}))

jest.mock('../src/tools/github', () => ({
  fetchPrConversation: jest.fn().mockResolvedValue({ items: [] }),
  fetchPrFiles: jest.fn().mockResolvedValue([]),
}))

jest.mock('../src/agents/pr-review/context-agent', () => ({
  runContextAgent: jest.fn(),
}))

const mockListCompleteReviewsForPr =
  listCompleteReviewsForPr as jest.MockedFunction<
    typeof listCompleteReviewsForPr
  >

const mockFetchPrConversation = fetchPrConversation as jest.MockedFunction<
  typeof fetchPrConversation
>

const mockFetchPrFiles = fetchPrFiles as jest.MockedFunction<
  typeof fetchPrFiles
>

const mockRunContextAgent = runContextAgent as jest.MockedFunction<
  typeof runContextAgent
>

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeModelReply(text: string): ModelReply {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50 },
    model: 'claude-test',
    cost: 0,
  }
}

function makeEmptyDomainResult(domain: string): string {
  return JSON.stringify({
    domain,
    findings: [],
    confidence: 0.9,
    tokensUsed: 50,
    durationMs: 100,
  })
}

function makeSummaryJson(): string {
  return JSON.stringify({
    summary: 'Clean PR with minor improvements.',
    whatLooksGood: ['Good test coverage'],
    questions: [],
    testingRecommendations: ['Run integration tests'],
    verdict: 'APPROVE',
    verdictSummary: 'No blocking issues found.',
    ticketAlignment: [],
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runReview (coordinator)', () => {
  let callCount: number
  let mockModel: ModelClient

  beforeEach(() => {
    callCount = 0
    mockListCompleteReviewsForPr.mockReset()
    mockListCompleteReviewsForPr.mockResolvedValue([])
    mockFetchPrConversation.mockReset()
    mockFetchPrConversation.mockResolvedValue({ items: [] })
    mockFetchPrFiles.mockReset()
    mockFetchPrFiles.mockResolvedValue([])
    mockRunContextAgent.mockReset()
    mockModel = {
      chat: jest.fn(async (_messages, _tools, _systemPrompt) => {
        callCount++
        // Call sequence in quick mode (5 domain agents run in parallel, then 1 summary):
        // 1–5 = correctness / security / conventions / performance / style (parallel, any order)
        // 6   = coordinator summary
        //
        // In full mode an extra context-agent call fires first (callCount 1),
        // shifting domain calls to 2–6 and summary to 7. All current tests use
        // quick mode, so we only need to handle up to call 6.
        if (callCount <= 5)
          return makeModelReply(makeEmptyDomainResult('CORRECTNESS'))
        return makeModelReply(makeSummaryJson())
      }),
    }
  })

  function makeContext(octokit: Octokit | null = null): ReviewContext {
    const checkpoints = new InMemoryCheckpointStore()
    const registry: ToolRegistry = {}
    return {
      deps: {
        model: mockModel,
        memory: {
          getMemories: async () => [],
          createMemory: async () => {},
          searchReviews: async () => [],
          storeReview: async () => {},
          searchCode: async () => [],
        },
        checkpoints,
      },
      registry,
      dispatcher: _reviewId => call => dispatch(call, registry, _reviewId),
      octokit,
    }
  }

  function stubOctokit(): Octokit {
    return {} as Octokit
  }

  it('runs the full pipeline and returns a PRReview in quick mode', async () => {
    const context = makeContext()
    const events: Array<{ event: string; data: unknown }> = []

    const review = await runReview({
      reviewId: 'test-rev-1',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'quick', // skips context agent loop
      context,
      emit: (event, data) => events.push({ event, data }),
    })

    expect(review.reviewId).toBe('test-rev-1')
    expect(review.prUrl).toBe('https://github.com/owner/repo/pull/1')
    expect(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).toContain(review.verdict)
    expect(events.some(e => e.event === 'done')).toBe(true)
    expect(events.some(e => e.event === 'checkpoint')).toBe(true)
    expect(events).toContainEqual({
      event: 'progress',
      data: {
        tool: 'prior_rounds',
        args: { roundCount: 0, findingCount: 0 },
        label: 'No prior review rounds',
      },
    })
    expect(mockFetchPrConversation).not.toHaveBeenCalled()
    const userContents = (mockModel.chat as jest.Mock).mock.calls.map(
      call => call[0][0].content as string
    )
    expect(userContents.some(c => c.includes('<github_conversation>'))).toBe(
      true
    )
    expect(userContents.some(c => c.includes('"omitted": false'))).toBe(true)
    expect(userContents.every(c => !c.includes('"githubConversation"'))).toBe(
      true
    )
  })

  it('emits the SSE done event at the end', async () => {
    const context = makeContext()
    const emitted: string[] = []

    await runReview({
      reviewId: 'test-rev-2',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'quick',
      context,
      emit: event => emitted.push(event),
    })

    expect(emitted).toContain('done')
  })

  it('writes checkpoints to the store', async () => {
    const context = makeContext()

    await runReview({
      reviewId: 'test-rev-3',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'quick',
      context,
    })

    const inputCp = await context.deps.checkpoints.load('test-rev-3', 'INPUT')
    expect(inputCp).not.toBeNull()
    expect(inputCp?.status).toBe('PASS')
  })

  it('calls the SSE emitter when reviewId is present', async () => {
    const context = makeContext()
    const emit = jest.fn()

    await runReview({
      reviewId: 'test-rev-4',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'quick',
      context,
      emit,
    })

    expect(emit).toHaveBeenCalledWith(
      'done',
      expect.objectContaining({
        reviewId: 'test-rev-4',
        extras: expect.objectContaining({
          summary: 'Clean PR with minor improvements.',
          whatLooksGood: ['Good test coverage'],
          testingRecommendations: ['Run integration tests'],
        }),
      })
    )
  })

  it('does not call SSE emitter when reviewId is absent', async () => {
    // Just check the default no-op emit doesn't throw
    const context = makeContext()
    await expect(
      runReview({
        reviewId: 'test-rev-5',
        prUrl: 'https://github.com/owner/repo/pull/1',
        mode: 'quick',
        context,
        // emit not provided — defaults to no-op
      })
    ).resolves.toBeDefined()
  })

  it('injects priorRounds into domain-agent context on re-review', async () => {
    mockListCompleteReviewsForPr.mockResolvedValue([
      {
        id: 'rev-old',
        created_at: '2026-08-16T00:00:00Z',
        result: {
          summary: 'Auth callback leak',
          blockingIssues: [
            {
              id: 'f1',
              severity: 'BLOCKING',
              category: 'SECURITY',
              file: 'src/auth.ts',
              line: 10,
              title: 'Token not cleared on reject',
              body: 'should not appear',
              confidence: 0.9,
            },
          ],
          suggestions: [],
          nits: [],
        },
        submission: {
          decisions: [{ findingId: 'f1', action: 'ACCEPT' }],
        },
      },
    ])
    const context = makeContext()
    const emit = jest.fn()
    const logs: string[] = []
    const logSpy = jest.spyOn(console, 'log').mockImplementation(msg => {
      logs.push(String(msg))
    })

    await runReview({
      reviewId: 'test-rev-6',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'quick',
      context,
      emit,
    })

    logSpy.mockRestore()

    expect(mockListCompleteReviewsForPr).toHaveBeenCalledWith(
      'https://github.com/owner/repo/pull/1',
      { excludeId: 'test-rev-6', limit: 3 }
    )
    const userContents = (mockModel.chat as jest.Mock).mock.calls.map(
      call => call[0][0].content as string
    )
    expect(
      userContents.some(c => c.includes('Token not cleared on reject'))
    ).toBe(true)
    expect(userContents.some(c => c.includes('"action": "ACCEPT"'))).toBe(true)
    expect(userContents.some(c => c.includes('should not appear'))).toBe(false)
    expect(emit).toHaveBeenCalledWith('progress', {
      tool: 'prior_rounds',
      args: { roundCount: 1, findingCount: 1 },
      label: 'Loaded 1 prior finding from 1 round of this PR',
    })
    const loaded = logs
      .map(l => {
        try {
          return JSON.parse(l) as {
            prior_rounds_loaded?: {
              roundCount: number
              findingCount: number
              titles: string[]
            }
          }
        } catch {
          return {}
        }
      })
      .find(o => o.prior_rounds_loaded)
    expect(loaded?.prior_rounds_loaded).toMatchObject({
      roundCount: 1,
      findingCount: 1,
      titles: ['Token not cleared on reject'],
    })
    expect(
      logs.some(l => {
        try {
          const parsed = JSON.parse(l) as {
            harness_run_complete?: {
              priorRounds: number
              priorFindings: number
            }
          }
          return (
            parsed.harness_run_complete?.priorRounds === 1 &&
            parsed.harness_run_complete?.priorFindings === 1
          )
        } catch {
          return false
        }
      })
    ).toBe(true)
  })

  it('continues the review when prior-round load fails', async () => {
    mockListCompleteReviewsForPr.mockRejectedValue(new Error('DB down'))
    const context = makeContext()
    await expect(
      runReview({
        reviewId: 'test-rev-7',
        prUrl: 'https://github.com/owner/repo/pull/1',
        mode: 'quick',
        context,
      })
    ).resolves.toBeDefined()
  })

  function mockFullContextAgent() {
    mockRunContextAgent.mockResolvedValue({
      context: {
        prUrl: 'https://github.com/owner/repo/pull/1',
        prTitle: 'Feature',
        prAuthor: 'alice',
        prBranch: 'feat',
        diff: 'diff --git a/foo.ts b/foo.ts',
        filesChanged: ['foo.ts'],
        fileCoverage: [{ file: 'foo.ts', status: 'READ' }],
        externalContextCalls: 2,
      },
      tokensUsed: 10,
      cost: 0,
    })
  }

  it('overwrites githubConversation in full mode even when context JSON omits it', async () => {
    mockFullContextAgent()
    mockFetchPrConversation.mockResolvedValue({
      items: [
        {
          kind: GithubCommentKind.DISCUSSION,
          source: GithubCommentSource.HUMAN,
          id: 7,
          author: 'bob',
          createdAt: '2026-08-01T00:00:00Z',
          body: 'Please keep the public API stable',
        },
      ],
    })
    const context = makeContext(stubOctokit())
    const emit = jest.fn()

    await runReview({
      reviewId: 'test-rev-8',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'full',
      context,
      emit,
    })

    expect(mockFetchPrConversation).toHaveBeenCalledTimes(1)
    const userContents = (mockModel.chat as jest.Mock).mock.calls.map(
      call => call[0][0].content as string
    )
    expect(
      userContents.some(c => c.includes('Please keep the public API stable'))
    ).toBe(true)
    expect(userContents.some(c => c.includes('<github_conversation>'))).toBe(
      true
    )
    expect(userContents.some(c => c.includes('"kind": "DISCUSSION"'))).toBe(
      true
    )
    expect(emit).toHaveBeenCalledWith('progress', {
      tool: 'github_conversation',
      args: { itemCount: 1, omitted: false, failed: false },
      label: 'Loaded 1 GitHub comment',
    })
  })

  it('overwrites a githubConversation pack invented by the context agent', async () => {
    mockRunContextAgent.mockResolvedValue({
      context: {
        prUrl: 'https://github.com/owner/repo/pull/1',
        prTitle: 'Feature',
        prAuthor: 'alice',
        prBranch: 'feat',
        diff: 'diff --git a/foo.ts b/foo.ts',
        filesChanged: ['foo.ts'],
        fileCoverage: [{ file: 'foo.ts', status: 'READ' }],
        githubConversation: {
          items: [
            {
              kind: GithubCommentKind.DISCUSSION,
              id: 999,
              createdAt: '2026-01-01T00:00:00Z',
              body: 'model-invented pack must not win',
            },
          ],
          omitted: false,
        },
        externalContextCalls: 2,
      },
      tokensUsed: 10,
      cost: 0,
    })
    mockFetchPrConversation.mockResolvedValue({
      items: [
        {
          kind: GithubCommentKind.DISCUSSION,
          source: GithubCommentSource.HUMAN,
          id: 7,
          author: 'bob',
          createdAt: '2026-08-01T00:00:00Z',
          body: 'Please keep the public API stable',
        },
      ],
    })
    const context = makeContext(stubOctokit())

    await runReview({
      reviewId: 'test-rev-13',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'full',
      context,
    })

    const userContents = (mockModel.chat as jest.Mock).mock.calls.map(
      call => call[0][0].content as string
    )
    expect(
      userContents.some(c => c.includes('Please keep the public API stable'))
    ).toBe(true)
    expect(
      userContents.some(c => c.includes('model-invented pack must not win'))
    ).toBe(false)
  })

  describe('ground-truth diff (ATH-50)', () => {
    // The context agent's JSON is the model's transcription of the diff, capped
    // by an 8192-token output budget. It must never beat the real patches.
    function mockElidingContextAgent() {
      mockRunContextAgent.mockResolvedValue({
        context: {
          prUrl: 'https://github.com/owner/repo/pull/1',
          prTitle: 'Feature',
          prAuthor: 'alice',
          prBranch: 'feat',
          diff: 'diff --git a/foo.ts b/foo.ts\n@@\n+function getTier() { ... }',
          filesChanged: ['foo.ts'],
          fileCoverage: [{ file: 'foo.ts', status: 'READ' }],
          externalContextCalls: 2,
        },
        tokensUsed: 10,
        cost: 0,
      })
    }

    function agentContexts(): string[] {
      return (mockModel.chat as jest.Mock).mock.calls.map(
        call => call[0][0].content as string
      )
    }

    it('replaces the transcribed diff with the real patches', async () => {
      mockElidingContextAgent()
      mockFetchPrFiles.mockResolvedValue([
        {
          filename: 'foo.ts',
          patch: '@@ -1 +1 @@\n+function getTier() { return REAL_BODY }',
        },
      ])

      await runReview({
        reviewId: 'test-rev-gt-1',
        prUrl: 'https://github.com/owner/repo/pull/1',
        mode: 'full',
        context: makeContext(stubOctokit()),
      })

      const contexts = agentContexts()
      expect(contexts.some(c => c.includes('REAL_BODY'))).toBe(true)
      expect(contexts.some(c => c.includes('getTier() { ... }'))).toBe(false)
    })

    it('replaces self-reported READ coverage with the computed status', async () => {
      mockElidingContextAgent()
      mockFetchPrFiles.mockResolvedValue([
        { filename: 'foo.ts', patch: undefined },
      ])

      await runReview({
        reviewId: 'test-rev-gt-2',
        prUrl: 'https://github.com/owner/repo/pull/1',
        mode: 'full',
        context: makeContext(stubOctokit()),
      })

      const contexts = agentContexts()
      expect(contexts.some(c => c.includes('"status": "SKIPPED"'))).toBe(true)
      expect(contexts.some(c => c.includes('"status": "READ"'))).toBe(false)
    })

    it('reports the fetch on the activity feed', async () => {
      mockElidingContextAgent()
      mockFetchPrFiles.mockResolvedValue([
        { filename: 'foo.ts', patch: '@@ -1 +1 @@\n+ok' },
      ])
      const emit = jest.fn()

      await runReview({
        reviewId: 'test-rev-gt-3',
        prUrl: 'https://github.com/owner/repo/pull/1',
        mode: 'full',
        context: makeContext(stubOctokit()),
        emit,
      })

      expect(emit).toHaveBeenCalledWith('progress', {
        tool: 'ground_truth_diff',
        args: { files: 1, truncated: 0, skipped: 0 },
        label: '📄 Diff loaded from GitHub (1 files)',
      })
    })

    it('falls back to the context agent when the fetch throws', async () => {
      mockElidingContextAgent()
      mockFetchPrFiles.mockRejectedValue(new Error('API down'))
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

      const review = await runReview({
        reviewId: 'test-rev-gt-4',
        prUrl: 'https://github.com/owner/repo/pull/1',
        mode: 'full',
        context: makeContext(stubOctokit()),
      })

      warnSpy.mockRestore()
      expect(review.reviewId).toBe('test-rev-gt-4')
      expect(agentContexts().some(c => c.includes('getTier() { ... }'))).toBe(
        true
      )
    })

    it('skips the fetch when there is no GitHub token', async () => {
      mockElidingContextAgent()
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

      await runReview({
        reviewId: 'test-rev-gt-5',
        prUrl: 'https://github.com/owner/repo/pull/1',
        mode: 'full',
        context: makeContext(null),
      })

      warnSpy.mockRestore()
      expect(mockFetchPrFiles).not.toHaveBeenCalled()
    })

    it('does not fetch when the PR URL cannot be parsed', async () => {
      mockElidingContextAgent()

      await runReview({
        reviewId: 'test-rev-gt-6',
        prUrl: 'https://example.com/not-a-pr',
        mode: 'full',
        context: makeContext(stubOctokit()),
      })

      expect(mockFetchPrFiles).not.toHaveBeenCalled()
    })

    it('does not fetch in quick mode', async () => {
      await runReview({
        reviewId: 'test-rev-gt-7',
        prUrl: 'https://github.com/owner/repo/pull/1',
        mode: 'quick',
        context: makeContext(stubOctokit()),
      })

      expect(mockFetchPrFiles).not.toHaveBeenCalled()
    })
  })

  it('continues CONTEXT when GitHub conversation fetch throws', async () => {
    mockFullContextAgent()
    mockFetchPrConversation.mockRejectedValue(new Error('API down'))
    const context = makeContext(stubOctokit())
    const emit = jest.fn()
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const review = await runReview({
      reviewId: 'test-rev-9',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'full',
      context,
      emit,
    })

    warnSpy.mockRestore()
    expect(review.reviewId).toBe('test-rev-9')
    expect(emit).toHaveBeenCalledWith('progress', {
      tool: 'github_conversation',
      args: { itemCount: 0, omitted: false, failed: true },
      label: 'GitHub conversation unavailable',
    })
    const userContents = (mockModel.chat as jest.Mock).mock.calls.map(
      call => call[0][0].content as string
    )
    expect(userContents.some(c => c.includes('<github_conversation>'))).toBe(
      true
    )
    expect(userContents.every(c => !c.includes('"githubConversation"'))).toBe(
      true
    )
  })

  it('treats fetch error field as a miss without failing CONTEXT', async () => {
    mockFullContextAgent()
    mockFetchPrConversation.mockResolvedValue({
      items: [],
      error: 'rate limited',
    })
    const context = makeContext(stubOctokit())
    const emit = jest.fn()
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    await runReview({
      reviewId: 'test-rev-10',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'full',
      context,
      emit,
    })

    warnSpy.mockRestore()
    expect(emit).toHaveBeenCalledWith(
      'progress',
      expect.objectContaining({
        tool: 'github_conversation',
        label: 'GitHub conversation unavailable',
      })
    )
  })

  it('does not fetch when the PR URL cannot be parsed', async () => {
    mockFullContextAgent()
    const context = makeContext(stubOctokit())
    const emit = jest.fn()

    await runReview({
      reviewId: 'test-rev-11',
      prUrl: 'https://example.com/not-a-pr',
      mode: 'full',
      context,
      emit,
    })

    expect(mockFetchPrConversation).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(
      'progress',
      expect.objectContaining({
        tool: 'github_conversation',
        label: 'GitHub conversation unavailable',
      })
    )
  })

  it('skips GitHub conversation fetch when octokit is null', async () => {
    mockFullContextAgent()
    const context = makeContext(null)
    const emit = jest.fn()
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    await runReview({
      reviewId: 'test-rev-12',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'full',
      context,
      emit,
    })

    warnSpy.mockRestore()
    expect(mockFetchPrConversation).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('progress', {
      tool: 'github_conversation',
      args: { itemCount: 0, omitted: false, failed: true },
      label: 'GitHub conversation unavailable',
    })
  })

  it('downgrades an ATH-16-style hedged BLOCKING finding before emit', async () => {
    mockModel.chat = jest.fn(async (messages, _tools, systemPrompt) => {
      const content = String(messages[0]?.content ?? '')
      if (content.includes('write the final review summary')) {
        return makeModelReply(makeSummaryJson())
      }
      if (
        typeof systemPrompt === 'string' &&
        systemPrompt.includes('correctness review')
      ) {
        return makeModelReply(
          JSON.stringify({
            domain: 'CORRECTNESS',
            findings: [
              {
                id: 'ath-16',
                severity: 'BLOCKING',
                category: 'CORRECTNESS',
                file: 'app/api/webhooks/github/route.ts',
                line: 40,
                title: '204 for non-PR events returned after full auth',
                body: 'The real issue is that the 204 for non-PR events is returned correctly only after full auth — this appears correct. No blocking issue here on re-examination.',
                confidence: 0.85,
              },
            ],
            confidence: 0.8,
          })
        )
      }
      return makeModelReply(makeEmptyDomainResult('SECURITY'))
    })

    const emit = jest.fn()
    const review = await runReview({
      reviewId: 'test-rev-13',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'quick',
      context: makeContext(),
      emit,
    })

    expect(review.blockingIssues).toHaveLength(0)
    expect(review.suggestions).toEqual([
      expect.objectContaining({
        id: 'ath-16',
        severity: 'SUGGESTION',
      }),
    ])
    expect(review.suggestions[0].body).toContain(
      '*(severity auto-adjusted: rationale hedged)*'
    )
    expect(emit).toHaveBeenCalledWith(
      'finding',
      expect.objectContaining({
        finding: expect.objectContaining({
          id: 'ath-16',
          severity: 'SUGGESTION',
        }),
      })
    )
  })

  it('passes per-agent overlays into domain system prompts', async () => {
    await runReview({
      reviewId: 'test-rev-overlay',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'quick',
      overlays: { PERFORMANCE: 'Flag useEffect fetch' },
      context: makeContext(),
    })
    const systemPrompts = (mockModel.chat as jest.Mock).mock.calls.map(
      call => call[2] as string
    )
    expect(systemPrompts.some(s => s.includes('Flag useEffect fetch'))).toBe(
      true
    )
    expect(systemPrompts.some(s => s.includes('<operator-overlay>'))).toBe(true)
  })

  it('passes the context overlay to the context agent in full mode', async () => {
    mockFullContextAgent()
    await runReview({
      reviewId: 'test-rev-overlay-ctx',
      prUrl: 'https://github.com/owner/repo/pull/1',
      mode: 'full',
      overlays: { CONTEXT: 'Also search RIB-' },
      context: makeContext(stubOctokit()),
    })
    expect(mockRunContextAgent).toHaveBeenCalledWith(
      expect.objectContaining({ overlay: 'Also search RIB-' })
    )
  })

  it('does not fail CONTEXT when the context agent omits the diff', async () => {
    mockRunContextAgent.mockResolvedValue({
      context: {
        prUrl: 'https://github.com/owner/repo/pull/1',
        prTitle: 'Feature',
        prAuthor: 'alice',
        prBranch: 'feat',
        diff: '',
        filesChanged: [],
        fileCoverage: [],
        externalContextCalls: 2,
      },
      tokensUsed: 10,
      cost: 0,
    })
    mockFetchPrFiles.mockResolvedValue([
      {
        filename: 'foo.ts',
        patch: '@@ -1 +1 @@\n+export const ok = true',
      },
    ])
    await expect(
      runReview({
        reviewId: 'test-rev-no-diff',
        prUrl: 'https://github.com/owner/repo/pull/1',
        mode: 'full',
        context: makeContext(stubOctokit()),
      })
    ).resolves.toBeDefined()

    const contexts = (mockModel.chat as jest.Mock).mock.calls.map(
      call => call[0][0].content as string
    )
    expect(contexts.some(c => c.includes('export const ok = true'))).toBe(true)
  })
})
