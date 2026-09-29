import type { Browser } from 'webdriverio'
import type { Replay, Trace } from './explorer.ts'
import { expectationLocator, toSelector } from './locator.ts'
import { redactor, restoreSelector } from './redact.ts'
import type { Criterion, Expectation } from './types.ts'

/** How long the generated specs wait for an element (config/wdio.shared.conf.ts), so the replay waits as long. */
export const SPEC_WAIT_MS = 15_000

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
    for (const taken of trace.steps.flatMap((step) => step.taken ?? [])) {
      const element = browser.$(restoreSelector(taken.selector, criterion.inputs))
      // A spec's commands wait for their element the same way, through its waitforTimeout.
      await element.waitForExist({ timeout: waitMs })
      if (taken.type === 'type') await element.setValue(criterion.inputs[taken.input!])
      else await element.click()
    }
    for (const expectation of criterion.expect) {
      const selector = toSelector(expectationLocator(expectation, trace.platform))
      const shown = await browser
        .$(selector)
        .waitForDisplayed({ timeout: waitMs })
        .then(
          () => true,
          () => false,
        )
      if (!shown) return result('failed', `${describe(expectation)} is not on screen at the end.`)
    }
    return result('passed', 'The generated steps pass with plain Appium.')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return result('failed', message.split('\n')[0])
  }
}

function describe(expectation: Expectation): string {
  return 'id' in expectation ? `The element "${expectation.id}"` : `The text "${expectation.text}"`
}
