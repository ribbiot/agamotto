import { type NextRequest, NextResponse } from 'next/server'
import { AutoStartDecision } from '../../../../src/lib/auto-start'
import { tryAutoStartOpenedReview } from '../../../../src/lib/auto-start-review'
import { createSupabaseServiceRoleClient } from '../../../../src/lib/supabase/server'
import {
  SYNC_INVALIDATES_STATUSES,
  TrackedPrStatus,
} from '../../../../src/lib/tracked-prs'
import { verifyGitHubSignature } from '../../../../src/lib/webhook'

// Used for constant-time dummy HMAC comparisons when no repo row is found or
// the repo has no secret, so the latency profile of those paths is
// indistinguishable from a known-repo / wrong-signature path.
const TIMING_DUMMY_SECRET = 'timing-equalization-dummy-secret-not-used-for-auth'

/**
 * GitHub pull_request webhook payload (the fields we care about).
 */
interface GitHubPrPayload {
  action?: string
  pull_request?: {
    number: number
    title: string
    html_url: string
    state: string
    user: { login: string }
    created_at: string
    closed_at: string | null
  }
  repository?: {
    name: string
    owner: { login: string }
  }
}

/**
 * POST /api/webhooks/github
 *
 * Receives GitHub webhook events and keeps `tracked_prs` in sync for
 * `pull_request` events (opened, reopened, closed, synchronize).
 *
 * Auth runs first — before branching on event type — so that non-pull_request
 * events (ping, push, etc.) are fully verified before the 204 acknowledgement.
 * All 401 failure paths return identical bodies and perform the same HMAC work
 * to prevent both response-body and timing-based repo enumeration.
 *
 *   opened    → upsert (idempotent); optional auto-start first review (ATH-58)
 *               auto-start completes to READY and never posts to GitHub
 *   reopened  → update only; sets source=WEBHOOK, preserves updated_since_review
 *   closed    → update status=CLOSED, pr_closed_at, updated_since_review=false
 *   synchronize → flip REVIEWED|READY → OPEN and set updated_since_review=true
 *
 * Returns 204 for unrecognised event types or ignored actions.
 * Returns 401 for any authentication/authorization failure.
 */
export async function POST(request: NextRequest) {
  // ── Step 1: signature header presence (fast path, no body needed) ─────────
  const signature = request.headers.get('x-hub-signature-256')
  if (!signature) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Step 2: read and parse body ───────────────────────────────────────────
  const rawBody = await request.text()

  let payload: GitHubPrPayload
  try {
    payload = JSON.parse(rawBody) as GitHubPrPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // ── Step 3: extract repo identity for secret lookup ───────────────────────
  // The HMAC is computed over rawBody (not the parsed fields), so a forged
  // owner/repo only affects which secret is fetched — the signature check still
  // fails unless the caller knows that repo's actual secret.
  const owner = payload.repository?.owner?.login
  const repo = payload.repository?.name

  const service = createSupabaseServiceRoleClient()

  if (!owner || !repo) {
    // Can't identify the repo — perform dummy HMAC to equalise timing, then 401.
    verifyGitHubSignature(rawBody, TIMING_DUMMY_SECRET, signature)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Step 4: look up repo and verify HMAC ──────────────────────────────────
  // Return 401 (not 404) for unknown repos to prevent existence enumeration.
  const { data: configuredRepo, error: repoLookupError } = await service
    .from('configured_repos')
    .select('id, webhook_secret, auto_start')
    .eq('owner', owner)
    .eq('name', repo)
    .single()

  if (repoLookupError || !configuredRepo) {
    verifyGitHubSignature(rawBody, TIMING_DUMMY_SECRET, signature)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const webhookSecret: string | null = configuredRepo.webhook_secret
  if (!webhookSecret) {
    // Repo is misconfigured — dummy HMAC to equalise timing, then 401.
    verifyGitHubSignature(rawBody, TIMING_DUMMY_SECRET, signature)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!verifyGitHubSignature(rawBody, webhookSecret, signature)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Step 5: branch on event type (auth is complete) ──────────────────────
  const event = request.headers.get('x-github-event')
  if (event !== 'pull_request') {
    // Fully verified — acknowledge and ignore non-pull_request events.
    return new NextResponse(null, { status: 204 })
  }

  // ── Step 6: validate pull_request payload fields ──────────────────────────
  const action = payload.action
  if (!action) {
    return NextResponse.json(
      { error: 'Missing action in payload' },
      { status: 400 }
    )
  }

  const pr = payload.pull_request
  if (!pr) {
    return NextResponse.json(
      { error: 'Missing pull_request in payload' },
      { status: 400 }
    )
  }

  const prNumber = pr.number
  const prUrl = pr.html_url
  const prTitle = pr.title
  const prAuthor = pr.user?.login ?? null
  const prOpenedAt = pr.created_at

  // ── Step 7: handle each action ────────────────────────────────────────────

  if (action === 'opened') {
    let existingStatus: string | null = null
    let lastReviewId: string | null = null
    if (configuredRepo.auto_start === true) {
      const { data: existing } = await service
        .from('tracked_prs')
        .select('status, last_review_id')
        .eq('owner', owner)
        .eq('repo', repo)
        .eq('pr_number', prNumber)
        .maybeSingle()
      existingStatus = existing?.status ?? null
      lastReviewId = existing?.last_review_id ?? null
    }

    // Upsert so duplicate webhook deliveries are idempotent.
    // Explicitly initialise updated_since_review=false — no review exists yet.
    // Do not clobber IN_REVIEW when auto-start already kicked the pipeline.
    const { error } = await service.from('tracked_prs').upsert(
      {
        owner,
        repo,
        pr_number: prNumber,
        pr_url: prUrl,
        pr_title: prTitle,
        pr_author: prAuthor,
        pr_opened_at: prOpenedAt,
        pr_closed_at: null,
        source: 'WEBHOOK',
        updated_since_review: false,
        ...(existingStatus === TrackedPrStatus.IN_REVIEW
          ? {}
          : { status: TrackedPrStatus.OPEN }),
      },
      { onConflict: 'owner,repo,pr_number', ignoreDuplicates: false }
    )

    if (error) {
      console.error('[POST /api/webhooks/github] upsert error (opened)', error)
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      )
    }

    let started: boolean | undefined
    if (configuredRepo.auto_start === true) {
      const decision = await tryAutoStartOpenedReview({
        prUrl,
        prAuthor,
        existingStatus,
        lastReviewId,
      })
      started = decision === AutoStartDecision.START
    }
    return NextResponse.json({ ok: true, action, started })
  }

  if (action === 'reopened') {
    // Use update (not upsert) so we only touch the fields that should change.
    // source=WEBHOOK is set per the acceptance criteria (opened/reopened → WEBHOOK).
    // updated_since_review is set to false explicitly: the closed handler always
    // writes false in the normal flow, so this is consistent with that behaviour
    // and also handles the edge case where a closed event was missed (which would
    // otherwise preserve a stale true from a prior synchronize event).
    const { error } = await service
      .from('tracked_prs')
      .update({
        status: 'OPEN',
        source: 'WEBHOOK',
        updated_since_review: false,
        pr_url: prUrl,
        pr_title: prTitle,
        pr_author: prAuthor,
        pr_opened_at: prOpenedAt,
        pr_closed_at: null,
      })
      .eq('owner', owner)
      .eq('repo', repo)
      .eq('pr_number', prNumber)

    if (error) {
      console.error(
        '[POST /api/webhooks/github] update error (reopened)',
        error
      )
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      )
    }
    return NextResponse.json({ ok: true, action })
  }

  if (action === 'closed') {
    // Intentional no-op for untracked PRs: if the PR was never in tracked_prs,
    // the update matches zero rows, error is null, and matched=0 is returned.
    // A console.warn is emitted so operators can detect misconfiguration.
    const prClosedAt = pr.closed_at ?? new Date().toISOString()
    const { data: updated, error } = await service
      .from('tracked_prs')
      .update({
        status: 'CLOSED',
        pr_closed_at: prClosedAt,
        updated_since_review: false,
      })
      .eq('owner', owner)
      .eq('repo', repo)
      .eq('pr_number', prNumber)
      .select('id')

    if (error) {
      console.error('[POST /api/webhooks/github] update error (closed)', error)
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      )
    }
    const matched = Array.isArray(updated) ? updated.length : 0
    if (matched === 0) {
      console.warn(
        `[POST /api/webhooks/github] closed event for untracked PR ${owner}/${repo}#${prNumber}`
      )
    }
    return NextResponse.json({ ok: true, action, matched })
  }

  if (action === 'synchronize') {
    // REVIEWED and READY both mean the last run is done; new commits stale it.
    // OPEN already has no review to invalidate. IN_REVIEW sees HEAD naturally.
    const { data: updated, error } = await service
      .from('tracked_prs')
      .update({ status: 'OPEN', updated_since_review: true })
      .eq('owner', owner)
      .eq('repo', repo)
      .eq('pr_number', prNumber)
      .in('status', [...SYNC_INVALIDATES_STATUSES])
      .select('id')

    if (error) {
      console.error(
        '[POST /api/webhooks/github] update error (synchronize)',
        error
      )
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      )
    }
    const matched = Array.isArray(updated) ? updated.length : 0
    if (matched === 0) {
      console.warn(
        `[POST /api/webhooks/github] synchronize event matched no REVIEWED or READY PRs for ${owner}/${repo}#${prNumber}`
      )
    }
    return NextResponse.json({ ok: true, action, matched })
  }

  // Unrecognised action (labeled, edited, assigned, etc.) — acknowledge and ignore
  return new NextResponse(null, { status: 204 })
}
