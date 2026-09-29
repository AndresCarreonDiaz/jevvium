import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SPEC_WAIT_MS } from '../src/replay.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'screenshots')

/** Runs the specs jevvium generated. Nothing here calls a model. */
export const config: Omit<WebdriverIO.Config, 'capabilities'> = {
  runner: 'local',
  maxInstances: 1,

  logLevel: 'warn',
  bail: 0,
  // jevvium's replay check waits as long, so a test it passed passes here too.
  waitforTimeout: SPEC_WAIT_MS,
  connectionRetryTimeout: 300_000,
  connectionRetryCount: 2,

  // Local only: the generated specs need no insecure Appium features.
  services: [['appium', { args: { address: '127.0.0.1', log: './reports/appium.log' } }]],

  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 120_000 },

  reporters: [
    'spec',
    ['junit', { outputDir: './reports/junit', outputFileFormat: ({ cid }) => `results-${cid}.xml` }],
  ],

  afterTest: async (test, _context, { passed }) => {
    if (passed) return
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    // Test titles are whole acceptance criteria, so keep file names short.
    const name = `${test.parent} - ${test.title}`.replace(/[^a-z0-9-]+/gi, '_').slice(0, 120)
    await browser.saveScreenshot(join(SCREENSHOT_DIR, `${name}.png`))
  },
}
