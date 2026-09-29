/**
 * Test data stays on the machine: before a screen goes to the decision model or
 * into a trace, each input value in it is replaced with `{name}`.
 *
 * - Matching ignores case, so an app that upper-cases an email is still covered.
 * - A value made only of digits also matches when the app groups them with spaces,
 *   dashes or slashes, the way card numbers, phone numbers and dates are shown.
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
 * code generation can put the exact value back. Values are replaced only inside
 * the selector's quoted strings (or an accessibility id), never in its syntax or
 * an XPath index: `{name}` where the value is written as it is, `{name|q}` where
 * its quotes are escaped (iOS predicate and UiSelector strings). Braces already in
 * the selector are doubled, as in a format string.
 */
export function placeholderSelector(selector: string, inputs: Record<string, string>): string {
  const entries = usable(inputs)
  return valueParts(selector)
    .map(({ text, value, escaped }) => {
      if (!value || entries.length === 0) return braces(text)
      const forms = entries
        .map(([name, raw]) => {
          const written = escaped ? predicateEscape(raw) : raw
          return { written, placeholder: `{${name}${written === raw ? '' : '|q'}}` }
        })
        .sort((a, b) => b.written.length - a.written.length)
      const pattern = new RegExp(forms.map(({ written }) => `(${wholeIfShort(escapeRegExp(written), written)})`).join('|'), 'gu')
      let result = ''
      let last = 0
      for (const match of text.matchAll(pattern)) {
        const group = match.slice(1).findIndex((g) => g !== undefined)
        result += braces(text.slice(last, match.index)) + forms[group].placeholder
        last = match.index + match[0].length
      }
      return result + braces(text.slice(last))
    })
    .join('')
}

/** Puts the values `placeholderSelector` took out back in. */
export function restoreSelector(selector: string, inputs: Record<string, string>): string {
  return selector.replace(/\{\{|\}\}|\{([^{}|]+)(\|q)?\}/g, (token, name?: string, quoted?: string) => {
    if (name === undefined) return token[0]
    const value = inputs[name]
    if (value === undefined) throw new Error(`The selector ${selector} needs an input named "${name}"`)
    return quoted ? predicateEscape(value) : value
  })
}

/** Longest first, so a value that contains another is replaced whole. */
function usable(inputs: Record<string, string>): [string, string][] {
  return Object.entries(inputs)
    .filter(([, value]) => value.trim() !== '')
    .sort(([, a], [, b]) => b.length - a.length)
}

function valuePattern(value: string): string {
  if (/^\d{4,}$/.test(value)) return [...value].join('[\\s/-]?')
  const forms = [...new Set([value, predicateEscape(value)])]
  if (value.length < 3) return wholeIfShort(forms.map(escapeRegExp).join('|'), value)
  return forms.map(anyCase).join('|')
}

/** A short value must stand alone: no letter or digit right before or after it. */
function wholeIfShort(pattern: string, value: string): string {
  return value.length < 3 ? `(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])` : pattern
}

/** A pattern for `text` in any case, letter by letter (the `i` flag would apply to short values too). */
function anyCase(text: string): string {
  return [...text]
    .map((char) => {
      const lower = char.toLowerCase()
      const upper = char.toUpperCase()
      return lower === upper || lower.length > 1 || upper.length > 1 ? escapeRegExp(char) : `[${lower}${upper}]`
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
