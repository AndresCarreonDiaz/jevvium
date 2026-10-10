import type { Expectation } from './types.ts'

/** The expectation with its value passed through `redact`, for storing it in a trace. */
export function redactExpectation(expectation: Expectation, redact: (text: string) => string): Expectation {
  if ('id' in expectation) return { id: redact(expectation.id) }
  if ('text' in expectation) return { text: redact(expectation.text) }
  return { contains: redact(expectation.contains) }
}

/** `text "You are logged in!"`, `text containing "logged in"` or `id "ContinueShopping"`. */
export function describeExpectation(expectation: Expectation): string {
  if ('id' in expectation) return `id "${expectation.id}"`
  if ('text' in expectation) return `text "${expectation.text}"`
  return `text containing "${expectation.contains}"`
}
