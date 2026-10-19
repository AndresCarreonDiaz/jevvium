import { buildActions, controlStates, describeAction, describeElement, redactScreen } from './actions.ts'
import { fingerprintOf, type Device } from './device.ts'
import { redactExpectation } from './expectations.ts'
import { prepareFrame, type PreparedFrame } from './frames.ts'
import { expectationLocator, toSelector } from './locator.ts'
import { LEAVE_EMPTY, STUCK, type Box, type Decision, type DecisionProvider, type DecisionRequest, type Look } from './providers/types.ts'
import { placeholderSelector, redactor } from './redact.ts'
import { isBusy, maskRegions, needsFullRead, parseScreen, withoutTicking } from './screen.ts'
import type { Action, Criterion, ElementKind, Expectation, Platform, Rect, Screen, ScreenElement, ScrollDirection } from './types.ts'

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
  /**
   * Gets the screen each kept decision saw, as a masked frame (see `prepareFrame`): typed
   * fields, test data and the keyboard painted over. `name` is what the step records as its
   * `frame` (`03.jpg`). Called once the run has ended, in step order. Needs `device.screenshot`,
   * and an iOS device for now: an Android page source doesn't show the keyboard, so it couldn't
   * be painted over.
   */
  onFrame?: (name: string, frame: PreparedFrame) => void | Promise<void>
  /**
   * Lets the model look at the screen, as a masked frame that leaves the machine with the
   * request. `true` looks where the page source isn't enough: where the answer from text alone
   * would stop the run (no way forward, a confidence below `minConfidence`, the same action
   * again on an unchanged screen). That can't catch a model that is sure of the wrong thing
   * because the text lacks what matters (prices that only show on screen, so it scrolls past
   * the one it wants): `'always'` looks at every step, and the look's answer wins where it is
   * surer than the text answer. Needs
   * `device.screenshot`, a provider with `look`, and an iOS device (see `onFrame`).
   */
  look?: boolean | 'always'
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
  /** Where the element was on screen, in the units of `Trace.screen`, for drawing it on the step's frame. */
  frame?: Rect
  /** The element had no label, text or id: a look at the screen found it, and its selector goes by position. */
  unlabeled?: true
}

/** What the model said when it looked at a screenshot at a step (see `ExploreOptions.look`). */
export type StepLook = {
  /**
   * Why it looked: the answer from text alone was no way forward, too unsure to act, or the same
   * action again on an unchanged screen; or the run looks at every step.
   */
  why: 'stuck' | 'unsure' | 'repeating' | 'always'
  /**
   * Its answers with the screenshot in view. When the run took the element under its box, the
   * action is that tap and the confidence is how sure it was the control is visible.
   */
  decision: Decision
  /** Probability that the control to use next was visible. */
  targetShown: number
  /** Where it said that control is, as fractions of the frame. */
  box?: Box & { confidence: number }
  /** The element the box's centre fell on, described as the model saw it. */
  pointedAt?: string
  /** What the run took from the look: its verdict on the step or goal, its action, the element the box fell on, or nothing. */
  used: 'goal' | 'action' | 'box' | 'none'
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
  /** The masked screenshot of the screen this decision saw, when frames were kept (see `ExploreOptions.onFrame`). */
  frame?: string
  /** The model looked at the screen at this step (see `ExploreOptions.look`). */
  look?: StepLook
  /** A look was asked for, so its screenshot went out, but no answer came back: the text answer stood. */
  lookError?: string
  /**
   * The element this decision chose turned out covered, so the model decided again on the same
   * screen. Such a decision is dropped from the trace, unless it looked: then it stays, marked,
   * since its screenshot went out.
   */
  covered?: true
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
  /**
   * Totals for every request made to the provider, including those whose answers were thrown
   * away. `looks` counts the requests that carried a screenshot (included in `requests`).
   */
  usage: { requests: number; inputTokens: number; outputTokens: number; looks?: number }
  /** The screen's size in the page source's units (points on iOS), for drawing on the frames. */
  screen?: { width: number; height: number }
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
/** The least probability, looking, that the control to use next is visible for its box to count. */
const TARGET_SHOWN_MIN = 0.5
/**
 * How sure a look must be of an action to take it instead of the answer from text alone. A
 * look comes where the run would otherwise stop, so it has to give a clear way forward:
 * taking unsure looks kept a run scrolling a list it had already seen.
 */
const LOOK_ACTION_MIN = 0.5
/**
 * How long a tap sent straight to the simulator may leave the page source exactly as it was,
 * on top of the effect wait, before it is taken as lost and sent again through Appium.
 */
const LOST_TAP_MS = 1_000

/** A page source, and whether visibility in it has to be worked out from positions. */
type Read = { source: string; geometric: boolean }
type View = { read: Read; screen: Screen; actions: Action[]; request: DecisionRequest }
/** A view and the decision on it, with a screenshot taken while the decision was being made. */
type Observed = View & { decision: Decision; shot?: Buffer; shotError?: string }
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
  const lookAlways = options.look === 'always'
  const { platform } = device
  if (options.look && platform !== 'ios') throw new Error('Looking at screenshots works on iOS only for now: an Android page source does not show the keyboard to paint over')
  const looking = Boolean(options.look) && options.provider.look !== undefined && device.screenshot !== undefined
  const shooting = (looking || options.onFrame !== undefined) && device.screenshot !== undefined && platform === 'ios'

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
  /** How often each action was chosen on a screen, and the screen as it was the last time, to count only repeats on an unchanged screen. */
  const repeats = new Map<string, { count: number; print: string }>()

  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, ...(looking && { looks: 0 }) }
  let failedExpectations: Expectation[] = []
  /**
   * Each step's frame, prepared on first use: right away when frames are kept, so it happens
   * off the decision's critical path, and only when the model looks otherwise.
   */
  const frames = new Map<Step, () => Promise<PreparedFrame | undefined>>()
  /** Why a step's frame couldn't be prepared, noted on the step once the run is over. */
  const frameErrors = new Map<Step, string>()
  let screenSize: Trace['screen']
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
    ...(screenSize && { screen: screenSize }),
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
      for (const element of [...parsed.elements, ...(parsed.unlabeled ?? [])]) {
        const selector = toSelector(element.locator)
        const checkedOn = hidden.get(selector)
        if (checkedOn === undefined || checkedOn === screenPrint) continue
        if (await device.isVisible!(element.locator)) hidden.delete(selector)
        else hidden.set(selector, screenPrint)
      }
      parsed.elements = parsed.elements.filter((element) => !hidden.has(toSelector(element.locator)))
      if (parsed.unlabeled) parsed.unlabeled = parsed.unlabeled.filter((element) => !hidden.has(toSelector(element.locator)))
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
  const isStable = async (read: Read, deadline: number, pause = POLL_MS): Promise<boolean> => {
    if (Date.now() >= deadline) return true
    if (pause > 0) await sleep(pause)
    return stillShows(read)
  }

  /** A screen as the repeat count compares it: its page source without what ticks on its own. */
  const printOf = (read: Read): string => withoutTicking(fingerprintOf(read.source, platform))

  /** Whether the screen shows `source` right now. */
  const stillShows = async ({ source }: Read): Promise<boolean> => {
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

  /**
   * Whether the screen still shows `before`, as `now` does, and goes on showing it for `ms` more,
   * not counting the numbers that change on their own (a countdown, a clock). Returns the last read.
   */
  const unchangedFor = async (before: Read, now: Read, ms: number): Promise<{ unchanged: boolean; read: Read }> => {
    const was = printOf(before)
    if (printOf(now) !== was) return { unchanged: false, read: now }
    const deadline = Date.now() + ms
    let last = now
    while (Date.now() < deadline) {
      await sleep(POLL_MS * 2)
      last = await read()
      if (printOf(last) !== was) return { unchanged: false, read: last }
    }
    return { unchanged: true, read: last }
  }

  /** Whether a direct tap has been seen to change the screen this session: after that, none is taken as lost. */
  let directTapLanded = false

  /**
   * After a tap sent straight to the simulator: a tap that leaves the screen as it was for the
   * effect wait and a second more most likely never reached the app (the first tap of a session on
   * iOS 27.0, every tap with Xcode 27.1). Until a direct tap has been seen to land, such a tap is
   * sent again through Appium, once, and every tap after it goes through Appium. Once one has
   * landed, a tap that changes nothing is left alone: it may be one whose effect is slow, and a
   * second tap could place a second order. A re-sent tap whose element has gone landed after all.
   */
  const afterDirectTap = async (element: ScreenElement, before: Read, now: Read): Promise<Read> => {
    if (printOf(now) !== printOf(before)) {
      directTapLanded = true
      return now
    }
    if (directTapLanded || !device.fallBackToAppium) return now
    const waited = await unchangedFor(before, now, LOST_TAP_MS)
    if (!waited.unchanged) {
      directTapLanded = true
      return waited.read
    }
    device.fallBackToAppium("a tap sent straight to the simulator changed nothing, so it was sent again through Appium, and taps go through Appium from now on")
    try {
      await device.tap(element)
    } catch {
      // The element is gone: the first tap did land, and its effect was slow.
    }
    return read()
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
  const observe = async (candidate: Read): Promise<Observed> => {
    const deadline = Date.now() + settleTimeoutMs
    let current = candidate
    while (isBusy(current.source, platform) && Date.now() < deadline) {
      await sleep(POLL_MS)
      current = await read()
    }
    const view = await prepare(current)
    // The decision and the screenshot are asked for together. The stability check reads the
    // screen once the screenshot is taken, so a stable screen proves the screenshot shows the
    // page source its masks come from; one the check couldn't read (the deadline passed) isn't kept.
    const shot = shoot()
    const check = shooting
      ? shot.then(async () => {
          // One read after the screenshot, whatever the deadline: it is what proves the frame's masks fit.
          const late = Date.now() >= deadline
          const same = await stillShows(current)
          return { stable: late || same, fits: same }
        })
      : isStable(current, deadline).then((stable) => ({ stable, fits: false }))
    const [decision, { stable, fits }, taken] = await Promise.all([decide(view.request), check, shot])
    if (stable) return { ...view, decision, ...framed(taken, fits) }
    discardedDecisions++
    const settledView = await prepare(await settle(deadline))
    const [settledDecision, settledShot] = await Promise.all([decide(settledView.request), shoot()])
    // Nothing has read the screen since this screenshot: check it still shows what the masks come from.
    const settledFits = settledShot.png !== undefined && (await stillShows(settledView.read))
    return { ...settledView, decision: settledDecision, ...framed(settledShot, settledFits) }
  }

  /** A screenshot, when frames are kept or the model may look; a failure only costs the frame. */
  const shoot = async (): Promise<{ png?: Buffer; error?: string }> => {
    if (!shooting) return {}
    try {
      return { png: await device.screenshot!() }
    } catch (error) {
      return { error: `a screenshot failed, so this step has no frame: ${firstLine(error)}` }
    }
  }

  /** The screenshot to keep, if its masks can be trusted to fit it, or why there is none. */
  const framed = (taken: { png?: Buffer; error?: string }, fits: boolean): { shot?: Buffer; shotError?: string } => {
    if (taken.error) return { shotError: taken.error }
    if (!taken.png) return {}
    if (!fits) return { shotError: "the screen changed around its screenshot, so this step's frame wasn't kept" }
    return { shot: taken.png }
  }

  /**
   * The step's frame: scaled, with typed fields, test data and the keyboard painted over,
   * from the same page source the decision was made on.
   */
  const keepFrame = (step: Step, png: Buffer, source: string, screen: Screen): void => {
    let prepared: Promise<PreparedFrame | undefined> | undefined
    const get = () =>
      // On iOS the page source is in points; on Android in the screenshot's own pixels.
      (prepared ??= prepareFrame(png, { screen: screen.size, regions: maskRegions(source, platform, redact) }).catch((error: unknown) => {
        frameErrors.set(step, `its screenshot couldn't be prepared, so it has no frame: ${firstLine(error)}`)
        return undefined
      }))
    frames.set(step, get)
    step.frame = `${String(step.index).padStart(2, '0')}.jpg`
    if (options.onFrame) void get()
  }

  /**
   * Why the answer from text alone would end the run here, if it would: no way forward, too
   * unsure to act, or the same action again on an unchanged screen. A step or goal it calls
   * done ends nothing: the checks decide that.
   */
  const wouldStop = (decision: Decision, screen: Screen, actions: Action[], doneAt: number, print: string): 'stuck' | 'unsure' | 'repeating' | undefined => {
    if (decision.goalMet >= doneAt) return undefined
    if (decision.action === STUCK) return 'stuck'
    const action = actions.find((a) => a.key === decision.action)
    if (action && timesChosen(screen, action, print) + 1 >= REPEAT_LIMIT) return 'repeating'
    if (decision.confidence < minConfidence) return 'unsure'
    return undefined
  }

  /** How often this action has been chosen on this screen while it stayed as it is now. */
  const timesChosen = (screen: Screen, action: Action, print: string): number => {
    const before = repeats.get(`${screen.texts.join('|')}#${action.key}`)
    return before && before.print === print ? before.count : 0
  }

  /** Asks the model again with the step's frame in view, and works out what to take from its answer. */
  const lookAgain = async (
    step: Step,
    view: Observed,
    why: StepLook['why'],
    doneAt: number,
  ): Promise<{ decision: Decision; action?: Action; used: StepLook['used'] } | undefined> => {
    const frame = await frames.get(step)?.()
    if (!frame) return undefined
    // Counted before it is sent: the screenshot leaves the machine whatever comes back.
    usage.requests++
    usage.looks = (usage.looks ?? 0) + 1
    let seen: Look
    try {
      seen = await options.provider.look!(view.request, frame)
    } catch (error) {
      // The answer from text alone stands, as if the model hadn't looked.
      step.lookError = redact(firstLine(error))
      return undefined
    }
    usage.inputTokens += seen.decision.usage?.inputTokens ?? 0
    usage.outputTokens += seen.decision.usage?.outputTokens ?? 0
    const textWouldStop = wouldStop(view.decision, view.screen, view.actions, doneAt, printOf(view.read)) !== undefined
    const result = useLook(
      view.decision,
      seen,
      { doneAt, minConfidence: Math.max(minConfidence, LOOK_ACTION_MIN), textWouldStop, always: lookAlways },
      (box) => pointedAt(box, view.screen, view.actions),
    )
    step.look = {
      why,
      decision: trim(result.used === 'none' ? seen.decision : result.decision),
      targetShown: seen.targetShown,
      ...(seen.box && { box: seen.box }),
      ...(result.pointed && { pointedAt: describeAction(result.pointed) }),
      used: result.used,
    }
    if (result.used === 'none') return undefined
    return { decision: result.decision, used: result.used, ...(result.pointed && { action: result.pointed }) }
  }

  /** The element on the current screen that this selector finds, by the same reading the run uses. */
  const findOnScreen = async (selector: string, deadline: number): Promise<{ read: Read; element: ScreenElement } | undefined> => {
    const current = await settle(deadline)
    const search = (visibility: 'attribute' | 'geometry' | 'all') => {
      const parsed = parseScreen(current.source, platform, { visibility })
      return [...parsed.elements, ...(parsed.unlabeled ?? [])].find((element) => toSelector(element.locator) === selector)
    }
    const element = search(current.geometric ? 'geometry' : 'attribute') ?? search('all')
    return element && { read: current, element }
  }

  /** Does one action again, on the element its selector finds now. */
  const redo = async (action: Action, deadline: number): Promise<boolean> => {
    const found = await findOnScreen(toSelector(action.element.locator), deadline)
    if (!found) return false
    const { element } = found
    const direct = device.input === 'simulator'
    if (action.type === 'type') await device.type(element, criterion.inputs[action.input])
    else if (action.type === 'scroll') await device.scroll!(element, action.direction)
    else await device.tap(element)
    next = direct ? await changedFrom(found.read) : await read()
    if (direct && action.type === 'tap') next = await afterDirectTap(element, found.read, next)
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
    ...(item.element.frame && { frame: item.element.frame }),
    ...(item.element.unlabeled && { unlabeled: true as const }),
  })

  const trace = await run()
  // The frames go out once the run is over, so writing them never slows a decision down. A frame
  // that can't be prepared or handed over costs that frame, never the trace.
  for (const step of trace.steps) {
    const get = frames.get(step)
    const frame = get && options.onFrame ? await get() : undefined
    const failed = frameErrors.get(step)
    if (failed && options.onFrame) step.notes = [...(step.notes ?? []), failed]
    if (!frame) {
      delete step.frame
      continue
    }
    try {
      await options.onFrame!(step.frame!, frame)
    } catch (error) {
      step.notes = [...(step.notes ?? []), `its frame couldn't be kept: ${redact(firstLine(error))}`]
      delete step.frame
    }
  }
  return trace

  async function run(): Promise<Trace> {
    try {
      // Idle connections close after a few seconds, so open one now, while the first screen is read.
      void Promise.resolve()
        .then(() => options.provider.warmUp?.())
        .catch(() => {})
      next = await read()
      // Decisions that acted. Those that only moved the plan on to its next step don't count.
      let acted = 0
      for (let index = 1; ; index++) {
        const view = await observe(next)
        const { read: settled, screen, actions, request } = view
        let { decision } = view
        screenSize ??= screen.size
        const step: Step = {
          index: steps.length + 1,
          atMs: Date.now() - started,
          screenText: screen.texts,
          actionCount: actions.length,
          decision: trim(decision),
          ...(plan.length > 0 && { planStep }),
        }
        steps.push(step)
        if (view.shot) keepFrame(step, view.shot, settled.source, screen)
        if (view.shotError) step.notes = [view.shotError]

        // The page source isn't always enough: when the answer from text alone would stop the
        // run, or is unsure, the model looks at the screen before anything is done.
        const doneAt = planStep < plan.length ? stepThreshold : goalThreshold
        const screenPrint = printOf(settled)
        const stopping = wouldStop(decision, screen, actions, doneAt, screenPrint)
        // Looking at every step, a step the model calls done from text is left to the checks.
        const lookNow = lookAlways ? decision.goalMet < doneAt : stopping !== undefined
        const why = looking && view.shot && acted < maxSteps && lookNow ? (lookAlways ? 'always' : stopping) : undefined
        // Where the run would stop, the checks come first, as without looking: if they hold, the
        // run is over, and no screenshot needs to go out.
        let checked: Expectation[] | undefined
        if (why && stopping && performed.length > 0 && criterion.expect.length > 0) {
          checked = await failing(device, criterion.expect, STOP_CHECK_MS)
          if (checked.length === 0) {
            options.onStep?.(step)
            return finish('passed', `All ${criterion.expect.length} expectations hold, although the model was unsure the goal was reached.`)
          }
        }
        let sawGoal = false
        if (why) {
          const looked = await lookAgain(step, view, why, doneAt)
          if (looked) {
            decision = looked.decision
            sawGoal = looked.used === 'goal'
            if (looked.action && !actions.includes(looked.action)) actions.push(looked.action)
          }
        }

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
          // A verdict reached by looking at the screenshot saw what was shown, so it stands.
          if (settled.geometric && !sawGoal) {
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
            const failed = checked ?? (await failing(device, criterion.expect, STOP_CHECK_MS))
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
          discardedDecisions++
          if (step.look || step.lookError) {
            // Its screenshot went out with the look, so the decision stays in the trace, marked.
            step.covered = true
            options.onStep?.(step)
          } else {
            steps.pop()
            index--
          }
          next = await read()
          continue
        }

        // The same action on the same screen, again and again, means the app isn't responding to it.
        const loopKey = `${screen.texts.join('|')}#${action.key}`
        const seen = timesChosen(screen, action, screenPrint) + 1
        repeats.set(loopKey, { count: seen, print: screenPrint })
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
        const direct = device.input === 'simulator'
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
          const description = request.actions.find((d) => d.key === item.key)?.description ?? describeAction(item)
          step.taken.push(takenFrom(item, description))
          done.push(item)
          history.push(description)
        }
        performed.push(entry)
        next = direct && step.taken.length > 0 ? await changedFrom(settled) : await read()
        if (direct && action.type === 'tap' && step.taken.length === 1) next = await afterDirectTap(action.element, settled, next)
        step.atMs = Date.now() - started
        const notes = device.drainNotes?.() ?? []
        if (notes.length > 0) step.notes = [...(step.notes ?? []), ...notes]
        options.onStep?.(step)

        hidden.clear()
        covered.clear()
        coveredSinceAction = 0
      }
    } catch (error) {
      // WebdriverIO quotes the selector in its errors, and a selector can hold test data.
      const message = error instanceof Error ? error.message : String(error)
      return finish('error', redact(message.split('\n')[0]))
    }
  }
}

/**
 * What to take from a look at the screen (see `ExploreOptions.look`), given the answer from
 * text alone. In order:
 *
 * - a step or goal the model now sees done: its whole answer, so the checks run;
 * - a usable action (at least `minConfidence` sure) that it is surer of than the text answer,
 *   or a different one where the text answer would end the run;
 * - when the text answer would end the run: the element under the centre of the box it drew
 *   around the control to use next, if it says that control is visible. The element is taken
 *   from the page source, so the step still acts through a selector, never a point.
 *
 * Otherwise nothing: the text answer stands, and the run goes on or stops as it would have.
 */
export function useLook(
  text: Decision,
  seen: Look,
  context: { doneAt: number; minConfidence: number; textWouldStop: boolean; always?: boolean },
  pointAt: (box: Box) => Action | undefined,
): { decision: Decision; used: StepLook['used']; pointed?: Action } {
  const { decision } = seen
  if (decision.goalMet >= context.doneAt) return { decision, used: 'goal' }
  const usable = decision.action !== STUCK && decision.confidence >= context.minConfidence
  // Where the text answer would end the run, any other clear way forward is worth taking. Otherwise,
  // looking at every step or not, the look has to be surer: it can be wrong where the text is right
  // (a placeholder in a screenshot looks like a value).
  const better = text.action === STUCK || decision.confidence > text.confidence || (context.textWouldStop && decision.action !== text.action)
  if (usable && better) return { decision, used: 'action' }
  if (context.textWouldStop && seen.box && seen.targetShown >= Math.max(TARGET_SHOWN_MIN, context.minConfidence)) {
    const pointed = pointAt(seen.box)
    if (pointed) {
      return {
        decision: {
          ...decision,
          action: pointed.key,
          confidence: seen.targetShown,
          probabilities: { ...decision.probabilities, [pointed.key]: Math.max(decision.probabilities[pointed.key] ?? 0, seen.targetShown) },
        },
        used: 'box',
        pointed,
      }
    }
  }
  return { decision: text, used: 'none' }
}

/**
 * The tap on the element under the centre of a box drawn on a screenshot of this screen: the
 * smallest button, switch or key whose frame holds that point, labelled or not. A box that
 * falls on no such element, on a field or a list, or only on something covering more than a
 * quarter of the screen, points at nothing.
 */
export function pointedAt(box: Box, screen: Screen, actions: Action[]): Action | undefined {
  if (!screen.size) return undefined
  const x = ((box.left + box.right) / 2) * screen.size.width
  const y = ((box.top + box.bottom) / 2) * screen.size.height
  const holds = (element: ScreenElement) =>
    element.frame !== undefined &&
    x >= element.frame.x &&
    x <= element.frame.x + element.frame.w &&
    y >= element.frame.y &&
    y <= element.frame.y + element.frame.h
  // Something as big as a quarter of the screen is a container, not the control the box was drawn around.
  const tooBig = (element: ScreenElement) => element.frame!.w * element.frame!.h > (screen.size!.width * screen.size!.height) / 4
  const candidates = [...screen.elements, ...(screen.unlabeled ?? [])].filter(
    (element) => (element.kind === 'button' || element.kind === 'switch' || element.kind === 'key') && holds(element) && !tooBig(element),
  )
  const smallest = candidates.sort((a, b) => a.frame!.w * a.frame!.h - b.frame!.w * b.frame!.h)[0]
  if (!smallest) return undefined
  return actions.find((action) => action.type === 'tap' && action.element.key === smallest.key) ?? { key: `tap:${smallest.key}`, type: 'tap', element: smallest }
}

/** An error's first line: WebdriverIO's errors run on with stack-like detail. */
function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]
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
