/**
 * GitHub login helpers for allowlists (ALLOWED_GITHUB_USERS, ADMIN_GITHUB_USERS).
 *
 * GitHub usernames are case-insensitive; we always compare lowercase.
 */

export type GithubIdentity = {
  provider?: string
  identity_data?: unknown
}

export type GithubUserLike =
  | {
      user_metadata?: { user_name?: unknown }
      identities?: GithubIdentity[]
    }
  | null
  | undefined

function loginFromRaw(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const login = raw.trim().toLowerCase()
  return login.length > 0 ? login : undefined
}

function loginFromIdentityData(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  return loginFromRaw((data as { user_name?: unknown }).user_name)
}

export function parseGithubLogins(raw: string | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const logins: string[] = []
  for (const part of raw.split(',')) {
    const login = part.trim().toLowerCase()
    if (!login || seen.has(login)) continue
    seen.add(login)
    logins.push(login)
  }
  return logins
}

export function githubLoginFromUser(user: GithubUserLike): string | undefined {
  if (!user) return undefined
  const githubIdentity = user.identities?.find(i => i.provider === 'github')
  return (
    loginFromRaw(user.user_metadata?.user_name) ??
    loginFromIdentityData(githubIdentity?.identity_data)
  )
}

/**
 * Settings/config mutations. Only GitHub logins listed in ADMIN_GITHUB_USERS
 * may edit agent overlays, conventions, or configured repos. Empty or unset = no admins.
 */
export function isAdminGithubUser(
  user: GithubUserLike,
  adminEnv: string | undefined = process.env.ADMIN_GITHUB_USERS
): boolean {
  const login = githubLoginFromUser(user)
  return login !== undefined && parseGithubLogins(adminEnv).includes(login)
}

/**
 * Sign-in / auto-start allowlist. Empty or unset ALLOWED_GITHUB_USERS means
 * every GitHub login is allowed (local dev). Production should set the env.
 */
export function isAllowedGithubLogin(
  login: string | null | undefined,
  allowedEnv: string | undefined = process.env.ALLOWED_GITHUB_USERS
): boolean {
  const normalized = login?.trim().toLowerCase() ?? ''
  if (!normalized) return false
  const allowed = parseGithubLogins(allowedEnv)
  return allowed.length === 0 || allowed.includes(normalized)
}
