import { buildActions, describeAction, redactScreen } from './actions.ts'
import type { Device } from './device.ts'
import { expectationLocator, toSelector } from './locator.ts'
import { STUCK, type Decision, type DecisionProvider } from './providers/types.ts'
import { isBusy, parseScreen } from './screen.ts'
import type { Action, Criterion, Expectation, Platform } from './types.ts'

export type ExploreOptions = {
  provider: DecisionProvider
  /** Stop after this many actions. */
  maxSteps?: number
  /** Below this confidence the run stops and asks for a human instead of guessing. */
  minConfidence?: number
  /** Probability above which the model's "goal reached" triggers the checks. */
  goalThreshold?: number
  /** How long each expectation may take to appear. */
  expectTimeoutMs?: number
  /** How long to wait for the screen to stop changing, and spinners to go, after an action. */
  settleTimeoutMs?: number
  onStep?: (step: Step) => void
}

export type Outcome = 'passed' | 'failed' | 'stuck' | 'escalated' | 'gave-up'

/** One action the run took, stored without input values. */
export type TakenAction = {
  type: Action['type']
  description: string
  selector: string
  /** Name of the test data typed, for `type` actions. */
  input?: string
}

export type Step = {
  index: number
  screenText: string[]
  actionCount: number
  decision: Decision
  taken?: TakenAction
}

/**
 * The full record of a run. It holds input names, never values, so traces
 * can be shared or published without leaking test data.
 */
export type Trace = {
  criterion: { id: string; goal: string; expect: Expectation[] }
  platform: Platform
  provider: string
  startedAt: string
  durationMs: number
  outcome: Outcome
  reason: string
  steps: Step[]
  failedExpectations: Expectation[]
}

const TOP_PROBABILITIES = 5
const REPEAT_LIMIT = 3

/** Drives the app toward the criterion's goal, one decision at a time. */
export async function explore(device: Device, criterion: Criterion, options: ExploreOptions): Promise<Trace> {
  const maxSteps = options.maxSteps ?? 15
  const minConfidence = options.minConfidence ?? 0.5
  const goalThreshold = options.goalThreshold ?? 0.8
  const expectTimeoutMs = options.expectTimeoutMs ?? 5_000
  const settleTimeoutMs = options.settleTimeoutMs ?? 15_000

  const started = Date.now()
  const inputNames = Object.keys(criterion.inputs)
  const steps: Step[] = []
  const history: string[] = []
  const repeats = new Map<string, number>()
  let failedExpectations: Expectation[] = []

  const finish = (outcome: Outcome, reason: string): Trace => ({
    criterion: { id: criterion.id, goal: criterion.goal, expect: criterion.expect },
    platform: device.platform,
    provider: options.provider.name,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    outcome,
    reason,
    steps,
    failedExpectations,
  })

  let source = await device.pageSource()
  for (let index = 1; index <= maxSteps + 1; index++) {
    const screen = redactScreen(parseScreen(source, device.platform), criterion.inputs)
    const actions = buildActions(screen, inputNames)
    const described = actions.map((action) => ({ key: action.key, description: describeAction(action) }))

    const decision = await options.provider.decide({
      platform: device.platform,
      goal: criterion.goal,
      screenText: screen.texts,
      actions: described,
      history,
      inputNames,
    })
    const step: Step = { index, screenText: screen.texts, actionCount: actions.length, decision: trim(decision) }
    steps.push(step)

    if (decision.goalMet >= goalThreshold) {
      options.onStep?.(step)
      if (criterion.expect.length === 0) {
        return finish('passed', 'The model judged the goal reached. There are no expectations to confirm it.')
      }
      failedExpectations = await failing(device, criterion.expect, expectTimeoutMs)
      return failedExpectations.length === 0
        ? finish('passed', `Goal reached and all ${criterion.expect.length} expectations hold.`)
        : finish('failed', `The model judged the goal reached, but ${failedExpectations.length} expectations do not hold.`)
    }

    if (index > maxSteps) {
      options.onStep?.(step)
      return finish('gave-up', `The goal was not reached within ${maxSteps} steps.`)
    }
    if (decision.action === STUCK) {
      options.onStep?.(step)
      return finish('stuck', 'The model found no action on this screen that moves toward the goal.')
    }
    if (decision.confidence < minConfidence) {
      options.onStep?.(step)
      return finish(
        'escalated',
        `Confidence ${decision.confidence.toFixed(2)} is below ${minConfidence}. A person should decide this step.`,
      )
    }

    const action = actions.find((a) => a.key === decision.action)
    if (!action) throw new Error(`The provider picked "${decision.action}", which is not an option on this screen`)

    // The same action on the same screen, again and again, means the app isn't responding to it.
    const loopKey = `${screen.texts.join('|')}#${action.key}`
    const seen = (repeats.get(loopKey) ?? 0) + 1
    repeats.set(loopKey, seen)
    if (seen >= REPEAT_LIMIT) {
      options.onStep?.(step)
      return finish('stuck', `"${describeAction(action)}" was chosen ${seen} times on the same screen.`)
    }

    if (action.type === 'type') await device.type(action.element.locator, criterion.inputs[action.input])
    else await device.tap(action.element.locator)

    step.taken = {
      type: action.type,
      description: described.find((d) => d.key === action.key)!.description,
      selector: toSelector(action.element.locator),
      ...(action.type === 'type' && { input: action.input }),
    }
    history.push(step.taken.description)
    options.onStep?.(step)

    source = await settle(device, settleTimeoutMs)
  }
  throw new Error('unreachable')
}

/**
 * Waits until two page sources in a row match and no spinner is showing, so the
 * next decision sees a finished screen rather than one mid-transition.
 */
async function settle(device: Device, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let previous = await device.pageSource()
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const current = await device.pageSource()
    if (current === previous && !isBusy(current, device.platform)) return current
    previous = current
  }
  return previous
}

async function failing(device: Device, expectations: Expectation[], timeoutMs: number): Promise<Expectation[]> {
  const failed: Expectation[] = []
  for (const expectation of expectations) {
    if (!(await device.isDisplayed(expectationLocator(expectation, device.platform), timeoutMs))) {
      failed.push(expectation)
    }
  }
  return failed
}

/** Keeps the trace readable: the top few probabilities are enough to see what else was close. */
function trim(decision: Decision): Decision {
  const top = Object.entries(decision.probabilities)
    .sort(([, a], [, b]) => b - a)
    .slice(0, TOP_PROBABILITIES)
  return { ...decision, probabilities: Object.fromEntries(top) }
}
