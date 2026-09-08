/**
 * ATH-29: GitHub-comment sections that are not findings — preamble,
 * ticket alignment, what-looks-good, questions, and testing
 * recommendations — with the same Include/edit model as findings.
 */

import { ReviewSection } from '../agents/pr-review/schema'
import type {
  AlignmentItem,
  FindingDecision,
  PRReview,
  SectionDecision,
} from '../agents/pr-review/schema'

export { ReviewSection }
export type { SectionDecision }

export const REVIEW_SECTIONS: ReviewSection[] = [
  ReviewSection.PREAMBLE,
  ReviewSection.TICKET_ALIGNMENT,
  ReviewSection.WHAT_LOOKS_GOOD,
  ReviewSection.QUESTIONS,
  ReviewSection.TESTING_RECOMMENDATIONS,
]

export type ReviewCommentExtras = {
  summary?: string
  verdict?: PRReview['verdict']
  verdictSummary?: string
  ticketAlignment?: AlignmentItem[]
  whatLooksGood?: string[]
  questions?: string[]
  testingRecommendations?: string[]
}

export type UiSectionDecision = {
  section: ReviewSection
  accepted: boolean
  editedBody?: string
}

function sectionUiRecord(
  make: (section: ReviewSection) => UiSectionDecision
): Record<ReviewSection, UiSectionDecision> {
  return Object.fromEntries(
    REVIEW_SECTIONS.map(section => [section, make(section)])
  ) as Record<ReviewSection, UiSectionDecision>
}

export type ResolvedSection = {
  included: boolean
  text: string
}

export function defaultPreambleText(extras: {
  verdictSummary?: string
  summary?: string
}): string {
  return [extras.verdictSummary, extras.summary]
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(part => part.length > 0)
    .join('\n\n')
}

export function defaultListText(items: string[] | undefined): string {
  return (items ?? [])
    .map(item => item.trim())
    .filter(item => item.length > 0)
    .join('\n')
}

export function defaultAlignmentText(
  items: AlignmentItem[] | undefined
): string {
  return (items ?? [])
    .map(item => {
      const requirement = item.requirement.trim()
      if (!requirement) return ''
      const mark = item.met ? '[x]' : '[ ]'
      const loc =
        typeof item.location === 'string' && item.location.trim().length > 0
          ? ` — ${item.location.trim()}`
          : ''
      return `${mark} ${requirement}${loc}`
    })
    .filter(line => line.length > 0)
    .join('\n')
}

export function defaultSectionText(
  section: ReviewSection,
  extras: ReviewCommentExtras
): string {
  switch (section) {
    case ReviewSection.PREAMBLE:
      return defaultPreambleText(extras)
    case ReviewSection.TICKET_ALIGNMENT:
      return defaultAlignmentText(extras.ticketAlignment)
    case ReviewSection.WHAT_LOOKS_GOOD:
      return defaultListText(extras.whatLooksGood)
    case ReviewSection.QUESTIONS:
      return defaultListText(extras.questions)
    case ReviewSection.TESTING_RECOMMENDATIONS:
      return defaultListText(extras.testingRecommendations)
  }
}

export function listItemsFromText(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(item => item.length > 0)
}

export function resolveSection(
  section: ReviewSection,
  defaultText: string,
  decisions: SectionDecision[] | undefined
): ResolvedSection {
  const decision = decisions?.find(d => d.section === section)
  if (!decision) {
    return { included: defaultText.length > 0, text: defaultText }
  }
  if (decision.action === 'REJECT') {
    return { included: false, text: defaultText }
  }
  const edited =
    decision.action === 'EDIT' &&
    typeof decision.editedBody === 'string' &&
    decision.editedBody.trim().length > 0
      ? decision.editedBody
      : defaultText
  return { included: edited.length > 0, text: edited }
}

function includedFromAction(action: unknown): boolean | undefined {
  // undefined = unrecognised action, so hydrateSectionUi skips the row
  if (action === 'REJECT') return false
  if (action === 'ACCEPT' || action === 'EDIT') return true
  return undefined
}

function isReviewSection(value: unknown): value is ReviewSection {
  return REVIEW_SECTIONS.some(section => section === value)
}

const EMPTY_UI: Record<ReviewSection, UiSectionDecision> = sectionUiRecord(
  section => ({ section, accepted: false })
)

function defaultSectionUi(
  extras: ReviewCommentExtras
): Record<ReviewSection, UiSectionDecision> {
  return sectionUiRecord(section => ({
    section,
    accepted: defaultSectionText(section, extras).length > 0,
  }))
}

export function hydrateSectionUi(
  extras: ReviewCommentExtras,
  submission?: unknown
): Record<ReviewSection, UiSectionDecision> {
  const defaults = defaultSectionUi(extras)

  const rec =
    submission !== null &&
    typeof submission === 'object' &&
    !Array.isArray(submission)
      ? (submission as Record<string, unknown>)
      : null
  const list = rec?.sections
  if (!Array.isArray(list)) return defaults

  const overlay = new Map<ReviewSection, UiSectionDecision>()
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }
    const row = item as Record<string, unknown>
    if (!isReviewSection(row.section)) continue
    const accepted = includedFromAction(row.action)
    if (accepted === undefined) continue
    const decision: UiSectionDecision = {
      section: row.section,
      accepted,
    }
    if (typeof row.editedBody === 'string' && row.editedBody.length > 0) {
      decision.editedBody = row.editedBody
    }
    overlay.set(row.section, decision)
  }

  return sectionUiRecord(section => overlay.get(section) ?? defaults[section])
}

export function sectionReviewAction(decision: {
  accepted: boolean
  editedBody?: string
}): FindingDecision['action'] {
  if (!decision.accepted) return 'REJECT'
  if (decision.editedBody) return 'EDIT'
  return 'ACCEPT'
}

export function sectionDecisionsFromUi(
  sections: Record<ReviewSection, UiSectionDecision>
): SectionDecision[] {
  return REVIEW_SECTIONS.map(section => {
    const d = sections[section] ?? EMPTY_UI[section]
    return {
      section,
      action: sectionReviewAction(d),
      ...(d.editedBody ? { editedBody: d.editedBody } : {}),
    }
  })
}

function parseAlignmentItems(value: unknown): AlignmentItem[] {
  if (!Array.isArray(value)) return []
  const items: AlignmentItem[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }
    const rec = item as Record<string, unknown>
    if (typeof rec.requirement !== 'string' || rec.requirement.trim() === '') {
      continue
    }
    if (typeof rec.met !== 'boolean') continue
    const row: AlignmentItem = {
      requirement: rec.requirement,
      met: rec.met,
    }
    if (typeof rec.location === 'string' && rec.location.trim().length > 0) {
      row.location = rec.location
    }
    items.push(row)
  }
  return items
}

export function extrasFromReview(review: unknown): ReviewCommentExtras {
  if (review === null || typeof review !== 'object' || Array.isArray(review)) {
    return {}
  }
  const rec = review as Record<string, unknown>
  const extras: ReviewCommentExtras = {}
  if (typeof rec.summary === 'string') extras.summary = rec.summary
  if (
    rec.verdict === 'APPROVE' ||
    rec.verdict === 'REQUEST_CHANGES' ||
    rec.verdict === 'COMMENT'
  ) {
    extras.verdict = rec.verdict
  }
  if (typeof rec.verdictSummary === 'string') {
    extras.verdictSummary = rec.verdictSummary
  }
  const ticketAlignment = parseAlignmentItems(rec.ticketAlignment)
  if (ticketAlignment.length > 0) extras.ticketAlignment = ticketAlignment
  if (Array.isArray(rec.whatLooksGood)) {
    extras.whatLooksGood = rec.whatLooksGood.filter(
      (item): item is string => typeof item === 'string'
    )
  }
  if (Array.isArray(rec.questions)) {
    extras.questions = rec.questions.filter(
      (item): item is string => typeof item === 'string'
    )
  }
  if (Array.isArray(rec.testingRecommendations)) {
    extras.testingRecommendations = rec.testingRecommendations.filter(
      (item): item is string => typeof item === 'string'
    )
  }
  return extras
}

export function sectionHasContent(
  section: ReviewSection,
  extras: ReviewCommentExtras,
  decision?: UiSectionDecision
): boolean {
  if (decision?.editedBody && decision.editedBody.trim().length > 0) {
    return true
  }
  return defaultSectionText(section, extras).length > 0
}

export function displayedSectionText(
  section: ReviewSection,
  extras: ReviewCommentExtras,
  decision?: UiSectionDecision
): string {
  if (decision?.editedBody != null) return decision.editedBody
  return defaultSectionText(section, extras)
}

export function findingShadeKey(id: string): string {
  return `finding:${id}`
}

export function sectionShadeKey(section: ReviewSection): string {
  return `section:${section}`
}

export function visibleReviewSections(
  extras: ReviewCommentExtras,
  sections: Record<ReviewSection, UiSectionDecision>
): ReviewSection[] {
  return REVIEW_SECTIONS.filter(section =>
    sectionHasContent(section, extras, sections[section])
  )
}

export function reviewShadeKeys(
  findingIds: string[],
  visibleSections: ReviewSection[]
): string[] {
  return [
    ...findingIds.map(findingShadeKey),
    ...visibleSections.map(sectionShadeKey),
  ]
}

export function collapsedShadeMap(keys: string[]): Record<string, boolean> {
  return Object.fromEntries(keys.map(key => [key, true]))
}

export function allCardsCollapsed(
  collapsed: Record<string, boolean>,
  keys: string[]
): boolean {
  return keys.length > 0 && keys.every(key => collapsed[key] === true)
}

export enum IncludeAllState {
  ALL = 'ALL',
  NONE = 'NONE',
  MIXED = 'MIXED',
}

export function includeAllState(flags: boolean[]): IncludeAllState {
  if (flags.length === 0 || flags.every(flag => !flag)) {
    return IncludeAllState.NONE
  }
  if (flags.every(Boolean)) return IncludeAllState.ALL
  return IncludeAllState.MIXED
}
