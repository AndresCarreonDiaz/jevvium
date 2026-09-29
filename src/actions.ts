import type { Action, Screen, ScreenElement } from './types.ts'

/**
 * Every action worth offering on a screen: tap each button or switch, and type
 * each named input into each field. Typing is offered by input name only, so
 * the decision model never sees the value.
 */
export function buildActions(screen: Screen, inputNames: string[]): Action[] {
  const actions: Action[] = []
  for (const element of screen.elements) {
    if (element.kind === 'input') {
      for (const input of inputNames) {
        actions.push({ key: `type:${element.key}:${input}`, type: 'type', element, input })
      }
    } else {
      actions.push({ key: `tap:${element.key}`, type: 'tap', element })
    }
  }
  return actions
}

export function describeAction(action: Action): string {
  if (action.element.kind === 'key') return `Press the "${action.element.label}" key on the on-screen keyboard`
  const target = describeElement(action.element)
  return action.type === 'type'
    ? `Type the test data "${action.input}" into ${target}`
    : `${action.element.kind === 'switch' ? 'Toggle' : 'Tap'} ${target}`
}

function describeElement(element: ScreenElement): string {
  const noun = element.kind === 'input' ? 'field' : element.kind
  const details = [
    element.id && element.id !== element.label ? `id ${element.id}` : undefined,
    element.region && `${element.region} of the screen`,
  ].filter(Boolean)
  return `the ${noun} "${element.label}"${details.length ? ` (${details.join(', ')})` : ''}`
}

/**
 * Replaces every test data value in a screen with `{name}`, so a field that
 * echoes what was typed (or a "Welcome, jane@example.com" banner) doesn't
 * send the value to the decision model.
 */
export function redactScreen(screen: Screen, inputs: Record<string, string>): Screen {
  // Longest first, so a value that contains another is replaced whole.
  const values = Object.entries(inputs)
    .filter(([, value]) => value.length >= 3)
    .sort(([, a], [, b]) => b.length - a.length)
  const redact = (text: string) =>
    values.reduce((result, [name, value]) => result.split(value).join(`{${name}}`), text)

  return {
    ...screen,
    texts: screen.texts.map(redact),
    elements: screen.elements.map((element) => ({
      ...element,
      label: redact(element.label),
      id: element.id && redact(element.id),
    })),
  }
}
