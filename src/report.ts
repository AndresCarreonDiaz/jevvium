import type { Trace } from './explorer.ts'
import type { Expectation } from './types.ts'

/** How many lines of the last screen's text the report shows. */
const SCREEN_LINES = 8

/**
 * What a run that didn't pass ends with, for a person to act on: the checks that
 * don't hold, text on screen that nearly matches one, and what the last screen
 * showed. Everything comes from the trace, so test data is already replaced.
 */
export function stopReport(trace: Trace): string[] {
  if (trace.outcome === 'passed') return []
  const screen = trace.steps.at(-1)?.screenText ?? []
  const lines: string[] = []
  for (const expectation of trace.failedExpectations) {
    lines.push(`missing: ${describe(expectation)}`)
    const near = 'text' in expectation ? nearMatch(expectation.text, screen) : undefined
    if (near) lines.push(`  on screen instead: "${near}" (a text check must match the whole text, capitals and punctuation included)`)
  }
  if (screen.length > 0) {
    const shown = screen.slice(0, SCREEN_LINES).map((text) => `"${shorten(text)}"`)
    const more = screen.length > SCREEN_LINES ? `, and ${screen.length - SCREEN_LINES} more` : ''
    lines.push(`last screen: ${shown.join(', ')}${more}`)
  }
  return lines
}

function describe(expectation: Expectation): string {
  return 'text' in expectation ? `text "${expectation.text}"` : `id "${expectation.id}"`
}

/** Text on screen that equals the expected text once case, spacing and punctuation are ignored. */
function nearMatch(expected: string, screen: string[]): string | undefined {
  const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const target = plain(expected)
  return screen.find((text) => text !== expected && plain(text) === target)
}

function shorten(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}
