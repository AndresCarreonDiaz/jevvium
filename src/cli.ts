#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { remote } from 'webdriverio'
import { generateSpec, safeId, specFileName } from './codegen.ts'
import { loadCriterion } from './criteria.ts'
import { STARTER_PLAN } from './plan.ts'
import { simulatorDevice, webdriverDevice, type Device } from './device.ts'
import { explore, type Outcome, type Replay, type Step, type TakenAction, type Trace } from './explorer.ts'
import { ClaudeProvider } from './providers/claude.ts'
import { JevProvider } from './providers/jev.ts'
import type { DecisionProvider } from './providers/types.ts'
import { OpenAIDecisionsProvider } from './providers/openai.ts'
import { redactor } from './redact.ts'
import { replay } from './replay.ts'
import { stopReport } from './report.ts'
import { lookSummary, runReport } from './run-report.ts'
import type { TestSettings } from './wdio.conf.ts'
import { hasDriver, isAppiumUp, startAppium, type AppiumServer } from './appium.ts'
import { builtWebDriverAgent, defaultSimulator, findSimulator, hasWebDriverAgent, simulators, simulatorSet } from './simulators.ts'
import { checkSimulatorBuild, platformOf } from './app.ts'
import type { Criterion, Platform } from './types.ts'

const run = promisify(execFile)

const USAGE = `jevvium: turn test plans written in plain words into Appium tests

Usage (npx jevvium in a project that installed it with npm i -D jevvium):
  jevvium explore <plan.md...> --app <path> [options]
  jevvium codegen <trace.json> --criteria <plan.md> [--out <dir>]
  jevvium validate <plan.md...>           check test plans without a device or a key
  jevvium test [spec...] --app <path>     run the generated tests (default: every one in --out)
  jevvium init                            write a starter test plan, a .env.jevvium for the key, .gitignore entries

A test plan is a Markdown file: a title, numbered steps, and "Expected:" checks. A YAML
criteria file (goal, steps, inputs, expect) is accepted too.

Explore options:
  --app <path>               the app to test: an iOS Simulator build (.app, or an .ipa or .zip
                             holding one) or an Android .apk (required)
  --bundle-id <id>           instead of --app: an iOS app already installed on the simulator
  --platform <name>          android or ios (default: from the app)
  --device <name>            simulator or emulator name (default on iOS: the plain iPhone with
                             the highest number, on the newest runtime; on Android: the emulator)
  --platform-version <ver>   OS version of the simulator or emulator (default: the newest)
  --server <url>             an Appium server to use (default: jevvium starts its own)
  --runs <dir>               where traces go (default: runs)
  --out <dir>                where generated specs go (default: generated)
  --max-steps <n>            decisions that act before giving up (default: 15)
  --min-confidence <p>       below this, stop and escalate (default: 0.2)
  --goal-threshold <p>       "goal reached" probability that triggers the checks (default: 0.8)
  --max-backtracks <n>       times a run may restart the app and try the model's runner-up at
                             the decision that led to a dead end (default: 2; 0 turns it off)
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
  --vision                   let the model look at the screen where the page source isn't
                             enough, the steps where its answer from text alone would end the
                             run: a masked screenshot (typed text, test data and the keyboard
                             painted grey) goes to TypeSafe with that step's request (Jev and
                             iOS only; off by default)
  --vision=always            look at every step, for plans that need what only the screen shows
                             (prices, colours, icons without labels): a second request per step,
                             with the screenshot, about twice the input tokens
  --screenshots <steps|off>  keep each step's masked screenshot in the run folder, for the run
                             report (default: steps; iOS only). Without --vision they stay on the
                             machine; with it, those of the steps where the model looks are sent

Environment (also read from .env.jevvium and then .env, if present):
  TYPESAFE_API_KEY           key for the Jev decision model
  TYPESAFE_API_URL           another endpoint that serves TypeSafe's API (optional)
  JEVVIUM_MODEL              Jev model that decides (default: jev-1.13.0)
  JEVVIUM_VISION_MODEL       Jev model that looks at screenshots, with --vision (default: jev-1.14.0)
  OPENAI_API_KEY             key for --provider openai
  OPENAI_DECISIONS_MODEL     OpenAI model name (default: gpt-6-luna)
  CLAUDE_MODEL               Claude Code model for --provider claude (default: sonnet)
`

async function main(): Promise<number> {
  // jevvium's own file first: a project's .env may be committed, or built into the app. A file
  // never overrides a variable that is already set, so the shell wins over both.
  for (const file of ['.env.jevvium', '.env']) {
    try {
      process.loadEnvFile(file)
    } catch {
      // No such file; the environment may already have the key.
    }
  }

  const { positionals, values } = parseArgs({
    // --vision takes an optional value, which parseArgs can't express: a bare one means auto.
    args: process.argv.slice(2).map((arg) => (arg === '--vision' ? '--vision=auto' : arg)),
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
      'max-backtracks': { type: 'string', default: '2' },
      criteria: { type: 'string' },
      input: { type: 'string', default: 'auto' },
      provider: { type: 'string', default: 'jev' },
      'fresh-session': { type: 'boolean', default: false },
      parallel: { type: 'string' },
      verify: { type: 'boolean', default: true },
      // A bare --vision is --vision=auto (see below).
      vision: { type: 'string' },
      screenshots: { type: 'string', default: 'steps' },
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
        const inputs = Object.keys(criterion.inputs).length
        const steps = criterion.steps?.length ? `${criterion.steps.length} ${criterion.steps.length === 1 ? 'step' : 'steps'}, ` : ''
        console.log(`ok     ${file}: ${steps}${checks} ${checks === 1 ? 'check' : 'checks'}, ${inputs} ${inputs === 1 ? 'input' : 'inputs'}${warning}`)
        for (const [name, value] of Object.entries(criterion.inputs)) console.log(`         ${name}: ${value}`)
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
  if (platform === 'android' && values.server === undefined && !hasDriver('appium-uiautomator2-driver')) {
    throw new Error("Android needs Appium's UiAutomator2 driver next to jevvium: npm i -D appium-uiautomator2-driver")
  }
  if (app && platform === 'ios') await checkSimulatorBuild(app)
  if (values.input !== 'auto' && values.input !== 'appium') throw new Error('--input must be auto or appium')
  if (!['jev', 'openai', 'claude'].includes(values.provider)) throw new Error('--provider must be jev, openai or claude')
  if (values.screenshots !== 'steps' && values.screenshots !== 'off') throw new Error('--screenshots must be steps or off')
  if (values.vision !== undefined && values.vision !== 'auto' && values.vision !== 'always') {
    throw new Error(`--vision is on its own (looking where the page source isn't enough) or --vision=always, not --vision=${values.vision}`)
  }
  const vision = values.vision === 'always' ? ('always' as const) : values.vision === 'auto'
  if (vision && values.provider !== 'jev') throw new Error('--vision works with --provider jev only: it needs a model that takes screenshots and box questions')
  if (vision && platform !== 'ios') throw new Error("--vision works on iOS only for now: an Android page source doesn't show the keyboard, so it can't be painted over")
  const maxSteps = count('--max-steps', values['max-steps'])
  const minConfidence = probability('--min-confidence', values['min-confidence'])
  const goalThreshold = probability('--goal-threshold', values['goal-threshold'])
  const maxBacktracks = values['max-backtracks'] === '0' ? 0 : count('--max-backtracks', values['max-backtracks'])
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
  await provider.check?.({ vision: Boolean(vision) })
  if (vision) {
    const when = vision === 'always' ? 'At every step' : "Where the page source isn't enough"
    console.log(`Vision: on. ${when}, a masked screenshot of the screen goes to TypeSafe (${provider.visionModel}) with the request.`)
  }
  if (platform !== 'ios' && values.screenshots === 'steps') console.log('(screenshots: kept on iOS only for now)')

  // How long the sessions took to start, which the summary shows apart from the criteria.
  let sessionMs = 0
  const openSession = (address: ServerAddress, caps: WebdriverIO.Capabilities) => async (out: Out) => {
    const settings = caps as Record<string, unknown>
    const udid = settings['appium:udid']
    // Appium builds WebDriverAgent with Xcode when it has none for this driver, which can't be
    // told from here: the first session on a simulator, and the first after a driver update.
    const first = typeof udid === 'string' && !settings['appium:prebuiltWDAPath'] && !(await hasWebDriverAgent(udid))
    out(`Starting the Appium session (${first ? 'the first on this simulator' : 'a first session on a simulator'} builds WebDriverAgent with Xcode: a minute or a few)`)
    const started = Date.now()
    // WebdriverIO's own warnings are about requests it retried; jevvium reports what fails.
    const browser = await remote({ ...address, logLevel: 'error', connectionRetryTimeout: 600_000, capabilities: caps })
    sessionMs += Date.now() - started
    out(`(session ready in ${((Date.now() - started) / 1000).toFixed(1)} s)`)
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
          ...capabilities(platform, { app, bundleId: values['bundle-id'] }, simulator.name, simulator.version, simulator.udid),
          // Launching an installed WebDriverAgent skips an xcodebuild run for every session.
          'appium:usePreinstalledWDA': true,
          ...(!installed && { 'appium:prebuiltWDAPath': builtAgent }),
        }
        const address = i === 0 ? server : { protocol: 'http', hostname: '127.0.0.1', port: extra[i - 1].port, path: '/' }
        return new Lane(simulator.name, openSession(address, caps))
      }),
    )
  }

  let runNumber = 0
  /** Explores one criterion on a lane, replays a pass and writes the results. */
  const runOne = async (lane: Lane, criterion: Criterion, file: string, out: Out): Promise<Result> => {
    out(`\n${lanes.length > 1 ? `[${lane.name}] ` : ''}${criterion.id}: ${criterion.title ?? criterion.goal}`)
    // The trace is <stem>.json; the frames and the report go in the folder <stem>/. The run number
    // keeps runs that start in the same millisecond, on parallel lanes, apart.
    const stem = join(values.runs, `${safeId(criterion.id)}.${platform}.${Date.now()}${++runNumber > 1 ? `-${runNumber}` : ''}`)
    const kept = new Map<string, Buffer>()
    const keep = async (name: string, frame: { jpeg: Buffer }) => {
      mkdirSync(stem, { recursive: true })
      writeFileSync(join(stem, name), frame.jpeg)
      kept.set(name, frame.jpeg)
    }
    const device = lane.name
      ? `${lane.name}${simulator ? `, iOS ${simulator.version}` : ''}`
      : simulator
        ? `${simulator.name}, iOS ${simulator.version}`
        : (values.device ?? platform)
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
        // A dead end can go back and try again, since the app can be restarted from here.
        restart: () => restartApp(session),
        maxBacktracks,
        onStep: (step) => printStep(step, out, goalThreshold, minConfidence),
        ...(values.screenshots === 'steps' && { onFrame: keep }),
        look: vision,
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
      report(trace, criterion, out, { stem, kept, device, file })
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
          const result = await runOne(lane, criterion, file, out)
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
  console.log(`\n${summary(results, Date.now() - started, sessionMs, lanes.length)}`)
  return results.every(succeeded) ? 0 : 1

  /** Writes the trace, the run report and, for a pass, the spec. */
  function report(
    trace: Trace,
    criterion: Criterion,
    out: Out,
    run: { stem: string; kept: Map<string, Buffer>; device: string; file: string },
  ): void {
    mkdirSync(values.runs, { recursive: true })
    const tracePath = `${run.stem}.json`
    writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`)

    out(`  ${trace.outcome.toUpperCase()} in ${(trace.durationMs / 1000).toFixed(1)}s: ${trace.reason}`)
    const replayed = trace.replay
    if (replayed?.outcome === 'error') out(`  the replay with plain Appium could not run: ${replayed.reason}`)
    else if (replayed) {
      const verdict = replayed.outcome === 'passed' ? 'passed' : `FAILED: ${replayed.reason}`
      out(`  replayed with plain Appium in ${(replayed.durationMs / 1000).toFixed(1)}s: ${verdict}`)
    }
    for (const line of stopReport(trace)) out(`  ${line}`)
    const last = trace.steps.at(-1)?.frame
    if (trace.outcome !== 'passed' && last) out(`  last screen: ${join(run.stem, last)}`)
    out(`  trace: ${tracePath}`)
    let specFile: string | undefined
    if (trace.outcome === 'passed') {
      try {
        specFile = writeSpec(trace, criterion, values.out)
        out(`  test:  ${specFile}`)
      } catch (error) {
        out(`  test:  not written: ${firstLine(error)}`)
      }
    }
    const spec = specFile ? readFileSync(specFile, 'utf8') : undefined
    const report = { planFile: run.file, device: run.device, specFile, spec, inputs: criterion.inputs, frames: run.kept, goalThreshold }
    const { markdown, html } = runReport(trace, report)
    mkdirSync(run.stem, { recursive: true })
    writeFileSync(join(run.stem, 'report.md'), markdown)
    writeFileSync(join(run.stem, 'report.html'), html)
    out(`  report: ${join(run.stem, 'report.html')}`)
  }
}

/**
 * Writes what a project needs to start: a test plan to edit, a file for the key, and
 * .gitignore entries. The key gets a file of its own, readable only by its owner,
 * because a project's .env may be committed or built into the app.
 */
function init(): number {
  const created: string[] = []
  const starter = join('criteria', 'example.md')
  if (!existsSync(starter)) {
    mkdirSync('criteria', { recursive: true })
    writeFileSync(starter, STARTER_PLAN)
    created.push(starter)
  }
  if (!existsSync('.env.jevvium')) {
    writeFileSync('.env.jevvium', '# Your Jev key, from console.typesafe.ai\nTYPESAFE_API_KEY=\n', { mode: 0o600 })
    created.push('.env.jevvium')
  }
  // The key, run logs and failure screenshots can hold secrets or test data; the generated tests are meant to be committed.
  const ignored = existsSync('.gitignore') ? readFileSync('.gitignore', 'utf8') : ''
  const missing = ['.env.jevvium', 'runs/', 'screenshots/'].filter((entry) => !ignored.split('\n').some((line) => line.trim() === entry))
  if (missing.length > 0) {
    const separator = ignored && !ignored.endsWith('\n') ? '\n' : ''
    writeFileSync('.gitignore', `${ignored}${separator}${missing.join('\n')}\n`)
    created.push(`.gitignore entries for ${missing.join(', ')}`)
  }
  console.log(created.length > 0 ? `Created ${created.join(', ')}.` : 'Nothing to create: the starter test plan, .env.jevvium and the .gitignore entries are there.')
  console.log(`
Next:
  1. Put your Jev key in .env.jevvium (TYPESAFE_API_KEY=..., from console.typesafe.ai).
  2. Edit ${starter} to describe a flow in your app, the way you'd write a test plan.
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
    throw new Error(`No generated ${platform} tests in ${outDir}. Explore a plan first: npx jevvium explore criteria/example.md --app <path>`)
  }
  for (const spec of specs) {
    if (!existsSync(spec)) throw new Error(`No test at ${spec}`)
    // Generated tests import @wdio/globals, which Node looks for from the test's own folder up.
    try {
      createRequire(spec).resolve('@wdio/globals')
    } catch {
      throw new Error(
        `${spec} can't find @wdio/globals. Install jevvium in the project the tests are in (npm i -D jevvium; with pnpm, add @wdio/globals too)`,
      )
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

/** "5 criteria in 21.4 s (6.2 s of it starting the sessions) on 3 simulators: 3 passed, 1 failed its replay, 1 stuck" */
function summary(results: Result[], durationMs: number, sessionMs: number, simulators: number): string {
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
  const starting = sessionMs > 0 ? ` (${(sessionMs / 1000).toFixed(1)} s of it starting the ${simulators > 1 ? 'sessions' : 'session'})` : ''
  const parts = [...counts].map(([label, n]) => `${n} ${label}`).join(', ')
  return `${results.length} ${results.length === 1 ? 'criterion' : 'criteria'} in ${(durationMs / 1000).toFixed(1)} s${starting}${where}: ${parts}`
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
        ...(udid && { 'appium:udid': udid, 'appium:wdaLocalPort': wdaPort(udid), 'appium:mjpegServerPort': wdaPort(udid) + 1000 }),
        'appium:wdaLaunchTimeout': 240_000,
        // jevvium never reads the simulator's system log, and capturing it slows the session down.
        'appium:skipLogCapture': true,
        ...shared,
      }
}

/**
 * WebDriverAgent's port for a simulator, from its udid, so that no two simulators share
 * one: the driver reuses whatever WebDriverAgent answers on the port, whichever simulator
 * it drives. The one a run leaves running on the same simulator is reused, which is what
 * makes the next session start in a few seconds.
 */
function wdaPort(udid: string): number {
  return 8100 + (createHash('sha256').update(udid).digest().readUInt16BE(0) % 1000)
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
function printStep(step: Step, out: Out, goalThreshold: number, minConfidence: number): void {
  const decision = step.look && step.look.used !== 'none' ? step.look.decision : step.decision
  const reached = !step.taken?.length && (step.completed !== undefined || decision.goalMet >= goalThreshold)
  const stats = `${reached ? `goal ${decision.goalMet.toFixed(2)}` : decision.confidence.toFixed(2)} · ${decision.latencyMs} ms`
  // A step that acted on nothing says why; a confident one stopped for a reason the outcome line gives.
  const verdict = step.covered
    ? 'its choice was covered'
    : step.completed
      ? `step ${step.completed} done`
      : reached
        ? 'goal reached'
        : decision.action === 'STUCK'
          ? 'no way forward'
          : decision.confidence < minConfidence
            ? 'unsure'
            : 'stopped'
  const lines = step.taken?.length ? step.taken.map(describeTaken) : [verdict]
  lines.forEach((line, i) => {
    const prefix = i === 0 ? String(step.index).padStart(4) : '    '
    out(`${prefix}  ${i === 0 ? line.padEnd(40) + stats : line}`)
  })
  // Looking at every step, only a look that changed what the run did is worth a line: another
  // action, a verdict, or going on where the text answer would have ended the run.
  const look = step.look
  const textWouldStop = step.decision.action === 'STUCK' || step.decision.confidence < minConfidence
  const changed = look !== undefined && look.used !== 'none' && (look.used !== 'action' || look.decision.action !== step.decision.action || textWouldStop)
  if (look && (look.why !== 'always' || changed)) out(`      (looked at the screen: ${lookSummary(step)})`)
  if (step.lookError) out(`      (looked at the screen, but got no answer: ${step.lookError})`)
  if (step.covered) out('      (the element it chose was covered, so it decided again)')
  for (const note of step.notes ?? []) out(`      (${note})`)
  if (step.backtrack) out(`      (dead end: restarting the app and going back to step ${step.backtrack.to} to try "${step.backtrack.instead}" instead)`)
  if (step.retry) out(`      (step ${step.retry.of} again, with the model's runner-up)`)
}

function describeTaken(taken: TakenAction): string {
  if (taken.type === 'type') return `type ${taken.input} → "${taken.target}"`
  if (taken.type === 'scroll') return `scroll ${taken.direction} ${taken.target === 'screen' ? 'the screen' : `"${taken.target}"`}`
  if (taken.kind === 'key') return `press "${taken.target}"`
  if (taken.unlabeled) return `tap an unlabeled ${taken.kind} (${taken.description.match(/\((\w+) of the screen\)/)?.[1] ?? 'found by looking'})`
  return `${taken.kind === 'switch' ? 'toggle' : 'tap'} "${taken.target}"`
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`jevvium: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  },
)
