import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { remote } from 'webdriverio'
import { generateSpec, safeId, specFileName } from './codegen.ts'
import { loadCriterion } from './criteria.ts'
import { simulatorDevice, webdriverDevice, type Device } from './device.ts'
import { explore, type Outcome, type Step, type TakenAction, type Trace } from './explorer.ts'
import { JevProvider } from './providers/jev.ts'
import { OpenAIDecisionsProvider } from './providers/openai.ts'
import { redactor } from './redact.ts'
import { replay } from './replay.ts'
import { builtWebDriverAgent, findSimulator, hasWebDriverAgent, simulatorSet, startAppium, type AppiumServer } from './simulators.ts'
import type { Criterion, Platform } from './types.ts'

const run = promisify(execFile)

const USAGE = `jevvium: turn acceptance criteria into Appium tests

Usage (from the jevvium folder):
  npm run jevvium -- explore <criteria.yml...> --platform <android|ios> --app <path> [options]
  npm run jevvium -- codegen <trace.json> --criteria <criteria.yml> [--out <dir>]

Explore options:
  --platform <name>          android or ios (required)
  --app <path>               .apk or .app to install (required)
  --device <name>            device name (default: "Android Emulator" or "iPhone 17")
  --platform-version <ver>   OS version of the emulator or simulator (default: Appium picks)
  --server <url>             a local Appium server (default: http://127.0.0.1:4723)
  --runs <dir>               where traces go (default: runs)
  --out <dir>                where generated specs go (default: generated)
  --max-steps <n>            decisions that act before giving up (default: 15)
  --min-confidence <p>       below this, stop and escalate (default: 0.2)
  --goal-threshold <p>       "goal reached" probability that triggers the checks (default: 0.8)
  --input <auto|appium>      auto taps and types straight into an iOS Simulator, skipping XCTest,
                             and falls back to Appium elsewhere (default: auto)
  --provider <jev|openai>    the decision model: TypeSafe's Jev, or OpenAI's Decisions API
                             (in limited preview) (default: jev)
  --fresh-session            start a new Appium session for every criterion instead of
                             restarting the app (slower, fully isolated)
  --parallel <n>             explore up to n criteria at once, each on its own iOS Simulator
                             with its own Appium server (simulators "jevvium 2" and on are
                             created the first time and kept)
  --no-verify                don't replay a passing run with plain Appium before writing its
                             test (faster, but the test isn't proven to pass on its own)

Environment (read from .env if present):
  TYPESAFE_API_KEY           key for the Jev decision model
  TYPESAFE_API_URL           another endpoint that serves TypeSafe's API (optional)
  JEVVIUM_MODEL              Jev model name (default: jev-latest)
  OPENAI_API_KEY             key for --provider openai
  OPENAI_DECISIONS_MODEL     OpenAI model name (default: gpt-6-luna)
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
      'min-confidence': { type: 'string', default: '0.2' },
      'goal-threshold': { type: 'string', default: '0.8' },
      criteria: { type: 'string' },
      input: { type: 'string', default: 'auto' },
      provider: { type: 'string', default: 'jev' },
      'fresh-session': { type: 'boolean', default: false },
      parallel: { type: 'string' },
      verify: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h' },
    },
    allowNegative: true,
  })
  const [command, ...files] = positionals

  if (values.help || !command || files.length === 0) {
    console.log(USAGE)
    return values.help ? 0 : 1
  }

  if (command === 'codegen') {
    if (files.length !== 1) throw new Error('codegen takes exactly one trace file')
    if (!values.criteria) throw new Error('codegen needs --criteria <file> for the input values')
    const trace = JSON.parse(readFileSync(files[0], 'utf8')) as Trace
    console.log(writeSpec(trace, loadCriterion(values.criteria), values.out))
    return 0
  }
  if (command !== 'explore') throw new Error(`Unknown command "${command}"`)

  // Everything is checked before an Appium session is started, since that can take minutes.
  const platform = values.platform
  if (platform !== 'android' && platform !== 'ios') throw new Error('--platform must be android or ios')
  if (!values.app) throw new Error('--app is required')
  if (values.input !== 'auto' && values.input !== 'appium') throw new Error('--input must be auto or appium')
  if (values.provider !== 'jev' && values.provider !== 'openai') throw new Error('--provider must be jev or openai')
  const maxSteps = count('--max-steps', values['max-steps'])
  const minConfidence = probability('--min-confidence', values['min-confidence'])
  const goalThreshold = probability('--goal-threshold', values['goal-threshold'])
  const parallel = values.parallel === undefined ? 1 : count('--parallel', values.parallel)
  if (parallel > 1 && platform !== 'ios') throw new Error('--parallel only runs on iOS Simulators for now')
  const server = serverAddress(values.server)
  const criteria: [string, Criterion][] = files.map((file) => [file, loadCriterion(file)])
  const app = resolve(values.app)
  const provider = values.provider === 'openai' ? new OpenAIDecisionsProvider() : new JevProvider()
  const baseCapabilities = capabilities(platform, app, values.device, values['platform-version'])

  const openSession = (address: ServerAddress, caps: WebdriverIO.Capabilities) => async (out: Out) => {
    const browser = await remote({ ...address, logLevel: 'warn', connectionRetryTimeout: 600_000, capabilities: caps })
    try {
      const device = values.input === 'appium' || !browser.isIOS ? webdriverDevice(browser) : await directInput(browser, out)
      out(`(input: ${device.input === 'simulator' ? 'direct to the simulator' : 'through Appium'})`)
      return { browser, device, appId: await currentApp(browser) }
    } catch (error) {
      await browser.deleteSession().catch(() => {})
      throw error
    }
  }

  const lanes: Lane[] = []
  const servers: AppiumServer[] = []
  const shutDown = async () => {
    await Promise.all(lanes.map((lane) => lane.drop()))
    for (const started of servers) started.stop()
  }

  // Ctrl+C closes the sessions, including ones being created, instead of leaving them
  // holding devices, and nothing new starts meanwhile. npm and tsx pass the signal on too,
  // so repeats within a second are ignored; pressing it again after that quits at once.
  let stopping: { signal: NodeJS.Signals; at: number; done: Promise<void> } | undefined
  const interrupt = (signal: NodeJS.Signals) => {
    if (stopping) {
      if (Date.now() - stopping.at > 1_000) process.exit(exitCode(signal))
      return
    }
    console.log('\nStopping: closing the Appium sessions (Ctrl+C again quits at once).')
    const done = shutDown()
    stopping = { signal, at: Date.now(), done }
    void done.finally(() => process.exit(exitCode(signal)))
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)

  /**
   * Simulators for running criteria side by side, each with its own Appium server,
   * since one server starts one session at a time. The first uses --server.
   */
  const parallelLanes = async (size: number): Promise<Lane[]> => {
    const base = await findSimulator(values.device ?? 'iPhone 17', values['platform-version'])
    mkdirSync(values.runs, { recursive: true })
    console.log(`Getting ${size} simulators ready (new ones are created and booted the first time)`)
    const [simulators, extra] = await Promise.all([
      simulatorSet(base, size),
      Promise.all(
        Array.from({ length: size - 1 }, (_, i) =>
          startAppium(join(values.runs, `appium-${i + 2}.log`)).then((started) => (servers.push(started), started)),
        ),
      ),
    ])
    const builtAgent = builtWebDriverAgent()
    return Promise.all(
      simulators.map(async (simulator, i) => {
        const installed = await hasWebDriverAgent(simulator.udid)
        // Several xcodebuild runs building WebDriverAgent at once get in each other's way.
        if (!installed && !builtAgent) {
          throw new Error('Run jevvium once without --parallel first, so Appium builds WebDriverAgent for the simulators to share')
        }
        const caps = {
          ...baseCapabilities,
          'appium:udid': simulator.udid,
          'appium:wdaLocalPort': 8100 + i,
          'appium:mjpegServerPort': 9100 + i,
          // Launching an installed WebDriverAgent skips an xcodebuild run for every session.
          'appium:usePreinstalledWDA': true,
          ...(!installed && { 'appium:prebuiltWDAPath': builtAgent }),
        }
        const address = i === 0 ? server : { protocol: 'http', hostname: '127.0.0.1', port: extra[i - 1].port, path: '/' }
        return new Lane(simulator.name, openSession(address, caps))
      }),
    )
  }

  /** Explores one criterion on a lane, replays a pass and writes the results. */
  const runOne = async (lane: Lane, file: string, criterion: Criterion, out: Out): Promise<Result> => {
    out(`\n${parallel > 1 ? `[${lane.name}] ` : ''}${criterion.id}: ${criterion.goal}`)
    try {
      const session = await lane.ready(values['fresh-session'], out)
      if (stopping) return { outcome: 'interrupted' }
      const trace = await explore(session.device, criterion, {
        provider,
        maxSteps,
        minConfidence,
        goalThreshold,
        onStep: (step) => printStep(step, out),
      })
      if (stopping) return { outcome: 'interrupted' }
      // Whatever broke may have taken the session with it; the next criterion starts a new one.
      let broken = trace.outcome === 'error'
      if (trace.outcome === 'passed' && values.verify) {
        // Prove the test the way it will run: from a fresh start, with plain Appium commands.
        const started = Date.now()
        try {
          await restartApp(session)
          trace.replay = await replay(session.browser, trace, criterion)
        } catch (error) {
          // Only the restart throws here. The run it follows is still written down.
          const reason = redactor(criterion.inputs)(`Could not restart the app for the replay: ${firstLine(error)}`)
          trace.replay = { outcome: 'failed', reason, durationMs: Date.now() - started }
          broken = true
        }
        if (stopping) return { outcome: 'interrupted' }
      }
      report(trace, criterion, out)
      if (broken) await lane.drop()
      return { outcome: trace.outcome, replay: trace.replay?.outcome }
    } catch (error) {
      if (stopping) return { outcome: 'interrupted' }
      out(`  ERROR: ${firstLine(error)} (${file})`)
      await lane.drop()
      return { outcome: 'error' }
    }
  }

  // Each lane keeps one session for its criteria and restarts the app between them: a new
  // Appium session costs several seconds. --fresh-session trades that for isolation.
  const started = Date.now()
  const results: Result[] = []
  try {
    const size = Math.min(parallel, criteria.length)
    lanes.push(...(size > 1 ? await parallelLanes(size) : [new Lane('', openSession(server, baseCapabilities))]))
    const queue = [...criteria]
    await Promise.all(
      lanes.map(async (lane) => {
        for (let next = queue.shift(); next && !stopping; next = queue.shift()) {
          // Side by side, each criterion's lines are printed together when it finishes.
          const lines: string[] = []
          const out: Out = lanes.length > 1 ? (line) => lines.push(line) : (line) => console.log(line)
          results.push(await runOne(lane, ...next, out))
          if (lines.length > 0 && !stopping) console.log(lines.join('\n'))
        }
      }),
    )
  } finally {
    if (!stopping) await shutDown()
  }
  if (stopping) {
    await stopping.done
    return exitCode(stopping.signal)
  }
  console.log(`\n${summary(results, Date.now() - started, lanes.length)}`)
  return results.every(succeeded) ? 0 : 1

  /** Writes the trace and, for a pass, the spec. */
  function report(trace: Trace, criterion: Criterion, out: Out): void {
    mkdirSync(values.runs, { recursive: true })
    const tracePath = join(values.runs, `${safeId(trace.criterion.id)}.${trace.platform}.${Date.now()}.json`)
    writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`)

    out(`  ${trace.outcome.toUpperCase()} in ${(trace.durationMs / 1000).toFixed(1)}s: ${trace.reason}`)
    if (trace.replay) {
      const { outcome, durationMs, reason } = trace.replay
      const verdict = outcome === 'passed' ? 'passed' : `FAILED: ${reason}`
      out(`  replayed with plain Appium in ${(durationMs / 1000).toFixed(1)}s: ${verdict}`)
    }
    out(`  trace: ${tracePath}`)
    if (trace.outcome === 'passed') out(`  test:  ${writeSpec(trace, criterion, values.out)}`)
  }
}

type Out = (line: string) => void
type ServerAddress = ReturnType<typeof serverAddress>
type Result = { outcome: Outcome | 'interrupted'; replay?: 'passed' | 'failed' }

function succeeded({ outcome, replay }: Result): boolean {
  return outcome === 'passed' && replay !== 'failed'
}

/** "5 criteria in 21.4 s on 3 simulators: 3 passed, 1 failed its replay, 1 stuck" */
function summary(results: Result[], durationMs: number, simulators: number): string {
  const counts = new Map<string, number>()
  for (const result of results) {
    const label = result.outcome === 'passed' && result.replay === 'failed' ? 'failed its replay' : result.outcome
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const where = simulators > 1 ? ` on ${simulators} simulators` : ''
  const parts = [...counts].map(([label, n]) => `${n} ${label}`).join(', ')
  return `${results.length} ${results.length === 1 ? 'criterion' : 'criteria'} in ${(durationMs / 1000).toFixed(1)} s${where}: ${parts}`
}

/** One device and the Appium server that drives it. Its criteria run one after another. */
class Lane {
  readonly name: string
  private readonly open: (out: Out) => Promise<Session>
  private session?: Session
  private opening?: Promise<Session>

  constructor(name: string, open: (out: Out) => Promise<Session>) {
    this.name = name
    this.open = open
  }

  /** The session, with the app on its first screen: started, or restarted. */
  async ready(fresh: boolean, out: Out): Promise<Session> {
    if (this.session && fresh) await this.drop()
    if (this.session) {
      await restartApp(this.session)
      return this.session
    }
    this.opening = this.open(out)
    try {
      this.session = await this.opening
    } finally {
      this.opening = undefined
    }
    return this.session
  }

  /** Ends the session, or the one being started. */
  async drop(): Promise<void> {
    const current = this.session ?? this.opening
    this.session = undefined
    const session = await Promise.resolve(current).catch(() => undefined)
    if (session) await close(session).catch(() => {})
  }
}

type Session = { browser: WebdriverIO.Browser; device: Device; appId: string }

function exitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]
}

async function close({ browser, device }: Session): Promise<void> {
  device.close?.()
  await browser.deleteSession()
}

async function currentApp(browser: WebdriverIO.Browser): Promise<string> {
  if (browser.isAndroid) return browser.getCurrentPackage()
  return ((await browser.execute('mobile: activeAppInfo')) as { bundleId: string }).bundleId
}

/** Restarts the app so the next criterion starts from its first screen. */
async function restartApp({ browser, device, appId }: Session): Promise<void> {
  const udid = (browser.capabilities as { udid?: string }).udid
  if (device.input === 'simulator' && udid) {
    // simctl is about twice as fast as going through Appium, and copes with an app that isn't running.
    await run('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, appId])
  } else {
    await browser.terminateApp(appId)
    await browser.activateApp(appId)
  }
  await waitForLaunch(device)
}

/** Waits until the relaunched app shows a screen that has stopped changing. */
async function waitForLaunch(device: Device, timeoutMs = 20_000): Promise<void> {
  const read = () => (device.fingerprint ? device.fingerprint() : device.pageSource())
  const deadline = Date.now() + timeoutMs
  let previous = await read()
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const current = await read()
    const hasContent = /<XCUIElementType(StaticText|Button)\b|<android\.widget\.(TextView|Button)\b/.test(current)
    if (current === previous && hasContent) return
    previous = current
  }
}

/** The simulator helper for input when it can start, Appium otherwise. */
async function directInput(browser: WebdriverIO.Browser, out: Out): Promise<Device> {
  try {
    return await simulatorDevice(browser)
  } catch (error) {
    out(`  (${firstLine(error)}; using Appium for input)`)
    return webdriverDevice(browser)
  }
}

function writeSpec(trace: Trace, criterion: Criterion, outDir: string): string {
  mkdirSync(outDir, { recursive: true })
  const path = join(outDir, specFileName(trace))
  writeFileSync(path, generateSpec(trace, criterion))
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
        // jevvium never reads the simulator's system log, and capturing it slows the session down.
        'appium:skipLogCapture': true,
        ...shared,
      }
}

function serverAddress(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`--server must be a URL like http://127.0.0.1:4723, not "${value}"`)
  }
  const protocol = url.protocol.replace(':', '')
  return {
    protocol,
    hostname: url.hostname,
    port: Number(url.port) || (protocol === 'https' ? 443 : 80),
    path: url.pathname,
  }
}

function count(flag: string, value: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} must be a whole number of 1 or more, not "${value}"`)
  return number
}

function probability(flag: string, value: string): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${flag} must be a number from 0 to 1 (with a decimal point), not "${value}"`)
  }
  return number
}

/** One line per step: what it did, then the model's confidence and how long it took to answer. */
function printStep(step: Step, out: Out): void {
  const { decision } = step
  const reached = !step.taken?.length && decision.goalMet >= 0.5
  const stats = `${reached ? `goal ${decision.goalMet.toFixed(2)}` : decision.confidence.toFixed(2)} · ${decision.latencyMs} ms`
  const lines = step.taken?.length
    ? step.taken.map(describeTaken)
    : [reached ? 'goal reached' : decision.action === 'STUCK' ? 'no way forward' : 'unsure']
  lines.forEach((line, i) => {
    const prefix = i === 0 ? String(step.index).padStart(4) : '    '
    out(`${prefix}  ${i === 0 ? line.padEnd(40) + stats : line}`)
  })
}

function describeTaken(taken: TakenAction): string {
  if (taken.type === 'type') return `type ${taken.input} → "${taken.target}"`
  if (taken.kind === 'key') return `press "${taken.target}"`
  return `${taken.kind === 'switch' ? 'toggle' : 'tap'} "${taken.target}"`
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`jevvium: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  },
)
