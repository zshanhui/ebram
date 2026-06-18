export const InvestigationVerdict = {
  VALID: 'VALID',
  NOT_VALID: 'NOT_VALID',
  OUT_SCOPE: 'OUT_SCOPE',
  NEEDS_HUMAN: 'NEEDS_HUMAN',
  SPAM: 'SPAM',
  DANGEROUS: 'DANGEROUS',
} as const

export type InvestigationVerdict = typeof InvestigationVerdict[keyof typeof InvestigationVerdict]

export const investigationVerdictValues = Object.values(InvestigationVerdict) as [
  InvestigationVerdict,
  ...InvestigationVerdict[],
]

export const silentNegativeVerdicts: ReadonlySet<InvestigationVerdict> = new Set([
  InvestigationVerdict.SPAM,
  InvestigationVerdict.DANGEROUS,
  InvestigationVerdict.NOT_VALID,
  InvestigationVerdict.OUT_SCOPE,
])

export function formatInvestigationVerdictPromptList(): string {
  return investigationVerdictValues.join(' | ')
}
