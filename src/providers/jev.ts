import { randomUUID } from 'node:crypto'
import { blankFrame, type PreparedFrame } from '../frames.ts'
import { apiKey, HttpError, postJson } from './http.ts'
import {
  actionOptions,
  fillKey,
  fillQuestion,
  goalMetQuestion,
  inputOptions,
  lookGoalMetQuestion,
  lookNextActionQuestion,
  nextActionQuestion,
  SCREEN_KEY,
  stateOf,
  targetBoxQuestion,
  targetShownQuestion,
} from './questions.ts'
import type { Box, Decision, DecisionProvider, DecisionRequest, Look } from './types.ts'

const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone'
const MAX_OPTIONS = 255
/**
 * The model that decides. A version, not an alias such as `jev-latest`, so that a model
 * release can't change the paths a plan explores without anyone choosing it. Every run
 * in the README used this one.
 */
export const DEFAULT_MODEL = 'jev-1.13.0'
/** The model that looks at screenshots: box questions need Jev 1.14. */
export const DEFAULT_VISION_MODEL = 'jev-1.14.0'
/** TypeSafe takes images, and box questions, only with this header (an experimental feature). */
const IMAGES_HEADER = { 'TypeSafe-Danger-Zone-Images': 'true' }

export type JevOptions = {
  apiKey?: string
  /** The model that decides (default `jev-1.13.0`, or JEVVIUM_MODEL). */
  model?: string
  /** The model that looks at screenshots (default `jev-1.14.0`, or JEVVIUM_VISION_MODEL). */
  visionModel?: string
  url?: string
  /** Retries for rate limits, overload and temporary server errors, with exponential backoff. */
  retries?: number
  timeoutMs?: number
  /** Injected in tests. */
  fetch?: typeof fetch
  /** Injected in tests so backoff doesn't slow them down. */
  sleep?: (ms: number) => Promise<void>
}

type ChoiceAnswer = { type: 'choice'; choice: string; probabilities?: Record<string, number>; confidence?: number }
type NoulAnswer = { type: 'noul'; noul: number }
type BoxAnswer = { type: 'box'; box: Box; confidence?: number }
type Answer = ChoiceAnswer | NoulAnswer | BoxAnswer
type SystemOneResponse = {
  model: string
  answers: Record<string, Answer | undefined>
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
  readonly visionModel: string
  private readonly apiKey: string
  private readonly model: string
  private readonly url: string
  private readonly retries: number
  private readonly timeoutMs: number
  private readonly fetch: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: JevOptions = {}) {
    this.apiKey = apiKey(options.apiKey ?? process.env.TYPESAFE_API_KEY, 'TYPESAFE_API_KEY', 'Jev', 'Get a key at console.typesafe.ai.')
    this.model = options.model ?? process.env.JEVVIUM_MODEL ?? DEFAULT_MODEL
    this.visionModel = options.visionModel ?? process.env.JEVVIUM_VISION_MODEL ?? DEFAULT_VISION_MODEL
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

  async check(options: { vision?: boolean } = {}): Promise<void> {
    // The smallest request System One takes: one yes-or-no question about nothing in particular.
    const body = {
      model: this.model,
      state: { purpose: 'jevvium checks that the key works before a run' },
      questions: { ok: { type: 'noul', instructions: 'Is this a check?', criteria: { true: 'Yes.', false: 'No.' } } },
    }
    try {
      await this.post(body)
    } catch (error) {
      throw new Error(explain(error, this.url, this.model), { cause: error })
    }
    if (!options.vision) return
    // A plain grey frame and a box question: what looking needs from the key and the model.
    const frame = await blankFrame().catch((error: unknown) => {
      throw new Error(`--vision can't run without its image library. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    })
    const ref = reference()
    try {
      await this.post(
        {
          model: this.visionModel,
          state: { [SCREEN_KEY]: ref },
          assets: { [ref]: asset(frame) },
          questions: { grey: { type: 'box', instructions: `The grey area in \`${SCREEN_KEY}\`` } },
        },
        IMAGES_HEADER,
      )
    } catch (error) {
      throw new Error(`${explain(error, this.url, this.visionModel, 'JEVVIUM_VISION_MODEL')} Looking at screenshots needs a model that takes images and box questions (Jev 1.14 or later).`, {
        cause: error,
      })
    }
  }

  async decide(request: DecisionRequest): Promise<Decision> {
    const started = performance.now()
    const response = await this.post(buildBody(request, this.model))
    return toDecision(response, request, Math.round(performance.now() - started))
  }

  /**
   * The same questions as `decide`, with the screenshot in the state, plus two more about
   * it: whether the control to use next is visible, and where it is (a box question).
   * All of them go out in one request, to the vision model.
   */
  async look(request: DecisionRequest, frame: PreparedFrame): Promise<Look> {
    const started = performance.now()
    const response = await this.post(buildLookBody(request, this.visionModel, frame), IMAGES_HEADER)
    const decision = toDecision(response, request, Math.round(performance.now() - started))
    const shown = response.answers.target_shown
    const target = response.answers.target
    if (shown?.type !== 'noul') throw new Error('Jev returned a look without target_shown')
    return {
      decision,
      targetShown: shown.noul,
      ...(target?.type === 'box' && validBox(target.box) && { box: { ...target.box, confidence: target.confidence ?? 0 } }),
    }
  }

  private post(body: unknown, headers?: Record<string, string>): Promise<SystemOneResponse> {
    return postJson<SystemOneResponse>(this.url, body, {
      apiKey: this.apiKey,
      service: 'Jev',
      retries: this.retries,
      timeoutMs: this.timeoutMs,
      fetch: this.fetch,
      sleep: this.sleep,
      headers,
    })
  }
}

/** A decision from Jev's answers to the next-action, goal and field questions. */
function toDecision(response: SystemOneResponse, request: DecisionRequest, latencyMs: number): Decision {
  if (typeof response?.answers !== 'object' || response.answers === null) {
    throw new Error(`Jev answered without answers (got ${Object.keys(response ?? {}).join(', ') || 'nothing'})`)
  }
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

function validBox(box: Box | undefined): box is Box {
  return (
    box !== undefined &&
    [box.top, box.bottom, box.left, box.right].every((edge) => Number.isFinite(edge) && edge >= 0 && edge <= 1) &&
    box.left < box.right &&
    box.top < box.bottom
  )
}

/** A name for the screenshot in a request: random, so it can't also appear in the screen's text. */
function reference(): string {
  return `jevvium-screen-${randomUUID()}`
}

function asset(frame: PreparedFrame) {
  return { type: 'image', format: 'jpg', data_base64: frame.jpeg.toString('base64') }
}

/** What a failed request to Jev means for the user, in one line. */
function explain(error: unknown, url: string, model: string, variable = 'JEVVIUM_MODEL'): string {
  if (!(error instanceof HttpError)) {
    return `Can't reach Jev at ${url}: ${error instanceof Error ? error.message : String(error)}`
  }
  if (error.status === 401 || error.status === 403) {
    return `Jev refused TYPESAFE_API_KEY (HTTP ${error.status}). Check the key at console.typesafe.ai.`
  }
  if (error.status === 402) return 'Jev says the account has no credit left (HTTP 402). Add credit at console.typesafe.ai.'
  if (error.status === 404) return `Jev answered HTTP 404. Check the model name (${model}, from ${variable}) and TYPESAFE_API_URL.`
  if (error.status === 400) return `Jev refused the request for ${model} (from ${variable}): ${error.message}`
  return error.message
}

export function buildBody(request: DecisionRequest, model: string) {
  if (request.actions.length + 1 > MAX_OPTIONS) {
    throw new Error(`Jev accepts at most ${MAX_OPTIONS} options; this screen has ${request.actions.length} actions`)
  }
  const inputs = inputOptions(request)
  const fillQuestions = Object.fromEntries(
    request.fields.map((field) => [fillKey(field.key), { type: 'choice', instructions: fillQuestion(field), criteria: inputs }]),
  )

  const goal = goalMetQuestion(request)
  return {
    model,
    state: stateOf(request),
    questions: {
      next_action: { type: 'choice', instructions: nextActionQuestion(request), criteria: actionOptions(request) },
      goal_met: { type: 'noul', instructions: goal.instructions, criteria: goal.answers },
      ...fillQuestions,
    },
  }
}

/**
 * The decision questions with the screenshot in view (see `look`). The screenshot goes
 * into the state once, under `screen`, and the questions name it by that key, so the
 * image is sent once however many questions mention it.
 */
export function buildLookBody(request: DecisionRequest, model: string, frame: PreparedFrame) {
  const body = buildBody(request, model)
  const ref = reference()
  const goal = lookGoalMetQuestion(request)
  const shown = targetShownQuestion(request)
  return {
    ...body,
    state: { ...body.state, [SCREEN_KEY]: ref },
    assets: { [ref]: asset(frame) },
    questions: {
      ...body.questions,
      next_action: { ...body.questions.next_action, instructions: lookNextActionQuestion(request) },
      goal_met: { type: 'noul', instructions: goal.instructions, criteria: goal.answers },
      target_shown: { type: 'noul', instructions: shown.instructions, criteria: shown.answers },
      target: { type: 'box', instructions: targetBoxQuestion(request) },
    },
  }
}
