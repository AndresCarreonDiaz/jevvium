import type { Browser } from 'webdriverio'
import { toSelector } from './locator.ts'
import type { Locator, Platform } from './types.ts'

/**
 * The few things jevvium needs from a device. The explorer only talks to this,
 * so it can run on WebdriverIO, inside an Appium plugin, or against a fake in tests.
 */
export interface Device {
  readonly platform: Platform
  pageSource(): Promise<string>
  tap(locator: Locator): Promise<void>
  type(locator: Locator, value: string): Promise<void>
  isDisplayed(locator: Locator, timeoutMs: number): Promise<boolean>
}

export function webdriverDevice(browser: Browser): Device {
  if (!browser.isAndroid && !browser.isIOS) {
    throw new Error('jevvium needs an Appium session on Android or iOS')
  }
  return {
    platform: browser.isIOS ? 'ios' : 'android',
    pageSource: () => browser.getPageSource(),
    tap: async (locator) => {
      await browser.$(toSelector(locator)).click()
    },
    type: async (locator, value) => {
      await browser.$(toSelector(locator)).setValue(value)
    },
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

