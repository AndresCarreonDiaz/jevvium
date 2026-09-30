/**
 * Test data stays on the machine: before a screen goes to the decision model or
 * into a trace, each input value in it is replaced with `{name}`.
 *
 * - Matching ignores case, so an app that upper-cases an email is still covered.
 * - A value written as a number (a card, a phone number, a date) also matches when
 *   the app groups its digits with spaces, dots, slashes, dashes or parentheses.
 * - A value shorter than 3 characters is replaced only where it stands alone and in
 *   its exact case, so "42" is hidden in "PIN 42" but "1420" is left as it is, and a
 *   state "IN" doesn't hide the word "in".
 * - A value with quotes is also found where a selector escapes them, since error
 *   messages quote selectors.
 *
 * An app that transforms a value in other ways (masking, truncating, translating)
 * can still show part of it in a form this can't recognize.
 */
export function redactor(inputs: Record<string, string>): (text: string) => string {
  const entries = usable(inputs)
  if (entries.length === 0) return (text) => text
  const pattern = new RegExp(entries.map(([, value]) => `(${valuePattern(value)})`).join('|'), 'gu')
  // One pass, so a placeholder already written can't be matched by a shorter value.
  return (text) =>
    text.replace(pattern, (...match: unknown[]) => {
      const group = (match.slice(1, entries.length + 1) as (string | undefined)[]).findIndex((g) => g !== undefined)
      return `{${entries[group][0]}}`
    })
}

/**
 * Takes input values out of a selector so traces don't store test data, while
 * code generation can put the exact text back. Values are replaced only inside the
 * selector's quoted strings (or an accessibility id), never in its syntax or an
 * XPath index, with a placeholder that says how the app showed the value:
 *
 * - `{name}` as it is, `{name|upper}` or `{name|lower}` in capitals or lower case,
 * - `{name|mask:(###) ###-####}` a number with its digits grouped that way,
 * - `{name|?}` in some other form, which can't be rebuilt (see `restoreSelector`),
 * - with `|q` added where quotes are escaped (iOS predicate and UiSelector strings).
 *
 * Braces already in the selector are doubled, as in a format string.
 */
export function placeholderSelector(selector: string, inputs: Record<string, string>): string {
  const entries = usable(inputs)
  return valueParts(selector)
    .map(({ text, value, escaped }) => {
      if (!value || entries.length === 0) return braces(text)
      const forms = selectorForms(entries, escaped)
      const pattern = new RegExp(forms.map((form) => `(${form.pattern})`).join('|'), 'gu')
      let result = ''
      let last = 0
      for (const match of text.matchAll(pattern)) {
        const form = forms[match.slice(1).findIndex((g) => g !== undefined)]
        result += braces(text.slice(last, match.index)) + form.placeholder(match[0])
        last = match.index + match[0].length
      }
      return result + braces(text.slice(last))
    })
    .join('')
}

/** Puts the values `placeholderSelector` took out back in, the way the app showed them. */
export function restoreSelector(selector: string, inputs: Record<string, string>): string {
  return selector.replace(/\{\{|\}\}|\{([^{}|]+)((?:\|[^{}|]*)*)\}/g, (token, name?: string, modifiers = '') => {
    if (name === undefined) return token[0]
    let value = inputs[name]
    if (value === undefined) throw new Error(`The selector ${selector} needs an input named "${name}"`)
    const steps = (modifiers as string).split('|').slice(1)
    for (const step of steps) {
      if (step === '?') {
        throw new Error(
          `A selector held the test data "${name}" in a form jevvium can't rebuild (${selector}). Explore again, or write that step by hand.`,
        )
      }
      if (step === 'upper') value = value.toUpperCase()
      if (step === 'lower') value = value.toLowerCase()
      if (step.startsWith('mask:')) value = fillMask(step.slice(5), value, name)
    }
    return steps.includes('q') ? predicateEscape(value) : value
  })
}

type SelectorForm = { pattern: string; placeholder: (match: string) => string }

/**
 * What each input can look like inside one value part of a selector, most exact
 * first: as typed, upper or lower case, digits grouped, then any other mix of case.
 */
function selectorForms(entries: [string, string][], escaped: boolean): SelectorForm[] {
  const written = (text: string) => (escaped ? predicateEscape(text) : text)
  const tag = (name: string, modifier?: string) => (text: string) => {
    const q = escaped && predicateEscape(text) !== text ? '|q' : ''
    return `{${name}${modifier ? `|${modifier}` : ''}${q}}`
  }
  const exact: SelectorForm[] = []
  const cased: SelectorForm[] = []
  const grouped: SelectorForm[] = []
  const mixed: SelectorForm[] = []
  for (const [name, raw] of entries) {
    exact.push({ pattern: wholeIfShort(escapeRegExp(written(raw)), raw), placeholder: () => tag(name)(raw) })
    if (raw.length < 3) continue
    for (const [modifier, text] of [['upper', raw.toUpperCase()], ['lower', raw.toLowerCase()]] as const) {
      if (text !== raw) cased.push({ pattern: escapeRegExp(written(text)), placeholder: () => tag(name, modifier)(raw) })
    }
    const digits = digitsOf(raw)
    if (digits) grouped.push({ pattern: digitPattern(digits), placeholder: (match) => `{${name}|mask:${match.replace(/\d/g, '#')}}` })
    else mixed.push({ pattern: anyCase(written(raw)), placeholder: () => `{${name}|?}` })
  }
  const longestFirst = (a: SelectorForm, b: SelectorForm) => b.pattern.length - a.pattern.length
  return [...exact.sort(longestFirst), ...cased.sort(longestFirst), ...grouped, ...mixed]
}

/** Longest first, so a value that contains another is replaced whole. */
function usable(inputs: Record<string, string>): [string, string][] {
  return Object.entries(inputs)
    .filter(([, value]) => value.trim() !== '')
    .sort(([, a], [, b]) => b.length - a.length)
}

function valuePattern(value: string): string {
  const digits = digitsOf(value)
  if (digits) return digitPattern(digits)
  const forms = [...new Set([value, predicateEscape(value)])]
  if (value.length < 3) return wholeIfShort(forms.map(escapeRegExp).join('|'), value)
  // Whole-value upper and lower case catch what letter-by-letter can't, such as "ß" shown as "SS".
  const whole = forms.flatMap((form) => [form.toUpperCase(), form.toLowerCase()]).map(escapeRegExp)
  return [...new Set([...forms.map(anyCase), ...whole])].join('|')
}

/** The digits of a value written as a number of 4 digits or more, or undefined. */
function digitsOf(value: string): string | undefined {
  if (!/^\+?[\d\s()./-]+$/.test(value)) return undefined
  const digits = value.replace(/\D/g, '')
  return digits.length >= 4 ? digits : undefined
}

/** Those digits in order, with a few separators allowed between them and a leading "+" or "(". */
function digitPattern(digits: string): string {
  return `(?:\\+|\\()?${[...digits].join('[\\s().\\/-]{0,3}')}`
}

/** Writes the value's digits into the places the app showed digits in. */
function fillMask(mask: string, value: string, name: string): string {
  const digits = [...value.replace(/\D/g, '')]
  if (digits.length !== [...mask].filter((char) => char === '#').length) {
    throw new Error(`The test data "${name}" no longer fits the way the app showed it (${mask}); explore again`)
  }
  return mask.replace(/#/g, () => digits.shift()!)
}

/** A short value must stand alone: no letter or digit right before or after it. */
function wholeIfShort(pattern: string, value: string): string {
  return value.length < 3 ? `(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])` : pattern
}

/** A pattern for `text` in any case, letter by letter (the `i` flag would apply to short values too). */
function anyCase(text: string): string {
  return [...text]
    .map((char) => {
      const variants = [...new Set([char, char.toLowerCase(), char.toUpperCase()])].filter((variant) => [...variant].length === 1)
      return variants.length > 1 ? `[${variants.join('')}]` : escapeRegExp(char)
    })
    .join('')
}

type Part = { text: string; value: boolean; escaped: boolean }

/**
 * Splits a selector into its value parts (an accessibility id, or the inside of
 * each quoted string except a predicate's element type) and the syntax around
 * them. Predicate and UiSelector strings escape quotes with a backslash; XPath 1.0
 * strings have no escapes.
 */
function valueParts(selector: string): Part[] {
  if (selector.startsWith('~')) {
    return [{ text: '~', value: false, escaped: false }, { text: selector.slice(1), value: true, escaped: false }]
  }
  const escaped = selector.startsWith('-ios ') || selector.startsWith('android=')
  const strings = escaped ? /"((?:[^"\\]|\\.)*)"/g : /"([^"]*)"|'([^']*)'/g
  const parts: Part[] = []
  let last = 0
  for (const match of selector.matchAll(strings)) {
    if (selector.slice(0, match.index).endsWith('type == ')) continue
    const start = match.index + 1
    const end = match.index + match[0].length - 1
    parts.push({ text: selector.slice(last, start), value: false, escaped }, { text: selector.slice(start, end), value: true, escaped })
    last = end
  }
  parts.push({ text: selector.slice(last), value: false, escaped })
  return parts
}

function braces(text: string): string {
  return text.replace(/[{}]/g, '$&$&')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** How `quoted()` in locator.ts writes a value inside an iOS predicate or UiSelector string. */
function predicateEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
