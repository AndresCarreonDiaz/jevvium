import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { parse } from 'yaml'
import type { Criterion, Expectation } from './types.ts'

const KEYS = ['goal', 'inputs', 'expect', 'id']
const EXPECT_KEYS = ['id', 'text']

/**
 * Reads one acceptance criterion from a YAML file. Every value is read as the text
 * written, so test data like 0042 or a 17-digit card number stays exactly as typed.
 */
export function loadCriterion(path: string): Criterion {
  try {
    const raw: unknown = parse(readFileSync(path, 'utf8'), { schema: 'failsafe' })
    return parseCriterion(raw, basename(path, extname(path)))
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

export function parseCriterion(raw: unknown, fallbackId: string): Criterion {
  if (!isRecord(raw)) throw new Error('A criterion must be a YAML mapping')
  // A misspelt key would otherwise drop its part silently: `expects:` would leave the run with no checks.
  for (const key of Object.keys(raw)) {
    if (!KEYS.includes(key)) throw new Error(`Unknown key \`${key}\`${suggestion(key, KEYS)}. A criterion has goal, inputs, expect and id.`)
  }

  const goal = raw.goal
  if (typeof goal !== 'string' || goal.trim() === '') {
    throw new Error('A criterion needs a non-empty `goal`')
  }

  const inputs: Record<string, string> = {}
  if (raw.inputs !== undefined) {
    if (!isRecord(raw.inputs)) throw new Error('`inputs` must map names to values')
    for (const [name, value] of Object.entries(raw.inputs)) {
      // Names appear in placeholders such as `{email}`, so they are kept to plain words.
      if (!/^[A-Za-z][\w-]*$/.test(name)) {
        throw new Error(`Input name \`${name}\` must start with a letter and use only letters, digits, _ and -`)
      }
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new Error(`Input \`${name}\` must be a string or a number`)
      }
      inputs[name] = String(value)
    }
  }

  const expect: Expectation[] = []
  if (raw.expect !== undefined) {
    if (!Array.isArray(raw.expect)) throw new Error('`expect` must be a list')
    for (const item of raw.expect) {
      if (!isRecord(item)) throw new Error('Each `expect` entry needs an `id` or a `text`')
      for (const key of Object.keys(item)) {
        if (!EXPECT_KEYS.includes(key)) {
          throw new Error(`Unknown key \`${key}\` in an \`expect\` entry${suggestion(key, EXPECT_KEYS)}. Each entry has an \`id\` or a \`text\`.`)
        }
      }
      if (item.id !== undefined && item.text !== undefined) {
        throw new Error('An `expect` entry has both `id` and `text`; give each check its own entry')
      }
      if (typeof item.id === 'string' && item.id !== '') expect.push({ id: item.id })
      else if (typeof item.text === 'string' && item.text !== '') expect.push({ text: item.text })
      else throw new Error('Each `expect` entry needs an `id` or a `text`')
    }
  }

  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : fallbackId
  // The id heads the generated spec in a comment, which a line break would end.
  if (/[\p{Cc}\u2028\u2029]/u.test(id)) throw new Error('A criterion `id` must be a single line of text')
  return { id, goal: goal.trim(), inputs, expect }
}

/** " (did you mean `expect`?)" for a key a typo or two away from a known one, or that starts with it. */
function suggestion(key: string, known: string[]): string {
  const lower = key.toLowerCase()
  const near = known
    .map((candidate) => ({ candidate, distance: lower.startsWith(candidate) ? 0 : editDistance(lower, candidate) }))
    .sort((a, b) => a.distance - b.distance)[0]
  return near && near.distance <= 2 ? ` (did you mean \`${near.candidate}\`?)` : ''
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
