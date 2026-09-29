import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { generateSpec } from '../src/codegen.ts'
import type { Device } from '../src/device.ts'
import { explore } from '../src/explorer.ts'
import { toSelector } from '../src/locator.ts'
import { STUCK, type Decision, type DecisionProvider, type DecisionRequest } from '../src/providers/types.ts'
import type { Criterion, Locator } from '../src/types.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8')

const criterion: Criterion = {
  id: 'login',
  goal: 'A user logs in and is told they are logged in.',
  inputs: { email: 'qa.demo@example.com', password: 'Str0ngPassw0rd' },
  expect: [{ text: 'You are logged in!' }],
}

/** The demo app's login flow, driven by the real iOS page sources. */
class FakeApp implements Device {
  readonly platform = 'ios' as const
  screen: 'ios-home' | 'ios-login' | 'ios-login-success' = 'ios-home'
  typed: Record<string, string> = {}
  loginWorks = true

  async pageSource() {
    return fixture(this.screen)
  }
  async tap(locator: Locator) {
    const selector = toSelector(locator)
    if (selector === '~Login') this.screen = 'ios-login'
    if (selector === '~button-LOGIN' && this.typed['~input-email'] && this.typed['~input-password']) {
      if (this.loginWorks) this.screen = 'ios-login-success'
    }
  }
  async type(locator: Locator, value: string) {
    this.typed[toSelector(locator)] = value
  }
  async isDisplayed(locator: Locator) {
    return this.screen === 'ios-login-success' && toSelector(locator).includes('You are logged in!')
  }
}

/** A provider that follows a script and records what it was asked. */
class ScriptedProvider implements DecisionProvider {
  readonly name = 'scripted'
  readonly requests: DecisionRequest[] = []
  constructor(private readonly pick: (request: DecisionRequest) => Partial<Decision> & { action: string }) {}

  async decide(request: DecisionRequest): Promise<Decision> {
    this.requests.push(structuredClone(request))
    return { confidence: 0.9, probabilities: {}, goalMet: 0, model: 'scripted-1', latencyMs: 1, ...this.pick(request) }
  }
}

/** Picks the action whose description mentions `text`. */
const find = (request: DecisionRequest, text: string) => {
  const match = request.actions.find((a) => a.description.includes(text))
  assert.ok(match, `no action mentions ${text}`)
  return match.key
}

const happyPath = (request: DecisionRequest) => {
  if (request.screenText.includes('You are logged in!')) return { action: STUCK, goalMet: 0.97 }
  if (request.history.length === 0) return { action: find(request, 'button "Login" (bottom') }
  if (request.history.length === 1) return { action: find(request, 'test data "email" into the field "Email"') }
  if (request.history.length === 2) return { action: find(request, 'test data "password" into the field "Password"') }
  return { action: find(request, '"LOGIN"') }
}

const options = { settleTimeoutMs: 0 }

describe('explore', () => {
  it('reaches the goal, confirms it with the expectations and records every step', async () => {
    const app = new FakeApp()
    const trace = await explore(app, criterion, { ...options, provider: new ScriptedProvider(happyPath) })

    assert.equal(trace.outcome, 'passed')
    assert.deepEqual(
      trace.steps.map((s) => s.taken?.selector),
      // "Login" is unique on the home screen, so the plain accessibility id is used there.
      ['~Login', '~input-email', '~input-password', '~button-LOGIN', undefined],
    )
    assert.deepEqual(app.typed, { '~input-email': 'qa.demo@example.com', '~input-password': 'Str0ngPassw0rd' })
  })

  it('never sends test data values to the provider or writes them to the trace', async () => {
    const provider = new ScriptedProvider(happyPath)
    const trace = await explore(new FakeApp(), criterion, { ...options, provider })

    for (const value of Object.values(criterion.inputs)) {
      assert.ok(!JSON.stringify(provider.requests).includes(value), `request leaked ${value}`)
      assert.ok(!JSON.stringify(trace).includes(value), `trace leaked ${value}`)
    }
    assert.deepEqual(provider.requests[0].inputNames, ['email', 'password'])
  })

  it('fails when the model thinks the goal is reached but an expectation does not hold', async () => {
    const app = new FakeApp()
    const provider = new ScriptedProvider((request) =>
      request.history.length === 4 ? { action: STUCK, goalMet: 0.9 } : happyPath(request),
    )
    app.loginWorks = false
    const trace = await explore(app, criterion, { ...options, provider })

    assert.equal(trace.outcome, 'failed')
    assert.deepEqual(trace.failedExpectations, [{ text: 'You are logged in!' }])
  })

  it('escalates instead of guessing when confidence is low', async () => {
    const provider = new ScriptedProvider((request) => ({ action: request.actions[0].key, confidence: 0.3 }))
    const trace = await explore(new FakeApp(), criterion, { ...options, provider, minConfidence: 0.5 })

    assert.equal(trace.outcome, 'escalated')
    assert.equal(trace.steps.length, 1)
    assert.equal(trace.steps[0].taken, undefined)
  })

  it('stops when the model is stuck', async () => {
    const trace = await explore(new FakeApp(), criterion, { ...options, provider: new ScriptedProvider(() => ({ action: STUCK })) })
    assert.equal(trace.outcome, 'stuck')
  })

  it('stops when the same action keeps being chosen on an unchanged screen', async () => {
    const provider = new ScriptedProvider((request) => ({ action: find(request, '"Home"') }))
    const trace = await explore(new FakeApp(), criterion, { ...options, provider })

    assert.equal(trace.outcome, 'stuck')
    assert.equal(trace.steps.filter((s) => s.taken).length, 2)
  })

  it('gives up after the step limit', async () => {
    let i = 0
    const provider = new ScriptedProvider((request) => ({ action: request.actions[i++ % 3].key }))
    const trace = await explore(new FakeApp(), criterion, { ...options, provider, maxSteps: 3 })

    assert.equal(trace.outcome, 'gave-up')
    assert.equal(trace.steps.filter((s) => s.taken).length, 3)
  })

  it('produces a trace that generates a deterministic spec', async () => {
    const trace = await explore(new FakeApp(), criterion, { ...options, provider: new ScriptedProvider(happyPath) })

    assert.equal(
      generateSpec(trace, criterion),
      [
        '// Generated by jevvium from the "login" criterion on ios (scripted-1).',
        '// It is a normal test: review it and edit it like any other code.',
        "import { $, expect } from '@wdio/globals'",
        '',
        "describe('login', () => {",
        "  it('A user logs in and is told they are logged in.', async () => {",
        "    await $('~Login').click()",
        "    await $('~input-email').setValue('qa.demo@example.com')",
        "    await $('~input-password').setValue('Str0ngPassw0rd')",
        "    await $('~button-LOGIN').click()",
        `    await expect($('-ios predicate string:label == "You are logged in!"')).toBeDisplayed()`,
        '  })',
        '})',
        '',
      ].join('\n'),
    )
  })

  it('refuses to generate a spec from a run that did not pass', async () => {
    const trace = await explore(new FakeApp(), criterion, { ...options, provider: new ScriptedProvider(() => ({ action: STUCK })) })
    assert.throws(() => generateSpec(trace, criterion), /Only passing runs/)
  })
})
