#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { remote } from 'webdriverio'
import { generateSpec, safeId, specFileName } from './codegen.ts'
import { loadCriterion } from './criteria.ts'
import { simulatorDevice, webdriverDevice, type Device } from './device.ts'
import { explore, type Outcome, type Replay, type Step, type TakenAction, type Trace } from './explorer.ts'
import { ClaudeProvider } from './providers/claude.ts'
import { JevProvider } from './providers/jev.ts'
import type { DecisionProvider } from './providers/types.ts'
import { OpenAIDecisionsProvider } from './providers/openai.ts'
import { redactor } from './redact.ts'
import { replay } from './replay.ts'
import { stopReport } from './report.ts'
import type { TestSettings } from './wdio.conf.ts'
import { isAppiumUp, startAppium, type AppiumServer } from './appium.ts'
import { builtWebDriverAgent, defaultSimulator, findSimulator, hasWebDriverAgent, simulators, simulatorSet } from './simulators.ts'
import { checkSimulatorBuild, platformOf } from './app.ts'
import type { Criterion, Platform } from './types.ts'

const run = promisify(execFile)

const USAGE = `jevvium: turn acceptance criteria into Appium tests

Usage (npx jevvium in a project that installed it with npm i -D jevvium):
  jevvium explore <criteria.yml...> --app <path> [options]
  jevvium codegen <trace.json> --criteria <criteria.yml> [--out <dir>]
  jevvium validate <criteria.yml...>      check criteria files without a device or a key
  jevvium test [spec...] --app <path>     run the generated tests (default: every one in --out)
  jevvium init                            write a starter criterion, a .env for the key, .gitignore entries

Explore options:
  --app <path>               the app to test: an iOS Simulator build (.app, or an .ipa or .zip
                             holding one) or an Android .apk (required)
  --bundle-id <id>           instead of --app: an iOS app already installed on the simulator
  --platform <name>          android or ios (default: from the app)
  --device <name>            device name (default: "Android Emulator" or "iPhone 17")
  --platform-version <ver>   OS version of the emulator or simulator (default: Appium picks)
  --server <url>             an Appium server to use (default: jevvium starts its own)
  --runs <dir>               where traces go (default: runs)
  --out <dir>                where generated specs go (default: generated)
  --max-steps <n>            decisions that act before giving up (default: 15)
  --min-confidence <p>       below this, stop and escalate (default: 0.2)
  --goal-threshold <p>       "goal reached" probability that triggers the checks (default: 0.8)
  --input <auto|appium>      auto taps and types straight into an iOS Simulator, skipping XCTest,
                             and falls back to Appium elsewhere (default: auto)
  --provider <name>          the decision model: jev (TypeSafe's Jev), openai (OpenAI's
                             Decisions API, in limited preview) or claude (Claude through the
                             Claude Code CLI and its login, for comparisons) (default: jev)
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
  CLAUDE_MODEL               Claude Code model for --provider claude (default: sonnet)
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
      'bundle-id': { type: 'string' },
      device: { type: 'string' },
      'platform-version': { type: 'string' },
      server: { type: 'string' },
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

  if (values.help || !command || (files.length === 0 && command !== 'init' && command !== 'test')) {
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
  if (command === 'validate') {
    let invalid = 0
    for (const file of files) {
      try {
        const criterion = loadCriterion(file)
        const checks = criterion.expect.length
        const warning = checks === 0 ? "; it has no expect checks, so it would pass on the model's word" : ''
        console.log(`ok     ${file}: ${checks} ${checks === 1 ? 'check' : 'checks'}, ${Object.keys(criterion.inputs).length} inputs${warning}`)
      } catch (error) {
        invalid++
        console.log(`error  ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return invalid === 0 ? 0 : 1
  }
  if (command === 'init') return init()
  if (command !== 'explore' && command !== 'test') throw new Error(`Unknown command "${command}"`)

  // Everything is checked before an Appium session is started, since that can take minutes.
  if (values.app && values['bundle-id']) throw new Error('Use --app or --bundle-id, not both')
  if (!values.app && !values['bundle-id']) {
    throw new Error('--app <path> is required: the app to test (or --bundle-id <id> for an iOS app already installed on the simulator)')
  }
  const app = values.app === undefined ? undefined : resolve(values.app)
  if (app && !existsSync(app)) throw new Error(`--app: nothing at ${app}`)
  const platform = values.platform?.toLowerCase() ?? (app ? platformOf(app) : 'ios')
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error(values.platform ? '--platform must be android or ios' : `Can't tell the platform from ${values.app}; add --platform ios or --platform android`)
  }
  if (values['bundle-id'] && platform !== 'ios') throw new Error('--bundle-id is for iOS apps; for Android, pass the .apk with --app')
  if (app && platform === 'ios') await checkSimulatorBuild(app)
  if (values.input !== 'auto' && values.input !== 'appium') throw new Error('--input must be auto or appium')
  if (!['jev', 'openai', 'claude'].includes(values.provider)) throw new Error('--provider must be jev, openai or claude')
  const maxSteps = count('--max-steps', values['max-steps'])
  const minConfidence = probability('--min-confidence', values['min-confidence'])
  const goalThreshold = probability('--goal-threshold', values['goal-threshold'])
  const parallel = values.parallel === undefined ? 1 : count('--parallel', values.parallel)
  if (parallel > 1 && platform !== 'ios') throw new Error('--parallel only runs on iOS Simulators for now')
  const userServer = values.server === undefined ? undefined : serverAddress(values.server)
  const criteria: [string, Criterion][] = command === 'explore' ? files.map((file) => [file, loadCriterion(file)]) : []
  const simulator =
    platform !== 'ios'
      ? undefined
      : values.device
        ? await findSimulator(values.device, values['platform-version'])
        : defaultSimulator(await simulators(), values['platform-version'])
  const baseCapabilities = capabilities(
    platform,
    { app, bundleId: values['bundle-id'] },
    simulator?.name ?? values.device,
    simulator?.version ?? values['platform-version'],
    simulator?.udid,
  )
  if (command === 'test') {
    if (simulator) console.log(`Simulator: ${simulator.name}, iOS ${simulator.version}`)
    const given = values.server === undefined || !userServer ? undefined : { url: values.server, address: userServer }
    return runTests(files, values.out, platform, baseCapabilities, values.runs, given)
  }
  const provider: DecisionProvider =
    values.provider === 'openai' ? new OpenAIDecisionsProvider() : values.provider === 'claude' ? new ClaudeProvider() : new JevProvider()
  // A missing or refused key shows up now, rather than after a session has started.
  await provider.check?.()

  const openSession = (address: ServerAddress, caps: WebdriverIO.Capabilities) => async (out: Out) => {
    const settings = caps as Record<string, unknown>
    const udid = settings['appium:udid']
    if (typeof udid === 'string' && !settings['appium:prebuiltWDAPath'] && !(await hasWebDriverAgent(udid))) {
      out('(first session on this simulator: Appium builds WebDriverAgent with Xcode, which takes a few minutes, once)')
    }
    // WebdriverIO's own warnings are about requests it retried; jevvium reports what fails.
    const browser = await remote({ ...address, logLevel: 'error', connectionRetryTimeout: 600_000, capabilities: caps })
    let device: Device | undefined
    try {
      device = values.input === 'appium' || !browser.isIOS ? webdriverDevice(browser) : await directInput(browser, out)
      out(`(input: ${device.input === 'simulator' ? 'direct to the simulator' : 'through Appium'})`)
      return { browser, device, appId: await currentApp(browser) }
    } catch (error) {
      device?.close?.()
      await browser.deleteSession().catch(() => {})
      throw error
    }
  }

  const lanes: Lane[] = []
  const servers: AppiumServer[] = []
  /** The Appium server the first lane uses: the one --server names, once it answers, or one jevvium starts. */
  let server!: ServerAddress
  const appiumServer = async (): Promise<ServerAddress> => {
    if (userServer) {
      if (!(await isAppiumUp(values.server!))) {
        throw new Error(`No Appium server answers at ${values.server}. Leave out --server and jevvium starts its own.`)
      }
      return userServer
    }
    mkdirSync(values.runs, { recursive: true })
    const log = join(values.runs, 'appium.log')
    console.log(`Starting Appium (log: ${log})`)
    const own = await startAppium(log, (spawned) => servers.push(spawned))
    return { protocol: 'http', hostname: '127.0.0.1', port: own.port, path: '/' }
  }
  const shutDown = async () => {
    await Promise.all(lanes.map((lane) => lane.close()))
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
   * since one server starts one session at a time. The first uses the run's own server.
   */
  const parallelLanes = async (size: number): Promise<Lane[]> => {
    const base = simulator!
    // The lanes launch the WebDriverAgent Appium already built: several xcodebuild runs building
    // it at once get in each other's way.
    const builtAgent = builtWebDriverAgent()
    if (!builtAgent) {
      throw new Error('Run jevvium once without --parallel first, so Appium builds WebDriverAgent for the simulators to share')
    }
    mkdirSync(values.runs, { recursive: true })
    console.log(`Getting ${size} simulators ready (new ones are created and booted the first time)`)
    const [simulators, extra] = await Promise.all([
      simulatorSet(base, size),
      Promise.all(
        Array.from({ length: size - 1 }, (_, i) => startAppium(join(values.runs, `appium-${i + 2}.log`), (spawned) => servers.push(spawned))),
      ),
    ])
    return Promise.all(
      simulators.map(async (simulator, i) => {
        const installed = await hasWebDriverAgent(simulator.udid)
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
  const runOne = async (lane: Lane, criterion: Criterion, out: Out): Promise<Result> => {
    out(`\n${lanes.length > 1 ? `[${lane.name}] ` : ''}${criterion.id}: ${criterion.goal}`)
    let session: Session
    try {
      session = await lane.ready(values['fresh-session'], out)
    } catch (error) {
      if (stopping) return { outcome: 'interrupted' }
      await lane.drop()
      return { outcome: 'error', startFailed: firstLine(error) }
    }
    try {
      if (stopping) return { outcome: 'interrupted' }
      const trace = await explore(session.device, criterion, {
        provider,
        maxSteps,
        minConfidence,
        goalThreshold,
        onStep: (step) => printStep(step, out, goalThreshold),
      })
      if (stopping) return { outcome: 'interrupted' }
      if (trace.outcome === 'passed' && values.verify) {
        // Prove the test the way it will run: from a fresh start, with plain Appium commands.
        const started = Date.now()
        try {
          await restartApp(session)
          trace.replay = await replay(session.browser, trace, criterion)
        } catch (error) {
          // Only the restart throws here. The run it follows is still written down.
          const reason = redactor(criterion.inputs)(`Could not restart the app for the replay: ${firstLine(error)}`)
          trace.replay = { outcome: 'error', reason, durationMs: Date.now() - started }
        }
        if (stopping) return { outcome: 'interrupted' }
      }
      // Whatever broke may have taken the session with it; the next criterion starts a new one.
      const broken = trace.outcome === 'error' || trace.replay?.outcome === 'error'
      report(trace, criterion, out)
      if (broken) await lane.drop()
      return { outcome: trace.outcome, replay: trace.replay?.outcome }
    } catch (error) {
      if (stopping) return { outcome: 'interrupted' }
      out(`  ERROR: ${firstLine(error)}`)
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
    if (simulator) console.log(`Simulator: ${simulator.name}, iOS ${simulator.version}`)
    server = await appiumServer()
    lanes.push(...(size > 1 ? await parallelLanes(size) : [new Lane('', openSession(server, baseCapabilities))]))
    const queue = [...criteria]
    await Promise.all(
      lanes.map(async (lane) => {
        for (let next = queue.shift(); next && !stopping; next = queue.shift()) {
          // Side by side, each criterion's lines are printed together when it finishes.
          const lines: string[] = []
          const out: Out = lanes.length > 1 ? (line) => lines.push(line) : (line) => console.log(line)
          const [file, criterion] = next
          const result = await runOne(lane, criterion, out)
          if (result.startFailed !== undefined) {
            // A lane that can't start a session hands its criteria to the lanes that can.
            if (lanes.some((other) => other !== lane && other.working)) {
              queue.unshift(next)
              console.log(`\n[${lane.name}] could not start a session, so the other simulators take its criteria: ${result.startFailed}`)
              break
            }
            out(`  ERROR: ${result.startFailed} (${file})`)
          }
          results.push(result)
          if (lines.length > 0 && !stopping) console.log(lines.join('\n'))
        }
        lane.working = false
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
    const replayed = trace.replay
    if (replayed?.outcome === 'error') out(`  the replay with plain Appium could not run: ${replayed.reason}`)
    else if (replayed) {
      const verdict = replayed.outcome === 'passed' ? 'passed' : `FAILED: ${replayed.reason}`
      out(`  replayed with plain Appium in ${(replayed.durationMs / 1000).toFixed(1)}s: ${verdict}`)
    }
    for (const line of stopReport(trace)) out(`  ${line}`)
    out(`  trace: ${tracePath}`)
    if (trace.outcome !== 'passed') return
    try {
      out(`  test:  ${writeSpec(trace, criterion, values.out)}`)
    } catch (error) {
      out(`  test:  not written: ${firstLine(error)}`)
    }
  }
}

/** A first criterion to edit, with what each part is for. */
const STARTER = `# A jevvium criterion: what a user does, the test data they type, and what the screen
# shows when it worked. jevvium explores your app to find the path, then writes it down
# as a plain WebdriverIO test.
#
#   check it, without a device:  npx jevvium validate criteria/example.yml
#   explore it:                  npx jevvium explore criteria/example.yml --app path/to/YourApp.app

# Where the feature is and what the user does, written like an acceptance criterion.
goal: On the Login screen, a registered user logs in with their email and password and is told they are logged in.

# Test data the user types, by name. The model sees only the names, so name each for its
# role (wrong_password, not password2). Use made-up data: the values end up in the test.
inputs:
  email: qa.demo@example.com
  password: Str0ngPassw0rd

# What must be true at the end, checked without any model: an accessibility \`id\`, or a
# \`text\` that matches an element's whole text, capitals and punctuation included.
expect:
  - text: You are logged in!
`

/** Writes what a project needs to start: a criterion to edit, a .env for the key, and .gitignore entries. */
function init(): number {
  const created: string[] = []
  const starter = join('criteria', 'example.yml')
  if (!existsSync(starter)) {
    mkdirSync('criteria', { recursive: true })
    writeFileSync(starter, STARTER)
    created.push(starter)
  }
  if (!existsSync('.env')) {
    writeFileSync('.env', '# Your Jev key, from console.typesafe.ai\nTYPESAFE_API_KEY=\n')
    created.push('.env')
  }
  // The key, run logs and failure screenshots can hold secrets or test data; the generated tests are meant to be committed.
  const ignored = existsSync('.gitignore') ? readFileSync('.gitignore', 'utf8') : ''
  const missing = ['.env', 'runs/', 'screenshots/'].filter((entry) => !ignored.split('\n').some((line) => line.trim() === entry))
  if (missing.length > 0) {
    const separator = ignored && !ignored.endsWith('\n') ? '\n' : ''
    writeFileSync('.gitignore', `${ignored}${separator}${missing.join('\n')}\n`)
    created.push(`.gitignore entries for ${missing.join(', ')}`)
  }
  console.log(created.length > 0 ? `Created ${created.join(', ')}.` : 'Nothing to create: the starter criterion, .env and .gitignore entries are there.')
  console.log(`
Next:
  1. Put your Jev key in .env (TYPESAFE_API_KEY=..., from console.typesafe.ai).
  2. Edit ${starter} to describe a flow in your app.
  3. npx jevvium explore ${starter} --app path/to/YourApp.app
  4. npx jevvium test --app path/to/YourApp.app`)
  return 0
}

/** Runs generated tests with WebdriverIO, on jevvium's own Appium server unless --server names one. */
async function runTests(
  specArgs: string[],
  outDir: string,
  platform: Platform,
  caps: WebdriverIO.Capabilities,
  runsDir: string,
  given: { url: string; address: ServerAddress } | undefined,
): Promise<number> {
  const specs =
    specArgs.length > 0
      ? specArgs.map((file) => resolve(file))
      : existsSync(outDir)
        ? readdirSync(outDir)
            .filter((file) => file.endsWith(`.${platform}.spec.ts`))
            .map((file) => resolve(outDir, file))
        : []
  if (specs.length === 0) {
    throw new Error(`No generated ${platform} tests in ${outDir}. Explore a criterion first: jevvium explore <criteria.yml> --app <path>`)
  }
  for (const spec of specs) {
    if (!existsSync(spec)) throw new Error(`No test at ${spec}`)
    // Generated tests import @wdio/globals, which Node looks for from the test's own folder up.
    try {
      createRequire(spec).resolve('@wdio/globals')
    } catch {
      throw new Error(`${spec} can't find @wdio/globals. Install jevvium in the project the tests are in: npm i -D jevvium`)
    }
  }

  let own: AppiumServer | undefined
  let address: ServerAddress
  if (given) {
    if (!(await isAppiumUp(given.url))) throw new Error(`No Appium server answers at ${given.url}. Leave out --server and jevvium starts its own.`)
    address = given.address
  } else {
    mkdirSync(runsDir, { recursive: true })
    const log = join(runsDir, 'appium.log')
    console.log(`Starting Appium (log: ${log})`)
    own = await startAppium(log)
    address = { protocol: 'http', hostname: '127.0.0.1', port: own.port, path: '/' }
  }
  try {
    const settings: TestSettings = { specs, ...address, capabilities: caps, screenshots: resolve('screenshots') }
    process.env.JEVVIUM_WDIO = JSON.stringify(settings)
    const { Launcher } = await import('@wdio/cli')
    // The config sits next to this file: wdio.conf.ts when run from source, wdio.conf.js once built.
    const config = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './wdio.conf.ts' : './wdio.conf.js', import.meta.url))
    return (await new Launcher(config).run()) ?? 1
  } finally {
    own?.stop()
  }
}

type Out = (line: string) => void
type ServerAddress = ReturnType<typeof serverAddress>
type Result = { outcome: Outcome | 'interrupted'; replay?: Replay['outcome']; startFailed?: string }

function succeeded({ outcome, replay }: Result): boolean {
  return outcome === 'passed' && (replay === undefined || replay === 'passed')
}

/** "5 criteria in 21.4 s on 3 simulators: 3 passed, 1 failed its replay, 1 stuck" */
function summary(results: Result[], durationMs: number, simulators: number): string {
  const counts = new Map<string, number>()
  for (const result of results) {
    const label =
      result.outcome !== 'passed' || result.replay === undefined || result.replay === 'passed'
        ? result.outcome
        : result.replay === 'failed'
          ? 'failed its replay'
          : 'could not be replayed'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const where = simulators > 1 ? ` on ${simulators} simulators` : ''
  const parts = [...counts].map(([label, n]) => `${n} ${label}`).join(', ')
  return `${results.length} ${results.length === 1 ? 'criterion' : 'criteria'} in ${(durationMs / 1000).toFixed(1)} s${where}: ${parts}`
}

/** One device and the Appium server that drives it. Its criteria run one after another. */
class Lane {
  readonly name: string
  /** False once it has taken its last criterion or can't start a session. */
  working = true
  private readonly open: (out: Out) => Promise<Session>
  private session?: Session
  private opening?: Promise<Session>
  private closed = false

  constructor(name: string, open: (out: Out) => Promise<Session>) {
    this.name = name
    this.open = open
  }

  /** The session, with the app on its first screen: restarted, or started when there is none. */
  async ready(fresh: boolean, out: Out): Promise<Session> {
    if (this.session && fresh) await this.drop()
    if (this.session) {
      try {
        await restartApp(this.session)
        return this.session
      } catch {
        // The session may have died with its WebDriverAgent; a new one is started instead.
        await this.drop()
      }
    }
    if (this.closed) throw new Error('The run is stopping')
    this.opening = this.open(out)
    try {
      this.session = await this.opening
    } finally {
      this.opening = undefined
    }
    return this.session
  }

  /** Ends the session for good: nothing new starts on this lane afterwards. */
  async close(): Promise<void> {
    this.closed = true
    this.working = false
    await this.drop()
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

function capabilities(
  platform: Platform,
  target: { app?: string; bundleId?: string },
  device?: string,
  version?: string,
  udid?: string,
): WebdriverIO.Capabilities {
  const shared = {
    ...(target.app && { 'appium:app': target.app }),
    ...(target.bundleId && { 'appium:bundleId': target.bundleId }),
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
        ...(udid && { 'appium:udid': udid }),
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
  if ((protocol !== 'http' && protocol !== 'https') || url.hostname === '') {
    throw new Error(`--server must be a URL like http://127.0.0.1:4723, not "${value}"`)
  }
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
function printStep(step: Step, out: Out, goalThreshold: number): void {
  const { decision } = step
  const reached = !step.taken?.length && decision.goalMet >= goalThreshold
  const stats = `${reached ? `goal ${decision.goalMet.toFixed(2)}` : decision.confidence.toFixed(2)} · ${decision.latencyMs} ms`
  const lines = step.taken?.length
    ? step.taken.map(describeTaken)
    : [reached ? 'goal reached' : decision.action === 'STUCK' ? 'no way forward' : 'unsure']
  lines.forEach((line, i) => {
    const prefix = i === 0 ? String(step.index).padStart(4) : '    '
    out(`${prefix}  ${i === 0 ? line.padEnd(40) + stats : line}`)
  })
  for (const note of step.notes ?? []) out(`      (${note})`)
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
