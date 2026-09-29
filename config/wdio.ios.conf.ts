import { join } from 'node:path'
import { config as shared } from './wdio.shared.conf.ts'

export const config: WebdriverIO.Config = {
  ...shared,
  specs: ['../generated/*.ios.spec.ts'],
  // The first session builds WebDriverAgent, which can take minutes on a fresh machine.
  connectionRetryTimeout: 600_000,
  capabilities: [
    {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:deviceName': process.env.IOS_DEVICE_NAME ?? 'iPhone 17',
      // Without a version, Appium uses the newest simulator runtime Xcode has.
      ...(process.env.IOS_PLATFORM_VERSION && { 'appium:platformVersion': process.env.IOS_PLATFORM_VERSION }),
      'appium:app': process.env.IOS_APP ?? join(process.cwd(), 'apps', 'wdiodemoapp.app'),
      'appium:newCommandTimeout': 240,
      'appium:wdaLaunchTimeout': 240_000,
    },
  ],
}
