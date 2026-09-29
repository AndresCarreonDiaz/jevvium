import { STUCK, type Decision, type DecisionProvider, type DecisionRequest } from './types.ts'

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
  answers: { next_action?: ChoiceAnswer; goal_met?: NoulAnswer }
  usage?: { input_tokens: number; output_tokens: number }
}

/**
 * Asks TypeSafe's Jev for the next action. Both questions (what to do next,
 * and whether the goal is already met) go out in one request, so each step
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
    this.url = options.url ?? DEFAULT_URL
    this.retries = options.retries ?? 3
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.fetch = options.fetch ?? globalThis.fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
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

    const probabilities = next.probabilities ?? {}
    return {
      action: next.choice,
      confidence: next.confidence ?? probabilities[next.choice] ?? 0,
      probabilities,
      goalMet: goal.noul,
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

  const options: Record<string, string> = {}
  for (const action of request.actions) options[action.key] = action.description
  options[STUCK] = 'None of the actions on this screen moves the test toward the goal.'

  return {
    model,
    state: {
      platform: request.platform,
      goal: request.goal,
      visible_text: request.screenText,
      steps_taken: request.history,
      test_data_available: request.inputNames,
    },
    questions: {
      next_action: {
        type: 'choice',
        instructions:
          'You are a QA engineer testing a mobile app. Given the goal, the visible text and the steps ' +
          'already taken, pick the single next action that moves the test closest to the goal. ' +
          'Prefer actions that have not been taken yet on this screen. If the keyboard is open and ' +
          'the next step is a tap outside the field, close the keyboard first.',
        criteria: options,
      },
      goal_met: {
        type: 'noul',
        instructions: 'Does the current screen show that the goal has been reached?',
        criteria: {
          true: 'The visible text or screen confirms the goal is complete.',
          false: 'The goal is not complete yet, or the screen does not show it.',
        },
      },
    },
  }
}
