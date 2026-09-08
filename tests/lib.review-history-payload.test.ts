import {
  reviewHistoryAuthor,
  reviewHistoryFields,
  reviewHistoryMetadata,
  UNKNOWN_REVIEW_AUTHOR,
} from '../src/lib/review-history-payload'
import { parsePrUrl } from '../src/lib/queue'

describe('reviewHistoryFields', () => {
  it('reads summary and findings[] from a bare review object', () => {
    expect(
      reviewHistoryFields({
        summary: 'Found 3 issues',
        findings: [{}, {}, {}],
      })
    ).toEqual({ summary: 'Found 3 issues', findingCount: 3 })
  })

  it('unwraps the finalize { review, submission } envelope', () => {
    expect(
      reviewHistoryFields({
        review: {
          summary: 'Token leak in callback',
          blockingIssues: [{ id: 'f1' }, { id: 'f2' }],
          suggestions: [{ id: 'f3' }],
          nits: [],
        },
        submission: { reviewId: 'rev-1', decisions: [], postToGitHub: false },
      })
    ).toEqual({ summary: 'Token leak in callback', findingCount: 3 })
  })

  it('counts PRReview buckets when findings is absent', () => {
    expect(
      reviewHistoryFields({
        summary: 'Looks good',
        blockingIssues: [{ id: 'b1' }],
        suggestions: [],
        nits: [{ id: 'n1' }, { id: 'n2' }],
      })
    ).toEqual({ summary: 'Looks good', findingCount: 3 })
  })

  it('returns empty summary and 0 findings for null or junk', () => {
    expect(reviewHistoryFields(null)).toEqual({
      summary: '',
      findingCount: 0,
    })
    expect(reviewHistoryFields(undefined)).toEqual({
      summary: '',
      findingCount: 0,
    })
    expect(reviewHistoryFields('not-an-object')).toEqual({
      summary: '',
      findingCount: 0,
    })
    expect(reviewHistoryFields({ summary: 12, findings: 'nope' })).toEqual({
      summary: '',
      findingCount: 0,
    })
  })

  it('prefers findings[] over buckets when both exist', () => {
    expect(
      reviewHistoryFields({
        summary: 'mixed',
        findings: [{ id: 'a' }],
        blockingIssues: [{ id: 'b' }, { id: 'c' }],
      })
    ).toEqual({ summary: 'mixed', findingCount: 1 })
  })
})

describe('reviewHistoryAuthor', () => {
  it('normalizes a GitHub login and falls back to unknown', () => {
    expect(reviewHistoryAuthor('Atharrison')).toBe('atharrison')
    expect(reviewHistoryAuthor('  Bob  ')).toBe('bob')
    expect(reviewHistoryAuthor(null)).toBe(UNKNOWN_REVIEW_AUTHOR)
    expect(reviewHistoryAuthor(undefined)).toBe(UNKNOWN_REVIEW_AUTHOR)
    expect(reviewHistoryAuthor('')).toBe(UNKNOWN_REVIEW_AUTHOR)
    expect(reviewHistoryAuthor('   ')).toBe(UNKNOWN_REVIEW_AUTHOR)
  })
})

describe('reviewHistoryMetadata', () => {
  it('fills repo fields from a parsed PR URL', () => {
    const parsed = parsePrUrl('https://github.com/acme/app/pull/42')
    expect(
      reviewHistoryMetadata({
        prUrl: 'https://github.com/acme/app/pull/42',
        parsed,
        prTitle: 'Fix leak',
        githubLogin: 'Dev',
      })
    ).toEqual({
      prUrl: 'https://github.com/acme/app/pull/42',
      repoName: 'acme/app',
      prTitle: 'Fix leak',
      author: 'dev',
      prNumber: 42,
    })
  })

  it('uses placeholder repo fields when the URL cannot be parsed', () => {
    expect(
      reviewHistoryMetadata({
        prUrl: 'not-a-pr',
        parsed: null,
        prTitle: 'Untitled',
        githubLogin: null,
      })
    ).toEqual({
      prUrl: 'not-a-pr',
      repoName: 'unknown/unknown',
      prTitle: 'Untitled',
      author: UNKNOWN_REVIEW_AUTHOR,
      prNumber: 0,
    })
  })
})
