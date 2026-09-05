export const KEY_WORDS = ['bug', 'report'] as const
export const SPAM_WORDS = ['seo', 'analysis', 'google', 'bing', 'phone call', 'are incomplete', 'keywords',
  'attract more clients', 'online visibility', 'improve your website', 'steps are incomplete',
  'Mark Colins', 'business and services',
  // gambling / promo-code spam (telegra.ph jackpot pitches)
  'promo code', 'jackpot', 'telegra.ph'
] as const
export const SPAM_BLOCK_MIN_MATCHES = 2
export const MIN_REPORT_WORDS = 15

export type InvestigationSkipReason = 'missing_keywords' | 'too_short'

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function matchesKeyword(text: string, keyword: string): boolean {
  const haystack = text.toLowerCase()
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack)
}

export function containsAllKeywords(
  text: string,
  keywords: readonly string[],
): boolean {
  return keywords.every((word) => matchesKeyword(text, word))
}

export function countSpamMatches(
  text: string,
  spamWords: readonly string[] = SPAM_WORDS,
): number {
  let count = 0
  for (const word of spamWords) {
    if (matchesKeyword(text, word)) count++
  }
  return count
}

export function shouldBlockAsSpam(
  text: string,
  spamWords: readonly string[] = SPAM_WORDS,
  minMatches: number = SPAM_BLOCK_MIN_MATCHES,
): boolean {
  return countSpamMatches(text, spamWords) >= minMatches
}

export const SPAM_BLOCK_REPLY_BODY = [
  'This email has been blocked by our automated spam filters.',
  '',
  'And will be reported to relevant public spam lists. Have a nice day :)',
].join('\n')

export function investigationSkipReason(
  text: string,
  keywords: readonly string[] = KEY_WORDS,
  minWords: number = MIN_REPORT_WORDS,
): InvestigationSkipReason | null {
  if (!containsAllKeywords(text, keywords)) return 'missing_keywords'
  if (countWords(text) < minWords) return 'too_short'
  return null
}

export function shouldInvestigateReport(text: string): boolean {
  return investigationSkipReason(text) === null
}
