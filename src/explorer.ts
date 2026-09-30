import { buildActions, controlStates, describeAction, describeElement, redactScreen } from './actions.ts'
import { fingerprintOf, type Device } from './device.ts'
import { expectationLocator, toSelector } from './locator.ts'
import { LEAVE_EMPTY, STUCK, type Decision, type DecisionProvider, type DecisionRequest } from './providers/types.ts'
import { placeholderSelector, redactor } from './redact.ts'
import { isBusy, needsFullRead, parseScreen } from './screen.ts'
import type { Action, Criterion, ElementKind, Expectation, Platform, Screen } from './types.ts'

export type ExploreOptions = {
  provider: DecisionProvider
  /** Stop after this many decisions that act. */
  maxSteps?: number
  /**
   * Below this confidence the run stops and asks for a human instead of guessing.
   * It is a safety net for confused steps: in the first real runs, correct steps
   * scored from 0.24 to 1.00, so it can't tell right from wrong on its own.
   */
  minConfidence?: number
  /** Probability above which the model's "goal reached" triggers the checks. */
  goalThreshold?: number
  /**
   * When the model decides to type into a field, other empty fields whose
   * answer is at least this confident are filled in the same step.
   */
  fillConfidence?: number
  /** How long each expectation may take to appear. */
  expectTimeoutMs?: number
  /** How long to wait for the screen to stop changing, and spinners to go, after an action. */
  settleTimeoutMs?: number
  onStep?: (step: Step) => void
}

/**
 * How the generated steps did when replayed with plain Appium (see `replay`):
 * `failed` when a step or expectation didn't hold, `error` when the replay couldn't
 * run at all (the session or WebDriverAgent went away), which says nothing about the test.
 */
export type Replay = { outcome: 'passed' | 'failed' | 'error'; reason: string; durationMs: number }

/** `error` means the run broke off (a device, helper or provider failure); `reason` says why. */
export type Outcome = 'passed' | 'failed' | 'stuck' | 'escalated' | 'gave-up' | 'error'

/** One action the run took. */
export type TakenAction = {
  type: Action['type']
  /** What kind of element it acted on. */
  kind: ElementKind
  /** The element's label, as the model saw it (test data replaced with `{name}`). */
  target: string
  description: string
  /** The selector, with test data in its values replaced by placeholders (see `placeholderSelector`). */
  selector: string
  /** Name of the test data typed, for `type` actions. */
  input?: string
}

export type Step = {
  index: number
  /** When the step ended, in ms since the run started: after its actions, or when its decision came. */
  atMs: number
  screenText: string[]
  actionCount: number
  decision: Decision
  /** What this step did: one action, or several fields of a form. */
  taken?: TakenAction[]
}

/**
 * The record of a run, meant to be shareable: test data values are replaced
 * with `{name}` in everything it stores (see `redactor` for what that covers),
 * and code generation fills the placeholders in selectors back in.
 */
export type Trace = {
  criterion: { id: string; goal: string; expect: Expectation[] }
  platform: Platform
  provider: string
  /** How taps and ASCII typing reached the app. */
  input: 'appium' | 'simulator'
  startedAt: string
  durationMs: number
  outcome: Outcome
  reason: string
  steps: Step[]
  failedExpectations: Expectation[]
  /**
   * Decisions thrown away because the screen was still changing or the chosen
   * element turned out to be covered. Their requests are counted in `usage`.
   */
  discardedDecisions: number
  /** Totals for every request made to the provider, including those whose answers were thrown away. */
  usage: { requests: number; inputTokens: number; outputTokens: number }
  /** Set by the CLI after a pass: the generated steps replayed with plain Appium. */
  replay?: Replay
}

const TOP_PROBABILITIES = 5
/** When a run stops, the screen has already settled, so its checks don't need a long wait. */
const STOP_CHECK_MS = 1_000
const REPEAT_LIMIT = 3
/** Covered elements the model may choose in a row, whichever they are, before the run stops. */
const COVERED_LIMIT = 6
const POLL_MS = 50
/**
 * How long to wait for direct input to show on screen. It reaches the app a moment
 * after it is sent (later on a busy machine), so the screen read right after it can
 * still be the old one, and look settled. Input with no visible effect costs this.
 * Input through Appium is done by the time the command returns.
 */
const EFFECT_WAIT_MS = 1_000

/** A page source, and whether visibility in it has to be worked out from positions. */
type Read = { source: string; geometric: boolean }
type View = { read: Read; screen: Screen; actions: Action[]; request: DecisionRequest }

/** Drives the app toward the criterion's goal, one decision at a time. */
export async function explore(device: Device, criterion: Criterion, options: ExploreOptions): Promise<Trace> {
  const maxSteps = options.maxSteps ?? 15
  const minConfidence = options.minConfidence ?? 0.2
  const goalThreshold = options.goalThreshold ?? 0.8
  const fillConfidence = options.fillConfidence ?? 0.5
  const expectTimeoutMs = options.expectTimeoutMs ?? 5_000
  const settleTimeoutMs = options.settleTimeoutMs ?? 15_000
  const { platform } = device

  const started = Date.now()
  const redact = redactor(criterion.inputs)
  const redactExpectation = (e: Expectation): Expectation => ('id' in e ? { id: redact(e.id) } : { text: redact(e.text) })
  const inputNames = Object.keys(criterion.inputs)
  const steps: Step[] = []
  const history: string[] = []
  const repeats = new Map<string, number>()
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 }
  let failedExpectations: Expectation[] = []
  let discardedDecisions = 0

  const finish = (outcome: Outcome, reason: string): Trace => ({
    criterion: { id: criterion.id, goal: redact(criterion.goal), expect: criterion.expect.map(redactExpectation) },
    platform,
    provider: options.provider.name,
    input: device.input ?? 'appium',
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    outcome,
    reason,
    steps,
    failedExpectations: failedExpectations.map(redactExpectation),
    discardedDecisions,
    usage,
  })

  const decide = async (request: DecisionRequest): Promise<Decision> => {
    const decision = await options.provider.decide(request)
    usage.requests++
    usage.inputTokens += decision.usage?.inputTokens ?? 0
    usage.outputTokens += decision.usage?.outputTokens ?? 0
    return decision
  }

  // Elements XCTest said were covered, keyed by selector, with the screen they were last
  // checked on. They stay out until the next action. When the screen changes, XCTest is
  // asked again, since what covered them (a toast, a banner) may have gone.
  const hidden = new Map<string, string>()
  // How often each element was chosen and found covered since the last action.
  const covered = new Map<string, number>()
  let coveredSinceAction = 0

  /**
   * On iOS, a read without XCTest's `visible` is several times faster, so it is
   * used whenever the screen is simple enough to work visibility out from
   * positions. Sheets, popovers and screens spread over several windows get the
   * full read; an alert inside the main window is handled from positions.
   */
  const fastReads = platform === 'ios' && device.fingerprint !== undefined
  const read = async (): Promise<Read> => {
    if (!fastReads) return { source: await device.pageSource(), geometric: false }
    const cheap = await device.fingerprint!()
    if (!needsFullRead(cheap)) return { source: cheap, geometric: true }
    return { source: await device.pageSource(), geometric: false }
  }

  const prepare = async (read: Read): Promise<View> => {
    const parsed = parseScreen(read.source, platform, { visibility: read.geometric ? 'geometry' : 'attribute' })
    if (hidden.size > 0) {
      const screenPrint = fingerprintOf(read.source, platform)
      for (const element of parsed.elements) {
        const selector = toSelector(element.locator)
        const checkedOn = hidden.get(selector)
        if (checkedOn === undefined || checkedOn === screenPrint) continue
        if (await device.isVisible!(element.locator)) hidden.delete(selector)
        else hidden.set(selector, screenPrint)
      }
      parsed.elements = parsed.elements.filter((element) => !hidden.has(toSelector(element.locator)))
    }
    const screen = redactScreen(parsed, criterion.inputs)
    const actions = buildActions(screen, inputNames)
    const fields = inputNames.length === 0
      ? []
      : screen.elements
          .filter((element) => element.kind === 'input' && element.empty)
          .map((element) => ({ key: element.key, description: describeElement(element) }))
    const request: DecisionRequest = {
      platform,
      goal: redact(criterion.goal),
      screenText: screen.texts,
      controlStates: controlStates(screen),
      actions: actions.map((action) => ({ key: action.key, description: describeAction(action) })),
      history: [...history],
      inputNames,
      fields,
    }
    return { read, screen, actions, request }
  }

  /** True if the screen still matches `source` a moment later, read the cheap way. */
  const isStable = async ({ source }: Read, deadline: number): Promise<boolean> => {
    if (Date.now() >= deadline) return true
    await sleep(POLL_MS)
    const now = device.fingerprint ? await device.fingerprint() : await device.pageSource()
    return now === (device.fingerprint ? fingerprintOf(source, platform) : source)
  }

  /**
   * Reads until the screen differs from `before`, or the effect wait passes. What ticks
   * on its own (a countdown, a clock, a progress value) isn't taken for the effect.
   */
  const changedFrom = async (before: Read): Promise<Read> => {
    const deadline = Date.now() + EFFECT_WAIT_MS
    const old = withoutTicking(fingerprintOf(before.source, platform))
    let current = await read()
    while (withoutTicking(fingerprintOf(current.source, platform)) === old && Date.now() < deadline) {
      await sleep(POLL_MS)
      current = await read()
    }
    return current
  }

  /** Reads until the screen has stopped changing and shows no spinner, or the deadline passes. */
  const settle = async (deadline: number): Promise<Read> => {
    let current = await read()
    while (Date.now() < deadline) {
      if (!isBusy(current.source, platform) && (await isStable(current, deadline))) return current
      if (isBusy(current.source, platform)) await sleep(POLL_MS)
      current = await read()
    }
    return current
  }

  /**
   * Reads a finished screen and decides what to do on it. The first question
   * goes out while the stability check runs, which hides the model's latency.
   * If the screen turns out to be still changing, that answer is thrown away,
   * the screen is left to settle without asking, and the model is asked once more.
   */
  const observe = async (candidate: Read): Promise<View & { decision: Decision }> => {
    const deadline = Date.now() + settleTimeoutMs
    let current = candidate
    while (isBusy(current.source, platform) && Date.now() < deadline) {
      await sleep(POLL_MS)
      current = await read()
    }
    const view = await prepare(current)
    const [decision, stable] = await Promise.all([decide(view.request), isStable(current, deadline)])
    if (stable) return { ...view, decision }
    discardedDecisions++
    const settledView = await prepare(await settle(deadline))
    return { ...settledView, decision: await decide(settledView.request) }
  }

  try {
    // Idle connections close after a few seconds, so open one now, while the first screen is read.
    void Promise.resolve()
      .then(() => options.provider.warmUp?.())
      .catch(() => {})
    let next = await read()
    for (let index = 1; index <= maxSteps + 1; index++) {
      const { read: settled, screen, actions, request, decision } = await observe(next)
      const step: Step = { index, atMs: Date.now() - started, screenText: screen.texts, actionCount: actions.length, decision: trim(decision) }
      steps.push(step)

      if (decision.goalMet >= goalThreshold) {
        options.onStep?.(step)
        if (criterion.expect.length === 0) {
          return finish('passed', 'The model judged the goal reached. There are no expectations to confirm it.')
        }
        failedExpectations = await failing(device, criterion.expect, expectTimeoutMs)
        if (failedExpectations.length === 0) {
          return finish('passed', `Goal reached and all ${criterion.expect.length} expectations hold.`)
        }
        // A fast read can include text XCTest considers hidden (a view kept on screen but not
        // shown), which can look like success. Before calling it a failure, the model judges a
        // full read, with XCTest's own visibility, and carries on from there if it disagrees.
        if (settled.geometric) {
          failedExpectations = []
          next = { source: await device.pageSource(), geometric: false }
          continue
        }
        return finish('failed', `The model judged the goal reached, but ${failedExpectations.length} expectations do not hold.`)
      }

      /**
       * Before giving up, check the expectations anyway: the model can be unsure
       * the goal is reached when it is. They decide pass or fail, not the model.
       * A run that took no action can't pass this way, or a criterion whose
       * expectations already hold on the first screen would pass untested.
       */
      const stop = async (outcome: Outcome, reason: string): Promise<Trace> => {
        options.onStep?.(step)
        const acted = steps.some((s) => s.taken)
        if (acted && criterion.expect.length > 0) {
          const failed = await failing(device, criterion.expect, STOP_CHECK_MS)
          if (failed.length === 0) {
            return finish('passed', `All ${criterion.expect.length} expectations hold, although the model was unsure the goal was reached.`)
          }
          failedExpectations = failed
          return finish(outcome, `${reason} ${failed.length} of ${criterion.expect.length} expectations do not hold.`)
        }
        return finish(outcome, reason)
      }

      if (index > maxSteps) return stop('gave-up', `The goal was not reached within ${maxSteps} steps.`)
      if (decision.action === STUCK) {
        return stop('stuck', 'The model found no action on this screen that moves toward the goal.')
      }
      if (decision.confidence < minConfidence) {
        return stop(
          'escalated',
          `Confidence ${decision.confidence.toFixed(2)} is below ${minConfidence}. A person should decide this step.`,
        )
      }

      const action = actions.find((a) => a.key === decision.action)
      if (!action) throw new Error(`The provider picked "${decision.action}", which is not an option on this screen`)

      // Positions can't show what covers an element, so XCTest confirms the one about to be
      // used. If it's covered, it is left out and the model decides again on a fresh read.
      if (settled.geometric && !(await visible(device, action))) {
        const selector = toSelector(action.element.locator)
        const times = (covered.get(selector) ?? 0) + 1
        covered.set(selector, times)
        coveredSinceAction++
        // It came back as visible and was covered again: whatever covers it keeps coming back.
        if (times >= REPEAT_LIMIT) {
          return stop('stuck', `"${describeAction(action)}" was chosen ${times} times, but the element stays covered.`)
        }
        // Different covered elements, one after another (their names can change as they tick).
        if (coveredSinceAction >= COVERED_LIMIT) {
          return stop('stuck', `The model chose ${coveredSinceAction} covered elements in a row.`)
        }
        hidden.set(selector, fingerprintOf(settled.source, platform))
        steps.pop()
        discardedDecisions++
        next = await read()
        index--
        continue
      }

      // The same action on the same screen, again and again, means the app isn't responding to it.
      const loopKey = `${screen.texts.join('|')}#${action.key}`
      const seen = (repeats.get(loopKey) ?? 0) + 1
      repeats.set(loopKey, seen)
      if (seen >= REPEAT_LIMIT) return stop('stuck', `"${describeAction(action)}" was chosen ${seen} times on the same screen.`)

      const batch = action.type === 'type' ? formFill(action, screen, actions, decision, fillConfidence) : [action]
      step.taken = []
      for (const item of batch) {
        // The other fields of a form are checked right before each is used, after the
        // earlier ones have opened the keyboard. A covered one is left for a later decision.
        if (item !== action && settled.geometric && !(await visible(device, item))) continue
        if (item.type === 'type') await device.type(item.element, criterion.inputs[item.input])
        else await device.tap(item.element)
        const description = request.actions.find((d) => d.key === item.key)!.description
        step.taken.push({
          type: item.type,
          kind: item.element.kind,
          target: item.element.label,
          description,
          selector: placeholderSelector(toSelector(item.element.locator), criterion.inputs),
          ...(item.type === 'type' && { input: item.input }),
        })
        history.push(description)
      }
      step.atMs = Date.now() - started
      options.onStep?.(step)

      hidden.clear()
      covered.clear()
      coveredSinceAction = 0
      next = device.input === 'simulator' && step.taken.length > 0 ? await changedFrom(settled) : await read()
    }
    return finish('gave-up', `The goal was not reached within ${maxSteps} steps.`)
  } catch (error) {
    // WebdriverIO quotes the selector in its errors, and a selector can hold test data.
    const message = error instanceof Error ? error.message : String(error)
    return finish('error', redact(message.split('\n')[0]))
  }
}

/** The page source without the numbers that change on their own: in names, labels, text and progress values. */
function withoutTicking(source: string): string {
  return source
    .replace(/ (?:name|label|text|content-desc)="[^"]*"/g, (attribute) => attribute.replace(/\d/g, '#'))
    .replace(/<XCUIElementType(?:StaticText|ProgressIndicator)\b[^>]*/g, (tag) =>
      tag.replace(/ value="[^"]*"/, (attribute) => attribute.replace(/\d/g, '#')),
    )
}

/** XCTest's own verdict on whether an element is on screen and uncovered. Keyboard keys always are. */
async function visible(device: Device, action: Action): Promise<boolean> {
  if (action.element.kind === 'key' || !device.isVisible) return true
  return device.isVisible(action.element.locator)
}

/**
 * The chosen typing action plus every other empty field the model confidently
 * matched to an input in the same request, in screen order. One decision can
 * then fill a whole form instead of one field per round trip.
 */
function formFill(chosen: Action, screen: Screen, actions: Action[], decision: Decision, minConfidence: number): Action[] {
  const batch: Action[] = []
  for (const element of screen.elements) {
    if (element.key === chosen.element.key) {
      batch.push(chosen)
      continue
    }
    const fill = decision.fills[element.key]
    if (element.kind !== 'input' || !element.empty || !fill) continue
    if (fill.input === LEAVE_EMPTY || fill.confidence < minConfidence) continue
    const action = actions.find((a) => a.key === `type:${element.key}:${fill.input}`)
    if (action) batch.push(action)
  }
  return batch
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
