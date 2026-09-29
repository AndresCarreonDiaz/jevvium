import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SCREENSHOT_DIR = join(process.cwd(), 'screenshots')

/** Runs the specs jevvium generated. Nothing here calls a model. */
export const config: Omit<WebdriverIO.Config, 'capabilities'> = {
  runner: 'local',
  maxInstances: 1,

  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 300_000,
  connectionRetryCount: 2,

  services: [['appium', { args: { relaxedSecurity: true, log: './reports/appium.log' } }]],

  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 120_000 },

  reporters: [
    'spec',
    ['junit', { outputDir: './reports/junit', outputFileFormat: ({ cid }) => `results-${cid}.xml` }],
  ],

  afterTest: async (test, _context, { passed }) => {
    if (passed) return
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    const name = `${test.parent} - ${test.title}`.replace(/[^a-z0-9-]+/gi, '_')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, `${name}.png`))
  },
}
