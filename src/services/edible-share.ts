const PERCENT_MARKER = /\[\s*(\d+(?:[.,]\d+)?)\s*%\s*\]/
const SKIP_MARKER = /nicht\s+mitrechnen/i

export function parseEdiblePercent(note: string | null | undefined): number | null {
  if (!note) return null
  const percent = PERCENT_MARKER.exec(note)
  if (percent) {
    const value = Number.parseFloat(percent[1].replace(",", "."))
    return Math.min(100, Math.max(0, value))
  }
  return SKIP_MARKER.test(note) ? 0 : null
}
