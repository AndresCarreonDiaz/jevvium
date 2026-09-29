import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JevProvider } from '../src/providers/jev.ts'
import { STUCK, type DecisionRequest } from '../src/providers/types.ts'

const request: DecisionRequest = {
  platform: 'android',
  goal: 'Log in',
  screenText: ['Login / Sign up Form'],
  actions: [
    { key: 'type:e1:email', description: 'Type the test data "email" into the field "Email"' },
    { key: 'tap:e2', description: 'Tap the button "LOGIN"' },
  ],
  history: [],
  inputNames: ['email'],
}

const answer = {
  model: 'jev-1.13.0',
  answers: {
    next_action: { type: 'choice', choice: 'type:e1:email', probabilities: { 'type:e1:email': 0.82, 'tap:e2': 0.15, STUCK: 0.03 }, confidence: 0.82 },
    goal_met: { type: 'noul', noul: 0.02 },
  },
  usage: { input_tokens: 410, output_tokens: 12 },
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

describe('JevProvider', () => {
  it('asks both questions in one request and maps the answer', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const provider = new JevProvider({
      apiKey: 'test-key',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! })
        return json(200, answer)
      },
    })

    const decision = await provider.decide(request)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer test-key')
    const body = JSON.parse(calls[0].init.body as string)
    assert.equal(body.model, 'jev-latest')
    assert.equal(body.questions.next_action.type, 'choice')
    assert.deepEqual(Object.keys(body.questions.next_action.criteria), ['type:e1:email', 'tap:e2', STUCK])
    assert.equal(body.questions.goal_met.type, 'noul')
    assert.deepEqual(body.state.test_data_available, ['email'])

    assert.equal(decision.action, 'type:e1:email')
    assert.equal(decision.confidence, 0.82)
    assert.equal(decision.goalMet, 0.02)
    assert.equal(decision.model, 'jev-1.13.0')
    assert.deepEqual(decision.usage, { inputTokens: 410, outputTokens: 12 })
  })

  it('backs off and retries when rate limited or overloaded', async () => {
    const statuses = [429, 529, 200]
    const waits: number[] = []
    const provider = new JevProvider({
      apiKey: 'k',
      fetch: async () => {
        const status = statuses.shift()!
        return status === 200 ? json(200, answer) : json(status, { error: 'busy' })
      },
      sleep: async (ms) => {
        waits.push(ms)
      },
    })

    assert.equal((await provider.decide(request)).action, 'type:e1:email')
    assert.deepEqual(waits, [500, 1000])
  })

  it('fails fast on a validation error', async () => {
    const provider = new JevProvider({ apiKey: 'k', fetch: async () => json(422, { error: 'bad criteria' }) })
    await assert.rejects(provider.decide(request), /422/)
  })

  it('refuses to start without an API key', () => {
    const saved = process.env.TYPESAFE_API_KEY
    delete process.env.TYPESAFE_API_KEY
    try {
      assert.throws(() => new JevProvider(), /TYPESAFE_API_KEY/)
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved
    }
  })
})
