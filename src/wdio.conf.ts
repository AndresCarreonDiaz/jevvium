import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SPEC_WAIT_MS } from './replay.ts'

/**
 * The WebdriverIO config `jevvium test` runs the generated tests with. It ships
 * inside jevvium, so WebdriverIO finds its runner and framework next to it, and it
 * takes the specs, the Appium server and the capabilities from `jevvium test`
 * through the environment, which its worker processes inherit. Nothing here calls
 * a model.
 */
export type TestSettings = {
  specs: string[]
  protocol: string
  hostname: string
  port: number
  path: string
  capabilities: WebdriverIO.Capabilities
  /** Where a failed test's screenshot goes. */
  screenshots: string
}

const raw = process.env.JEVVIUM_WDIO
if (!raw) throw new Error('This WebdriverIO config is run by `jevvium test`')
const settings = JSON.parse(raw) as TestSettings

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: settings.specs,
  maxInstances: 1,
  protocol: settings.protocol,
  hostname: settings.hostname,
  port: settings.port,
  path: settings.path,
  capabilities: [settings.capabilities],

  logLevel: 'error',
  bail: 0,
  // jevvium's replay check waits as long, so a test it passed passes here too.
  waitforTimeout: SPEC_WAIT_MS,
  // The first session on a simulator builds WebDriverAgent, which can take minutes.
  connectionRetryTimeout: 600_000,
  connectionRetryCount: 2,

  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 120_000 },
  reporters: ['spec'],

  afterTest: async (test, _context, { passed }) => {
    if (passed) return
    mkdirSync(settings.screenshots, { recursive: true })
    // Test titles are whole acceptance criteria, so keep file names short.
    const name = `${test.parent} - ${test.title}`.replace(/[^a-z0-9-]+/gi, '_').slice(0, 120)
    await browser.saveScreenshot(join(settings.screenshots, `${name}.png`))
  },
}
