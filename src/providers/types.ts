import type { Platform } from '../types.ts'

/** The option a provider picks when nothing on screen moves toward the goal. */
export const STUCK = 'STUCK'

/** The answer for a field that none of the test data belongs in. */
export const LEAVE_EMPTY = 'leave_empty'

/**
 * Everything a provider sees for one step. It holds descriptions only:
 * input values and locators stay on the machine running the test.
 */
export type DecisionRequest = {
  platform: Platform
  goal: string
  /** Visible text on the current screen. */
  screenText: string[]
  /** State that text doesn't show, e.g. `The switch "Wi-Fi" is on`. */
  controlStates: string[]
  /** Candidate actions, keyed by the value the provider must return. */
  actions: { key: string; description: string }[]
  /** Descriptions of the actions already taken, oldest first. */
  history: string[]
  /** Names of the test data the flow can type, e.g. `email`. */
  inputNames: string[]
  /**
   * Empty fields on screen. For each, the provider says which input belongs in
   * it, so a whole form can be filled from one decision.
   */
  fields: { key: string; description: string }[]
}

export type Decision = {
  /** An action key from the request, or `STUCK`. */
  action: string
  /**
   * How sure the provider is of `action`, from 0 to 1. For Jev this is its
   * confidence score, which it computes from the whole probability distribution
   * (docs.typesafe.ai/confidence); other providers may report the probability.
   */
  confidence: number
  /**
   * Probability of every option, when the provider reports it. Claude reports none, so
   * the Claude provider puts only its own confidence in its choice here.
   */
  probabilities: Record<string, number>
  /** Probability that the current screen already shows the goal reached. */
  goalMet: number
  /** For each field in the request: the input name that belongs in it, or `leave_empty`. */
  fills: Record<string, { input: string; confidence: number }>
  /** Model version that answered. */
  model: string
  latencyMs: number
  /** Of `latencyMs`, the time the model's API took, when the provider reports it apart from its own overhead. */
  apiLatencyMs?: number
  /** Tokens the model spent thinking before it answered, when the provider reports them. */
  thinkingTokens?: number
  usage?: { inputTokens: number; outputTokens: number }
}

export interface DecisionProvider {
  readonly name: string
  decide(request: DecisionRequest): Promise<Decision>
  /** Opens a connection ahead of the first decision, so that decision doesn't pay for the handshake. */
  warmUp?(): Promise<void>
}
