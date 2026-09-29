import type { Platform } from '../types.ts'

/** The option a provider picks when nothing on screen moves toward the goal. */
export const STUCK = 'STUCK'

/**
 * Everything a provider sees for one step. It holds descriptions only:
 * input values and locators stay on the machine running the test.
 */
export type DecisionRequest = {
  platform: Platform
  goal: string
  /** Visible text on the current screen. */
  screenText: string[]
  /** Candidate actions, keyed by the value the provider must return. */
  actions: { key: string; description: string }[]
  /** Descriptions of the actions already taken, oldest first. */
  history: string[]
  /** Names of the test data the flow can type, e.g. `email`. */
  inputNames: string[]
}

export type Decision = {
  /** An action key from the request, or `STUCK`. */
  action: string
  /** Probability the provider assigns to `action`, from 0 to 1. */
  confidence: number
  /** Probability of every option, when the provider reports it. */
  probabilities: Record<string, number>
  /** Probability that the current screen already shows the goal reached. */
  goalMet: number
  /** Model version that answered. */
  model: string
  latencyMs: number
  usage?: { inputTokens: number; outputTokens: number }
}

export interface DecisionProvider {
  readonly name: string
  decide(request: DecisionRequest): Promise<Decision>
}
