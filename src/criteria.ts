import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { parse } from 'yaml'
import type { Criterion, Expectation } from './types.ts'

/** Reads one acceptance criterion from a YAML file. */
export function loadCriterion(path: string): Criterion {
  const raw: unknown = parse(readFileSync(path, 'utf8'))
  return parseCriterion(raw, basename(path, extname(path)))
}

export function parseCriterion(raw: unknown, fallbackId: string): Criterion {
  if (!isRecord(raw)) throw new Error('A criterion must be a YAML mapping')

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
      if (isRecord(item) && typeof item.id === 'string') expect.push({ id: item.id })
      else if (isRecord(item) && typeof item.text === 'string') expect.push({ text: item.text })
      else throw new Error('Each `expect` entry needs an `id` or a `text`')
    }
  }

  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : fallbackId
  // The id heads the generated spec in a comment, which a line break would end.
  if (/[\p{Cc}\u2028\u2029]/u.test(id)) throw new Error('A criterion `id` must be a single line of text')
  return { id, goal: goal.trim(), inputs, expect }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
