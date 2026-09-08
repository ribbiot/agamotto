'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import {
  storedReviewUiState,
  type StoredReviewPayload,
} from '../../../src/lib/stored-review-ui'
import type { SiblingReviewNav } from '../../../src/lib/review-siblings'
import { formatPriorRoundsActivity } from '../../../src/lib/prior-rounds'
import {
  formatGithubConversationActivityLabel,
  formatGithubConversationFetchFailed,
} from '../../../src/lib/github-conversation'
import {
  formatTokenUsage,
  type ReviewRunStatsPayload,
} from '../../../src/lib/review-run-stats'
import {
  FinalizeBannerTone,
  buildFinalizeBanner,
  githubCommentPosted,
  type FinalizeBanner,
} from '../../../src/lib/finalize-comment'
import {
  finalizeDecisionsFromUi,
  formatReviewCommentFromUi,
} from '../../../src/lib/review-comment-copy'
import {
  findingCategories,
  ReviewSection,
} from '../../../src/agents/pr-review/schema'
import { formatConfidencePercent } from '../../../src/lib/confidence-bar'
import { ConfidenceBar } from '../../components/ConfidenceBar'
import {
  IncludeAllState,
  allCardsCollapsed,
  collapsedShadeMap,
  displayedSectionText,
  extrasFromReview,
  findingShadeKey,
  hydrateSectionUi,
  includeAllState,
  reviewShadeKeys,
  sectionDecisionsFromUi,
  sectionHasContent,
  sectionShadeKey,
  visibleReviewSections,
  type ReviewCommentExtras,
  type UiSectionDecision,
} from '../../../src/lib/review-sections'

interface Finding {
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

interface FindingDecision {
  findingId: string
  accepted: boolean
  editedTitle?: string
  editedBody?: string
}

enum SubmitKind {
  SAVE = 'SAVE',
  POST = 'POST',
  APPROVE = 'APPROVE',
}
type StreamStatus = 'connecting' | 'running' | 'done' | 'error'
type PhaseStatus = 'pending' | 'running' | 'done' | 'error'

interface ActivityEntry {
  id: number
  type: 'tool' | 'phase' | 'finding' | 'alarm'
  text: string
}

const SEVERITY_STYLES: Record<Finding['severity'], string> = {
  BLOCKING: 'border-red-600 bg-red-950/30',
  SUGGESTION: 'border-yellow-600 bg-yellow-950/30',
  NIT: 'border-gray-700 bg-gray-900/50',
}

const SEVERITY_BADGE: Record<Finding['severity'], string> = {
  BLOCKING: 'bg-red-700 text-red-100',
  SUGGESTION: 'bg-yellow-700 text-yellow-100',
  NIT: 'bg-gray-700 text-gray-300',
}

const SECTION_CARD: Record<ReviewSection, string> = {
  [ReviewSection.PREAMBLE]: 'border-indigo-800 bg-gray-900',
  [ReviewSection.TICKET_ALIGNMENT]: 'border-amber-800 bg-amber-950/20',
  [ReviewSection.WHAT_LOOKS_GOOD]: 'border-green-800 bg-green-950/20',
  [ReviewSection.QUESTIONS]: 'border-violet-800 bg-violet-950/20',
  [ReviewSection.TESTING_RECOMMENDATIONS]: 'border-sky-800 bg-sky-950/20',
}

const SECTION_LABEL: Record<ReviewSection, string> = {
  [ReviewSection.PREAMBLE]: 'Preamble',
  [ReviewSection.TICKET_ALIGNMENT]: 'Acceptance Criteria alignment',
  [ReviewSection.WHAT_LOOKS_GOOD]: 'What looks good',
  [ReviewSection.QUESTIONS]: 'Questions',
  [ReviewSection.TESTING_RECOMMENDATIONS]: 'Testing recommendations',
}

const PIPELINE: { key: string; label: string }[] = [
  { key: 'INPUT', label: 'Input validation' },
  { key: 'CONTEXT', label: 'Context agent' },
  { key: 'DOMAIN', label: 'Domain agents' },
  { key: 'OUTPUT', label: 'Final review' },
]

function formatTool(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'fetch_pr_diff':
      return 'Reading PR diff…'
    case 'fetch_pr_files':
      return 'Listing changed files…'
    case 'fetch_ticket':
      return `Fetching ticket ${args.ticketId ?? ''}…`
    case 'search_past_reviews':
      return `Searching history: ${args.file ?? ''}…`
    case 'prior_rounds':
      return formatPriorRoundsActivity(
        Number(args.roundCount ?? 0),
        Number(args.findingCount ?? 0)
      )
    case 'github_conversation':
      // args.failed is set when the GitHub conversation fetch failed entirely
      if (args.failed) return formatGithubConversationFetchFailed()
      return formatGithubConversationActivityLabel(
        Number(args.itemCount ?? 0),
        Boolean(args.omitted)
      )
    default:
      return tool.replace(/_/g, ' ') + '…'
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

const BANNER_TONE_CLASS: Record<FinalizeBannerTone, string> = {
  [FinalizeBannerTone.SUCCESS]:
    'border-green-700 bg-green-950/40 text-green-400',
  [FinalizeBannerTone.WARNING]:
    'border-amber-700 bg-amber-950/40 text-amber-300',
  [FinalizeBannerTone.ERROR]: 'border-red-800 bg-red-950/40 text-red-400',
}

function SubmitBannerView({
  banner,
  copied,
  onCopy,
}: {
  banner: FinalizeBanner
  copied: boolean
  onCopy: (text: string) => void
}) {
  const copyBody = banner.copyBody
  return (
    <div
      className={`rounded-lg border px-4 py-2.5 text-sm font-medium ${BANNER_TONE_CLASS[banner.tone]}`}
    >
      <p>
        {banner.message}
        {banner.detail && (
          <span
            className="ml-1.5 cursor-help text-xs font-normal text-amber-500/80 underline decoration-dotted underline-offset-2"
            title={banner.detail}
          >
            Details
          </span>
        )}
      </p>
      {copyBody && (
        <button
          type="button"
          onClick={() => onCopy(copyBody)}
          className="mt-2 rounded bg-gray-800 px-3 py-1 text-xs font-semibold text-white hover:bg-gray-700"
        >
          {copied ? 'Copied' : 'Copy review'}
        </button>
      )}
    </div>
  )
}

interface Props {
  reviewId: string
  prUrl: string
  mode?: 'full' | 'quick'
  storedResult?: StoredReviewPayload | null
  storedSubmission?: unknown
  siblingNav?: SiblingReviewNav | null
}

export function ReviewShell({
  reviewId,
  prUrl,
  mode = 'full',
  storedResult = null,
  storedSubmission = null,
  siblingNav = null,
}: Props) {
  const hydrated = storedReviewUiState(storedResult, storedSubmission)
  const [status, setStatus] = useState<StreamStatus>(
    hydrated?.status ?? 'connecting'
  )
  const [findings, setFindings] = useState<Finding[]>(hydrated?.findings ?? [])
  const [decisions, setDecisions] = useState<Record<string, FindingDecision>>(
    hydrated?.decisions ?? {}
  )
  const [commentExtras, setCommentExtras] = useState<ReviewCommentExtras>(
    hydrated?.extras ?? {}
  )
  const [sections, setSections] = useState<
    Record<ReviewSection, UiSectionDecision>
  >(hydrated?.sections ?? hydrateSectionUi({}))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')
  const [editingSection, setEditingSection] = useState<ReviewSection | null>(
    null
  )
  const [sectionEditBody, setSectionEditBody] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [submitKind, setSubmitKind] = useState<SubmitKind | null>(null)
  const [postedToGitHub, setPostedToGitHub] = useState(
    hydrated?.postedToGitHub ?? false
  )
  const [submitResult, setSubmitResult] = useState<FinalizeBanner | null>(null)
  const [copied, setCopied] = useState(false)
  const [phaseStatuses, setPhaseStatuses] = useState<
    Record<string, PhaseStatus>
  >(
    hydrated?.phaseStatuses ?? {
      INPUT: 'running',
      CONTEXT: 'pending',
      DOMAIN: 'pending',
      OUTPUT: 'pending',
    }
  )
  const [activity, setActivity] = useState<ActivityEntry[]>(
    hydrated?.activity.map((entry, i) => ({ ...entry, id: i + 1 })) ?? []
  )
  const [elapsed, setElapsed] = useState(0)
  const [isCachedReview, setIsCachedReview] = useState(
    hydrated?.isCachedReview ?? false
  )
  const [runStats, setRunStats] = useState<ReviewRunStatsPayload | null>(null)
  const startTimeRef = useRef(Date.now())
  const domainDoneRef = useRef(0)
  const streamFailedRef = useRef(false)
  const esRef = useRef<EventSource | null>(null)
  const activityListRef = useRef<HTMLDivElement | null>(null)
  const activitySeqRef = useRef(hydrated?.activity.length ?? 0)

  // Tick elapsed while running — skip for cache replays (no meaningful duration)
  useEffect(() => {
    if (status !== 'running' || isCachedReview) return
    const t = setInterval(
      () => setElapsed(Date.now() - startTimeRef.current),
      1000
    )
    return () => clearInterval(t)
  }, [status, isCachedReview])

  // Keep the activity log pinned to the latest event without scrolling the page
  useEffect(() => {
    const container = activityListRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [activity])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [reviewId])

  function addActivity(entry: Omit<ActivityEntry, 'id'>) {
    setActivity(prev => [...prev, { ...entry, id: ++activitySeqRef.current }])
  }

  useEffect(() => {
    // COMPLETE hydrate is passed from the server page — skip EventSource
    // entirely (do not open-then-close). Pager hops remount via key={reviewId}.
    if (storedResult) return

    streamFailedRef.current = false
    const es = new EventSource(
      `/api/review/${reviewId}?prUrl=${encodeURIComponent(prUrl)}&mode=${mode}`
    )
    esRef.current = es

    es.addEventListener('connected', e => {
      const data = JSON.parse((e as MessageEvent).data ?? '{}')
      setStatus('running')
      addActivity({
        type: 'phase',
        text: data.cached
          ? '⚡ Loaded from cache'
          : '⚡ Connected to review stream',
      })
      if (data.cached) setIsCachedReview(true)
    })

    es.addEventListener('checkpoint', e => {
      const data = JSON.parse(e.data)
      if (data.stage === 'INPUT') {
        setPhaseStatuses(p => ({ ...p, INPUT: 'done', CONTEXT: 'running' }))
        addActivity({
          type: 'phase',
          text: '✓ Input validated — starting context agent',
        })
      } else if (data.stage === 'CONTEXT') {
        setPhaseStatuses(p => ({ ...p, CONTEXT: 'done', DOMAIN: 'running' }))
        addActivity({
          type: 'phase',
          text: '✓ Context gathered — running domain agents',
        })
      } else if (data.stage === 'DOMAIN') {
        const agentName =
          typeof data.agentName === 'string' ? data.agentName : 'unknown'
        addActivity({ type: 'phase', text: `✓ ${agentName} agent complete` })
        domainDoneRef.current += 1
      } else if (data.stage === 'OUTPUT') {
        // OUTPUT is the authoritative signal that all domain agents finished.
        // Forcing DOMAIN→done here means the UI never hangs if an individual
        // agent fails to emit its completion checkpoint (avoids hardcoding the
        // agent count in client code).
        setPhaseStatuses(p => ({ ...p, DOMAIN: 'done', OUTPUT: 'done' }))
        addActivity({
          type: 'phase',
          text:
            domainDoneRef.current > 0
              ? '✓ All domain agents done — summary complete'
              : '✓ Review summary complete',
        })
      }
    })

    es.addEventListener('progress', e => {
      const data = JSON.parse(e.data)
      addActivity({
        type: 'tool',
        text:
          typeof data.label === 'string'
            ? data.label
            : formatTool(
                data.tool,
                (data.args ?? {}) as Record<string, unknown>
              ),
      })
    })

    es.addEventListener('finding', e => {
      const finding: Finding = JSON.parse(e.data).finding
      setFindings(prev => [...prev, finding])
      setDecisions(prev => ({
        ...prev,
        [finding.id]: {
          findingId: finding.id,
          accepted: finding.severity !== 'NIT',
        },
      }))
      addActivity({
        type: 'finding',
        text: `● [${finding.severity}] ${finding.title}`,
      })
    })

    es.addEventListener('alarm', e => {
      const data = JSON.parse(e.data)
      addActivity({
        type: 'alarm',
        text: `⚠ Alarm: ${data.alarm?.type ?? 'unknown'}`,
      })
    })

    es.addEventListener('error', e => {
      const msg = (e as MessageEvent).data
        ? JSON.parse((e as MessageEvent).data).error
        : 'Unknown error'
      streamFailedRef.current = true
      addActivity({ type: 'alarm', text: `✗ Error: ${msg}` })
      setStatus('error')
      setPhaseStatuses(p => {
        const next = { ...p }
        for (const key of Object.keys(next) as Array<keyof typeof next>) {
          if (next[key] === 'running') next[key] = 'error'
        }
        return next
      })
    })

    es.addEventListener('done', e => {
      setStatus(streamFailedRef.current ? 'error' : 'done')
      setElapsed(Date.now() - startTimeRef.current)
      if (!streamFailedRef.current) {
        addActivity({ type: 'phase', text: '🎉 Review complete' })
        try {
          const data = JSON.parse((e as MessageEvent).data ?? '{}') as {
            extras?: unknown
          }
          if (data.extras && typeof data.extras === 'object') {
            const extras = extrasFromReview(data.extras)
            setCommentExtras(extras)
            // extras arrive only on done; section cards are hidden until then,
            // so this is the first user-visible section state, not a clobber
            // of in-progress edits. COMPLETE View Review skips EventSource.
            setSections(hydrateSectionUi(extras))
          }
        } catch {
          // extras are optional on older streams
        }
      }
      es.close()
    })

    es.addEventListener('stats', e => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        setRunStats(data)
      } catch {
        // malformed stats payload — degrade gracefully, don't crash the handler
      }
    })

    es.onerror = () => {
      streamFailedRef.current = true
      setStatus('error')
      setPhaseStatuses(p => {
        const next = { ...p }
        for (const key of Object.keys(next) as Array<keyof typeof next>) {
          if (next[key] === 'running') next[key] = 'error'
        }
        return next
      })
      es.close()
    }

    return () => es.close()
  }, [reviewId, mode, prUrl, storedResult])

  function toggle(id: string) {
    setDecisions(prev => ({
      ...prev,
      [id]: { ...prev[id], accepted: !prev[id].accepted },
    }))
  }

  function startEdit(finding: Finding) {
    setEditingSection(null)
    setEditingId(finding.id)
    const d = decisions[finding.id]
    setEditTitle(d?.editedTitle ?? finding.title)
    setEditBody(d?.editedBody ?? finding.body)
  }

  function saveEdit(id: string) {
    const finding = findings.find(f => f.id === id)
    setDecisions(prev => ({
      ...prev,
      [id]: {
        ...prev[id],
        editedTitle:
          editTitle !== finding?.title ? editTitle || undefined : undefined,
        editedBody:
          editBody !== finding?.body ? editBody || undefined : undefined,
      },
    }))
    setEditingId(null)
  }

  function toggleSection(section: ReviewSection) {
    setSections(prev => ({
      ...prev,
      [section]: { ...prev[section], accepted: !prev[section].accepted },
    }))
  }

  function toggleCollapsed(key: string) {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))
  }

  function setIncludeAll(accepted: boolean) {
    setDecisions(prev => {
      const next = { ...prev }
      for (const f of findings) {
        next[f.id] = { ...prev[f.id], findingId: f.id, accepted }
      }
      return next
    })
    setSections(prev => {
      const next = { ...prev }
      for (const section of visibleReviewSections(commentExtras, prev)) {
        next[section] = { ...prev[section], accepted }
      }
      return next
    })
  }

  function toggleCollapseAll(keys: string[]) {
    setCollapsed(prev =>
      allCardsCollapsed(prev, keys) ? {} : collapsedShadeMap(keys)
    )
  }

  function startSectionEdit(section: ReviewSection) {
    setEditingId(null)
    setEditingSection(section)
    setSectionEditBody(
      displayedSectionText(section, commentExtras, sections[section])
    )
  }

  function saveSectionEdit(section: ReviewSection) {
    // Baseline is generated text so saving that text back clears editedBody.
    const original = displayedSectionText(section, commentExtras)
    const trimmed = sectionEditBody
    setSections(prev => ({
      ...prev,
      [section]: {
        ...prev[section],
        editedBody:
          trimmed !== original && trimmed.length > 0 ? trimmed : undefined,
      },
    }))
    setEditingSection(null)
  }

  async function copyComment(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be blocked (non-HTTPS, permissions); the banner still shows.
    }
  }

  async function handleSubmit(postComment: boolean) {
    setSubmitKind(postComment ? SubmitKind.POST : SubmitKind.SAVE)
    setSubmitResult(null) // clear any previous error before retry
    try {
      const body = {
        decisions: finalizeDecisionsFromUi(decisions),
        sections: sectionDecisionsFromUi(sections),
        postComment,
      }
      const res = await fetch(`/api/review/${reviewId}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      setSubmitResult(
        buildFinalizeBanner({
          httpOk: res.ok,
          httpError: data.error,
          approve: false,
          postComment,
          comment: data.comment,
          accepted: data.summary?.accepted,
          rejected: data.summary?.rejected,
        })
      )
      if (res.ok && githubCommentPosted(postComment, data.comment)) {
        setPostedToGitHub(true)
      }
    } catch {
      setSubmitResult(
        buildFinalizeBanner({
          httpOk: false,
          httpError: 'unexpected server response',
          approve: false,
          postComment,
          comment: null,
        })
      )
    } finally {
      setSubmitKind(null)
    }
  }

  async function handleApprove(postComment: boolean) {
    setSubmitKind(postComment ? SubmitKind.APPROVE : SubmitKind.SAVE)
    setSubmitResult(null) // clear any previous error before retry
    try {
      const res = await fetch(`/api/review/${reviewId}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisions: [],
          sections: sectionDecisionsFromUi(sections),
          postComment,
          approve: true,
        }),
      })
      const data = await res.json()
      setSubmitResult(
        buildFinalizeBanner({
          httpOk: res.ok,
          httpError: data.error,
          approve: true,
          postComment,
          comment: data.comment,
        })
      )
      if (res.ok && githubCommentPosted(postComment, data.comment)) {
        setPostedToGitHub(true)
      }
    } catch {
      setSubmitResult(
        buildFinalizeBanner({
          httpOk: false,
          httpError: 'unexpected server response',
          approve: true,
          postComment,
          comment: null,
        })
      )
    } finally {
      setSubmitKind(null)
    }
  }
  const accepted = Object.values(decisions).filter(d => d.accepted).length
  const total = findings.length
  const visibleSections = visibleReviewSections(commentExtras, sections)
  const shadeKeys = reviewShadeKeys(
    findings.map(f => f.id),
    visibleSections
  )
  const cardsCollapsed = allCardsCollapsed(collapsed, shadeKeys)
  const includeState = includeAllState([
    ...findings.map(f => decisions[f.id]?.accepted ?? true),
    ...visibleSections.map(section => sections[section]?.accepted ?? false),
  ])
  const hasCards = shadeKeys.length > 0
  const busy = submitKind !== null
  const reviewMarkdown = formatReviewCommentFromUi({
    reviewId,
    findings,
    decisions,
    extras: commentExtras,
    sections,
  })

  function renderSection(section: ReviewSection) {
    if (
      status !== 'done' ||
      !sectionHasContent(section, commentExtras, sections[section])
    ) {
      return null
    }
    return (
      <ReviewSectionCard
        section={section}
        extras={commentExtras}
        decision={sections[section]}
        isEditing={editingSection === section}
        editBody={sectionEditBody}
        collapsed={Boolean(collapsed[sectionShadeKey(section)])}
        onToggle={() => toggleSection(section)}
        onToggleCollapse={() => toggleCollapsed(sectionShadeKey(section))}
        onStartEdit={() => startSectionEdit(section)}
        onSave={() => saveSectionEdit(section)}
        onCancel={() => setEditingSection(null)}
        onEditBodyChange={setSectionEditBody}
      />
    )
  }

  return (
    <div className="flex gap-6">
      {/* ── Main panel ─────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">PR Review</h1>
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 text-sm text-indigo-400 hover:underline"
            >
              {prUrl}
            </a>
          )}
          <p className="mt-1 text-xs text-gray-500 font-mono">
            review/{reviewId}
          </p>
          {siblingNav && (
            <div className="mt-3 lg:hidden">
              <SiblingNavBlock nav={siblingNav} />
            </div>
          )}
        </div>

        {/* Status bar */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <StatusIndicator status={status} />
          {mode === 'quick' && (
            <span className="rounded-full bg-indigo-900/50 border border-indigo-700 px-2 py-0.5 text-xs font-semibold text-indigo-300">
              ⚡ Quick
            </span>
          )}
          {status === 'done' && total > 0 && (
            <span className="text-sm text-gray-400">
              {total} finding{total !== 1 ? 's' : ''} — {accepted} accepted
            </span>
          )}
          {status === 'done' && hasCards && (
            <div className="ml-auto flex items-center gap-3">
              <button
                type="button"
                onClick={() => toggleCollapseAll(shadeKeys)}
                className="rounded border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-800"
              >
                {cardsCollapsed ? 'Expand all' : 'Collapse all'}
              </button>
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="accent-indigo-500"
                  checked={includeState === IncludeAllState.ALL}
                  ref={el => {
                    if (el)
                      el.indeterminate = includeState === IncludeAllState.MIXED
                  }}
                  onChange={e => setIncludeAll(e.target.checked)}
                />
                <span className="text-xs text-gray-400">Include all</span>
              </label>
            </div>
          )}
        </div>

        {status === 'done' &&
          (sectionHasContent(
            ReviewSection.PREAMBLE,
            commentExtras,
            sections[ReviewSection.PREAMBLE]
          ) ||
            sectionHasContent(
              ReviewSection.TICKET_ALIGNMENT,
              commentExtras,
              sections[ReviewSection.TICKET_ALIGNMENT]
            )) && (
            <div className="mb-3 flex flex-col gap-3">
              {renderSection(ReviewSection.PREAMBLE)}
              {renderSection(ReviewSection.TICKET_ALIGNMENT)}
            </div>
          )}

        {/* Findings placeholder while running */}
        {findings.length === 0 && status !== 'done' && status !== 'error' && (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-8 text-center text-sm text-gray-500">
            {status === 'connecting'
              ? 'Connecting to review stream…'
              : 'Agents are running — findings will appear here'}
          </div>
        )}

        {findings.length === 0 && status === 'error' && (
          <div className="rounded-lg border border-red-900 bg-red-950/30 p-8 text-center text-sm text-red-400">
            Review failed. Check the activity log or server logs for details.
          </div>
        )}

        {findings.length === 0 && status === 'done' && (
          <div className="rounded-lg border border-green-800 bg-green-950/30 p-8 text-center text-sm text-green-400">
            No findings — clean review!
          </div>
        )}

        <div className="flex flex-col gap-3">
          {findings.map(f => {
            const decision = decisions[f.id]
            const isEditing = editingId === f.id
            const isCollapsed = Boolean(collapsed[findingShadeKey(f.id)])

            return (
              <div
                key={f.id}
                className={`rounded-lg border p-4 transition-opacity ${SEVERITY_STYLES[f.severity]} ${decision?.accepted === false ? 'opacity-50' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <ShadeButton
                      expanded={!isCollapsed}
                      onClick={() => toggleCollapsed(findingShadeKey(f.id))}
                    >
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${SEVERITY_BADGE[f.severity]}`}
                      >
                        {f.severity}
                      </span>
                    </ShadeButton>
                    <span className="text-xs text-gray-400 font-mono">
                      {f.file}
                      {f.line ? `:${f.line}` : ''}
                    </span>
                    <span className="text-xs text-gray-500">
                      {findingCategories(f).join(' · ')}
                    </span>
                    {findingCategories(f).length > 1 && (
                      <span
                        className="text-xs text-indigo-400"
                        title="Independently raised by more than one agent"
                      >
                        {findingCategories(f).length} agents agree
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1.5">
                      <ConfidenceBar confidence={f.confidence} />
                      <span className="text-xs text-gray-500">
                        {formatConfidencePercent(f.confidence)}
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <label className="flex items-center gap-1.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="accent-indigo-500"
                        checked={decision?.accepted ?? true}
                        onChange={() => toggle(f.id)}
                      />
                      <span className="text-xs text-gray-400">Include</span>
                    </label>
                  </div>
                </div>

                {!isCollapsed && (
                  <>
                    <p className="mt-2 text-sm font-medium text-gray-100">
                      {decisions[f.id]?.editedTitle ? (
                        <span className="text-indigo-300">
                          {decisions[f.id].editedTitle}
                        </span>
                      ) : (
                        f.title
                      )}
                    </p>
                    <p className="mt-1 text-sm text-gray-400">
                      {decisions[f.id]?.editedBody ?? f.body}
                    </p>

                    {isEditing ? (
                      <div className="mt-3 space-y-2">
                        <div>
                          <label className="mb-1 block text-xs text-gray-500">
                            Title
                          </label>
                          <input
                            type="text"
                            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-1.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
                            value={editTitle}
                            onChange={e => setEditTitle(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-gray-500">
                            Description
                          </label>
                          <textarea
                            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
                            rows={4}
                            value={editBody}
                            onChange={e => setEditBody(e.target.value)}
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => saveEdit(f.id)}
                            className="rounded bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-500"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="rounded bg-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-gray-600"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {f.suggestedFix && (
                          <p className="mt-2 rounded bg-gray-800 px-3 py-2 font-mono text-xs text-green-400">
                            {f.suggestedFix}
                          </p>
                        )}
                        <button
                          onClick={() => startEdit(f)}
                          className="mt-2 text-xs text-indigo-400 hover:underline"
                        >
                          Edit suggestion
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>

        {status === 'done' &&
          (sectionHasContent(
            ReviewSection.WHAT_LOOKS_GOOD,
            commentExtras,
            sections[ReviewSection.WHAT_LOOKS_GOOD]
          ) ||
            sectionHasContent(
              ReviewSection.QUESTIONS,
              commentExtras,
              sections[ReviewSection.QUESTIONS]
            ) ||
            sectionHasContent(
              ReviewSection.TESTING_RECOMMENDATIONS,
              commentExtras,
              sections[ReviewSection.TESTING_RECOMMENDATIONS]
            )) && (
            <div className="mt-3 flex flex-col gap-3">
              {renderSection(ReviewSection.WHAT_LOOKS_GOOD)}
              {renderSection(ReviewSection.QUESTIONS)}
              {renderSection(ReviewSection.TESTING_RECOMMENDATIONS)}
            </div>
          )}

        {/* Submit controls */}
        {status === 'done' && total > 0 && (
          <div className="mt-6 space-y-3">
            {submitResult && (
              <SubmitBannerView
                banner={submitResult}
                copied={copied}
                onCopy={copyComment}
              />
            )}
            {!postedToGitHub && (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    disabled={busy}
                    onClick={() => handleSubmit(false)}
                    className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {submitKind === SubmitKind.SAVE
                      ? 'Saving…'
                      : 'Save findings'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => handleSubmit(true)}
                    className="inline-flex items-center gap-2 rounded-lg bg-[#238636] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#2ea043] disabled:opacity-50"
                  >
                    <GitHubMark className="h-4 w-4" />
                    {submitKind === SubmitKind.POST
                      ? 'Posting…'
                      : 'Post to GitHub'}
                  </button>
                  <CopyReviewButton
                    markdown={reviewMarkdown}
                    copied={copied}
                    onCopy={copyComment}
                  />
                </div>
                <p className="text-xs text-gray-500">
                  Include toggles stay on this page until you save or post.
                </p>
              </>
            )}
            {postedToGitHub && !submitResult && (
              <CopyReviewButton
                markdown={reviewMarkdown}
                copied={copied}
                onCopy={copyComment}
              />
            )}
          </div>
        )}

        {/* Clean review: no findings → save or approve on GitHub */}
        {status === 'done' && total === 0 && (
          <div className="mt-6 space-y-3">
            {submitResult && (
              <SubmitBannerView
                banner={submitResult}
                copied={copied}
                onCopy={copyComment}
              />
            )}
            {!postedToGitHub && (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    disabled={busy}
                    onClick={() => handleApprove(false)}
                    className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {submitKind === SubmitKind.SAVE ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => handleApprove(true)}
                    className="inline-flex items-center gap-2 rounded-lg bg-[#238636] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#2ea043] disabled:opacity-50"
                  >
                    <GitHubMark className="h-4 w-4" />
                    {submitKind === SubmitKind.APPROVE
                      ? 'Approving…'
                      : 'Approve PR on GitHub'}
                  </button>
                  <CopyReviewButton
                    markdown={reviewMarkdown}
                    copied={copied}
                    onCopy={copyComment}
                  />
                </div>
                <p className="text-xs text-gray-500">
                  Saving records this clean review without commenting on GitHub.
                </p>
              </>
            )}
            {postedToGitHub && !submitResult && (
              <CopyReviewButton
                markdown={reviewMarkdown}
                copied={copied}
                onCopy={copyComment}
              />
            )}
          </div>
        )}
      </div>

      {/* ── Activity sidebar ───────────────────────────────────────────────── */}
      <div className="w-72 shrink-0 hidden lg:block">
        <div className="sticky top-4 space-y-4">
          {/* Pipeline stages */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Pipeline
              </h2>
              <span
                className={`text-xs font-mono tabular-nums ${status === 'done' ? 'text-green-500' : 'text-gray-500'}`}
              >
                {isCachedReview ? '⚡ cache' : formatElapsed(elapsed)}
              </span>
            </div>
            <div className="space-y-2">
              {PIPELINE.map(({ key, label }) => {
                const skipped = mode === 'quick' && key === 'CONTEXT'
                return (
                  <PhaseRow
                    key={key}
                    label={skipped ? `${label} (skipped)` : label}
                    status={
                      skipped ? 'pending' : (phaseStatuses[key] ?? 'pending')
                    }
                    dimmed={skipped}
                  />
                )
              })}
            </div>
            {runStats && (
              <div className="mt-3 pt-3 border-t border-gray-800">
                <p
                  className={`text-xs font-mono tabular-nums ${
                    runStats.maxTokens != null &&
                    runStats.tokensUsed > runStats.maxTokens
                      ? 'text-red-400'
                      : 'text-gray-500'
                  }`}
                >
                  {formatTokenUsage(runStats.tokensUsed, runStats.maxTokens)}
                  {runStats.estimatedCostUsd != null && (
                    <>
                      {' · '}${runStats.estimatedCostUsd.toFixed(4)}
                    </>
                  )}
                  {runStats.durationMs != null && (
                    <>
                      {' · '}
                      {formatElapsed(runStats.durationMs)}
                    </>
                  )}
                </p>
                <div className="mt-1.5 space-y-0.5">
                  {Object.entries(runStats.phaseDurations ?? {}).map(
                    ([phase, ms]) => (
                      <div key={phase} className="flex items-center gap-2">
                        <span className="text-xs text-gray-600 w-16">
                          {phase}
                        </span>
                        <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-indigo-600 rounded-full"
                            style={{
                              width: `${runStats.durationMs != null && runStats.durationMs > 0 ? Math.min(100, (ms / runStats.durationMs) * 100) : 0}%`,
                            }}
                          />
                        </div>
                        <span className="text-xs text-gray-600 font-mono tabular-nums w-12 text-right">
                          {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}
                        </span>
                      </div>
                    )
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Activity feed */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Activity
            </h2>
            <div
              ref={activityListRef}
              className="max-h-80 overflow-y-auto space-y-1.5 pr-1"
            >
              {activity.length === 0 ? (
                <p className="text-xs text-gray-600">Waiting for events…</p>
              ) : (
                activity.map(item => (
                  <p
                    key={item.id}
                    className={`text-xs font-mono leading-snug ${
                      item.type === 'alarm'
                        ? 'text-red-400'
                        : item.type === 'finding'
                          ? 'text-yellow-400'
                          : item.type === 'phase'
                            ? 'text-green-400'
                            : 'text-gray-400'
                    }`}
                  >
                    {item.text}
                  </p>
                ))
              )}
            </div>
          </div>

          {siblingNav && <SiblingNavBlock nav={siblingNav} />}
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

/** GitHub mark (Octicons). Used on the Post / Approve CTAs. */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
    </svg>
  )
}

function CopyReviewButton({
  markdown,
  copied,
  onCopy,
}: {
  markdown: string
  copied: boolean
  onCopy: (text: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onCopy(markdown)}
      className="rounded-lg border border-gray-600 bg-gray-800 px-5 py-2.5 text-sm font-semibold text-gray-100 hover:bg-gray-700"
    >
      {copied ? 'Copied' : 'Copy review'}
    </button>
  )
}

function SiblingNavBlock({ nav }: { nav: SiblingReviewNav }) {
  const btn =
    'flex-1 rounded-md border px-3 py-2 text-center text-sm font-medium transition'
  const enabled =
    'border-gray-600 bg-gray-800 text-gray-100 hover:border-indigo-500 hover:text-indigo-300'
  const disabled =
    'cursor-not-allowed border-gray-800 bg-gray-950 text-gray-600'

  return (
    <div className="rounded-lg border border-indigo-900/50 bg-gray-900 p-4">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Reviews
      </h2>
      <p className="mb-3 text-sm font-medium text-white">
        Review {nav.position} of {nav.total}
      </p>
      <div className="flex gap-2">
        {nav.olderId ? (
          <Link href={`/review/${nav.olderId}`} className={`${btn} ${enabled}`}>
            ← Older
          </Link>
        ) : (
          <span className={`${btn} ${disabled}`}>← Older</span>
        )}
        {nav.newerId ? (
          <Link href={`/review/${nav.newerId}`} className={`${btn} ${enabled}`}>
            Newer →
          </Link>
        ) : (
          <span className={`${btn} ${disabled}`}>Newer →</span>
        )}
      </div>
    </div>
  )
}

function ShadeButton({
  expanded,
  onClick,
  children,
}: {
  expanded: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-left hover:opacity-90"
    >
      <span className="text-xs text-gray-500" aria-hidden="true">
        {expanded ? '▾' : '▸'}
      </span>
      {children}
    </button>
  )
}

function ReviewSectionCard({
  section,
  extras,
  decision,
  isEditing,
  editBody,
  collapsed,
  onToggle,
  onToggleCollapse,
  onStartEdit,
  onSave,
  onCancel,
  onEditBodyChange,
}: {
  section: ReviewSection
  extras: ReviewCommentExtras
  decision: UiSectionDecision
  isEditing: boolean
  editBody: string
  collapsed: boolean
  onToggle: () => void
  onToggleCollapse: () => void
  onStartEdit: () => void
  onSave: () => void
  onCancel: () => void
  onEditBodyChange: (value: string) => void
}) {
  const text = displayedSectionText(section, extras, decision)
  return (
    <div
      className={`rounded-lg border p-4 transition-opacity ${SECTION_CARD[section]} ${decision.accepted === false ? 'opacity-50' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <ShadeButton expanded={!collapsed} onClick={onToggleCollapse}>
          <span className="text-sm font-medium text-gray-100">
            {SECTION_LABEL[section]}
          </span>
        </ShadeButton>
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            className="accent-indigo-500"
            checked={decision.accepted}
            onChange={onToggle}
          />
          <span className="text-xs text-gray-400">Include</span>
        </label>
      </div>
      {!collapsed && (
        <>
          <p className="mt-2 whitespace-pre-wrap text-sm text-gray-400">
            {text}
          </p>
          {isEditing ? (
            <div className="mt-3 space-y-2">
              <textarea
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
                rows={
                  section === ReviewSection.PREAMBLE ||
                  section === ReviewSection.TICKET_ALIGNMENT
                    ? 5
                    : 4
                }
                value={editBody}
                onChange={e => onEditBodyChange(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onSave}
                  className="rounded bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-500"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={onCancel}
                  className="rounded bg-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-gray-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={onStartEdit}
              className="mt-2 text-xs text-indigo-400 hover:underline"
            >
              Edit
            </button>
          )}
        </>
      )}
    </div>
  )
}

function StatusIndicator({ status }: { status: StreamStatus }) {
  const configs: Record<StreamStatus, { dot: string; label: string }> = {
    connecting: { dot: 'bg-yellow-400 animate-pulse', label: 'Connecting' },
    running: { dot: 'bg-green-400 animate-pulse', label: 'Agents running' },
    done: { dot: 'bg-indigo-400', label: 'Complete' },
    error: { dot: 'bg-red-500', label: 'Stream error' },
  }
  const { dot, label } = configs[status]
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <span className="text-sm text-gray-400">{label}</span>
    </div>
  )
}

function PhaseRow({
  label,
  status,
  dimmed = false,
}: {
  label: string
  status: PhaseStatus
  dimmed?: boolean
}) {
  return (
    <div className={`flex items-center gap-2.5 ${dimmed ? 'opacity-35' : ''}`}>
      <PhaseIcon status={status} />
      <span
        className={`text-xs ${
          status === 'done'
            ? 'text-gray-300'
            : status === 'running'
              ? 'text-white font-medium'
              : status === 'error'
                ? 'text-red-400'
                : 'text-gray-600'
        }`}
      >
        {label}
      </span>
      {status === 'running' && (
        <span className="ml-auto text-xs text-indigo-400 animate-pulse">
          running
        </span>
      )}
      {status === 'error' && (
        <span className="ml-auto text-xs text-red-400">failed</span>
      )}
    </div>
  )
}

function PhaseIcon({ status }: { status: PhaseStatus }) {
  if (status === 'done')
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-green-700 text-green-100 text-[9px] font-bold">
        ✓
      </span>
    )
  if (status === 'running')
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
    )
  if (status === 'error')
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-700 text-red-100 text-[9px] font-bold">
        ✗
      </span>
    )
  // pending
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-gray-700" />
  )
}
