import type { ScrollDirection } from './types.ts'

/**
 * How jevvium scrolls, while exploring and in the tests it writes: WebdriverIO's
 * `browser.swipe`, a finger dragged across 80% of the list over a second. Slow
 * enough not to fling, so the same swipe moves the list the same distance every
 * time, on iOS and Android alike.
 */
export const SWIPE = { duration: 1_000, percent: 0.8 }

/** The finger's direction for a scroll: to see what is below, the finger moves up. */
export function swipeDirection(scroll: ScrollDirection): ScrollDirection {
  return { down: 'up', up: 'down', right: 'left', left: 'right' }[scroll] as ScrollDirection
}
