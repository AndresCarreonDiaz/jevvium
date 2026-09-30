// Compares decision providers on the same criteria: runs `explore` with each one,
// then reads the traces it wrote. Replays are skipped, since they don't involve a model.
//
//   npm run benchmark -- --providers jev,openai --repeat 3 [--suites demo,shop] [--parallel 4] [--out dir]
//
// A provider whose key isn't set is skipped. Every run costs requests to that provider.
// claude-<model> (claude-haiku, claude-sonnet, ...) runs Claude through the Claude Code
// CLI and its login instead of a key, so its requests count against that subscription.
// A round is kept only when it finished and wrote a trace for every criterion, so an
// interrupted or broken round runs again next time.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Trace } from '../src/explorer.ts'
import type { Decision } from '../src/providers/types.ts'

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
/** Each CLI run the Claude provider made in a round, refused replies included, written there by the provider. */
const CLAUDE_LOG = 'claude-calls.jsonl'
type ClaudeCall = {
  attempt?: number
  effort?: string
  refused?: string
  usage?: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens_details?: { thinking_tokens?: number } }
}
/**
 * Published prices per million tokens, input and output, by provider or by the model that
 * answered. Claude's are list prices without prompt caching. OpenAI hasn't priced Decisions yet.
 */
const PRICES: Record<string, [number, number] | undefined> = {
  jev: [0.042, 0],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-4-5-20251001': [1, 5],
}
/** Claude models without effort levels: the CLI leaves --effort out of their requests. */
const NO_EFFORT = new Set(['claude-haiku-4-5-20251001'])
/** How a run ends when the model never gave a usable answer: the model failed, the run didn't break. */
const NO_ANSWER = /without a usable answer/

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
  if (claudeModel(provider)) {
    if (spawnSync('claude', ['--version']).status === 0) return true
    console.log(`Skipping ${provider}: the claude CLI (Claude Code) is not installed`)
    return false
  }
  if (!KEYS[provider]) fail(`Unknown provider "${provider}" (known: ${Object.keys(KEYS).join(', ')}, claude-<model>)`)
  if (process.env[KEYS[provider]]) return true
  console.log(`Skipping ${provider}: ${KEYS[provider]} is not set`)
  return false
})
if (providers.length === 0) {
  console.log('Nothing to run: every provider was skipped (see above).')
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
  const model = claudeModel(entry.provider)
  const child = spawnSync(
    'npx',
    [
      'tsx', 'src/cli.ts', 'explore', ...criteria, '--platform', 'ios', '--app', app, '--provider', model ? 'claude' : entry.provider,
      '--max-steps', String(maxSteps), '--no-verify', '--device', values.device, '--runs', staging, '--out', join(staging, 'generated'),
      ...(values['platform-version'] ? ['--platform-version', values['platform-version']] : []),
      ...(values.parallel ? ['--parallel', values.parallel] : []),
    ],
    { stdio: 'inherit', env: model ? { ...process.env, CLAUDE_MODEL: model, JEVVIUM_CLAUDE_LOG: join(staging, CLAUDE_LOG) } : process.env },
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

// A run that broke (the device, the network, the provider refusing) says nothing about the model.
// One where the model never gave a usable answer does: it counts as not passing.
const counted = (trace: Trace) => trace.outcome !== 'error' || NO_ANSWER.test(trace.reason)
const results = new Map(
  providers.map((provider) => {
    const folders = rounds.filter((entry) => entry.provider === provider).map(folder)
    return [provider, { folders, all: tracesIn(folders) }] as const
  }),
)
const passedCriteria = (provider: string) =>
  new Set(results.get(provider)!.all.filter((trace) => trace.outcome === 'passed').map((trace) => trace.criterion.id))
// Decisions, requests and time per passed run compare the same work: the criteria every provider passed.
const common = [...passedCriteria(providers[0])].filter((id) => providers.every((provider) => passedCriteria(provider).has(id)))

const rows = new Map<string, string[]>()
const add = (label: string, value: string) => rows.set(label, [...(rows.get(label) ?? []), value])
const notes: string[] = []
for (const provider of providers) {
  const { folders, all } = results.get(provider)!
  const traces = all.filter(counted)
  const passed = traces.filter((trace) => trace.outcome === 'passed')
  // Averaged per criterion first, so that a criterion passed more often doesn't weigh more.
  const perPass = (value: (trace: Trace) => number) =>
    average(common.map((id) => average(passed.filter((trace) => trace.criterion.id === id).map(value))))
  const decisions = traces.flatMap((trace) => trace.steps.map((step) => step.decision))
  const latencies = decisions.map((decision) => decision.latencyMs).sort((a, b) => a - b)
  const input = traces.reduce((sum, trace) => sum + trace.usage.inputTokens, 0)
  const output = traces.reduce((sum, trace) => sum + trace.usage.outputTokens, 0)
  const requests = traces.reduce((sum, trace) => sum + trace.usage.requests, 0)
  const models = [...new Set(decisions.map((decision) => decision.model))]
  const price = PRICES[provider] ?? (models.length === 1 ? PRICES[models[0]] : undefined)
  // "Goal reached" against what the expectation checks found, in every run they ran in:
  // true on the last screen of a pass, false everywhere else.
  const checked = traces.filter((trace) => trace.outcome === 'passed' || trace.failedExpectations.length > 0)
  const judged = checked.flatMap((trace) =>
    trace.steps.map((step, i) => [step.decision.goalMet, trace.outcome === 'passed' && i === trace.steps.length - 1 ? 1 : 0]),
  )
  add('Runs passed', `${passed.length} of ${traces.length} (${show(passed.length / traces.length, (r) => `${Math.round(r * 100)}%`)})`)
  add('Runs that broke (not counted)', String(all.length - traces.length))
  add('Decisions kept per passed run †', show(perPass((trace) => trace.steps.length), (n) => n.toFixed(1)))
  add('Requests per passed run †', show(perPass((trace) => trace.usage.requests), (n) => n.toFixed(1)))
  add('Exploring time per passed run †', show(perPass((trace) => trace.durationMs) / 1000, (s) => `${s.toFixed(1)} s`))
  add('Decision latency, median', show(quantile(latencies, 0.5), (ms) => `${ms} ms`))
  add('Decision latency, 90th percentile', show(quantile(latencies, 0.9), (ms) => `${ms} ms`))
  add('Input tokens per request', show(input / requests, (n) => Math.round(n).toLocaleString('en-US')))
  add(
    'Cost per 1,000 requests',
    price ? show(((input * price[0] + output * price[1]) / 1e6 / requests) * 1000, (usd) => `$${usd.toFixed(usd < 1 ? 3 : 2)}`) : 'not published',
  )
  add('"Goal reached" Brier score (lower is better)', show(average(judged.map(([p, y]) => (p - y) ** 2)), (n) => n.toFixed(3)))
  if (claudeModel(provider)) notes.push(claudeNote(provider, models, decisions, callsIn(folders)))
}

const table = [
  `| | ${providers.join(' | ')} |`,
  `| --- |${providers.map(() => ' --- |').join('')}`,
  ...[...rows].map(([label, cells]) => `| ${label} | ${cells.join(' | ')} |`),
].join('\n')
const criteria = [...new Set(providers.flatMap((provider) => results.get(provider)!.all.map((trace) => trace.criterion.id)))].sort()
const differences = criteria.flatMap((id) => {
  const tally = providers.map((provider) => {
    const runs = results.get(provider)!.all.filter((trace) => trace.criterion.id === id && counted(trace))
    return { provider, passed: runs.filter((trace) => trace.outcome === 'passed').length, runs: runs.length }
  })
  return new Set(tally.map((t) => t.passed / t.runs)).size > 1
    ? [`${id} (${tally.map((t) => `${t.provider} ${t.passed} of ${t.runs}`).join(', ')})`]
    : []
})
const note = [
  `Suites: ${suites.join(', ')}. Rounds: ${repeat}. Replays off.`,
  `† Over the ${common.length} criteria every provider passed at least once, averaged per criterion.`,
  ...(providers.length > 1 && differences.length > 0 ? [`Pass rates differ on ${differences.join('; ')}.`] : []),
].join(' ')
mkdirSync(values.out, { recursive: true })
const report = [note, table, ...notes].join('\n\n')
writeFileSync(join(values.out, 'results.md'), `${report}\n`)
console.log(`\n${report}\n\nWritten to ${join(values.out, 'results.md')}`)
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

/** How the Claude runs were made, from the traces and the provider's log of CLI runs. */
function claudeNote(provider: string, models: string[], decisions: Decision[], calls: ClaudeCall[]): string {
  const measured = decisions.filter((decision) => decision.apiLatencyMs !== undefined)
  const api = measured.map((decision) => decision.apiLatencyMs!).sort((a, b) => a - b)
  const startup = average(measured.map((decision) => decision.latencyMs - decision.apiLatencyMs!))
  const thinking = (call: ClaudeCall) => call.usage?.output_tokens_details?.thinking_tokens ?? 0
  const thought = calls.filter((call) => thinking(call) > 0).length
  const thinkingTokens = calls.reduce((sum, call) => sum + thinking(call), 0)
  const cached = calls.some((call) => (call.usage?.cache_read_input_tokens ?? 0) + (call.usage?.cache_creation_input_tokens ?? 0) > 0)
  const efforts = [...new Set(calls.flatMap((call) => (call.effort ? [call.effort] : [])))]
  const effort = models.some((model) => NO_EFFORT.has(model))
    ? 'with no effort level (the model has none)'
    : `at ${efforts.length > 0 ? `${efforts.join(' and ')} effort` : "the CLI's default effort"}`
  // A decision asks again after its first unusable reply, and gives up after a second.
  const retried = calls.filter((call) => call.refused !== undefined && call.attempt === 1).length
  const unanswered = calls.filter((call) => call.refused !== undefined && call.attempt === 2).length
  const ms = (value: number) => show(value, (n) => `${Math.round(n)} ms`)
  return [
    `${provider} (${models.join(', ')}) ran through the Claude Code CLI on a Claude subscription, one CLI run per answer,`,
    `${effort}, with prompt caching ${cached ? 'on' : 'off'}.`,
    thought > 0
      ? `It thought before answering in ${thought} of ${calls.length} CLI runs (${thinkingTokens.toLocaleString('en-US')} thinking tokens): ` +
        "the CLI can't turn thinking off for a model that decides for itself when to think."
      : `It answered without thinking in all ${calls.length} CLI runs.`,
    retried === 0
      ? 'Every reply was a usable answer.'
      : `${retried} ${retried === 1 ? 'reply was' : 'replies were'} not a usable answer and asked again` +
        `${unanswered > 0 ? `, and ${unanswered} of those got no usable answer the second time either` : ''}.`,
    `Its latency includes starting the CLI (${ms(startup)} on average); the API time alone had a median of`,
    `${ms(quantile(api, 0.5))} and a 90th percentile of ${ms(quantile(api, 0.9))}.`,
    "Input tokens are each model's own count: the tokenizers differ, and Claude's include the answer format and text the CLI adds to every run.",
    'Its confidence is its own estimate, not a probability the model computed.',
  ].join(' ')
}

/** The model in a claude-<model> provider name. */
function claudeModel(provider: string): string | undefined {
  return /^claude-([a-z0-9][a-z0-9.-]*)$/.exec(provider)?.[1]
}

function callsIn(dirs: string[]): ClaudeCall[] {
  return dirs
    .map((dir) => join(dir, CLAUDE_LOG))
    .filter((file) => existsSync(file))
    .flatMap((file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ClaudeCall))
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
