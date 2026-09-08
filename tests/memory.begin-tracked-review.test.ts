const mockCreateReview = jest.fn()
const mockMarkPrInReview = jest.fn()

jest.mock('../src/memory/review-store', () => ({
  createReview: (...args: unknown[]) => mockCreateReview(...args),
}))

jest.mock('../src/memory/tracked-pr-store', () => ({
  markPrInReview: (...args: unknown[]) => mockMarkPrInReview(...args),
}))

import { beginTrackedReview } from '../src/memory/begin-tracked-review'

beforeEach(() => {
  jest.clearAllMocks()
  mockCreateReview.mockResolvedValue(undefined)
  mockMarkPrInReview.mockResolvedValue(undefined)
})

describe('beginTrackedReview', () => {
  it('creates the review row then marks IN_REVIEW', async () => {
    await beginTrackedReview(
      'rev-1',
      'https://github.com/acme/app/pull/42',
      'full'
    )
    expect(mockCreateReview).toHaveBeenCalledWith(
      'rev-1',
      'https://github.com/acme/app/pull/42',
      'full'
    )
    expect(mockMarkPrInReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'app',
        pr_number: 42,
      }),
      'rev-1'
    )
  })

  it('omits last_review_id when createReview fails', async () => {
    mockCreateReview.mockRejectedValue(new Error('insert failed'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await beginTrackedReview(
      'rev-1',
      'https://github.com/acme/app/pull/42',
      'quick'
    )
    expect(mockMarkPrInReview).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 42 }),
      null
    )
    spy.mockRestore()
  })

  it('skips the queue upsert when the PR URL does not parse', async () => {
    await beginTrackedReview('rev-1', 'https://example.com/not-a-pr', 'full')
    expect(mockCreateReview).toHaveBeenCalled()
    expect(mockMarkPrInReview).not.toHaveBeenCalled()
  })

  it('swallows markPrInReview errors', async () => {
    mockMarkPrInReview.mockRejectedValue(new Error('upsert failed'))
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      beginTrackedReview('rev-1', 'https://github.com/acme/app/pull/42', 'full')
    ).resolves.toBeUndefined()
    spy.mockRestore()
  })
})
