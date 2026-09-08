import { TrackedPrStatus } from '../src/lib/tracked-prs'
import {
  AutoStartDecision,
  WebhookPrAction,
  decideAutoStart,
  githubTokenFromEnv,
} from '../src/lib/auto-start'

const base = {
  action: WebhookPrAction.OPENED,
  autoStartEnabled: true,
  existingStatus: null as string | null,
  lastReviewId: null as string | null,
  authorLogin: 'dev',
  authorAllowed: true,
  hasGithubToken: true,
}

describe('decideAutoStart', () => {
  it('starts the first opened review when the repo is opted in and GITHUB_TOKEN is set', () => {
    expect(decideAutoStart(base)).toBe(AutoStartDecision.START)
  })

  it('skips when the per-repo flag is off', () => {
    expect(decideAutoStart({ ...base, autoStartEnabled: false })).toBe(
      AutoStartDecision.SKIP_DISABLED
    )
  })

  it('skips synchronize and reopened even when the flag is on', () => {
    expect(
      decideAutoStart({ ...base, action: WebhookPrAction.SYNCHRONIZE })
    ).toBe(AutoStartDecision.SKIP_NOT_OPENED)
    expect(decideAutoStart({ ...base, action: WebhookPrAction.REOPENED })).toBe(
      AutoStartDecision.SKIP_NOT_OPENED
    )
  })

  it('skips when a run is already IN_REVIEW', () => {
    expect(
      decideAutoStart({
        ...base,
        existingStatus: TrackedPrStatus.IN_REVIEW,
      })
    ).toBe(AutoStartDecision.SKIP_IN_REVIEW)
  })

  it('skips when last_review_id is already set (not the first pass)', () => {
    expect(decideAutoStart({ ...base, lastReviewId: 'rev-1' })).toBe(
      AutoStartDecision.SKIP_ALREADY_STARTED
    )
  })

  it('skips when the PR has no author login', () => {
    expect(decideAutoStart({ ...base, authorLogin: null })).toBe(
      AutoStartDecision.SKIP_NO_AUTHOR
    )
    expect(decideAutoStart({ ...base, authorLogin: '  ' })).toBe(
      AutoStartDecision.SKIP_NO_AUTHOR
    )
  })

  it('skips when the author is not on ALLOWED_GITHUB_USERS', () => {
    expect(decideAutoStart({ ...base, authorAllowed: false })).toBe(
      AutoStartDecision.SKIP_AUTHOR_NOT_ALLOWED
    )
  })

  it('skips when GITHUB_TOKEN is unset', () => {
    expect(decideAutoStart({ ...base, hasGithubToken: false })).toBe(
      AutoStartDecision.SKIP_NO_TOKEN
    )
  })
})

describe('githubTokenFromEnv', () => {
  it('returns the trimmed token or null', () => {
    expect(githubTokenFromEnv('ghs_abc')).toBe('ghs_abc')
    expect(githubTokenFromEnv('  ghs_abc  ')).toBe('ghs_abc')
    expect(githubTokenFromEnv('')).toBeNull()
    expect(githubTokenFromEnv('   ')).toBeNull()
    expect(githubTokenFromEnv(undefined)).toBeNull()
  })

  it('reads GITHUB_TOKEN from the environment when no argument is passed', () => {
    const saved = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = 'ghs_from_env'
    expect(githubTokenFromEnv()).toBe('ghs_from_env')
    delete process.env.GITHUB_TOKEN
    expect(githubTokenFromEnv()).toBeNull()
    if (saved === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = saved
  })
})
