// Compares decision providers on the same criteria: runs `explore` with each one,
// then reads the traces it wrote. Replays are skipped, since they don't involve a model.
//
//   npm run benchmark -- --providers jev,openai --repeat 3 [--suites demo,shop] [--parallel 4] [--out dir]
//
// A provider whose key isn't set is skipped. Every run costs requests to that provider.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
    criteria: readdirSync('criteria/mydemo-ios').map((file) => `criteria/mydemo-ios/${file}`),
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
    out: { type: 'string', default: `benchmarks/providers-${new Date().toISOString().slice(0, 10)}` },
  },
})
try {
  process.loadEnvFile()
} catch {
  // The keys may already be in the environment.
}

const providers = values.providers.split(',').filter((provider) => {
  if (!KEYS[provider]) throw new Error(`Unknown provider "${provider}"`)
  if (process.env[KEYS[provider]]) return true
  console.log(`Skipping ${provider}: ${KEYS[provider]} is not set`)
  return false
})
const repeat = Number(values.repeat)

for (const provider of providers) {
  for (let round = 1; round <= repeat; round++) {
    for (const suite of values.suites.split(',')) {
      const { app, criteria, maxSteps } = SUITES[suite]
      const runs = join(values.out, provider, `${suite}-${round}`)
      if (existsSync(runs)) continue // already run; delete the folder to run it again
      mkdirSync(runs, { recursive: true })
      console.log(`\n${provider}, ${suite}, round ${round}`)
      spawnSync(
        'npx',
        [
          'tsx', 'src/cli.ts', 'explore', ...criteria, '--platform', 'ios', '--app', app, '--provider', provider,
          '--max-steps', String(maxSteps), '--no-verify', '--device', values.device, '--runs', runs, '--out', join(runs, 'generated'),
          ...(values['platform-version'] ? ['--platform-version', values['platform-version']] : []),
          ...(values.parallel ? ['--parallel', values.parallel] : []),
        ],
        { stdio: 'inherit' },
      )
    }
  }
}

const report = ['| | ' + providers.join(' | ') + ' |', '| --- |' + providers.map(() => ' --- |').join('')]
const rows = new Map<string, string[]>()
for (const provider of providers) {
  const traces = tracesIn(join(values.out, provider))
  const passed = traces.filter((trace) => trace.outcome === 'passed')
  const decisions = traces.flatMap((trace) => trace.steps.map((step) => step.decision))
  const latencies = decisions.map((decision) => decision.latencyMs).sort((a, b) => a - b)
  const input = traces.reduce((sum, trace) => sum + trace.usage.inputTokens, 0)
  const output = traces.reduce((sum, trace) => sum + trace.usage.outputTokens, 0)
  const requests = traces.reduce((sum, trace) => sum + trace.usage.requests, 0)
  const price = PRICES[provider]
  // How well "goal reached" was judged in passing runs: 1 on the last step, 0 before it.
  const judged = passed.flatMap((trace) => trace.steps.map((step, i) => [step.decision.goalMet, i === trace.steps.length - 1 ? 1 : 0]))
  const add = (label: string, value: string) => rows.set(label, [...(rows.get(label) ?? []), value])
  add('Runs passed', `${passed.length} of ${traces.length} (${percent(passed.length / traces.length)})`)
  add('Decisions per passed run', average(passed.map((trace) => trace.steps.length)).toFixed(1))
  add('Exploring time per passed run', `${(average(passed.map((trace) => trace.durationMs)) / 1000).toFixed(1)} s`)
  add('Decision latency, median', `${quantile(latencies, 0.5)} ms`)
  add('Decision latency, 90th percentile', `${quantile(latencies, 0.9)} ms`)
  add('Input tokens per request', Math.round(input / requests).toLocaleString('en-US'))
  add('Cost per 1,000 requests', price ? `$${(((input * price[0] + output * price[1]) / 1e6 / requests) * 1000).toFixed(3)}` : 'not published')
  add('"Goal reached" Brier score (lower is better)', average(judged.map(([p, y]) => (p - y) ** 2)).toFixed(3))
}
for (const [label, cells] of rows) report.push(`| ${label} | ${cells.join(' | ')} |`)
const table = report.join('\n')
writeFileSync(join(values.out, 'results.md'), `${table}\n`)
console.log(`\n${table}\n\nWritten to ${join(values.out, 'results.md')}`)

function tracesIn(dir: string): Trace[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.json') && !file.includes('generated'))
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Trace)
}

function average(numbers: number[]): number {
  return numbers.length === 0 ? NaN : numbers.reduce((a, b) => a + b, 0) / numbers.length
}

function quantile(sorted: number[], q: number): number {
  return sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}
