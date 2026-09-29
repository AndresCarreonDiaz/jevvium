import { actionOptions, fillKey, fillQuestion, GOAL_MET, inputOptions, NEXT_ACTION, stateOf } from './questions.ts'
import type { Decision, DecisionProvider, DecisionRequest } from './types.ts'

const DEFAULT_URL = 'https://api.openai.com/v1/decisions'
/** The most questions one request may hold, as observed in the preview. */
const MAX_QUESTIONS = 64
const RETRYABLE = new Set([429, 500, 502, 503])

export type OpenAIDecisionsOptions = {
  apiKey?: string
  model?: string
  url?: string
  retries?: number
  timeoutMs?: number
  /** Injected in tests. */
  fetch?: typeof fetch
  /** Injected in tests so backoff doesn't slow them down. */
  sleep?: (ms: number) => Promise<void>
}

type Probability = { value: string; probability: number }
type Answer = { name?: string; choice?: string; probability?: number; probabilities?: Probability[]; confidence?: number }
type DecisionsResponse = { model: string; answers: Answer[]; usage?: { input_tokens: number; output_tokens: number } }

/**
 * Asks OpenAI's Decisions API (GPT-6 Luna) for the next action, with the same
 * questions and wording as `JevProvider`, so the two can be compared on equal
 * terms. The API was in limited preview when this was written, without public
 * documentation: the request follows calls recorded against it by an early
 * tester (choice questions with described choices, a predicate question, answers
 * in question order). Check it against OpenAI's reference once one exists.
 */
export class OpenAIDecisionsProvider implements DecisionProvider {
  readonly name = 'openai-decisions'
  private readonly apiKey: string
  private readonly model: string
  private readonly url: string
  private readonly retries: number
  private readonly timeoutMs: number
  private readonly fetch: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: OpenAIDecisionsOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('Set OPENAI_API_KEY to use the OpenAI Decisions provider')
    this.apiKey = apiKey
    this.model = options.model ?? process.env.OPENAI_DECISIONS_MODEL ?? 'gpt-6-luna'
    this.url = options.url ?? process.env.OPENAI_DECISIONS_URL ?? DEFAULT_URL
    this.retries = options.retries ?? 3
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.fetch = options.fetch ?? globalThis.fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async warmUp(): Promise<void> {
    await this.fetch(this.url, { method: 'HEAD', signal: AbortSignal.timeout(this.timeoutMs) }).catch(() => {})
  }

  async decide(request: DecisionRequest): Promise<Decision> {
    const body = buildDecisionsBody(request, this.model)
    const started = performance.now()
    const response = await this.post(body)
    const latencyMs = Math.round(performance.now() - started)

    // Answers come back in question order; a name, when present, is checked against it.
    const answerTo = (index: number): Answer | undefined => {
      const answer = response.answers[index]
      const asked = body.questions[index]?.name
      return answer && (answer.name === undefined || answer.name === asked) ? answer : response.answers.find((a) => a.name === asked)
    }
    const next = answerTo(0)
    const goal = answerTo(1)
    if (next?.choice === undefined || goal?.probability === undefined) {
      throw new Error('OpenAI Decisions returned an answer without next_action or goal_met')
    }

    const fills: Decision['fills'] = {}
    body.questions.slice(2).forEach((question, i) => {
      const answer = answerTo(i + 2)
      if (answer?.choice !== undefined) {
        const fieldKey = question.name.replace(/^fill_/, '')
        fills[fieldKey] = { input: answer.choice, confidence: answer.confidence ?? probabilityOf(answer, answer.choice) }
      }
    })

    const probabilities = Object.fromEntries((next.probabilities ?? []).map((p) => [p.value, p.probability]))
    return {
      action: next.choice,
      confidence: next.confidence ?? probabilityOf(next, next.choice),
      probabilities,
      goalMet: goal.probability,
      fills,
      model: response.model,
      latencyMs,
      usage: response.usage && { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    }
  }

  private async post(body: unknown): Promise<DecisionsResponse> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (res.ok) return (await res.json()) as DecisionsResponse
      if (RETRYABLE.has(res.status) && attempt < this.retries) {
        await this.sleep(500 * 2 ** attempt)
        continue
      }
      // The body explains validation errors; it never contains the key.
      throw new Error(`OpenAI Decisions request failed with ${res.status}: ${await res.text()}`)
    }
  }
}

type Question =
  | { type: 'choice'; name: string; instructions: string; choices: { value: string; description: string }[] }
  | { type: 'predicate'; name: string; instructions: string }

export function buildDecisionsBody(request: DecisionRequest, model: string) {
  const choices = (options: Record<string, string>) => Object.entries(options).map(([value, description]) => ({ value, description }))
  const inputs = choices(inputOptions(request))
  const questions: Question[] = [
    { type: 'choice', name: 'next_action', instructions: NEXT_ACTION, choices: choices(actionOptions(request)) },
    { type: 'predicate', name: 'goal_met', instructions: GOAL_MET },
    // Fields past the question limit are left for a later decision, one at a time.
    ...request.fields.slice(0, MAX_QUESTIONS - 2).map((field) => ({
      type: 'choice' as const,
      name: fillKey(field.key),
      instructions: fillQuestion(field),
      choices: inputs,
    })),
  ]
  return { model, input: JSON.stringify(stateOf(request)), questions }
}

function probabilityOf(answer: Answer, value: string): number {
  return answer.probabilities?.find((p) => p.value === value)?.probability ?? 0
}
