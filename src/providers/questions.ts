import { LEAVE_EMPTY, STUCK, type DecisionRequest } from './types.ts'

/**
 * The questions jevvium asks at every step, worded once so that every provider
 * is asked exactly the same thing.
 */
export const NEXT_ACTION =
  'You are a QA engineer testing a mobile app. Given the goal, the visible text and the steps ' +
  'already taken, pick the single next action that moves the test closest to the goal. ' +
  'The goal may happen on a screen other than the current one: navigating there is part of the ' +
  'test, so pick the action that most likely leads to that screen. ' +
  'Prefer actions that have not been taken yet on this screen. If the keyboard is open and ' +
  'the next step is a tap outside the field, close the keyboard first.'

/** Added to `NEXT_ACTION` when the criterion is a plan with steps. */
const FOLLOW_PLAN =
  ' The test follows a plan: work on its current step now, and use the later steps only to tell ' +
  'where the test is heading.'

export const GOAL_MET = 'Does the current screen show that the goal has been reached?'
const STEP_DONE =
  'Has the current step of the plan been completed? It is completed when the screen shows its ' +
  'result, and also when the test has already moved past it: the steps taken did what it says, ' +
  'and the screen now belongs to a later step.'

/** What a yes and a no to `GOAL_MET` mean. */
export const GOAL_MET_ANSWERS = {
  true: 'The visible text or control states confirm the goal is complete.',
  false: 'The goal is not complete yet, or the screen does not show it.',
}
const STEP_DONE_ANSWERS = {
  true: 'The current step is done: the screen shows its result, or the test is already on a later step.',
  false: 'The current step still has to be done, on this screen or another.',
}

/** The next-action question for this request: with the plan instructions when it has a plan. */
export function nextActionQuestion(request: DecisionRequest): string {
  return request.plan ? NEXT_ACTION + FOLLOW_PLAN : NEXT_ACTION
}

/** The "goal reached" question for this request: about the current step when it has a plan. */
export function goalMetQuestion(request: DecisionRequest): { instructions: string; answers: { true: string; false: string } } {
  return request.plan ? { instructions: STEP_DONE, answers: STEP_DONE_ANSWERS } : { instructions: GOAL_MET, answers: GOAL_MET_ANSWERS }
}

/** What the provider sees of the screen and the run so far. */
export function stateOf(request: DecisionRequest) {
  return {
    platform: request.platform,
    goal: request.goal,
    ...(request.plan && {
      test_plan: request.plan.steps.map((step, i) => `${i + 1}. ${step}`),
      current_step: request.plan.current,
    }),
    visible_text: request.screenText,
    control_states: request.controlStates,
    steps_taken: request.history,
    test_data_available: request.inputNames,
  }
}

/** The options for the next action, keyed by the value to answer with. */
export function actionOptions(request: DecisionRequest): Record<string, string> {
  const options: Record<string, string> = {}
  for (const action of request.actions) options[action.key] = action.description
  options[STUCK] = 'No action here can lead toward the goal, not even by navigating to another screen first.'
  return options
}

/** The question asked for each empty field: which test data goes in it. */
export function fillQuestion(field: DecisionRequest['fields'][number]): string {
  return `To reach the goal, which test data should be typed into ${field.description}?`
}

export function inputOptions(request: DecisionRequest): Record<string, string> {
  const options: Record<string, string> = {}
  for (const name of request.inputNames) options[name] = `The test data "${name}"`
  options[LEAVE_EMPTY] = 'None of the test data belongs here, or the goal needs this field left empty.'
  return options
}

export function fillKey(fieldKey: string): string {
  return `fill_${fieldKey}`
}
