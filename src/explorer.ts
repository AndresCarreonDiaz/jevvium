import { buildActions, controlStates, describeAction, describeElement, redactScreen } from './actions.ts'
import { fingerprintOf, type Device } from './device.ts'
import { redactExpectation } from './expectations.ts'
import { expectationLocator, toSelector } from './locator.ts'
import { LEAVE_EMPTY, STUCK, type Decision, type DecisionProvider, type DecisionRequest } from './providers/types.ts'
import { placeholderSelector, redactor } from './redact.ts'
import { isBusy, needsFullRead, parseScreen } from './screen.ts'
import type { Action, Criterion, ElementKind, Expectation, Platform, Screen, ScreenElement, ScrollDirection } from './types.ts'

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
   * Probability above which a plan step before the last counts as done and the test
   * moves on to the next. Lower than `goalThreshold`: moving on too early costs little,
   * since the whole plan stays in view and the checks still decide the pass.
   */
  stepThreshold?: number
  /**
   * When the model decides to type into a field, other empty fields whose
   * answer is at least this confident are filled in the same step.
   */
  fillConfidence?: number
  /** How long each expectation may take to appear. */
  expectTimeoutMs?: number
  /** How long to wait for the screen to stop changing, and spinners to go, after an action. */
  settleTimeoutMs?: number
  /**
   * Restarts the app on its first screen. With it, a run that dead-ends can backtrack:
   * restart, replay its actions up to the decision that led it wrong, and take the
   * model's runner-up there instead. Without it, a dead end ends the run.
   */
  restart?: () => Promise<void>
  /** How many times a run may backtrack (default 2). Each costs a restart and a replay. */
  maxBacktracks?: number
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
  /** Which way the list was scrolled, for `scroll` actions. */
  direction?: ScrollDirection
}

export type Step = {
  index: number
  /** When the step ended, in ms since the run started: after its actions, or when its decision came. */
  atMs: number
  screenText: string[]
  actionCount: number
  decision: Decision
  /** For a criterion with a plan: which of its steps (1-based) the test was on when it decided. */
  planStep?: number
  /** For a criterion with a plan: the model found this plan step done, so the test moved on to the next. */
  completed?: number
  /** What this step did: one action, or several fields of a form. */
  taken?: TakenAction[]
  /** Changes the device made to how it works during this step, such as falling back to Appium input. */
  notes?: string[]
  /**
   * This step was a dead end, and the run went back: the app was restarted and replayed
   * up to step `to`, where `instead` (the model's runner-up there) was taken.
   */
  backtrack?: { to: number; instead: string }
  /** This step took the model's runner-up at step `of` instead of its choice, after a backtrack. */
  retry?: { of: number }
  /** A backtrack undid this step: its actions aren't part of the path the run ended on. */
  undone?: true
}

/**
 * The record of a run, meant to be shareable: test data values are replaced
 * with `{name}` in everything it stores (see `redactor` for what that covers),
 * and code generation fills the placeholders in selectors back in.
 */
export type Trace = {
  criterion: { id: string; title?: string; goal: string; steps?: string[]; expect: Expectation[] }
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
/** The least likely an option may be for a backtrack to try it. */
const RUNNER_UP_MIN = 0.1
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
/** A step that acted, with what a backtrack needs to replay it or try something else there. */
type Performed = {
  step: Step
  /** The actions done, with the selectors that find their elements again. */
  batch: Action[]
  /** Every action the model could have picked, by key. */
  options: Map<string, Action>
  /** The model's probability for each option, untrimmed. */
  probabilities: Record<string, number>
  /** Options tried at this step so far: the model's choice, then any runner-up. */
  tried: Set<string>
  planStep: number
  /** How long the history was before this step acted. */
  historyLength: number
}

/** Drives the app toward the criterion's goal, one decision at a time. */
export async function explore(device: Device, criterion: Criterion, options: ExploreOptions): Promise<Trace> {
  const maxSteps = options.maxSteps ?? 15
  const maxBacktracks = options.restart ? (options.maxBacktracks ?? 2) : 0
  const minConfidence = options.minConfidence ?? 0.2
  const goalThreshold = options.goalThreshold ?? 0.8
  const stepThreshold = options.stepThreshold ?? Math.min(0.6, goalThreshold)
  const fillConfidence = options.fillConfidence ?? 0.5
  const expectTimeoutMs = options.expectTimeoutMs ?? 5_000
  const settleTimeoutMs = options.settleTimeoutMs ?? 15_000
  const { platform } = device

  const started = Date.now()
  const redact = redactor(criterion.inputs)
  const redacted = (e: Expectation) => redactExpectation(e, redact)
  const inputNames = Object.keys(criterion.inputs)
  const steps: Step[] = []
  const history: string[] = []
  /** The steps that acted and still stand, oldest first. */
  const performed: Performed[] = []
  let backtracks = 0
  /** The screens the run dead-ended on. Reaching one again another way means the app, not the path, is the problem. */
  const deadEnds = new Set<string>()
  let next: Read
  const repeats = new Map<string, number>()
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0 }
  let failedExpectations: Expectation[] = []
  let discardedDecisions = 0
  // A plan is worked through one step at a time; a criterion without one is a single step, its goal.
  const plan = criterion.steps?.map(redact) ?? []
  let planStep = 1

  const finish = (outcome: Outcome, reason: string): Trace => ({
    criterion: {
      id: criterion.id,
      ...(criterion.title && { title: redact(criterion.title) }),
      goal: redact(criterion.goal),
      ...(plan.length > 0 && { steps: plan }),
      expect: criterion.expect.map(redacted),
    },
    platform,
    provider: options.provider.name,
    input: device.input ?? 'appium',
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    outcome,
    reason,
    steps,
    failedExpectations: failedExpectations.map(redacted),
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
  // Which way each list was scrolled, by selector. A list recycles what scrolls off, so the page
  // source can't show there is a way back; this does.
  const scrolled = new Map<string, Set<ScrollDirection>>()
  const BACK: Record<ScrollDirection, ScrollDirection> = { down: 'up', up: 'down', right: 'left', left: 'right' }

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
    for (const element of parsed.elements) {
      const back = element.kind === 'list' ? scrolled.get(toSelector(element.locator)) : undefined
      if (back) element.scrolls = [...new Set([...(element.scrolls ?? []), ...[...back].map((direction) => BACK[direction])])]
    }
    const screen = redactScreen(parsed, criterion.inputs)
    const actions = buildActions(screen, inputNames, device.scroll !== undefined)
    const fields = inputNames.length === 0
      ? []
      : screen.elements
          .filter((element) => element.kind === 'input' && element.empty)
          .map((element) => ({ key: element.key, description: describeElement(element) }))
    const request: DecisionRequest = {
      platform,
      goal: redact(criterion.goal),
      ...(plan.length > 0 && { plan: { steps: plan, current: planStep } }),
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

  /** The element on the current screen that this selector finds, by the same reading the run uses. */
  const findOnScreen = async (selector: string, deadline: number): Promise<{ read: Read; element: ScreenElement } | undefined> => {
    const current = await settle(deadline)
    const search = (visibility: 'attribute' | 'geometry' | 'all') =>
      parseScreen(current.source, platform, { visibility }).elements.find((element) => toSelector(element.locator) === selector)
    const element = search(current.geometric ? 'geometry' : 'attribute') ?? search('all')
    return element && { read: current, element }
  }

  /** Does one action again, on the element its selector finds now. */
  const redo = async (action: Action, deadline: number): Promise<boolean> => {
    const found = await findOnScreen(toSelector(action.element.locator), deadline)
    if (!found) return false
    const { element } = found
    if (action.type === 'type') await device.type(element, criterion.inputs[action.input])
    else if (action.type === 'scroll') await device.scroll!(element, action.direction)
    else await device.tap(element)
    next = device.input === 'simulator' ? await changedFrom(found.read) : await read()
    return true
  }

  /**
   * The run went wrong somewhere before this dead end. Going back from the most recent
   * decision, the first one with an untried option that the model gave a real chance is
   * where to try again: the app is restarted, the actions before it are done again, and
   * that option is taken there. True when the run can carry on from the new screen.
   */
  const backtrack = async (deadEnd: Step): Promise<boolean> => {
    if (backtracks >= maxBacktracks) return false
    const screen = deadEnd.screenText.join('\n')
    if (deadEnds.has(screen)) return false
    deadEnds.add(screen)
    let at: { entry: Performed; key: string } | undefined
    for (let i = performed.length - 1; i >= 0 && !at; i--) {
      const entry = performed[i]
      const key = Object.entries(entry.probabilities)
        .sort(([, a], [, b]) => b - a)
        .find(([option, p]) => p >= RUNNER_UP_MIN && option !== STUCK && !entry.tried.has(option) && entry.options.has(option))?.[0]
      if (key) at = { entry, key }
    }
    if (!at) return false
    backtracks++
    const { entry, key } = at
    const instead = entry.options.get(key)!
    const description = describeAction(instead)
    deadEnd.backtrack = { to: entry.step.index, instead: description }
    options.onStep?.(deadEnd)

    // Everything from the wrong turn on is undone: replayed steps keep their place in the path.
    const from = performed.indexOf(entry)
    for (const step of steps) if (step.index >= entry.step.index && !step.undone) step.undone = true
    const keep = performed.slice(0, from)
    performed.length = 0
    entry.tried.add(key)
    history.length = entry.historyLength
    planStep = entry.planStep
    repeats.clear()
    hidden.clear()
    covered.clear()
    coveredSinceAction = 0
    scrolled.clear()

    await options.restart!()
    next = await read()
    const deadline = () => Date.now() + settleTimeoutMs
    for (const earlier of keep) {
      for (const action of earlier.batch) {
        if (!(await redo(action, deadline()))) throw new Error(`Backtracking couldn't repeat "${describeAction(action)}": its element wasn't found`)
        if (action.type === 'scroll') scrolled.set(toSelector(action.element.locator), (scrolled.get(toSelector(action.element.locator)) ?? new Set()).add(action.direction))
      }
      performed.push(earlier)
    }
    const retry: Step = {
      index: steps.length + 1,
      atMs: Date.now() - started,
      screenText: entry.step.screenText,
      actionCount: entry.step.actionCount,
      decision: entry.step.decision,
      ...(plan.length > 0 && { planStep }),
      retry: { of: entry.step.index },
    }
    if (!(await redo(instead, deadline()))) throw new Error(`Backtracking couldn't try "${description}": its element wasn't found`)
    retry.taken = [takenFrom(instead, description)]
    retry.atMs = Date.now() - started
    steps.push(retry)
    history.push(description)
    performed.push({ ...entry, step: retry, batch: [instead], tried: entry.tried })
    options.onStep?.(retry)
    return true
  }

  const takenFrom = (item: Action, description: string): TakenAction => ({
    type: item.type,
    kind: item.element.kind,
    target: item.element.label,
    description,
    selector: placeholderSelector(toSelector(item.element.locator), criterion.inputs),
    ...(item.type === 'type' && { input: item.input }),
    ...(item.type === 'scroll' && { direction: item.direction }),
  })

  try {
    // Idle connections close after a few seconds, so open one now, while the first screen is read.
    void Promise.resolve()
      .then(() => options.provider.warmUp?.())
      .catch(() => {})
    next = await read()
    // Decisions that acted. Those that only moved the plan on to its next step don't count.
    let acted = 0
    for (let index = 1; ; index++) {
      const { read: settled, screen, actions, request, decision } = await observe(next)
      const step: Step = {
        index: steps.length + 1,
        atMs: Date.now() - started,
        screenText: screen.texts,
        actionCount: actions.length,
        decision: trim(decision),
        ...(plan.length > 0 && { planStep }),
      }
      steps.push(step)

      // A plan step done, with more to come: the test moves on to the next step. The action the
      // model picked was for the step just finished, so it is asked again about the new one.
      if (decision.goalMet >= stepThreshold && planStep < plan.length) {
        step.completed = planStep
        planStep++
        options.onStep?.(step)
        next = settled
        continue
      }

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
      const stop = async (outcome: Outcome, reason: string): Promise<Trace | undefined> => {
        const acted = performed.length > 0
        if (acted && criterion.expect.length > 0) {
          const failed = await failing(device, criterion.expect, STOP_CHECK_MS)
          if (failed.length === 0) {
            options.onStep?.(step)
            return finish('passed', `All ${criterion.expect.length} expectations hold, although the model was unsure the goal was reached.`)
          }
          failedExpectations = failed
          reason = `${reason} ${failed.length} of ${criterion.expect.length} expectations do not hold.`
        }
        // A dead end after a wrong turn: go back and try the model's runner-up there, when there is one.
        if (outcome === 'stuck' && acted && (await backtrack(step))) {
          failedExpectations = []
          return undefined
        }
        options.onStep?.(step)
        return finish(outcome, reason)
      }

      if (acted >= maxSteps) return (await stop('gave-up', `The goal was not reached within ${maxSteps} steps.`))!
      if (decision.action === STUCK) {
        const trace = await stop('stuck', 'The model found no action on this screen that moves toward the goal.')
        if (trace) return trace
        continue
      }
      if (decision.confidence < minConfidence) {
        return (await stop(
          'escalated',
          `Confidence ${decision.confidence.toFixed(2)} is below ${minConfidence}. A person should decide this step.`,
        ))!
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
          const trace = await stop('stuck', `"${describeAction(action)}" was chosen ${times} times, but the element stays covered.`)
          if (trace) return trace
          continue
        }
        // Different covered elements, one after another (their names can change as they tick).
        if (coveredSinceAction >= COVERED_LIMIT) {
          const trace = await stop('stuck', `The model chose ${coveredSinceAction} covered elements in a row.`)
          if (trace) return trace
          continue
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
      if (seen >= REPEAT_LIMIT) {
        const trace = await stop('stuck', `"${describeAction(action)}" was chosen ${seen} times on the same screen.`)
        if (trace) return trace
        continue
      }
      // A direct tap that changed nothing may never have reached the app. The second try goes
      // through Appium, and so does every tap after it: retrying sooner could tap twice.
      if (seen === 2 && action.type === 'tap' && device.input === 'simulator') {
        device.fallBackToAppium?.('a tap sent straight to the simulator changed nothing, so taps go through Appium from now on')
      }

      const batch = action.type === 'type' ? formFill(action, screen, actions, decision, fillConfidence) : [action]
      step.taken = []
      acted++
      const done: Action[] = []
      const entry: Performed = {
        step,
        batch: done,
        options: new Map(actions.map((a) => [a.key, a])),
        probabilities: decision.probabilities,
        tried: new Set([action.key]),
        planStep,
        historyLength: history.length,
      }
      for (const item of batch) {
        // The other fields of a form are checked right before each is used, after the
        // earlier ones have opened the keyboard. A covered one is left for a later decision.
        if (item !== action && settled.geometric && !(await visible(device, item))) continue
        if (item.type === 'type') await device.type(item.element, criterion.inputs[item.input])
        else if (item.type === 'scroll') {
          await device.scroll!(item.element, item.direction)
          const selector = toSelector(item.element.locator)
          scrolled.set(selector, (scrolled.get(selector) ?? new Set()).add(item.direction))
        } else await device.tap(item.element)
        const description = request.actions.find((d) => d.key === item.key)!.description
        step.taken.push(takenFrom(item, description))
        done.push(item)
        history.push(description)
      }
      performed.push(entry)
      step.atMs = Date.now() - started
      const notes = device.drainNotes?.() ?? []
      if (notes.length > 0) step.notes = notes
      options.onStep?.(step)

      hidden.clear()
      covered.clear()
      coveredSinceAction = 0
      next = device.input === 'simulator' && step.taken.length > 0 ? await changedFrom(settled) : await read()
    }
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
