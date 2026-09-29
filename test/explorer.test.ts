import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { generateSpec } from '../src/codegen.ts'
import { fingerprintOf, type Device } from '../src/device.ts'
import { explore } from '../src/explorer.ts'
import { toSelector } from '../src/locator.ts'
import { STUCK, type Decision, type DecisionProvider, type DecisionRequest } from '../src/providers/types.ts'
import type { Criterion, Locator, ScreenElement } from '../src/types.ts'

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
    // What was typed shows in the real page source; the fixtures are fixed, so it goes in a comment.
    return `${fixture(this.screen)}<!-- ${JSON.stringify(this.typed)} -->`
  }
  async tap({ locator }: ScreenElement) {
    const selector = toSelector(locator)
    if (selector === '~Login') this.screen = 'ios-login'
    if (selector === '~button-LOGIN' && this.typed['~input-email'] && this.typed['~input-password']) {
      if (this.loginWorks) this.screen = 'ios-login-success'
    }
  }
  async type({ locator }: ScreenElement, value: string) {
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
  private readonly pick: (request: DecisionRequest) => Partial<Decision> & { action: string }
  constructor(pick: (request: DecisionRequest) => Partial<Decision> & { action: string }) {
    this.pick = pick
  }

  async decide(request: DecisionRequest): Promise<Decision> {
    this.requests.push(structuredClone(request))
    return { confidence: 0.9, probabilities: {}, goalMet: 0, fills: {}, model: 'scripted-1', latencyMs: 1, ...this.pick(request) }
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
      trace.steps.map((s) => s.taken?.[0].selector),
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

  it('passes when the expectations hold even though the model was unsure', async () => {
    const provider = new ScriptedProvider((request) =>
      request.history.length === 4 ? { action: STUCK, goalMet: 0.4 } : happyPath(request),
    )
    const trace = await explore(new FakeApp(), criterion, { ...options, provider })

    assert.equal(trace.outcome, 'passed')
    assert.match(trace.reason, /model was unsure/)
  })

  it('fills a whole form from one decision when the model is sure where each input goes', async () => {
    const app = new FakeApp()
    const provider = new ScriptedProvider((request) => {
      if (request.screenText.includes('You are logged in!')) return { action: STUCK, goalMet: 0.97 }
      if (request.history.length === 0) return { action: find(request, 'button "Login" (bottom') }
      if (request.history.length === 1) {
        return {
          action: find(request, 'test data "email" into the field "Email"'),
          fills: { e3: { input: 'email', confidence: 0.95 }, e4: { input: 'password', confidence: 0.9 } },
        }
      }
      return { action: find(request, '"LOGIN"') }
    })
    const trace = await explore(app, criterion, { ...options, provider })

    assert.equal(trace.outcome, 'passed')
    assert.deepEqual(provider.requests[1].fields.map((f) => f.key), ['e3', 'e4'])
    assert.deepEqual(trace.steps[1].taken?.map((t) => t.selector), ['~input-email', '~input-password'])
    assert.equal(trace.steps.length, 4, 'one decision fewer than filling field by field')
    assert.deepEqual(app.typed, { '~input-email': 'qa.demo@example.com', '~input-password': 'Str0ngPassw0rd' })
  })

  it('leaves other fields alone when the model is unsure what goes in them', async () => {
    const provider = new ScriptedProvider((request) =>
      request.history.length === 1
        ? { action: find(request, 'test data "email" into the field "Email"'), fills: { e4: { input: 'password', confidence: 0.3 } } }
        : request.history.length === 0
          ? { action: find(request, 'button "Login" (bottom') }
          : { action: STUCK },
    )
    const trace = await explore(new FakeApp(), criterion, { ...options, provider })
    assert.deepEqual(trace.steps[1].taken?.map((t) => t.selector), ['~input-email'])
  })

  it('throws away a decision made on a screen that was still changing', async () => {
    const app = new (class extends FakeApp {
      reads = 0
      async fingerprint() {
        // The first stability check sees the screen mid-transition; after that it has settled.
        return ++this.reads === 2 ? 'mid-transition' : fingerprintOf(await this.pageSource(), 'ios')
      }
    })()
    const trace = await explore(app, criterion, { provider: new ScriptedProvider(happyPath), settleTimeoutMs: 5_000 })

    assert.equal(trace.outcome, 'passed')
    assert.equal(trace.discardedDecisions, 1)
  })

  it('asks again without an element that turns out to be covered', async () => {
    const app = new (class extends FakeApp {
      async fingerprint() {
        return fingerprintOf(await this.pageSource(), 'ios')
      }
      async isVisible(locator: Locator) {
        return toSelector(locator) !== '~Login'
      }
    })()
    const provider = new ScriptedProvider((request) => {
      const login = request.actions.find((a) => a.description.includes('"Login"'))
      return { action: login?.key ?? STUCK }
    })
    const trace = await explore(app, criterion, { ...options, provider })

    assert.equal(trace.outcome, 'stuck')
    assert.equal(trace.discardedDecisions, 1)
    assert.ok(!provider.requests[1].actions.some((a) => a.description.includes('"Login"')), 'the covered element is left out')
    assert.equal(app.screen, 'ios-home', 'nothing was tapped')
  })

  it('escalates instead of guessing when confidence is low', async () => {
    const provider = new ScriptedProvider((request) => ({ action: request.actions[0].key, confidence: 0.1 }))
    const trace = await explore(new FakeApp(), criterion, { ...options, provider })

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

  it('keeps test data out of the trace, and the spec gets it back', async () => {
    // An account chooser: a button whose name carries the email the flow uses.
    const chooser = fixture('ios-home').replace(
      'name="Webview" label="Webview"',
      'name="Continue as qa.demo@example.com" label="Continue as qa.demo@example.com"',
    )
    const app = new (class extends FakeApp {
      async pageSource() {
        return this.screen === 'ios-home' ? chooser : fixture(this.screen)
      }
      async tap({ locator }: ScreenElement) {
        if (toSelector(locator) === '~Continue as qa.demo@example.com') this.screen = 'ios-login-success'
      }
    })()
    const withEmail: Criterion = { ...criterion, goal: 'Log in as qa.demo@example.com and be told so' }
    const provider = new ScriptedProvider((request) =>
      request.screenText.includes('You are logged in!')
        ? { action: STUCK, goalMet: 0.97 }
        : { action: find(request, 'Continue as {email}') },
    )
    const trace = await explore(app, withEmail, { ...options, provider })

    assert.equal(trace.outcome, 'passed')
    assert.ok(!JSON.stringify(trace).toLowerCase().includes('qa.demo@example.com'), 'the trace holds no test data')
    assert.ok(!JSON.stringify(provider.requests).includes('qa.demo@example.com'), 'the requests hold no test data')
    assert.equal(trace.criterion.goal, 'Log in as {email} and be told so')
    assert.equal(trace.steps[0].taken?.[0].selector, '~Continue as {email}')
    assert.match(generateSpec(trace, withEmail), /\$\('~Continue as qa\.demo@example\.com'\)\.click\(\)/)
  })

  it('asks at most one extra time while the screen keeps changing', async () => {
    const app = new (class extends FakeApp {
      reads = 0
      async fingerprint() {
        return `${fingerprintOf(await this.pageSource(), 'ios')}<!-- read ${this.reads++} -->`
      }
    })()
    const provider = new ScriptedProvider(() => ({ action: STUCK, usage: { inputTokens: 100, outputTokens: 10 } }))
    const trace = await explore(app, criterion, { provider, settleTimeoutMs: 400 })

    assert.equal(provider.requests.length, 2)
    assert.equal(trace.discardedDecisions, 1)
    assert.deepEqual(trace.usage, { requests: 2, inputTokens: 200, outputTokens: 20 })
  })

  it('offers a covered element again once the screen changes', async () => {
    const app = new (class extends FakeApp {
      covered = true
      async fingerprint() {
        return fingerprintOf(await this.pageSource(), 'ios') + (this.covered ? '' : '<!-- the toast is gone -->')
      }
      async isVisible(locator: Locator) {
        if (toSelector(locator) !== '~Login' || !this.covered) return true
        this.covered = false // a toast covered the tab, then went away
        return false
      }
    })()
    const provider = new ScriptedProvider((request) =>
      request.history.length === 0 && !request.actions.some((a) => a.description.includes('button "Login" (bottom'))
        ? { action: STUCK }
        : happyPath(request),
    )
    const trace = await explore(app, criterion, { provider, settleTimeoutMs: 1_000 })

    assert.equal(trace.outcome, 'passed')
    assert.ok(!provider.requests[1].actions.some((a) => a.description.includes('button "Login" (bottom')))
    assert.ok(provider.requests[2].actions.some((a) => a.description.includes('button "Login" (bottom')))
  })

  it('waits for direct input to reach the app before reading the screen again', async () => {
    // Direct input lands a moment after it is sent: until then the app shows, and settles on, the old screen.
    const app = new (class extends FakeApp {
      readonly input = 'simulator' as const
      async tap(element: ScreenElement) {
        setTimeout(() => void super.tap(element), 300)
      }
    })()
    const trace = await explore(app, criterion, { ...options, provider: new ScriptedProvider(happyPath) })
    assert.equal(trace.outcome, 'passed')
    // Each decision saw the screen the previous action led to, so none was repeated or lost.
    assert.deepEqual(trace.steps.map((step) => step.taken?.[0].target ?? 'done'), ['Login', 'Email', 'Password', 'LOGIN', 'done'])
  })

  it('stops instead of looping when the chosen element stays covered on a changing screen', async () => {
    // A countdown changes the screen on every read; XCTest lets "Login" back in when the
    // screen changes, then finds it covered again when it is about to be tapped.
    const app = new (class extends FakeApp {
      ticks = 0
      checks = 0
      async pageSource() {
        return (await super.pageSource()).replace(/"Support"/g, `"Support ${this.ticks++}s"`)
      }
      async fingerprint() {
        return fingerprintOf(await this.pageSource(), 'ios')
      }
      async isVisible(locator: Locator) {
        return toSelector(locator) !== '~Login' || ++this.checks % 2 === 0
      }
    })()
    const provider = new ScriptedProvider((request) => {
      const login = request.actions.find((a) => a.description.includes('"Login"'))
      return { action: login?.key ?? STUCK }
    })
    const trace = await explore(app, criterion, { provider, settleTimeoutMs: 200 })

    assert.equal(trace.outcome, 'stuck')
    assert.match(trace.reason, /stays covered/)
    assert.ok(provider.requests.length <= 6, `${provider.requests.length} requests`)
    assert.equal(app.screen, 'ios-home', 'nothing was tapped')
  })

  it('leaves a covered element out while XCTest still reports it covered, however the screen changes', async () => {
    const app = new (class extends FakeApp {
      ticks = 0
      async pageSource() {
        return (await super.pageSource()).replace(/"Support"/g, `"Support ${this.ticks++}s"`)
      }
      async fingerprint() {
        return fingerprintOf(await this.pageSource(), 'ios')
      }
      async isVisible(locator: Locator) {
        return toSelector(locator) !== '~Login'
      }
    })()
    const provider = new ScriptedProvider((request) => {
      const login = request.actions.find((a) => a.description.includes('"Login"'))
      return { action: login?.key ?? STUCK }
    })
    const trace = await explore(app, criterion, { provider, settleTimeoutMs: 200 })

    assert.equal(trace.outcome, 'stuck')
    // Two decisions to pick "Login", then two to find nothing else: each first answer is
    // thrown away because the countdown changed the screen meanwhile.
    assert.equal(provider.requests.length, 4)
  })

  it('keeps test data out of the reason when something breaks mid-run', async () => {
    const app = new (class extends FakeApp {
      async tap() {
        throw new Error(`Can't call click on element with selector "~Continue as ${criterion.inputs.email}"\nat tap`)
      }
    })()
    const trace = await explore(app, criterion, { ...options, provider: new ScriptedProvider(happyPath) })
    assert.equal(trace.outcome, 'error')
    assert.equal(trace.reason, `Can't call click on element with selector "~Continue as {email}"`)
  })

  it('keeps the criterion id on the spec header comment line', async () => {
    const odd = { ...criterion, id: 'login\u2028globalThis.injected = true' }
    const trace = await explore(new FakeApp(), odd, { ...options, provider: new ScriptedProvider(happyPath) })
    const spec = generateSpec(trace, odd)
    assert.ok(!spec.includes('\u2028'), 'no raw line separator')
    assert.match(spec.split('\n')[0], /^\/\/ Generated by jevvium from the "login globalThis\.injected = true" criterion/)
  })

  it('skips a form field that turns out to be covered', async () => {
    const app = new (class extends FakeApp {
      async fingerprint() {
        return fingerprintOf(await this.pageSource(), 'ios')
      }
      async isVisible(locator: Locator) {
        return toSelector(locator) !== '~input-password'
      }
    })()
    const provider = new ScriptedProvider((request) => {
      if (request.history.length === 0) return { action: find(request, 'button "Login" (bottom') }
      if (request.history.length === 1) {
        return {
          action: find(request, 'test data "email" into the field "Email"'),
          fills: { e3: { input: 'email', confidence: 0.95 }, e4: { input: 'password', confidence: 0.95 } },
        }
      }
      return { action: STUCK }
    })
    const trace = await explore(app, criterion, { ...options, provider })
    assert.deepEqual(trace.steps[1].taken?.map((t) => t.selector), ['~input-email'])
  })

  it('writes an error trace when something breaks mid-run', async () => {
    const provider = new ScriptedProvider(() => {
      throw new Error('the provider is down')
    })
    const trace = await explore(new FakeApp(), criterion, { ...options, provider })
    assert.equal(trace.outcome, 'error')
    assert.match(trace.reason, /the provider is down/)
  })

  it('refuses to write a spec from a criteria file that differs from the explored one', async () => {
    const trace = await explore(new FakeApp(), criterion, { ...options, provider: new ScriptedProvider(happyPath) })
    assert.throws(() => generateSpec(trace, { ...criterion, expect: [{ text: 'Something else' }] }), /doesn't match/)
  })
})
