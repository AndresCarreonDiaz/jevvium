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

/** Time for a tapped field to take focus before keys arrive; they travel on a separate channel. */
const FOCUS_MS = 80

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
  const { width, height } = await browser.getWindowSize()
  const directTyping = hid.keyboard !== 'none'

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
  /** Taps directly, or hands the tap to Appium. Returns whether the tap was direct. */
  const tap = async (element: ScreenElement): Promise<boolean> => {
    const centre = await centreOf(element)
    movedSinceRead = true
    if (!centre) {
      await appium.tap(element)
      return false
    }
    await hid.tap(centre.x / width, centre.y / height)
    return true
  }

  return {
    ...appium,
    input: 'simulator',
    pageSource: () => afterRead(appium.pageSource),
    fingerprint: () => afterRead(appium.fingerprint!),
    tap: async (element) => {
      await tap(element)
    },
    type: async (element, value) => {
      if (!directTyping || !canTypeDirectly(value)) {
        movedSinceRead = true
        return appium.type(element, value)
      }
      // Appium focused and typed it when the field had to be scrolled into view.
      if (!(await tap(element))) return appium.type(element, value)
      await new Promise((resolve) => setTimeout(resolve, FOCUS_MS))
      if (!element.empty) await hid.clear()
      await hid.type(value)
    },
    close: () => hid.close(),
  }
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
