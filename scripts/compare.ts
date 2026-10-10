// Measures a test with the model in the loop against the same test without it, on the
// same plans: `jevvium explore` (Jev decides each step, then the path is replayed with
// plain Appium) against `jevvium test` (the generated spec: plain WebdriverIO, no model).
// Each flow runs as its own command, so the wall clock is what one test costs end to end.
//
//   npm run compare -- [--repeat 3] [--device "iPhone 17"] [--platform-version 26.5] [--out dir]
//
// Every explore costs requests to Jev. A round that broke runs again next time.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Trace } from '../src/explorer.ts'

/** TypeSafe's published price per million input tokens; output tokens are free. */
const JEV_PRICE_PER_M_INPUT = 0.042
const SHOP = 'apps/mydemo-ios/Payload/My Demo App.app'
const DEMO = 'apps/wdiodemoapp.app'

/** The flows compared: the plans in Markdown and the single-goal criteria for the same apps. */
const FLOWS = [
  { file: 'criteria/login-plan.md', app: DEMO },
  { file: 'criteria/login.yml', app: DEMO },
  { file: 'criteria/mydemo-ios/bike-light.md', app: SHOP },
  { file: 'criteria/mydemo-ios/checkout-plan.md', app: SHOP },
  { file: 'criteria/mydemo-ios/add-to-cart.yml', app: SHOP },
  { file: 'criteria/mydemo-ios/cart-two-backpacks.yml', app: SHOP },
]

type Timing = {
  flow: string
  round: number
  explore: { wallMs: number; status: number | null }
  /** Missing when the explore didn't write a test. */
  test?: { wallMs: number; status: number | null; inSessionMs?: number; passed?: number; failing?: number }
}

const { values } = parseArgs({
  options: {
    repeat: { type: 'string', default: '3' },
    device: { type: 'string', default: 'iPhone 17' },
    'platform-version': { type: 'string' },
    out: { type: 'string', default: `benchmarks/explore-vs-appium-${localDate()}` },
  },
})
try {
  process.loadEnvFile()
} catch {
  // The key may already be in the environment.
}
if (!process.env.TYPESAFE_API_KEY) fail('TYPESAFE_API_KEY is not set')
const repeat = Number(values.repeat)
if (!Number.isInteger(repeat) || repeat < 1) fail(`--repeat must be a whole number of 1 or more, not "${values.repeat}"`)
const flowId = (file: string) => basename(file).replace(/\.(md|yml)$/, '')
const device = ['--device', values.device, ...(values['platform-version'] ? ['--platform-version', values['platform-version']] : [])]

const incomplete: string[] = []
for (let round = 1; round <= repeat; round++) {
  for (const flow of FLOWS) {
    const id = flowId(flow.file)
    const dir = join(values.out, `round-${round}`, id)
    if (existsSync(join(dir, 'timing.json'))) continue
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    console.log(`\nround ${round}, ${id}`)

    // With the model: explore, replay with plain Appium, write the test. One command, one session.
    const explore = command(['explore', flow.file, '--app', flow.app, '--max-steps', '25', ...device, '--runs', dir, '--out', join(dir, 'generated')])
    writeFileSync(join(dir, 'explore.log'), explore.output)
    const timing: Timing = { flow: id, round, explore: { wallMs: explore.wallMs, status: explore.status } }
    console.log(`  explore: ${(explore.wallMs / 1000).toFixed(1)} s, exit ${explore.status}`)
    const broke = explore.signal !== null || (explore.status !== 0 && explore.status !== 1) || tracesIn(dir).length !== 1
    if (broke) {
      rmSync(dir, { recursive: true, force: true })
      incomplete.push(`round ${round} ${id}`)
      continue
    }

    // Without the model: the generated test, as CI would run it. One command, one session.
    const specs = existsSync(join(dir, 'generated')) ? readdirSync(join(dir, 'generated')).filter((file) => file.endsWith('.spec.ts')) : []
    if (specs.length === 1) {
      const test = command(['test', join(dir, 'generated', specs[0]), '--app', flow.app, ...device, '--runs', dir])
      writeFileSync(join(dir, 'test.log'), test.output)
      timing.test = { wallMs: test.wallMs, status: test.status, ...parseWdio(test.output) }
      console.log(`  test: ${(test.wallMs / 1000).toFixed(1)} s, exit ${test.status}, ${timing.test.passed ?? 0} passing, ${timing.test.failing ?? 0} failing`)
    }
    // The Appium logs are large and say nothing the traces don't.
    for (const file of readdirSync(dir)) if (file.endsWith('.log') && file.startsWith('appium')) rmSync(join(dir, file))
    writeFileSync(join(dir, 'timing.json'), `${JSON.stringify(timing, null, 2)}\n`)
  }
}

// Results: the median over the rounds, per flow.
type Row = { id: string; file: string; traces: Trace[]; timings: Timing[] }
const rows: Row[] = FLOWS.map((flow) => {
  const id = flowId(flow.file)
  const dirs = Array.from({ length: repeat }, (_, i) => join(values.out, `round-${i + 1}`, id)).filter((dir) => existsSync(join(dir, 'timing.json')))
  return {
    id,
    file: flow.file,
    traces: dirs.flatMap(tracesIn),
    timings: dirs.map((dir) => JSON.parse(readFileSync(join(dir, 'timing.json'), 'utf8')) as Timing),
  }
})
// Rounded half up in integer tenths first: toFixed would round 17150 ms down to 17.1, since 17.15 isn't exact in binary.
const seconds = (ms: number) => (Number.isFinite(ms) ? `${(Math.round(ms / 100) / 10).toFixed(1)} s` : 'n/a')
const count = (n: number) => (Number.isFinite(n) ? String(Math.round(n)) : 'n/a')
const cost = (tokens: number) => (Number.isFinite(tokens) ? `$${((tokens * JEV_PRICE_PER_M_INPUT) / 1e6).toFixed(4)}` : 'n/a')
const withModel = [
  '| Flow | Passed | Exploring | Whole command | Decisions | Requests | Input tokens | Cost |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((row) => {
    const passed = row.traces.filter((trace) => trace.outcome === 'passed')
    const replays = row.traces.flatMap((trace) => (trace.replay ? [trace.replay] : []))
    const replayFailed = replays.length > 0 && replays.every((replay) => replay.outcome !== 'passed')
    return [
      `[${row.id}](../../${row.file})`,
      `${passed.length} of ${row.traces.length}`,
      seconds(median(passed.map((trace) => trace.durationMs))),
      `${seconds(median(row.timings.map((timing) => timing.explore.wallMs)))}${replayFailed ? ` (with a ${seconds(median(replays.map((r) => r.durationMs)))} failed replay)` : ''}`,
      count(median(passed.map((trace) => trace.steps.length))),
      count(median(passed.map((trace) => trace.usage.requests))),
      count(median(passed.map((trace) => trace.usage.inputTokens))),
      cost(median(passed.map((trace) => trace.usage.inputTokens))),
    ].join(' | ')
  }),
].map((line) => (line.startsWith('|') ? line : `| ${line} |`))
const withoutModel = [
  '| Flow | Replay, in the explore session | `jevvium test`: the test | `jevvium test`: whole command | Test passed |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((row) => {
    const replays = row.traces.flatMap((trace) => (trace.replay ? [trace.replay] : []))
    const tests = row.timings.flatMap((timing) => (timing.test ? [timing.test] : []))
    const replayed = replays.filter((replay) => replay.outcome === 'passed')
    const testPassed = tests.filter(passedTest)
    return [
      `[${row.id}](../../${row.file})`,
      replays.length === 0 ? 'n/a' : `${seconds(median(replayed.map((replay) => replay.durationMs)))} (${replayed.length} of ${replays.length} passed)`,
      seconds(median(testPassed.map((test) => test.inSessionMs ?? NaN))),
      `${seconds(median(tests.map((test) => test.wallMs)))}${tests.length > 0 && testPassed.length === 0 ? ' (failing)' : ''}`,
      tests.length === 0 ? 'no test written' : `${testPassed.length} of ${tests.length}`,
    ].join(' | ')
  }),
].map((line) => (line.startsWith('|') ? line : `| ${line} |`))

const all = rows.flatMap((row) => row.traces)
const models = [...new Set(all.flatMap((trace) => trace.steps.map((step) => step.decision.model)))]
const exploring = (row: Row) => median(row.traces.filter((t) => t.outcome === 'passed').map((t) => t.durationMs))
const tokens = (row: Row) => median(row.traces.filter((t) => t.outcome === 'passed').map((t) => t.usage.inputTokens))
const sum = (numbers: number[]) => numbers.filter(Number.isFinite).reduce((a, b) => a + b, 0)
// The flows whose generated test passes, so exploring and running are added up over the same flows.
const comparable = rows.filter((row) => row.timings.some((timing) => timing.test && passedTest(timing.test)))
const testTotal = sum(comparable.map((row) => median(row.timings.flatMap((timing) => (timing.test && passedTest(timing.test) ? [timing.test.inSessionMs ?? NaN] : [])))))
const testRuns = comparable.flatMap((row) => row.timings.flatMap((timing) => (timing.test ? [timing.test] : [])))
const note = [
  `Rounds: ${repeat}, one command per flow per round, on one simulator (${values.device}${values['platform-version'] ? `, iOS ${values['platform-version']}` : ''}), ` +
    `with ${models.join(', ')}. Every number is the median over the rounds. Exploring, decisions, requests, tokens and cost are over the runs whose outcome was passed; ` +
    'the whole-command times are over all the rounds.',
  '"Exploring" is the time from the first screen read to the verdict, with the model deciding each step; "whole command" adds starting Appium, ' +
    'the session, the app restart and the replay with plain Appium, and writing the test. ' +
    '"Decisions" counts every answer the run kept, the "step done" and "goal reached" verdicts included; "Requests" adds the answers thrown away because the screen was still changing or the chosen element was covered, which cost tokens all the same. ' +
    '"Replay" is that replay: the same selectors and commands as the generated test, in the same session, right after exploring. ' +
    '"`jevvium test`" runs the generated spec with WebdriverIO: "the test" is the time WebdriverIO reports for it, "whole command" adds starting Appium and the session.',
  `Cost is input tokens at TypeSafe's list price of $${JEV_PRICE_PER_M_INPUT} per million; output tokens are free at that price. The generated tests call no model, so a run costs $0 in model calls.`,
  `Adding up the per-flow medians: exploring all ${rows.length} flows took ${seconds(sum(rows.map(exploring)))} and ${cost(sum(rows.map(tokens)))}. ` +
    `Over the ${comparable.length} flows whose generated test passes (${testRuns.filter(passedTest).length} of ${testRuns.length} test runs), ` +
    `exploring took ${seconds(sum(comparable.map(exploring)))} and ${cost(sum(comparable.map(tokens)))}, and the tests ${seconds(testTotal)} and $0.`,
].join(' ')
const report = ['## With the model in the loop: `jevvium explore`', withModel.join('\n'), '## Without: plain Appium', withoutModel.join('\n'), note].join('\n\n')
mkdirSync(values.out, { recursive: true })
writeFileSync(join(values.out, 'results.md'), `${report}\n`)
console.log(`\n${report}\n\nWritten to ${join(values.out, 'results.md')}`)
if (incomplete.length > 0) {
  console.log(`\nThese didn't finish and will run again next time: ${incomplete.join(', ')}`)
  process.exitCode = 1
}

/** A test run that passed: WebdriverIO exited 0 and reported nothing failing. */
function passedTest(test: NonNullable<Timing['test']>): boolean {
  return test.status === 0 && (test.failing ?? 0) === 0
}

/** Runs the CLI from source, timing the whole command. */
function command(args: string[]): { output: string; wallMs: number; status: number | null; signal: NodeJS.Signals | null } {
  const started = Date.now()
  const child = spawnSync('npx', ['tsx', 'src/cli.ts', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env })
  return { output: `${child.stdout ?? ''}${child.stderr ?? ''}`, wallMs: Date.now() - started, status: child.status, signal: child.signal }
}

/** What WebdriverIO's spec reporter said: "1 passing (5.1s)", "1 failing". */
function parseWdio(output: string): { inSessionMs?: number; passed?: number; failing?: number } {
  const passing = /(\d+) passing \(([^)]+)\)/.exec(output)
  const failing = /(\d+) failing(?: \(([^)]+)\))?/.exec(output)
  const duration = passing?.[2] ?? failing?.[2]
  return {
    ...(duration && { inSessionMs: durationMs(duration) }),
    ...(passing && { passed: Number(passing[1]) }),
    ...(failing && { failing: Number(failing[1]) }),
  }
}

/** "1m 5.1s", "5.1s" or "512ms" in milliseconds. */
function durationMs(text: string): number {
  let ms = 0
  for (const [, value, unit] of text.matchAll(/([\d.]+)\s*(ms|s|m|h)/g)) {
    ms += Number(value) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit as 'ms' | 's' | 'm' | 'h']
  }
  return ms
}

function tracesIn(dir: string): Trace[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json') && file !== 'timing.json')
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Trace)
}

function median(numbers: number[]): number {
  const sorted = numbers.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (sorted.length === 0) return NaN
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function fail(message: string): never {
  console.error(`compare: ${message}`)
  process.exit(2)
}

function localDate(): string {
  const now = new Date()
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0')).join('-')
}
