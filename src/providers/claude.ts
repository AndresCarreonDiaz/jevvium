import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actionOptions, fillKey, fillQuestion, GOAL_MET, GOAL_MET_ANSWERS, inputOptions, NEXT_ACTION, stateOf } from './questions.ts'
import type { Decision, DecisionProvider, DecisionRequest } from './types.ts'

/** How Claude is told to answer. The questions it answers are the shared ones. */
export const ANSWER_FORMAT =
  'Answer every question in the JSON below, about a mobile app test, from its state. ' +
  'Reply with one JSON object and nothing else: no code fence, no reasoning. It has one entry per ' +
  "question, under the question's name. A choice question's entry is " +
  '{"choice": "<the key of one of its options>", "confidence": <how sure you are of that choice, from 0 to 1>}. ' +
  "A probability question's entry is a number: the probability, from 0 to 1, that the answer is yes. " +
  'For example: {"next_action": {"choice": "<key>", "confidence": <0 to 1>}, "goal_met": <0 to 1>}.'

/**
 * Left out of the CLI's environment: other providers' keys; any Anthropic API key, token or
 * endpoint, and the switches to other clouds (CLAUDE_CODE_USE_BEDROCK and the like), so that
 * the Claude Code login (a Claude subscription) is what answers; and the variables that can
 * override --effort, so that --effort decides it.
 */
const WITHHELD = [
  'CLAUDECODE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_EXTRA_BODY', 'TYPESAFE_API_KEY', 'OPENAI_API_KEY',
]

export type CliResult = { stdout: string; stderr: string; code: number | null }

export type ClaudeOptions = {
  /** A Claude Code model name or alias (default: CLAUDE_MODEL, else sonnet). */
  model?: string
  /**
   * The CLI's --effort level (default: medium). It is set explicitly so that the
   * user's Claude Code settings don't change the results.
   */
  effort?: string
  timeoutMs?: number
  /** Injected in tests: runs the CLI with these arguments and this prompt. */
  run?: (args: string[], prompt: string) => Promise<CliResult>
}

type CliOutput = {
  is_error?: boolean
  result?: string
  duration_api_ms?: number
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    output_tokens?: number
    output_tokens_details?: { thinking_tokens?: number }
  }
  modelUsage?: Record<string, { outputTokens?: number }>
}

type Answer = Pick<Decision, 'action' | 'confidence' | 'probabilities' | 'goalMet' | 'fills'>

/**
 * Asks Claude through the Claude Code CLI (`claude -p`), signed in with a Claude
 * subscription rather than an API key. It is provisional: it exists to compare
 * numbers while OpenAI's Decisions API is out of reach, and isn't how a model
 * should be called in earnest. Each decision runs the CLI once (twice if the
 * first reply isn't a usable answer), with no tools, no project or user setup
 * and no prompt caching, on the same state and questions as `JevProvider`. The
 * CLI turns thinking off where it can, but not for Sonnet 5.5, which decides for
 * itself when to think, so the thinking it did is reported with each decision.
 * Claude reports no probabilities, so its confidence is its own estimate, and
 * `probabilities` holds only that estimate, for its choice.
 */
export class ClaudeProvider implements DecisionProvider {
  readonly name = 'claude'
  private readonly model: string
  private readonly effort: string
  private readonly run: (args: string[], prompt: string) => Promise<CliResult>

  constructor(options: ClaudeOptions = {}) {
    this.model = options.model ?? (process.env.CLAUDE_MODEL?.trim() || 'sonnet')
    this.effort = options.effort ?? 'medium'
    this.run = options.run ?? runCli(options.timeoutMs ?? 60_000)
  }

  async decide(request: DecisionRequest): Promise<Decision> {
    const prompt = buildPrompt(request)
    const started = performance.now()
    const usage = { inputTokens: 0, outputTokens: 0 }
    let apiLatencyMs = 0
    let thinkingTokens = 0
    let reply = ''
    // One more try when the reply isn't a usable answer. The CLI retries API errors itself.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { output, wallMs } = await this.ask(prompt)
      const tokens = output.usage ?? {}
      usage.inputTokens += (tokens.input_tokens ?? 0) + (tokens.cache_read_input_tokens ?? 0) + (tokens.cache_creation_input_tokens ?? 0)
      usage.outputTokens += tokens.output_tokens ?? 0
      apiLatencyMs += output.duration_api_ms ?? 0
      thinkingTokens += tokens.output_tokens_details?.thinking_tokens ?? 0
      reply = output.result ?? ''
      const answer = parseAnswer(reply, request)
      const model = modelOf(output) ?? this.model
      this.log({ model, effort: this.effort, attempt, wallMs, apiMs: output.duration_api_ms, usage: output.usage, ...(!answer && { refused: reply.slice(0, 300) }) })
      if (answer) {
        return { ...answer, model, latencyMs: Math.round(performance.now() - started), apiLatencyMs, thinkingTokens, usage }
      }
    }
    throw new Error(`Claude replied twice without a usable answer, last: ${oneLine(reply).slice(0, 160)}`)
  }

  private async ask(prompt: string): Promise<{ output: CliOutput; wallMs: number }> {
    const started = performance.now()
    const { stdout, stderr, code } = await this.run(
      [
        '-p', '--safe-mode', '--model', this.model, '--effort', this.effort, '--output-format', 'json',
        '--tools', '', '--no-session-persistence', '--system-prompt', ANSWER_FORMAT,
      ],
      prompt,
    )
    let output: CliOutput
    try {
      output = JSON.parse(stdout) as CliOutput
    } catch {
      throw new Error(`claude exited with ${code}: ${oneLine(stderr || stdout).slice(0, 200)}`)
    }
    if (output.is_error) throw new Error(`Claude Code: ${oneLine(output.result ?? 'error').slice(0, 200)}`)
    return { output, wallMs: Math.round(performance.now() - started) }
  }

  /** One line per CLI run, refused replies included, for the benchmark to read. */
  private log(call: Record<string, unknown>): void {
    if (process.env.JEVVIUM_CLAUDE_LOG) appendFileSync(process.env.JEVVIUM_CLAUDE_LOG, `${JSON.stringify(call)}\n`)
  }
}

/** The state and questions Jev gets, in the same words. How to answer is in the system prompt. */
export function buildPrompt(request: DecisionRequest): string {
  const inputs = inputOptions(request)
  const questions: Record<string, unknown> = {
    next_action: { type: 'choice', instructions: NEXT_ACTION, options: actionOptions(request) },
    goal_met: { type: 'probability', instructions: GOAL_MET, yes: GOAL_MET_ANSWERS.true, no: GOAL_MET_ANSWERS.false },
  }
  for (const field of request.fields) questions[fillKey(field.key)] = { type: 'choice', instructions: fillQuestion(field), options: inputs }
  return JSON.stringify({ state: stateOf(request), questions })
}

/**
 * The answer in Claude's reply, or undefined if the reply doesn't hold a valid one. Asked
 * for bare JSON, models still wrap it in a code fence, or answer, write "Wait, ..." and
 * answer again. The last answer is the one they settled on, so that one has to be valid.
 */
export function parseAnswer(reply: string, request: DecisionRequest): Answer | undefined {
  const last = jsonObjects(reply)
    .filter((json) => typeof json === 'object' && json !== null && !Array.isArray(json) && 'next_action' in json)
    .at(-1)
  return last === undefined ? undefined : answerIn(last, request)
}

function answerIn(value: unknown, request: DecisionRequest): Answer | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const json = value as Record<string, unknown>
  const next = choiceAmong(json.next_action, actionOptions(request))
  const goalMet = probabilityIn(json.goal_met)
  if (!next || goalMet === undefined) return undefined

  // A field without a valid answer is left for a later step, as with the other providers.
  const inputs = inputOptions(request)
  const fills: Decision['fills'] = {}
  for (const field of request.fields) {
    const fill = choiceAmong(json[fillKey(field.key)], inputs)
    if (fill) fills[field.key] = { input: fill.choice, confidence: fill.confidence }
  }
  return { action: next.choice, confidence: next.confidence, probabilities: { [next.choice]: next.confidence }, goalMet, fills }
}

/** Every {...} in the text that parses as JSON, in the order they start. The text around them is ignored. */
function jsonObjects(text: string): unknown[] {
  const objects: unknown[] = []
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = closingBrace(text, start)
    if (end < 0) continue
    try {
      objects.push(JSON.parse(text.slice(start, end + 1)))
    } catch {
      // Not JSON: a brace in prose, say.
    }
  }
  return objects
}

/** Where the brace at `start` is closed, skipping braces inside strings, or -1. */
function closingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

function choiceAmong(value: unknown, options: Record<string, string>): { choice: string; confidence: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { choice, confidence } = value as { choice?: unknown; confidence?: unknown }
  return typeof choice === 'string' && Object.hasOwn(options, choice) && isProbability(confidence) ? { choice, confidence } : undefined
}

/** A probability, given as a number or, as models sometimes put it, as {"probability": number}. */
function probabilityIn(value: unknown): number | undefined {
  const probability = typeof value === 'object' && value !== null ? (value as { probability?: unknown }).probability : value
  return isProbability(probability) ? probability : undefined
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1
}

/** The model that wrote the answer: the one with the most output, should the CLI have used another. */
function modelOf(output: CliOutput): string | undefined {
  return Object.entries(output.modelUsage ?? {}).sort(([, a], [, b]) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0))[0]?.[0]
}

function runCli(timeoutMs: number): (args: string[], prompt: string) => Promise<CliResult> {
  // An empty folder, so the CLI finds no project to load.
  const cwd = mkdtempSync(join(tmpdir(), 'jevvium-claude-'))
  process.once('exit', () => rmSync(cwd, { recursive: true, force: true }))
  const env = cliEnvironment(process.env)

  return (args, prompt) =>
    new Promise((resolve, reject) => {
      const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      // Decoded as a stream, so a character split between two chunks survives.
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => (stdout += chunk))
      child.stderr.on('data', (chunk: string) => (stderr += chunk))
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        reject(error.code === 'ENOENT' ? new Error('The claude CLI (Claude Code) is not installed, or not on PATH') : error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (timedOut) reject(new Error(`Claude Code did not answer within ${timeoutMs / 1000} s`))
        else resolve({ stdout, stderr, code })
      })
      // The CLI waits for its whole input, and gives up on it after 3 s, so it goes in at once.
      child.stdin.on('error', () => {})
      child.stdin.end(prompt)
    })
}

/** The environment the CLI runs in: this one, minus what's withheld, plus the settings below. */
export function cliEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (!WITHHELD.includes(name) && !name.startsWith('CLAUDE_CODE_USE_')) env[name] = value
  }
  // Thinking off where the CLI can do that, like the other providers' single pass (models that
  // decide for themselves when to think ignore it). No prompt caching, so repeated runs of the
  // same screens don't answer faster and cheaper from each other's cache. Without non-essential
  // traffic (update checks, telemetry), the CLI starts in about 0.2 s instead of 1.7 s.
  return { ...env, MAX_THINKING_TOKENS: '0', DISABLE_PROMPT_CACHING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
