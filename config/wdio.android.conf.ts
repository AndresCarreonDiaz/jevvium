import { join } from 'node:path'
import { config as shared } from './wdio.shared.conf.ts'

export const config: WebdriverIO.Config = {
  ...shared,
  specs: ['../generated/*.android.spec.ts'],
  capabilities: [
    {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:deviceName': process.env.ANDROID_DEVICE_NAME ?? 'Android Emulator',
      ...(process.env.ANDROID_PLATFORM_VERSION && { 'appium:platformVersion': process.env.ANDROID_PLATFORM_VERSION }),
      'appium:app': process.env.ANDROID_APP ?? join(process.cwd(), 'apps', 'android.apk'),
      ...(!process.env.ANDROID_APP && { 'appium:appWaitActivity': 'com.wdiodemoapp.MainActivity' }),
      'appium:newCommandTimeout': 240,
    },
  ],
}
