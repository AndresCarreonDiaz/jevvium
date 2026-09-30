// Compares decision providers on the same criteria: runs `explore` with each one,
// then reads the traces it wrote. Replays are skipped, since they don't involve a model.
//
//   npm run benchmark -- --providers jev,openai --repeat 3 [--suites demo,shop] [--parallel 4] [--out dir]
//
// A provider whose key isn't set is skipped. Every run costs requests to that provider.
// A round is kept only when it finished and wrote a trace for every criterion, so an
// interrupted or broken round runs again next time.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Trace } from '../src/explorer.ts'

const SUITES: Record<string, { app: string; criteria: string[]; maxSteps: number }> = {
  demo: {
    app: 'apps/wdiodemoapp.app',
    criteria: ['criteria/login.yml', 'criteria/login-invalid-email.yml', 'criteria/signup.yml', 'criteria/forms-switch.yml'],
    maxSteps: 15,
  },
  shop: {
    app: 'apps/mydemo-ios/Payload/My Demo App.app',
    criteria: readdirSync('criteria/mydemo-ios')
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => `criteria/mydemo-ios/${file}`),
    maxSteps: 20,
  },
}
const KEYS: Record<string, string> = { jev: 'TYPESAFE_API_KEY', openai: 'OPENAI_API_KEY' }
/** Published prices per million tokens, input and output. OpenAI hasn't priced Decisions yet. */
const PRICES: Record<string, [number, number] | undefined> = { jev: [0.042, 0] }

const { values } = parseArgs({
  options: {
    providers: { type: 'string', default: 'jev,openai' },
    suites: { type: 'string', default: 'demo,shop' },
    repeat: { type: 'string', default: '3' },
    parallel: { type: 'string' },
    device: { type: 'string', default: 'iPhone 17' },
    'platform-version': { type: 'string' },
    out: { type: 'string', default: `benchmarks/providers-${localDate()}` },
  },
})
try {
  process.loadEnvFile()
} catch {
  // The keys may already be in the environment.
}

const suites = values.suites.split(',')
for (const suite of suites) if (!SUITES[suite]) fail(`Unknown suite "${suite}" (known: ${Object.keys(SUITES).join(', ')})`)
const repeat = Number(values.repeat)
if (!Number.isInteger(repeat) || repeat < 1) fail(`--repeat must be a whole number of 1 or more, not "${values.repeat}"`)
const providers = values.providers.split(',').filter((provider) => {
  if (!KEYS[provider]) fail(`Unknown provider "${provider}" (known: ${Object.keys(KEYS).join(', ')})`)
  if (process.env[KEYS[provider]]) return true
  console.log(`Skipping ${provider}: ${KEYS[provider]} is not set`)
  return false
})
if (providers.length === 0) {
  console.log('Nothing to run: no provider has its key set.')
  process.exit(1)
}

const rounds = providers.flatMap((provider) =>
  Array.from({ length: repeat }, (_, i) => suites.map((suite) => ({ provider, suite, round: i + 1 }))).flat(),
)
const folder = ({ provider, suite, round }: (typeof rounds)[number]) => join(values.out, provider, `${suite}-${round}`)
const incomplete: string[] = []

for (const entry of rounds) {
  const done = folder(entry)
  if (existsSync(done)) continue
  const { app, criteria, maxSteps } = SUITES[entry.suite]
  // A round runs in a staging folder and moves into place only once it is complete.
  const staging = join(values.out, '.incomplete', entry.provider, `${entry.suite}-${entry.round}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  console.log(`\n${entry.provider}, ${entry.suite}, round ${entry.round}`)
  const child = spawnSync(
    'npx',
    [
      'tsx', 'src/cli.ts', 'explore', ...criteria, '--platform', 'ios', '--app', app, '--provider', entry.provider,
      '--max-steps', String(maxSteps), '--no-verify', '--device', values.device, '--runs', staging, '--out', join(staging, 'generated'),
      ...(values['platform-version'] ? ['--platform-version', values['platform-version']] : []),
      ...(values.parallel ? ['--parallel', values.parallel] : []),
    ],
    { stdio: 'inherit' },
  )
  // Exit 1 only means some criterion didn't pass; a signal, exit 2 or a missing trace means the round broke.
  const finished = child.signal === null && (child.status === 0 || child.status === 1)
  if (finished && tracesIn([staging]).length === criteria.length) {
    mkdirSync(dirname(done), { recursive: true })
    renameSync(staging, done)
  } else {
    rmSync(staging, { recursive: true, force: true })
    incomplete.push(`${entry.provider} ${entry.suite} round ${entry.round}`)
  }
}
rmSync(join(values.out, '.incomplete'), { recursive: true, force: true })

const rows = new Map<string, string[]>()
const add = (label: string, value: string) => rows.set(label, [...(rows.get(label) ?? []), value])
for (const provider of providers) {
  const all = tracesIn(rounds.filter((entry) => entry.provider === provider).map(folder))
  // A run that broke (the device, the network, the provider refusing) says nothing about the model.
  const traces = all.filter((trace) => trace.outcome !== 'error')
  const passed = traces.filter((trace) => trace.outcome === 'passed')
  const decisions = traces.flatMap((trace) => trace.steps.map((step) => step.decision))
  const latencies = decisions.map((decision) => decision.latencyMs).sort((a, b) => a - b)
  const input = traces.reduce((sum, trace) => sum + trace.usage.inputTokens, 0)
  const output = traces.reduce((sum, trace) => sum + trace.usage.outputTokens, 0)
  const requests = traces.reduce((sum, trace) => sum + trace.usage.requests, 0)
  const price = PRICES[provider]
  // "Goal reached" against what the expectation checks found, in every run they ran in:
  // true on the last screen of a pass, false everywhere else.
  const checked = traces.filter((trace) => trace.outcome === 'passed' || trace.failedExpectations.length > 0)
  const judged = checked.flatMap((trace) =>
    trace.steps.map((step, i) => [step.decision.goalMet, trace.outcome === 'passed' && i === trace.steps.length - 1 ? 1 : 0]),
  )
  add('Runs passed', `${passed.length} of ${traces.length} (${show(passed.length / traces.length, (r) => `${Math.round(r * 100)}%`)})`)
  add('Runs that broke (not counted)', String(all.length - traces.length))
  add('Decisions kept per passed run', show(average(passed.map((trace) => trace.steps.length)), (n) => n.toFixed(1)))
  add('Requests per passed run', show(average(passed.map((trace) => trace.usage.requests)), (n) => n.toFixed(1)))
  add('Exploring time per passed run', show(average(passed.map((trace) => trace.durationMs)) / 1000, (s) => `${s.toFixed(1)} s`))
  add('Decision latency, median', show(quantile(latencies, 0.5), (ms) => `${ms} ms`))
  add('Decision latency, 90th percentile', show(quantile(latencies, 0.9), (ms) => `${ms} ms`))
  add('Input tokens per request', show(input / requests, (n) => Math.round(n).toLocaleString('en-US')))
  add('Cost per 1,000 requests', price ? show(((input * price[0] + output * price[1]) / 1e6 / requests) * 1000, (usd) => `$${usd.toFixed(3)}`) : 'not published')
  add('"Goal reached" Brier score (lower is better)', show(average(judged.map(([p, y]) => (p - y) ** 2)), (n) => n.toFixed(3)))
}

const table = [
  `| | ${providers.join(' | ')} |`,
  `| --- |${providers.map(() => ' --- |').join('')}`,
  ...[...rows].map(([label, cells]) => `| ${label} | ${cells.join(' | ')} |`),
].join('\n')
const note = `Suites: ${suites.join(', ')}. Rounds: ${repeat}. Replays off.`
mkdirSync(values.out, { recursive: true })
writeFileSync(join(values.out, 'results.md'), `${note}\n\n${table}\n`)
console.log(`\n${note}\n\n${table}\n\nWritten to ${join(values.out, 'results.md')}`)
if (incomplete.length > 0) {
  console.log(`\nThese rounds didn't finish and will run again next time: ${incomplete.join(', ')}`)
  process.exitCode = 1
}

function fail(message: string): never {
  console.error(`benchmark: ${message}`)
  process.exit(2)
}

function tracesIn(dirs: string[]): Trace[] {
  return dirs
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Trace),
    )
}

/** A number formatted, or "n/a" when there was nothing to measure. */
function show(value: number, format: (value: number) => string): string {
  return Number.isFinite(value) ? format(value) : 'n/a'
}

function average(numbers: number[]): number {
  return numbers.length === 0 ? NaN : numbers.reduce((a, b) => a + b, 0) / numbers.length
}

function quantile(sorted: number[], q: number): number {
  return sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

function localDate(): string {
  const now = new Date()
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0')).join('-')
}
