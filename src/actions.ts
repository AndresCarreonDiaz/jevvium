import { redactor } from './redact.ts'
import type { Action, Screen, ScreenElement } from './types.ts'

/**
 * Every action worth offering on a screen: tap each button or switch, type each
 * named input into each field, and scroll each list that has more to show, when
 * the device can scroll. Typing is offered by input name only, so the decision
 * model never sees the value.
 */
export function buildActions(screen: Screen, inputNames: string[], canScroll = true): Action[] {
  const actions: Action[] = []
  for (const element of screen.elements) {
    if (element.kind === 'input') {
      for (const input of inputNames) {
        actions.push({ key: `type:${element.key}:${input}`, type: 'type', element, input })
      }
    } else if (element.kind === 'list') {
      if (!canScroll) continue
      for (const direction of element.scrolls ?? []) {
        actions.push({ key: `scroll:${element.key}:${direction}`, type: 'scroll', element, direction })
      }
    } else {
      actions.push({ key: `tap:${element.key}`, type: 'tap', element })
    }
  }
  return actions
}

export function describeAction(action: Action): string {
  if (action.element.kind === 'key') return `Press the "${action.element.label}" key on the on-screen keyboard`
  if (action.type === 'scroll') {
    const where = action.element.label === 'screen' ? 'the screen' : describeElement(action.element)
    return `Scroll ${action.direction} in ${where} to see more of it`
  }
  const target = describeElement(action.element)
  return action.type === 'type'
    ? `Type the test data "${action.input}" into ${target}`
    : `${action.element.kind === 'switch' ? 'Toggle' : 'Tap'} ${target}`
}

export function describeElement(element: ScreenElement): string {
  if (element.unlabeled) return `an unlabeled ${element.kind}${element.region ? ` (${element.region} of the screen)` : ''}`
  const noun = element.kind === 'input' ? 'field' : element.kind
  const details = [
    element.placeholder ? `placeholder "${element.placeholder}"` : undefined,
    element.checked !== undefined ? `currently ${element.checked ? 'on' : 'off'}` : undefined,
    element.id && element.id !== element.label ? `id ${element.id}` : undefined,
    element.region && `${element.region} of the screen`,
  ].filter(Boolean)
  return `the ${noun} "${element.label}"${details.length ? ` (${details.join(', ')})` : ''}`
}

/** The on/off state of every switch, which visible text alone often leaves ambiguous. */
export function controlStates(screen: Screen): string[] {
  return screen.elements
    .filter((element) => element.checked !== undefined)
    .map((element) => `The switch "${element.label}" is ${element.checked ? 'on' : 'off'}`)
}

/**
 * The screen with each test data value replaced by `{name}` (see `redactor`), so
 * a field that echoes what was typed, or a "Welcome, jane@example.com" banner,
 * doesn't send the value to the decision model.
 */
export function redactScreen(screen: Screen, inputs: Record<string, string>): Screen {
  const redact = redactor(inputs)
  return {
    ...screen,
    texts: screen.texts.map(redact),
    elements: screen.elements.map((element) => ({
      ...element,
      label: redact(element.label),
      id: element.id && redact(element.id),
      placeholder: element.placeholder && redact(element.placeholder),
    })),
  }
}
