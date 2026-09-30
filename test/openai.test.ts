import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildBody } from '../src/providers/jev.ts'
import { buildDecisionsBody, OpenAIDecisionsProvider } from '../src/providers/openai.ts'
import { STUCK, type DecisionRequest } from '../src/providers/types.ts'

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

const answer = {
  model: 'gpt-6-luna-2026-09-29',
  answers: [
    {
      choice: 'type:e1:email',
      probabilities: [
        { value: 'type:e1:email', probability: 0.9 },
        { value: 'tap:e2', probability: 0.08 },
        { value: STUCK, probability: 0.02 },
      ],
      confidence: 0.88,
    },
    { probability: 0.03 },
    { choice: 'email', probabilities: [{ value: 'email', probability: 0.97 }, { value: 'leave_empty', probability: 0.03 }] },
  ],
  usage: { input_tokens: 520, output_tokens: 3 },
}

describe('OpenAIDecisionsProvider', () => {
  it('asks the same questions as Jev in one request and maps the ordered answers', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const provider = new OpenAIDecisionsProvider({
      apiKey: 'test-key',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! })
        return new Response(JSON.stringify(answer), { status: 200 })
      },
    })

    const decision = await provider.decide(request)

    assert.equal(calls[0].url, 'https://api.openai.com/v1/decisions')
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer test-key')
    const body = JSON.parse(calls[0].init.body as string)
    assert.equal(body.model, 'gpt-6-luna')
    assert.deepEqual(JSON.parse(body.input).test_data_available, ['email'])
    assert.deepEqual(
      body.questions.map((q: { type: string; name: string }) => `${q.type} ${q.name}`),
      ['choice next_action', 'predicate goal_met', 'choice fill_e1'],
    )
    assert.deepEqual(body.questions[0].choices.map((c: { value: string }) => c.value), ['type:e1:email', 'tap:e2', STUCK])

    assert.equal(decision.action, 'type:e1:email')
    assert.equal(decision.confidence, 0.88)
    assert.equal(decision.probabilities.STUCK, 0.02)
    assert.equal(decision.goalMet, 0.03)
    assert.deepEqual(decision.fills, { e1: { input: 'email', confidence: 0.97 } })
    assert.deepEqual(decision.usage, { inputTokens: 520, outputTokens: 3 })
  })

  it('is asked everything Jev is asked, in the same words', () => {
    const strings = (value: unknown): string[] =>
      typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
    const jev = buildBody(request, 'jev-latest')
    const openai = JSON.stringify(buildDecisionsBody(request, 'gpt-6-luna'))
    const wording = [...strings(jev.questions), ...strings(jev.state)].filter((text) => !['choice', 'noul'].includes(text))
    for (const text of wording) assert.ok(openai.includes(JSON.stringify(text).slice(1, -1)), `missing: ${text}`)
  })

  it('refuses a key with a line break, without repeating it', () => {
    assert.throws(() => new OpenAIDecisionsProvider({ apiKey: 'sk-secret\nOPENAI_API_KEY=' }), (error: Error) => {
      assert.match(error.message, /line break/)
      assert.ok(!error.message.includes('sk-secret'))
      return true
    })
  })

  it('says what came back when the answer has an unexpected shape', async () => {
    const provider = new OpenAIDecisionsProvider({ apiKey: 'test-key', fetch: async () => new Response(JSON.stringify({ model: 'x', output: [] })) })
    await assert.rejects(provider.decide(request), /without an answers list \(got model, output\)/)
  })

  it('retries when rate limited and reports other failures', async () => {
    let calls = 0
    const provider = new OpenAIDecisionsProvider({
      apiKey: 'test-key',
      sleep: async () => {},
      fetch: async () => (++calls === 1 ? new Response('slow down', { status: 429 }) : new Response('bad question', { status: 400 })),
    })
    await assert.rejects(provider.decide(request), /failed with 400: bad question/)
    assert.equal(calls, 2)
  })
})
