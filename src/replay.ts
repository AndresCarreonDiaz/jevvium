import type { Browser } from 'webdriverio'
import { describeExpectation } from './expectations.ts'
import type { Replay, Trace } from './explorer.ts'
import { expectationLocator, toSelector } from './locator.ts'
import { redactor, restoreSelector } from './redact.ts'
import { SWIPE, swipeDirection } from './scroll.ts'
import type { Criterion } from './types.ts'

/** How long the generated specs wait for an element (config/wdio.shared.conf.ts), so the replay waits as long. */
export const SPEC_WAIT_MS = 15_000
/** How long an action that came after the run waited for the app may wait for its element. */
export const AFTER_WAIT_MS = 60_000

/**
 * Runs a passing trace's steps with plain Appium commands, exactly as the
 * generated spec will (the same selectors, `click` and `setValue`, the same
 * expectations and waits), so a test is proven to pass on its own before it is
 * handed over. Exploration can take shortcuts a spec can't, such as typing like
 * a hardware keyboard on the simulator. The app must be on its first screen.
 */
export async function replay(browser: Browser, trace: Trace, criterion: Criterion, waitMs = SPEC_WAIT_MS): Promise<Replay> {
  const started = Date.now()
  // The reason is stored in the trace, which never holds test data.
  const redact = redactor(criterion.inputs)
  const result = (outcome: Replay['outcome'], reason: string): Replay => ({
    outcome,
    reason: redact(reason),
    durationMs: Date.now() - started,
  })

  try {
    let afterWait = false
    for (const step of trace.steps) {
      if (step.undone) continue
      if (step.waited) afterWait = true
      for (const taken of step.taken ?? []) {
        const element = browser.$(restoreSelector(taken.selector, criterion.inputs))
        // A spec's commands wait for their element the same way: through its waitforTimeout, or
        // the longer wait the spec writes out where the run waited for the app.
        await element.waitForExist({ timeout: afterWait ? Math.max(waitMs, AFTER_WAIT_MS) : waitMs })
        afterWait = false
        if (taken.type === 'type') await element.setValue(criterion.inputs[taken.input!])
        else if (taken.type === 'scroll') await browser.swipe({ ...SWIPE, direction: swipeDirection(taken.direction!), scrollableElement: element })
        else await element.click()
      }
    }
    for (const expectation of criterion.expect) {
      const selector = toSelector(expectationLocator(expectation, trace.platform))
      const shown = await browser
        .$(selector)
        .waitForDisplayed({ timeout: waitMs })
        .then(
          () => true,
          (error: unknown) => {
            if (lostSession(error)) throw error
            return false
          },
        )
      if (!shown) return result('failed', `The ${describeExpectation(expectation)} is not on screen at the end.`)
    }
    return result('passed', 'The generated steps pass with plain Appium.')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return result(lostSession(error) ? 'error' : 'failed', message.split('\n')[0])
  }
}

/** Whether a command failed because the session or WebDriverAgent went away, rather than the app. */
function lostSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /invalid session id|session is either terminated or not started|could not proxy command|ECONNREFUSED|socket hang up|unable to connect/i.test(message)
}
