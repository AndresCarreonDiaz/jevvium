import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { blankFrame } from '../src/frames.ts'
import { buildLookBody, JevProvider } from '../src/providers/jev.ts'
import { STUCK, type DecisionRequest } from '../src/providers/types.ts'

const request: DecisionRequest = {
  platform: 'android',
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
  model: 'jev-1.13.0',
  answers: {
    next_action: { type: 'choice', choice: 'type:e1:email', probabilities: { 'type:e1:email': 0.82, 'tap:e2': 0.15, STUCK: 0.03 }, confidence: 0.82 },
    goal_met: { type: 'noul', noul: 0.02 },
    fill_e1: { type: 'choice', choice: 'email', probabilities: { email: 0.97, leave_empty: 0.03 }, confidence: 0.95 },
  },
  usage: { input_tokens: 410, output_tokens: 12 },
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

describe('JevProvider', () => {
  // The defaults are what these tests check, so a model or endpoint exported in the shell can't change them.
  const saved: Record<string, string | undefined> = {}
  before(() => {
    for (const name of ['JEVVIUM_MODEL', 'JEVVIUM_VISION_MODEL', 'TYPESAFE_API_URL']) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
  })
  after(() => {
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value
  })

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
    // A version, not an alias, so a model release can't change the paths a plan explores.
    assert.equal(body.model, 'jev-1.13.0')
    assert.equal(body.questions.next_action.type, 'choice')
    assert.deepEqual(Object.keys(body.questions.next_action.criteria), ['type:e1:email', 'tap:e2', STUCK])
    assert.equal(body.questions.goal_met.type, 'noul')
    assert.deepEqual(body.state.test_data_available, ['email'])
    assert.equal(body.questions.fill_e1.type, 'choice')
    assert.deepEqual(Object.keys(body.questions.fill_e1.criteria), ['email', 'leave_empty'])

    assert.equal(decision.action, 'type:e1:email')
    assert.equal(decision.confidence, 0.82)
    assert.equal(decision.goalMet, 0.02)
    assert.deepEqual(decision.fills, { e1: { input: 'email', confidence: 0.95 } })
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

  it('sends no image and no image header with a decision', async () => {
    const calls: RequestInit[] = []
    const provider = new JevProvider({ apiKey: 'k', fetch: async (_url, init) => (calls.push(init!), json(200, answer)) })
    await provider.decide(request)
    const body = JSON.parse(calls[0].body as string)
    assert.equal(body.assets, undefined)
    assert.equal((calls[0].headers as Record<string, string>)['TypeSafe-Danger-Zone-Images'], undefined)
  })

  it('looks with the screenshot once in the state, the image header, the vision model and a box', async () => {
    const calls: RequestInit[] = []
    const looked = {
      model: 'jev-1.14.0',
      answers: {
        ...answer.answers,
        target_shown: { type: 'noul', noul: 0.93 },
        target: { type: 'box', box: { top: 0.9, bottom: 0.96, left: 0.31, right: 0.35 }, confidence: 0.57 },
      },
      usage: { input_tokens: 1807, output_tokens: 150 },
    }
    const provider = new JevProvider({ apiKey: 'k', fetch: async (_url, init) => (calls.push(init!), json(200, looked)) })
    const frame = await blankFrame()
    const look = await provider.look(request, frame)

    const body = JSON.parse(calls[0].body as string)
    assert.equal((calls[0].headers as Record<string, string>)['TypeSafe-Danger-Zone-Images'], 'true')
    assert.equal(body.model, 'jev-1.14.0')
    const refs = Object.keys(body.assets)
    assert.equal(refs.length, 1)
    assert.equal(body.state.screen, refs[0])
    assert.deepEqual(body.assets[refs[0]], { type: 'image', format: 'jpg', data_base64: frame.jpeg.toString('base64') })
    // The questions name the screenshot by its state key; the reference itself appears once, or the image is sent again.
    assert.equal(JSON.stringify(body).split(refs[0]).length - 1, 2)
    assert.match(body.questions.next_action.instructions, /`screen`/)
    assert.equal(body.questions.target_shown.type, 'noul')
    assert.equal(body.questions.target.type, 'box')
    assert.equal(body.questions.target.criteria, undefined)

    assert.equal(look.targetShown, 0.93)
    assert.deepEqual(look.box, { top: 0.9, bottom: 0.96, left: 0.31, right: 0.35, confidence: 0.57 })
    assert.equal(look.decision.action, 'type:e1:email')
    assert.equal(look.decision.model, 'jev-1.14.0')
    assert.deepEqual(look.decision.usage, { inputTokens: 1807, outputTokens: 150 })
  })

  it('drops a box whose edges are out of order or out of range', async () => {
    const bad = { ...answer, answers: { ...answer.answers, target_shown: { type: 'noul', noul: 0.9 }, target: { type: 'box', box: { top: 0.5, bottom: 0.4, left: 0.1, right: 0.2 } } } }
    const provider = new JevProvider({ apiKey: 'k', fetch: async () => json(200, bad) })
    assert.equal((await provider.look(request, await blankFrame())).box, undefined)
  })

  it('asks about the plan step in the look questions when there is a plan', async () => {
    const body = buildLookBody({ ...request, plan: { steps: ['Open the Login tab', 'Log in'], current: 2 } }, 'jev-1.14.0', await blankFrame())
    assert.match(body.questions.target.instructions, /this step of the test plan: "Log in"/)
    assert.match(body.questions.target_shown.instructions, /visible in the screenshot `screen`/)
  })

  it('checks the vision model with a frame and a box question when looking is on, and explains a refusal', async () => {
    const bodies: { model: string; questions: Record<string, { type: string }> }[] = []
    const ok = new JevProvider({ apiKey: 'k', fetch: async (_url, init) => (bodies.push(JSON.parse(init!.body as string)), json(200, answer)) })
    await ok.check({ vision: true })
    assert.deepEqual(bodies.map((b) => b.model), ['jev-1.13.0', 'jev-1.14.0'])
    assert.equal(Object.values(bodies[1].questions)[0].type, 'box')

    let calls = 0
    const old = new JevProvider({
      apiKey: 'k',
      visionModel: 'jev-1.13.0',
      fetch: async () => (calls++ === 0 ? json(200, answer) : json(400, { detail: { message: 'Invalid request.' } })),
    })
    await assert.rejects(old.check({ vision: true }), /jev-1\.13\.0 \(from JEVVIUM_VISION_MODEL\).*Jev 1\.14 or later/)
  })
})

