import {
  githubLoginFromUser,
  isAdminGithubUser,
  isAllowedGithubLogin,
  parseGithubLogins,
} from '../src/lib/github-users'

describe('parseGithubLogins', () => {
  it('returns an empty list for undefined, empty, or whitespace', () => {
    expect(parseGithubLogins(undefined)).toEqual([])
    expect(parseGithubLogins('')).toEqual([])
    expect(parseGithubLogins('   ')).toEqual([])
    expect(parseGithubLogins(',,,')).toEqual([])
  })

  it('splits, trims, and lowercases comma-separated logins', () => {
    expect(parseGithubLogins('Alice, Bob,CAROL')).toEqual([
      'alice',
      'bob',
      'carol',
    ])
  })

  it('deduplicates logins after normalizing', () => {
    expect(parseGithubLogins('Alice, alice, ALICE')).toEqual(['alice'])
  })
})

describe('githubLoginFromUser', () => {
  it('returns undefined for null or empty users', () => {
    expect(githubLoginFromUser(null)).toBeUndefined()
    expect(githubLoginFromUser(undefined)).toBeUndefined()
    expect(githubLoginFromUser({})).toBeUndefined()
  })

  it('reads user_metadata.user_name and lowercases it', () => {
    expect(
      githubLoginFromUser({ user_metadata: { user_name: 'Atharrison' } })
    ).toBe('atharrison')
  })

  it('prefers the github identity over a non-github identities[0]', () => {
    expect(
      githubLoginFromUser({
        identities: [
          { provider: 'email', identity_data: { user_name: 'not-this' } },
          { provider: 'github', identity_data: { user_name: 'FromGitHub' } },
        ],
      })
    ).toBe('fromgithub')
  })

  it('does not use a non-github identities[0] as the login', () => {
    expect(
      githubLoginFromUser({
        identities: [
          { provider: 'email', identity_data: { user_name: 'not-github' } },
        ],
      })
    ).toBeUndefined()
  })

  it('ignores blank user_name values and non-object identity_data', () => {
    expect(
      githubLoginFromUser({ user_metadata: { user_name: '   ' } })
    ).toBeUndefined()
    expect(
      githubLoginFromUser({
        identities: [{ provider: 'github', identity_data: 'nope' }],
      })
    ).toBeUndefined()
  })
})

describe('isAdminGithubUser', () => {
  const admin = {
    user_metadata: { user_name: 'atharrison' },
  }
  const other = {
    user_metadata: { user_name: 'coworker' },
  }

  it('returns false for a missing user', () => {
    expect(isAdminGithubUser(null, 'atharrison')).toBe(false)
    expect(isAdminGithubUser(undefined, undefined)).toBe(false)
  })

  it('denies everyone when the allowlist is unset or empty', () => {
    expect(isAdminGithubUser(admin, undefined)).toBe(false)
    expect(isAdminGithubUser(admin, '')).toBe(false)
    expect(isAdminGithubUser(admin, '  ,  ')).toBe(false)
    expect(isAdminGithubUser({ id: 'user-1' }, undefined)).toBe(false)
  })

  it('allows only listed GitHub logins when the allowlist is set', () => {
    expect(isAdminGithubUser(admin, 'atharrison,bob')).toBe(true)
    expect(isAdminGithubUser(admin, 'ATHARRISON')).toBe(true)
    expect(isAdminGithubUser(other, 'atharrison')).toBe(false)
  })

  it('denies users without a GitHub login when the allowlist is set', () => {
    expect(isAdminGithubUser({ id: 'user-1' }, 'atharrison')).toBe(false)
  })
})

describe('isAllowedGithubLogin', () => {
  it('rejects missing or blank logins', () => {
    expect(isAllowedGithubLogin(null, undefined)).toBe(false)
    expect(isAllowedGithubLogin('  ', undefined)).toBe(false)
  })

  it('allows any login when the allowlist is empty', () => {
    expect(isAllowedGithubLogin('dev', undefined)).toBe(true)
    expect(isAllowedGithubLogin('dev', '')).toBe(true)
    expect(isAllowedGithubLogin('Dev', '  ,  ')).toBe(true)
  })

  it('requires a listed login when the allowlist is set', () => {
    expect(isAllowedGithubLogin('Dev', 'alice,dev')).toBe(true)
    expect(isAllowedGithubLogin('other', 'alice,dev')).toBe(false)
  })
})
