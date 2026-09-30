import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildPrompt, ClaudeProvider, cliEnvironment, parseAnswer, type CliResult } from '../src/providers/claude.ts'
import { buildBody } from '../src/providers/jev.ts'
import type { DecisionRequest } from '../src/providers/types.ts'

const request: DecisionRequest = {
  platform: 'ios',
  goal: 'Log in',
  screenText: ['Login / Sign up Form'],
  controlStates: [],
  actions: [
    { key: 'type:e1:email', description: 'Type the test data "email" into the field "Email"' },
    { key: 'tap:e2', description: 'Tap the button "LOGIN"' },
  ],
  history: [],
  inputNames: ['email'],
  fields: [{ key: 'e1', description: 'the field "Email"' }],
}

/** What `claude -p --output-format json` prints, around a reply. */
const printed = (reply: string): CliResult => ({
  stdout: JSON.stringify({
    is_error: false,
    result: reply,
    duration_api_ms: 700,
    usage: { input_tokens: 400, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, output_tokens: 40, output_tokens_details: { thinking_tokens: 12 } },
    modelUsage: { 'claude-haiku-4-5-20251001': { outputTokens: 40 } },
  }),
  stderr: '',
  code: 0,
})

describe('ClaudeProvider', () => {
  it('runs the CLI once per decision and maps the answer, fence and all', async () => {
    const calls: { args: string[]; prompt: string }[] = []
    const provider = new ClaudeProvider({
      model: 'haiku',
      run: async (args, prompt) => {
        calls.push({ args, prompt })
        return printed('```json\n{"next_action": {"choice": "type:e1:email", "confidence": 0.9}, "goal_met": 0.03, "fill_e1": {"choice": "email", "confidence": 0.95}}\n```')
      },
    })

    const decision = await provider.decide(request)

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args.slice(0, 6), ['-p', '--safe-mode', '--model', 'haiku', '--effort', 'medium'])
    assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--tools'), calls[0].args.indexOf('--tools') + 2), ['--tools', ''])
    assert.equal(calls[0].prompt, buildPrompt(request))
    assert.equal(decision.action, 'type:e1:email')
    assert.equal(decision.confidence, 0.9)
    assert.equal(decision.goalMet, 0.03)
    assert.deepEqual(decision.fills, { e1: { input: 'email', confidence: 0.95 } })
    assert.equal(decision.model, 'claude-haiku-4-5-20251001')
    assert.deepEqual(decision.usage, { inputTokens: 900, outputTokens: 40 })
    assert.equal(decision.apiLatencyMs, 700)
    assert.equal(decision.thinkingTokens, 12)
  })

  it('asks Sonnet by default', async () => {
    const saved = process.env.CLAUDE_MODEL
    delete process.env.CLAUDE_MODEL
    try {
      let args: string[] = []
      const provider = new ClaudeProvider({
        run: async (given) => {
          args = given
          return printed('{"next_action": {"choice": "tap:e2", "confidence": 0.7}, "goal_met": 0.1}')
        },
      })
      await provider.decide(request)
      assert.equal(args[args.indexOf('--model') + 1], 'sonnet')
    } finally {
      if (saved !== undefined) process.env.CLAUDE_MODEL = saved
    }
  })

  it('is asked everything Jev is asked, in the same words', () => {
    const strings = (value: unknown): string[] =>
      typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
    const jev = buildBody(request, 'jev-latest')
    const claude = buildPrompt(request)
    const wording = [...strings(jev.questions), ...strings(jev.state)].filter((text) => !['choice', 'noul'].includes(text))
    for (const text of wording) assert.ok(claude.includes(JSON.stringify(text).slice(1, -1)), `missing: ${text}`)
  })

  it('asks once more when a reply is no answer, then gives up', async () => {
    let calls = 0
    const provider = new ClaudeProvider({
      run: async () => {
        calls++
        return printed('I would tap LOGIN.')
      },
    })
    await assert.rejects(provider.decide(request), /twice without a usable answer/)
    assert.equal(calls, 2)
  })

  it('adds up API time and tokens over a retry', async () => {
    const replies = ['I would tap LOGIN.', '{"next_action": {"choice": "tap:e2", "confidence": 0.7}, "goal_met": 0.1}']
    const provider = new ClaudeProvider({ run: async () => printed(replies.shift()!) })
    const decision = await provider.decide(request)
    assert.equal(decision.apiLatencyMs, 1400)
    assert.deepEqual(decision.usage, { inputTokens: 1800, outputTokens: 80 })
  })

  it('turns a CLI error into one line', async () => {
    const provider = new ClaudeProvider({
      run: async () => ({ stdout: JSON.stringify({ is_error: true, result: 'Usage limit reached\nTry again later' }), stderr: '', code: 1 }),
    })
    await assert.rejects(provider.decide(request), { message: 'Claude Code: Usage limit reached Try again later' })
  })
})

describe('parseAnswer', () => {
  it('refuses choices that are not options, and confidences outside 0 to 1', () => {
    const reply = (next: unknown, goal: unknown = 0.1) => JSON.stringify({ next_action: next, goal_met: goal })
    assert.equal(parseAnswer(reply({ choice: 'tap:e9', confidence: 0.9 }), request), undefined)
    assert.equal(parseAnswer(reply({ choice: 'toString', confidence: 0.9 }), request), undefined)
    assert.equal(parseAnswer(reply({ choice: 'tap:e2', confidence: 1.5 }), request), undefined)
    assert.equal(parseAnswer(reply({ choice: 'tap:e2', confidence: 0.9 }, 'no'), request), undefined)
    assert.equal(parseAnswer(reply({ choice: 'tap:e2', confidence: 0.9 }), request)?.action, 'tap:e2')
    assert.equal(parseAnswer(reply({ choice: 'tap:e2', confidence: 0.9 }, { probability: 0.92 }), request)?.goalMet, 0.92)
  })

  it('takes the answer a reply settles on after correcting itself', () => {
    const reply =
      '{"next_action": {"choice": "STUCK", "confidence": 0.05}, "goal_met": 0.93}\n\n' +
      'Wait, I must output a valid single object with a sensible choice. Corrected:\n\n' +
      '{"next_action": {"choice": "tap:e2", "confidence": 0.2}, "goal_met": 0.93}'
    assert.equal(parseAnswer(reply, request)?.action, 'tap:e2')
  })

  it('asks again rather than take an answer the reply took back', () => {
    const reply =
      '{"next_action": {"choice": "tap:e2", "confidence": 0.8}, "goal_met": 0.1}\n\n' +
      'Wait, wrong. {"next_action": {"choice": "tap:e7", "confidence": 0.9}, "goal_met": 0.1}'
    assert.equal(parseAnswer(reply, request), undefined)
  })

  it('skips braces in prose and in strings', () => {
    const reply = 'Using {braces} loosely: {"next_action": {"choice": "tap:e2", "confidence": 0.6}, "goal_met": 0.1, "note": "a } in a string"} done.'
    assert.equal(parseAnswer(reply, request)?.action, 'tap:e2')
    assert.equal(parseAnswer('{"next_action": {"choice": "tap:e2", "confidence": 0.6}, "goal_met": 0.1', request), undefined)
  })

  it('leaves out a fill whose answer is not valid', () => {
    const answer = parseAnswer(
      JSON.stringify({ next_action: { choice: 'tap:e2', confidence: 0.6 }, goal_met: 0, fill_e1: { choice: 'password', confidence: 0.9 } }),
      request,
    )
    assert.deepEqual(answer?.fills, {})
  })
})

describe('cliEnvironment', () => {
  it('keeps keys, other clouds and effort overrides away from the CLI', () => {
    const env = cliEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/someone',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'https://example.com',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      TYPESAFE_API_KEY: 'k',
      OPENAI_API_KEY: 'k',
      CLAUDECODE: '1',
    })
    assert.deepEqual(Object.keys(env).sort(), [
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'DISABLE_PROMPT_CACHING',
      'HOME',
      'MAX_THINKING_TOKENS',
      'PATH',
    ])
    assert.equal(env.DISABLE_PROMPT_CACHING, '1')
  })
})
