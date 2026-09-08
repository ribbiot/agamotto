/**
 * Pure auto-start policy for ATH-58.
 *
 * Webhook-triggered reviews generate findings only. They must never finalize
 * or post to GitHub — that stays an explicit human action (ATH-57).
 */
import { TrackedPrStatus } from './tracked-prs'

/** GitHub `pull_request` actions we branch on. */
export enum WebhookPrAction {
  OPENED = 'opened',
  REOPENED = 'reopened',
  CLOSED = 'closed',
  SYNCHRONIZE = 'synchronize',
}

/** Outcome of the auto-start gate. START is the only path that kicks the pipeline. */
export enum AutoStartDecision {
  START = 'START',
  SKIP_DISABLED = 'SKIP_DISABLED',
  SKIP_NOT_OPENED = 'SKIP_NOT_OPENED',
  SKIP_IN_REVIEW = 'SKIP_IN_REVIEW',
  SKIP_ALREADY_STARTED = 'SKIP_ALREADY_STARTED',
  SKIP_NO_AUTHOR = 'SKIP_NO_AUTHOR',
  SKIP_AUTHOR_NOT_ALLOWED = 'SKIP_AUTHOR_NOT_ALLOWED',
  SKIP_NO_TOKEN = 'SKIP_NO_TOKEN',
}

export interface AutoStartInput {
  action: string
  autoStartEnabled: boolean
  existingStatus: string | null
  lastReviewId: string | null
  authorLogin: string | null
  authorAllowed: boolean
  hasGithubToken: boolean
}

/** Trimmed GITHUB_TOKEN, or null when unset. Used for webhook diff fetch. */
export function githubTokenFromEnv(
  raw: string | undefined = process.env.GITHUB_TOKEN
): string | null {
  const token = raw?.trim() ?? ''
  return token.length > 0 ? token : null
}

export function decideAutoStart(input: AutoStartInput): AutoStartDecision {
  if (!input.autoStartEnabled) return AutoStartDecision.SKIP_DISABLED
  if (input.action !== WebhookPrAction.OPENED) {
    return AutoStartDecision.SKIP_NOT_OPENED
  }
  if (input.existingStatus === TrackedPrStatus.IN_REVIEW) {
    return AutoStartDecision.SKIP_IN_REVIEW
  }
  if (input.lastReviewId) return AutoStartDecision.SKIP_ALREADY_STARTED
  const login = input.authorLogin?.trim() ?? ''
  if (!login) return AutoStartDecision.SKIP_NO_AUTHOR
  if (!input.authorAllowed) return AutoStartDecision.SKIP_AUTHOR_NOT_ALLOWED
  if (!input.hasGithubToken) return AutoStartDecision.SKIP_NO_TOKEN
  return AutoStartDecision.START
}
