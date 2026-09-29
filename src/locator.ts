import type { Expectation, Locator, Platform } from './types.ts'

/** The WebdriverIO selector string for a locator, as used in `$()`. */
export function toSelector(locator: Locator): string {
  switch (locator.using) {
    case 'accessibility id':
      return `~${locator.value}`
    case '-ios predicate string':
      return `-ios predicate string:${locator.value}`
    case '-android uiautomator':
      return `android=${locator.value}`
    case 'xpath':
      return locator.value
  }
}

/** Where to look for an expectation. Ids match on both platforms; text is platform-specific. */
export function expectationLocator(expectation: Expectation, platform: Platform): Locator {
  if ('id' in expectation) return { using: 'accessibility id', value: expectation.id }
  return platform === 'ios'
    ? { using: '-ios predicate string', value: `label == ${quoted(expectation.text)}` }
    : { using: 'xpath', value: `//*[@text=${xpathLiteral(expectation.text)}]` }
}

/** A double-quoted string for iOS predicates and UiSelector arguments. */
export function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** XPath 1.0 has no escapes, so a value with both quote kinds needs concat(). */
export function xpathLiteral(value: string): string {
  if (!value.includes('"')) return `"${value}"`
  if (!value.includes("'")) return `'${value}'`
  return `concat(${value.split('"').map((part) => `"${part}"`).join(`, '"', `)})`
}
