/** Extract meaningful keywords — keeps short important terms like "KYC", "AI" */
export function extractKeywords(query: string): string[] {
  const stopWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'for', 'in', 'on', 'at', 'to', 'of',
    'is', 'it', 'about', 'that', 'with', 'by', 'this', 'my', 'me', 'i',
    'something', 'anything', 'some', 'any', 'show', 'find', 'get', 'use',
    'regarding', 'context', 'would', 'could', 'should', 'want', 'need',
    'looking', 'related', 'using', 'used', 'based',
  ])
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    // Allow short words (2+ chars) so "AI", "ML", "KYC" survive
    .filter((w) => w.length >= 2 && !stopWords.has(w))
    .slice(0, 10)
}
