export type Platform = 'android' | 'ios'

/**
 * How to find an element again. `accessibility id` works on both platforms and is
 * what a human would pick; the others are fallbacks for when it is missing or
 * not unique on the screen.
 */
export type Locator = {
  using: 'accessibility id' | '-ios predicate string' | '-android uiautomator' | 'xpath'
  value: string
}

/**
 * `key` is the keyboard's return key (done, go, search...), which closes or submits it.
 * `list` is a scrollable container with more content than fits: a list, a table, a form.
 */
export type ElementKind = 'button' | 'input' | 'switch' | 'key' | 'list'

/** Where more content is: scrolling `down` reveals what is below the fold. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

/** One element on screen that the user can act on. */
export type ScreenElement = {
  /** Short, stable key for this snapshot, e.g. `e4`. */
  key: string
  kind: ElementKind
  /** What a person would call it: its label, text or accessibility id. */
  label: string
  /** Its accessibility id or resource id, when it has one. */
  id?: string
  /** Where it sits vertically, which tells apart elements with the same label. */
  region?: 'top' | 'middle' | 'bottom'
  /** Whether a switch or checkbox is on. */
  checked?: boolean
  /** Whether an input has nothing typed in it yet. */
  empty?: boolean
  /** An input's placeholder, when its caption became its label. */
  placeholder?: string
  /** The directions a list can scroll in to show more. */
  scrolls?: ScrollDirection[]
  /** Its centre on screen, in points from the top left, for tapping it directly. */
  centre?: { x: number; y: number }
  locator: Locator
}

export type Screen = {
  platform: Platform
  elements: ScreenElement[]
  /** Visible text that is not an actionable element, for context. */
  texts: string[]
}

/** Something jevvium can do next. `key` is what the decision model picks. */
export type Action =
  | { key: string; type: 'tap'; element: ScreenElement }
  | { key: string; type: 'type'; element: ScreenElement; input: string }
  | { key: string; type: 'scroll'; element: ScreenElement; direction: ScrollDirection }

/**
 * A thing that must be true at the end, checked without any model: an element with
 * this accessibility id, one whose whole text is this, or one whose text contains it.
 */
export type Expectation = { id: string } | { text: string } | { contains: string }

/** An acceptance criterion, as written in a criteria file or a test plan. */
export type Criterion = {
  id: string
  /** The plan's title, when it has one: what the generated test is called. */
  title?: string
  /** The behaviour to reach, in plain language: for a plan, its title and any context paragraphs. */
  goal: string
  /**
   * The plan's numbered steps, in order, when it has them. The explorer works
   * through them one at a time, asking the model whether the current one is done.
   */
  steps?: string[]
  /** Test data the flow may type, by name. Values never leave the machine. */
  inputs: Record<string, string>
  /** Deterministic checks. The run only passes if all of them hold. */
  expect: Expectation[]
}
