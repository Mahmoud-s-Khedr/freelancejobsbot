/** Collapses all whitespace sequences to a single space and trims the result. */
export function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
