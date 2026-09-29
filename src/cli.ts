#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { remote } from 'webdriverio'
import { generateSpec, specFileName } from './codegen.ts'
import { loadCriterion } from './criteria.ts'
import { webdriverDevice } from './device.ts'
import { explore, type Step, type Trace } from './explorer.ts'
import { JevProvider } from './providers/jev.ts'
import type { Platform } from './types.ts'

const USAGE = `jevvium: turn acceptance criteria into Appium tests

Usage:
  jevvium explore <criteria.yml...> --platform <android|ios> --app <path> [options]
  jevvium codegen <trace.json> --criteria <criteria.yml> [--out <dir>]

Explore options:
  --platform <name>          android or ios (required)
  --app <path>               .apk or .app to install (required)
  --device <name>            device name (default: "Android Emulator" or "iPhone 17")
  --platform-version <ver>   OS version of the emulator or simulator
  --server <url>             Appium server (default: http://127.0.0.1:4723)
  --runs <dir>               where traces go (default: runs)
  --out <dir>                where generated specs go (default: generated)
  --max-steps <n>            actions before giving up (default: 15)
  --min-confidence <p>       below this, stop and escalate (default: 0.5)
  --goal-threshold <p>       "goal reached" probability that triggers the checks (default: 0.8)

Environment:
  TYPESAFE_API_KEY           key for the Jev decision model (read from .env if present)
`

async function main(): Promise<number> {
  try {
    process.loadEnvFile()
  } catch {
    // No .env file; the environment may already have the key.
  }

  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      platform: { type: 'string' },
      app: { type: 'string' },
      device: { type: 'string' },
      'platform-version': { type: 'string' },
      server: { type: 'string', default: 'http://127.0.0.1:4723' },
      runs: { type: 'string', default: 'runs' },
      out: { type: 'string', default: 'generated' },
      'max-steps': { type: 'string', default: '15' },
      'min-confidence': { type: 'string', default: '0.5' },
      'goal-threshold': { type: 'string', default: '0.8' },
      criteria: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...files] = positionals

  if (values.help || !command || files.length === 0) {
    console.log(USAGE)
    return values.help ? 0 : 1
  }

  if (command === 'codegen') {
    if (!values.criteria) throw new Error('codegen needs --criteria <file> for the input values')
    const trace = JSON.parse(readFileSync(files[0], 'utf8')) as Trace
    console.log(writeSpec(trace, values.criteria, values.out))
    return 0
  }
  if (command !== 'explore') throw new Error(`Unknown command "${command}"`)

  const platform = values.platform
  if (platform !== 'android' && platform !== 'ios') throw new Error('--platform must be android or ios')
  if (!values.app) throw new Error('--app is required')

  const provider = new JevProvider()
  const server = new URL(values.server)
  let failures = 0

  for (const file of files) {
    const criterion = loadCriterion(file)
    console.log(`\n${criterion.id}: ${criterion.goal}`)

    // A fresh session per criterion, so each one starts from a clean app.
    const browser = await remote({
      hostname: server.hostname,
      port: Number(server.port) || 4723,
      path: server.pathname,
      protocol: server.protocol.replace(':', ''),
      logLevel: 'warn',
      connectionRetryTimeout: 600_000,
      capabilities: capabilities(platform, resolve(values.app), values.device, values['platform-version']),
    })

    let trace: Trace
    try {
      trace = await explore(webdriverDevice(browser), criterion, {
        provider,
        maxSteps: Number(values['max-steps']),
        minConfidence: Number(values['min-confidence']),
        goalThreshold: Number(values['goal-threshold']),
        onStep: printStep,
      })
    } finally {
      await browser.deleteSession()
    }

    mkdirSync(values.runs, { recursive: true })
    const tracePath = join(values.runs, `${criterion.id}.${platform}.${Date.now()}.json`)
    writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`)

    console.log(`  ${trace.outcome.toUpperCase()}: ${trace.reason}`)
    console.log(`  trace: ${tracePath}`)
    if (trace.outcome === 'passed') console.log(`  test:  ${writeSpec(trace, file, values.out)}`)
    else failures++
  }
  return failures === 0 ? 0 : 1
}

function writeSpec(trace: Trace, criteriaFile: string, outDir: string): string {
  mkdirSync(outDir, { recursive: true })
  const path = join(outDir, specFileName(trace))
  writeFileSync(path, generateSpec(trace, loadCriterion(criteriaFile)))
  return path
}

function capabilities(platform: Platform, app: string, device?: string, version?: string): WebdriverIO.Capabilities {
  const shared = {
    'appium:app': app,
    'appium:newCommandTimeout': 240,
    ...(version && { 'appium:platformVersion': version }),
  }
  return platform === 'android'
    ? {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        'appium:deviceName': device ?? 'Android Emulator',
        ...shared,
      }
    : {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:deviceName': device ?? 'iPhone 17',
        'appium:wdaLaunchTimeout': 240_000,
        ...shared,
      }
}

function printStep(step: Step): void {
  const { decision } = step
  const what = step.taken?.description ?? (decision.goalMet >= 0.5 ? 'goal check' : decision.action)
  const stats = `confidence ${decision.confidence.toFixed(2)}, goal ${decision.goalMet.toFixed(2)}, ${decision.latencyMs} ms`
  console.log(`  ${String(step.index).padStart(2)}. ${what}  (${stats})`)
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`jevvium: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  },
)
