import { type NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { createSupabaseServerClient } from '../../../../src/lib/supabase/server'
import { beginTrackedReview } from '../../../../src/memory/begin-tracked-review'

const StartReviewBody = z.object({
  prUrl: z.string().url('prUrl must be a valid GitHub PR URL'),
  mode: z.enum(['full', 'quick']).default('full'),
  password: z.string().optional(),
})

function checkPassword(submitted: string | undefined): boolean {
  const raw = process.env.ACCESS_PASSWORDS
  if (!raw || raw.trim() === '') return true // gate is open (local dev / no env var set)
  const valid = raw
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
  return valid.length === 0 || valid.includes(submitted ?? '')
}

function isGitHubUser(
  user: {
    app_metadata?: { provider?: string }
    identities?: { provider: string }[]
  } | null
): boolean {
  if (!user) return false
  if (user.app_metadata?.provider === 'github') return true
  return user.identities?.some(i => i.provider === 'github') === true
}

/**
 * Session lookup only when the access-code gate is closed. A getUser error
 * or a non-GitHub identity is treated as unauthenticated (fall through to 401).
 */
async function hasGitHubSession(): Promise<boolean> {
  try {
    const supabase = await createSupabaseServerClient()
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser()
    if (error) {
      console.error('[POST /api/review/start] getUser failed:', error)
      return false
    }
    return isGitHubUser(user)
  } catch (err) {
    console.error('[POST /api/review/start] getUser failed:', err)
    return false
  }
}

/**
 * POST /api/review/start
 * Validates the PR URL, mints a reviewId, and returns it.
 * GitHub-authenticated users (queue Start Review) skip ACCESS_PASSWORDS;
 * anonymous callers still need the access code when that env var is set.
 */
export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = StartReviewBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 }
    )
  }

  if (!checkPassword(parsed.data.password) && !(await hasGitHubSession())) {
    return NextResponse.json(
      {
        error:
          'Invalid access code. Reach out via GitHub (@atharrison) to get one.',
      },
      { status: 401 }
    )
  }

  const reviewId = uuidv4()
  await beginTrackedReview(reviewId, parsed.data.prUrl, parsed.data.mode)

  return NextResponse.json(
    { reviewId, prUrl: parsed.data.prUrl, mode: parsed.data.mode },
    { status: 202 }
  )
}

/**
 * GET /api/review/start?prUrl=...
 * Browser form fallback — redirects to the review page.
 */
const GithubPrUrl = z
  .string()
  .url()
  .refine(val => /^https:\/\/github\.com\/.+\/.+\/pull\/\d+/.test(val), {
    message: 'prUrl must be a GitHub PR URL',
  })

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const prUrl = searchParams.get('prUrl')

  const proto = request.headers.get('x-forwarded-proto') ?? 'https'
  const host =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    new URL(request.url).host
  const baseUrl = `${proto}://${host}`

  if (!prUrl) {
    return NextResponse.redirect(new URL('/?error=missing_pr_url', baseUrl))
  }

  const parsed = GithubPrUrl.safeParse(prUrl)
  if (!parsed.success) {
    return NextResponse.redirect(new URL('/?error=invalid_pr_url', baseUrl))
  }

  const reviewId = uuidv4()
  await beginTrackedReview(reviewId, parsed.data, 'full')
  return NextResponse.redirect(
    new URL(
      `/review/${reviewId}?prUrl=${encodeURIComponent(parsed.data)}`,
      baseUrl
    )
  )
}
