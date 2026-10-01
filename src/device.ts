import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Browser } from 'webdriverio'
import { canTypeDirectly, IosHid } from './ios-hid.ts'
import { toSelector } from './locator.ts'
import { parseScreen } from './screen.ts'
import type { Locator, Platform, ScreenElement } from './types.ts'

/**
 * The few things jevvium needs from a device. The explorer only talks to this,
 * so it can run on WebdriverIO, inside an Appium plugin, or against a fake in tests.
 */
export interface Device {
  readonly platform: Platform
  /** How taps and typing reach the app: through Appium, or straight into the iOS Simulator. */
  readonly input?: 'appium' | 'simulator'
  pageSource(): Promise<string>
  /**
   * A cheaper read of the same page source: on iOS, the XML without XCTest's
   * `visible` attribute (what `mobile: source` returns with `excludedAttributes:
   * 'visible'`). It must equal `fingerprintOf(pageSource())` when nothing changed.
   * The explorer uses it to tell whether the screen is still changing and, on a
   * simple iOS screen, parses it as the screen itself.
   */
  fingerprint?(): Promise<string>
  tap(element: ScreenElement): Promise<void>
  /** Types into a field. When `element.empty`, there is nothing to clear first. */
  type(element: ScreenElement, value: string): Promise<void>
  isDisplayed(locator: Locator, timeoutMs: number): Promise<boolean>
  /** Whether the element is on screen and not covered, right now. */
  isVisible?(locator: Locator): Promise<boolean>
  /**
   * Sends taps through Appium from now on, for a device whose direct taps may not
   * reach the app. `reason` becomes a note.
   */
  fallBackToAppium?(reason: string): void
  /** What the device changed about how it works since the last call, for the trace. */
  drainNotes?(): string[]
  close?(): void
}

/** Everything through Appium. Works on any device, emulator or simulator. */
export function webdriverDevice(browser: Browser): Device {
  if (!browser.isAndroid && !browser.isIOS) {
    throw new Error('jevvium needs an Appium session on Android or iOS')
  }
  return {
    platform: browser.isIOS ? 'ios' : 'android',
    input: 'appium',
    pageSource: () => browser.getPageSource(),
    // On iOS, computing `visible` is most of the cost of a page source: without it a read is several times faster.
    fingerprint: browser.isIOS
      ? () => browser.execute('mobile: source', { format: 'xml', excludedAttributes: 'visible' }) as Promise<string>
      : () => browser.getPageSource(),
    tap: async (element) => {
      await browser.$(toSelector(element.locator)).click()
    },
    type: async (element, value) => {
      // Clearing costs about as much as typing, so skip it when there's nothing to clear.
      const field = browser.$(toSelector(element.locator))
      if (element.empty) await field.addValue(value)
      else await field.setValue(value)
    },
    isVisible: (locator) => browser.$(toSelector(locator)).isDisplayed(),
    isDisplayed: (locator, timeoutMs) =>
      browser
        .$(toSelector(locator))
        .waitForDisplayed({ timeout: timeoutMs })
        .then(
          () => true,
          () => false,
        ),
  }
}

/** How long a tapped field may take to get keyboard focus before XCTest types into it instead. */
const FOCUS_TIMEOUT_MS = 1_500
/** How long typed keys may keep arriving before the field is read back. */
const TYPED_SETTLE_MS = 1_000

/**
 * Reads the screen through Appium, but taps and types straight into the iOS
 * Simulator with jevvium's native helper, which skips XCTest. Fails on a real
 * device, or when the helper can't be built; callers fall back to `webdriverDevice`.
 *
 * Appium still does the input when the helper can't do it safely: an element that
 * has moved off screen or under the keyboard (XCTest scrolls it into view), text
 * that isn't plain ASCII, and typing on a simulator whose keyboard service the
 * helper couldn't reach.
 */
export async function simulatorDevice(browser: Browser): Promise<Device> {
  const appium = webdriverDevice(browser)
  const udid = (browser.capabilities as { udid?: string }).udid
  if (!browser.isIOS || !udid || !(await isSimulator(udid))) {
    throw new Error('Direct input only works on an iOS Simulator')
  }
  const hid = await IosHid.start(udid)
  const size = await browser.getWindowSize().catch((error: unknown) => {
    hid.close()
    throw error
  })
  const { width, height } = size
  let directTyping = hid.keyboard !== 'none'

  // Taps and typing move things (an opening keyboard scrolls a form), so after any
  // input an element's position is looked up again rather than trusted.
  let movedSinceRead = false
  const afterRead = async (read: () => Promise<string>) => {
    const source = await read()
    movedSinceRead = false
    return source
  }
  /** Where to tap the element now, or undefined when it is off screen or under the keyboard. */
  const centreOf = async (element: ScreenElement) => {
    if (!movedSinceRead && element.centre) return element.centre
    const selector = toSelector(element.locator)
    const now = parseScreen(await appium.fingerprint!(), 'ios', { visibility: 'geometry' }).elements.find(
      (candidate) => toSelector(candidate.locator) === selector,
    )
    return now?.centre
  }
  /** Taps directly, or hands the tap to Appium. Returns where it tapped, or undefined when Appium did. */
  const tap = async (element: ScreenElement): Promise<{ x: number; y: number } | undefined> => {
    const centre = await centreOf(element)
    movedSinceRead = true
    if (!centre) {
      await appium.tap(element)
      return undefined
    }
    await hid.tap(centre.x / width, centre.y / height)
    return centre
  }
  /**
   * Waits until the element has keyboard focus. Keys reach the app on a different
   * channel from touches, so without this a tap that lands late would send them to
   * the field before. The element is compared by identity, not position, since
   * focusing a field often scrolls the form.
   */
  const focused = async (element: ScreenElement): Promise<string | undefined> => {
    const deadline = Date.now() + FOCUS_TIMEOUT_MS
    const target = await browser.findElement(element.locator.using, element.locator.value).catch(() => undefined)
    const targetId = target && elementId(target)
    if (!targetId) return undefined
    do {
      const active = await browser.getActiveElement().catch(() => undefined)
      if (active && elementId(active) === targetId) return targetId
      await new Promise((resolve) => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    return undefined
  }
  /** Whether the field shows what was typed (see `showsTyped`), read once the keys have stopped arriving. */
  const typedCorrectly = async (fieldId: string, value: string): Promise<boolean> => {
    const read = () => browser.getElementAttribute(fieldId, 'value').then((shown) => shown ?? '', () => undefined)
    const deadline = Date.now() + TYPED_SETTLE_MS
    let shown = await read()
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const again = await read()
      const settled = again === shown
      shown = again
      if (settled || Date.now() >= deadline) break
    }
    return shown === undefined || showsTyped(shown, value)
  }
  let directTaps = true
  const notes: string[] = []

  return {
    ...appium,
    get input() {
      return directTaps ? ('simulator' as const) : ('appium' as const)
    },
    pageSource: () => afterRead(appium.pageSource),
    fingerprint: () => afterRead(appium.fingerprint!),
    tap: async (element) => {
      if (!directTaps) {
        movedSinceRead = true
        return appium.tap(element)
      }
      await tap(element)
    },
    type: async (element, value) => {
      if (!directTyping || !canTypeDirectly(value)) {
        movedSinceRead = true
        return appium.type(element, value)
      }
      // Once taps go through Appium, so does the one that focuses the field; the keys still go direct.
      if (!directTaps) {
        movedSinceRead = true
        await appium.tap(element)
      } else if (!(await tap(element))) {
        // Appium focused and typed it when the field had to be scrolled into view.
        return appium.type(element, value)
      }
      // A field that never reports focus (a custom input) is typed into through XCTest.
      const fieldId = await focused(element)
      if (!fieldId) return appium.type({ ...element, empty: false }, value)
      if (!element.empty) await hid.clear()
      await hid.type(value)
      // Keys can go missing on some simulators. Then XCTest types it, now and from here on.
      if (!(await typedCorrectly(fieldId, value))) {
        directTyping = false
        notes.push('text typed straight into the simulator came out wrong, so typing goes through Appium from now on')
        await appium.type({ ...element, empty: false }, value)
      }
    },
    fallBackToAppium: (reason) => {
      if (!directTaps) return
      directTaps = false
      notes.push(reason)
    },
    drainNotes: () => notes.splice(0),
    close: () => hid.close(),
  }
}

/**
 * Whether a field showing `shown` holds `value`. Formatting the app adds (spaces,
 * dashes, brackets, capitals) doesn't count as a difference, but a character of the
 * value that went missing does, punctuation included. A secure field, which shows
 * bullets, only has to have the right length.
 */
export function showsTyped(shown: string, value: string): boolean {
  if (/^[•●]+$/.test(shown)) return shown.length === value.length
  const typed = new Set(value.toLowerCase())
  const plain = (text: string) =>
    [...text.toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c) || (typed.has(c) && c.trim() !== '')).join('')
  return plain(shown) === plain(value)
}

/** The id in a WebDriver element reference, in its W3C or older form. */
function elementId(reference: object): string | undefined {
  const fields = reference as Record<string, unknown>
  const id = fields['element-6066-11e4-a52e-4f735466cecf'] ?? fields.ELEMENT
  return typeof id === 'string' ? id : undefined
}

async function isSimulator(udid: string): Promise<boolean> {
  const { stdout } = await promisify(execFile)('xcrun', ['simctl', 'list', 'devices', '--json'])
  const { devices } = JSON.parse(stdout) as { devices: Record<string, { udid: string }[]> }
  return Object.values(devices).some((list) => list.some((device) => device.udid === udid))
}

/** What `Device.fingerprint()` returns for this page source when the screen hasn't changed. */
export function fingerprintOf(source: string, platform: Platform): string {
  return platform === 'ios' ? source.replace(/ visible="(?:true|false)"/g, '') : source
}
