import { actionOptions, fillKey, fillQuestion, GOAL_MET, inputOptions, NEXT_ACTION, stateOf } from './questions.ts'
import type { Decision, DecisionProvider, DecisionRequest } from './types.ts'

const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone'
const MAX_OPTIONS = 255
const RETRYABLE = new Set([429, 529])

export type JevOptions = {
  apiKey?: string
  model?: string
  url?: string
  /** Retries for rate limits and overload, with exponential backoff. */
  retries?: number
  timeoutMs?: number
  /** Injected in tests. */
  fetch?: typeof fetch
  /** Injected in tests so backoff doesn't slow them down. */
  sleep?: (ms: number) => Promise<void>
}

type ChoiceAnswer = { type: 'choice'; choice: string; probabilities?: Record<string, number>; confidence?: number }
type NoulAnswer = { type: 'noul'; noul: number }
type SystemOneResponse = {
  model: string
  answers: { next_action?: ChoiceAnswer; goal_met?: NoulAnswer } & Record<string, ChoiceAnswer | NoulAnswer | undefined>
  usage?: { input_tokens: number; output_tokens: number }
}

/**
 * Asks TypeSafe's Jev for the next action. Every question (what to do next,
 * whether the goal is already met, what goes in each empty field) goes out in
 * one request and Jev answers them in parallel, so each step
 * costs a single round trip.
 */
export class JevProvider implements DecisionProvider {
  readonly name = 'jev'
  private readonly apiKey: string
  private readonly model: string
  private readonly url: string
  private readonly retries: number
  private readonly timeoutMs: number
  private readonly fetch: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: JevOptions = {}) {
    const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY
    if (!apiKey) throw new Error('Set TYPESAFE_API_KEY to use the Jev provider')
    this.apiKey = apiKey
    this.model = options.model ?? process.env.JEVVIUM_MODEL ?? 'jev-latest'
    this.url = options.url ?? process.env.TYPESAFE_API_URL ?? DEFAULT_URL
    this.retries = options.retries ?? 3
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.fetch = options.fetch ?? globalThis.fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async warmUp(): Promise<void> {
    // Any answer will do: the TLS connection it leaves open is what the first decision reuses.
    await this.fetch(this.url, { method: 'HEAD', signal: AbortSignal.timeout(this.timeoutMs) }).catch(() => {})
  }

  async decide(request: DecisionRequest): Promise<Decision> {
    const started = performance.now()
    const response = await this.post(buildBody(request, this.model))
    const latencyMs = Math.round(performance.now() - started)

    const next = response.answers.next_action
    const goal = response.answers.goal_met
    if (next?.type !== 'choice' || goal?.type !== 'noul') {
      throw new Error('Jev returned an answer without next_action or goal_met')
    }

    const fills: Decision['fills'] = {}
    for (const field of request.fields) {
      const answer = response.answers[fillKey(field.key)]
      if (answer?.type === 'choice') {
        fills[field.key] = { input: answer.choice, confidence: answer.confidence ?? answer.probabilities?.[answer.choice] ?? 0 }
      }
    }

    const probabilities = next.probabilities ?? {}
    return {
      action: next.choice,
      confidence: next.confidence ?? probabilities[next.choice] ?? 0,
      probabilities,
      goalMet: goal.noul,
      fills,
      model: response.model,
      latencyMs,
      usage: response.usage && {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    }
  }

  private async post(body: unknown): Promise<SystemOneResponse> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (res.ok) return (await res.json()) as SystemOneResponse
      if (RETRYABLE.has(res.status) && attempt < this.retries) {
        await this.sleep(500 * 2 ** attempt)
        continue
      }
      // The body explains validation errors; it never contains the key.
      throw new Error(`Jev request failed with ${res.status}: ${await res.text()}`)
    }
  }
}

export function buildBody(request: DecisionRequest, model: string) {
  if (request.actions.length + 1 > MAX_OPTIONS) {
    throw new Error(`Jev accepts at most ${MAX_OPTIONS} options; this screen has ${request.actions.length} actions`)
  }
  const inputs = inputOptions(request)
  const fillQuestions = Object.fromEntries(
    request.fields.map((field) => [fillKey(field.key), { type: 'choice', instructions: fillQuestion(field), criteria: inputs }]),
  )

  return {
    model,
    state: stateOf(request),
    questions: {
      next_action: { type: 'choice', instructions: NEXT_ACTION, criteria: actionOptions(request) },
      goal_met: {
        type: 'noul',
        instructions: GOAL_MET,
        criteria: {
          true: 'The visible text or control states confirm the goal is complete.',
          false: 'The goal is not complete yet, or the screen does not show it.',
        },
      },
      ...fillQuestions,
    },
  }
}
