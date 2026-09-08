import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from '../../../../../src/lib/supabase/server'
import { isAdminGithubUser } from '../../../../../src/lib/github-users'

async function requireAdmin() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  if (!isAdminGithubUser(user)) {
    return {
      error: NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      ),
    }
  }
  return { user }
}

const PatchRepoBody = z.object({
  auto_start: z.boolean(),
})

/**
 * PATCH /api/queue/repos/[id]
 * Toggle per-repo auto-start (ATH-58). Admin only.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin()
  if (auth.error) return auth.error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = PatchRepoBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 }
    )
  }

  const { id } = await params
  const service = createSupabaseServiceRoleClient()
  const { data, error } = await service
    .from('configured_repos')
    .update({ auto_start: parsed.data.auto_start })
    .eq('id', id)
    .select('id, owner, name, active, auto_start, created_at, updated_at')

  if (error) {
    console.error('[PATCH /api/queue/repos/[id]]', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ repo: data[0] })
}

/**
 * DELETE /api/queue/repos/[id]
 * Removes a configured repo.
 * Uses the service role client for consistency with other write operations
 * and to avoid any RLS edge cases on configured_repos.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin()
  if (auth.error) return auth.error

  const { id } = await params

  const service = createSupabaseServiceRoleClient()
  const { data, error } = await service
    .from('configured_repos')
    .delete()
    .eq('id', id)
    .select()

  if (error) {
    console.error('[DELETE /api/queue/repos/[id]]', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return new NextResponse(null, { status: 204 })
}
