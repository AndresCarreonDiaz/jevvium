import type { Criterion, Expectation } from './types.ts'

/**
 * Reads a test plan written in Markdown, the way a QA engineer writes one in a PR
 * description or a ticket, into a criterion:
 *
 *     # Send an asset
 *
 *     The wallet is already funded.
 *
 *     1. From the Home tab, tap Send
 *     2. Pick USDC from the asset list
 *     3. Enter 0xAb58...C9B as the recipient address
 *     4. Enter 10 as the amount and continue
 *     5. Review the details and confirm
 *
 *     Expected: the screen contains "Sent" and shows "10 USDC"
 *
 * - The title (or the first line) names the test; it and any plain paragraphs are the goal.
 * - Numbered or bulleted lines are the steps, in order. A step may wrap onto the next
 *   line, indented or not, as in Markdown; a blank line ends it.
 * - "Enter <value> as the <name>" in a step makes <name> test data, so the value is
 *   typed but never sent to the model. A "Test data:" section with "name: value"
 *   lines does the same.
 * - "Expected:" lines are the checks: each quoted string is text that must be on
 *   screen, whole, or anywhere in a text when the line says "contains"; `id X` is an
 *   accessibility id. A line without quotes is taken as the whole text.
 * - HTML comments are notes to the plan's readers, not part of it.
 */
export function parsePlan(markdown: string, fallbackId: string): Criterion {
  const context: string[] = []
  const steps: string[] = []
  const expect: Expectation[] = []
  const inputs: Record<string, string> = {}
  const addInput = (name: string, value: string, where: string) => {
    if (inputs[name] !== undefined && inputs[name] !== value) {
      throw new Error(`The test data "${name}" is given twice with different values (${where})`)
    }
    inputs[name] = value
  }

  let title: string | undefined
  let section: Section = 'steps'
  // The lines of the paragraph being read, and whether the last line continued a step.
  let paragraph: string[] = []
  let inStep = false
  const endParagraph = () => {
    if (paragraph.length > 0) context.push(paragraph.join(' '))
    paragraph = []
    inStep = false
  }

  for (const raw of markdown.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const line = raw.replace(/\r$/, '').trimEnd()
    if (line.trim() === '') {
      endParagraph()
      continue
    }

    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line)
    const labelled = /^\s*\**([A-Za-z][A-Za-z ]{1,30}?)\**\s*:\s*(.*)$/.exec(line)
    if (heading) {
      endParagraph()
      const kind = sectionOf(heading[1])
      if (kind) section = kind
      else if (title === undefined) {
        title = heading[1].trim()
        section = 'steps'
      } else section = 'steps'
      continue
    }
    if (labelled && sectionOf(labelled[1])) {
      endParagraph()
      section = sectionOf(labelled[1])!
      if (labelled[2].trim() !== '') consume(section, labelled[2].trim(), line)
      continue
    }

    const item = /^\s*(?:\d+[.)]|[-*+•])\s+(.+)$/.exec(line)
    if (item) {
      endParagraph()
      consume(section, item[1].trim(), line)
      inStep = section === 'steps'
      continue
    }
    if (inStep) {
      // A step that wraps onto the next line, indented or not, until a blank line.
      steps[steps.length - 1] += ` ${line.trim()}`
      continue
    }
    if (section === 'data') throw new Error(`Test data must be written as "name: value", not ${JSON.stringify(line.trim())}`)
    if (section === 'expected') {
      consume(section, line.trim(), line)
      continue
    }
    if (title === undefined && context.length === 0 && paragraph.length === 0) title = line.trim()
    else paragraph.push(line.trim())
  }
  endParagraph()

  function consume(kind: Section, text: string, line: string): void {
    if (kind === 'steps') steps.push(text)
    else if (kind === 'expected') expect.push(...parseExpected(text, line))
    else {
      const pair = /^\**([^:=*]+?)\**\s*[:=]\s*(.+)$/.exec(text)
      if (!pair) throw new Error(`Test data must be written as "name: value", not ${JSON.stringify(text)}`)
      addInput(inputName(pair[1], line), unquote(pair[2].trim()), line.trim())
    }
  }

  for (const step of steps) {
    for (const { name, value } of inlineInputs(step)) addInput(inputName(name, step), value, step)
  }

  // "Buy a backpack. A shopper buys..." : the title reads as a sentence before the context.
  const goal = [title, ...context]
    .filter((part): part is string => part !== undefined && part !== '')
    .map((part, i, parts) => (i < parts.length - 1 && !/[.!?:]$/.test(part) ? `${part}.` : part))
    .join(' ')
  if (goal === '') throw new Error('A test plan needs a title or a sentence saying what it tests')
  return { id: fallbackId, ...(title && { title }), goal, ...(steps.length > 0 && { steps }), inputs, expect }
}

type Section = 'steps' | 'expected' | 'data'

/** The first test plan `jevvium init` writes, with what each part is for in a comment the parser skips. */
export const STARTER_PLAN = `# Log in

1. Open the Login tab at the bottom of the screen
2. Enter qa.demo@example.com as the email and Str0ngPassw0rd as the password
3. Tap LOGIN

Expected: "You are logged in!"

<!--
A test plan for jevvium: a title, the steps a tester would follow, and what the screen
shows when it worked. jevvium explores your app to find the taps and the typing that
carry the plan out, then writes them down as a plain WebdriverIO test.

These steps are for the WebdriverIO demo app that jevvium's own examples use (the
repository's scripts/download-apps.sh fetches it). Replace them with a flow of your app.

  Check it without a device:  npx jevvium validate criteria/example.md
  Explore it:                 npx jevvium explore criteria/example.md --app path/to/YourApp.app

Steps: numbered lines, in order. jevvium works through them one at a time.
Test data: "Enter <value> as the <name>" in a step. Only the name reaches the model; the
  value is typed and ends up in the test, so use made-up data.
Expected: each quoted text must be on screen, whole, at the end. Say "contains" for a part
  of a text (contains "Order #"), or "id X" for an accessibility id. Checked without any
  model: the run only passes if every check holds.
Plain paragraphs outside this comment are context the model reads with the title, such
  as where the feature lives or what state the app starts in.
-->
`

const SECTIONS: [RegExp, Section][] = [
  [/^(steps?|test plan|plan|how|how to test|test)$/i, 'steps'],
  [/^(expected|expect|expected results?|expected outcome|then|results?|outcome|assert|verify)$/i, 'expected'],
  [/^(test data|data|inputs?|values|with)$/i, 'data'],
]

function sectionOf(name: string): Section | undefined {
  const plain = name.trim().replace(/[*_`]/g, '')
  return SECTIONS.find(([pattern]) => pattern.test(plain))?.[1]
}

/** The quoted strings in an "Expected" line, or the line itself when it quotes nothing. */
function parseExpected(text: string, line: string): Expectation[] {
  const found: Expectation[] = []
  const rest = text.replace(/(?:^|\s)(?:accessibility\s+)?id[:\s]+("[^"]+"|“[^”]+”|'[^']+'|\S+)/gi, (_, id: string) => {
    found.push({ id: unquote(id).replace(/[.,;]$/, '') })
    return ' '
  })
  const quoted = [...rest.matchAll(/"([^"]+)"|“([^”]+)”/g)].map((match) => match[1] ?? match[2])
  const partial = /\b(contain|includ|part of|somewhere|anywhere|mention)/i.test(rest)
  for (const value of quoted) found.push(partial ? { contains: value } : { text: value })
  if (found.length === 0) {
    const whole = text.replace(/[.;]$/, '').trim()
    if (whole === '') throw new Error(`An "Expected" line says nothing to check: ${JSON.stringify(line.trim())}`)
    found.push({ text: whole })
  }
  return found
}

/**
 * Test data written into a step: `enter 10 as the amount`, `type "Jane Tester" as
 * their full name`, `enter qa@example.com into the Email field`. One verb can give
 * several values: `enter 12345 as the zip code and United States as the country`.
 * The list ends at a clause that doesn't name a value (`and continue`), at a period
 * or a semicolon, or at `then`.
 */
export function inlineInputs(step: string): { name: string; value: string }[] {
  const found: { name: string; value: string }[] = []
  const verbs = /\b(?:enters?|types?|fills? in|inputs?|writes?|uses?|puts?|pastes?|provides?)\s+/gi
  for (const verb of step.matchAll(verbs)) {
    // A period ends the sentence only before a space or the end, so an email or a decimal survives.
    const clause = step.slice(verb.index + verb[0].length).split(/[.;](?=\s|$)|\s+then\b/i)[0]
    for (const piece of clauses(clause)) {
      const pair = /^("[^"]*"|“[^”]*”|'[^']*'|.+?)\s+(?:as|in|into|for|under)\s+(?:(?:the|their|a|an|its|my|your)\s+)?(.+)$/i.exec(piece)
      if (!pair) break
      found.push({ name: pair[2].trim(), value: unquote(pair[1]) })
    }
  }
  return found
}

/** The pieces of a list, split at commas and "and" outside quotes. */
function clauses(text: string): string[] {
  const pieces: string[] = []
  let current = ''
  let quote: string | undefined
  const closing: Record<string, string> = { '"': '"', '“': '”', "'": "'" }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (char === quote) quote = undefined
    } else if (closing[char] && (i === 0 || /\s/.test(text[i - 1]))) {
      quote = closing[char]
    } else if (char === ',' || /^\s+and\s+/i.test(text.slice(i))) {
      pieces.push(current)
      current = ''
      if (char !== ',') i += /^\s+and\s+/i.exec(text.slice(i))![0].length - 1
      continue
    }
    current += char
  }
  pieces.push(current)
  return pieces.map((piece) => piece.trim()).filter((piece) => piece !== '')
}

/** "recipient address field" becomes `recipient_address`: a plain word the model and the spec can use. */
function inputName(text: string, where: string): string {
  const name = text
    .toLowerCase()
    .replace(/\s+(field|box|input|textbox)$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9_]+/, '')
  if (name === '') throw new Error(`Can't name the test data in ${JSON.stringify(where.trim())}: say what it is, like "as the amount"`)
  return name
}

function unquote(value: string): string {
  return value.replace(/^(["'“])(.*)(["'”])$/, '$2')
}
