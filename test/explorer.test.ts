import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import sharp from 'sharp'
import { generateSpec } from '../src/codegen.ts'
import { fingerprintOf, type Device } from '../src/device.ts'
import { explore, pointedAt, useLook } from '../src/explorer.ts'
import type { PreparedFrame } from '../src/frames.ts'
import { toSelector } from '../src/locator.ts'
import { STUCK, type Box, type Decision, type DecisionProvider, type DecisionRequest, type Look } from '../src/providers/types.ts'
import { sentLine } from '../src/run-report.ts'
import { parseScreen } from '../src/screen.ts'
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
  screen: string = 'ios-home'
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
  it('records when each step ended', async () => {
    const trace = await explore(new FakeApp(), criterion, { ...options, provider: new ScriptedProvider(happyPath) })
    const times = trace.steps.map((step) => step.atMs)
    assert.ok(times.every((at, i) => at >= 0 && at <= trace.durationMs && (i === 0 || at >= times[i - 1])), JSON.stringify(times))
  })

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
      async pageSource() {
        return (await super.pageSource()) + (this.covered ? '' : '<!-- the toast is gone -->')
      }
      async fingerprint() {
        return fingerprintOf(await this.pageSource(), 'ios')
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
    assert.equal(trace.discardedDecisions, 1, 'only the decision that picked the covered tab')
    // The screen had changed by the next read, and XCTest let the tab back in.
    assert.ok(provider.requests[1].actions.some((a) => a.description.includes('button "Login" (bottom')))
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

  it('sends taps through Appium once a direct tap has changed nothing', async () => {
    // Some simulators drop direct taps. The model picks the same tap again, and that one goes through Appium.
    const app = new (class extends FakeApp {
      direct = true
      notes: string[] = []
      get input() {
        return this.direct ? ('simulator' as const) : ('appium' as const)
      }
      async tap(element: ScreenElement) {
        if (!this.direct) await super.tap(element)
      }
      fallBackToAppium(reason: string) {
        this.direct = false
        this.notes.push(reason)
      }
      drainNotes() {
        return this.notes.splice(0)
      }
    })()
    const byScreen = (request: DecisionRequest) => {
      if (request.screenText.includes('You are logged in!')) return { action: STUCK, goalMet: 0.97 }
      if (!request.screenText.includes('Login / Sign up Form')) return { action: find(request, 'button "Login" (bottom') }
      const done = request.history.join('\n')
      if (!done.includes('"email"')) return { action: find(request, 'test data "email" into the field "Email"') }
      if (!done.includes('"password"')) return { action: find(request, 'test data "password" into the field "Password"') }
      return { action: find(request, '"LOGIN"') }
    }
    const trace = await explore(app, criterion, { ...options, provider: new ScriptedProvider(byScreen) })
    assert.equal(trace.outcome, 'passed')
    // The lost tap is sent again through Appium within the same step, so the path holds it once.
    assert.deepEqual(trace.steps.map((step) => step.taken?.[0].target ?? 'done'), ['Login', 'Email', 'Password', 'LOGIN', 'done'])
    assert.match(trace.steps[0].notes?.join('\n') ?? '', /sent again through Appium, and taps go through Appium from now on/)
    assert.equal((generateSpec(trace, criterion).match(/\$\('~Login'\)\.click\(\)/g) ?? []).length, 1)
  })

  it('does not take a ticking countdown for the effect of a tap that has not landed yet', async () => {
    const app = new (class extends FakeApp {
      readonly input = 'simulator' as const
      started = Date.now()
      async pageSource() {
        // A countdown on screen changes every 100 ms, whatever the taps do.
        const left = 60 - Math.floor((Date.now() - this.started) / 100)
        return (await super.pageSource()).replace(/"Support"/g, `"Resend in ${left}s"`)
      }
      async tap(element: ScreenElement) {
        setTimeout(() => void super.tap(element), 300)
      }
    })()
    const provider = new ScriptedProvider(happyPath)
    const trace = await explore(app, criterion, { ...options, provider })
    assert.equal(trace.outcome, 'passed')
    assert.deepEqual(trace.steps.map((step) => step.taken?.[0].target ?? 'done'), ['Login', 'Email', 'Password', 'LOGIN', 'done'])
  })

  it('stops when the model keeps choosing covered elements whose names keep changing', async () => {
    const app = new (class extends FakeApp {
      ticks = 0
      async pageSource() {
        // "Login" carries a live value in its name, so each read shows a new element.
        return (await super.pageSource()).replace(/"Login"/g, `"Login ${this.ticks++}%"`)
      }
      async fingerprint() {
        return fingerprintOf(await this.pageSource(), 'ios')
      }
      async isVisible(locator: Locator) {
        return !toSelector(locator).includes('Login ')
      }
    })()
    const provider = new ScriptedProvider((request) => ({ action: request.actions.find((a) => a.description.includes('"Login '))?.key ?? STUCK }))
    const trace = await explore(app, criterion, { provider, settleTimeoutMs: 0 })
    assert.equal(trace.outcome, 'stuck')
    assert.match(trace.reason, /covered elements in a row/)
    assert.ok(provider.requests.length <= 8, `${provider.requests.length} requests`)
  })

  it('judges a goal claimed on a fast read again on a full read before calling it a failure', async () => {
    // The fast read shows a success text that a full read marks hidden.
    const hiddenSuccess = fixture('ios-home').replace('</XCUIElementTypeApplication>', '<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="You are logged in!" visible="false" x="20" y="300" width="200" height="20"/></XCUIElementTypeApplication>')
    const app = new (class extends FakeApp {
      async fingerprint() {
        return fingerprintOf(await this.pageSource(), 'ios')
      }
      async pageSource() {
        return this.screen === 'ios-home' ? hiddenSuccess : fixture(this.screen)
      }
    })()
    const provider = new ScriptedProvider((request) =>
      request.screenText.includes('You are logged in!') && request.history.length < 4 && !request.screenText.includes('LOGIN')
        ? { action: STUCK, goalMet: request.screenText.includes('WEBDRIVER') ? 0.95 : 0.97 }
        : happyPath(request),
    )
    const trace = await explore(app, criterion, { ...options, provider })
    assert.equal(trace.outcome, 'passed')
    assert.equal(trace.steps[0].taken, undefined, 'the claim on the fast read took no action')
    assert.ok(!provider.requests[1].screenText.includes('You are logged in!'), 'the full read left the hidden text out')
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

describe('explore with backtracking', () => {
  /** The demo app, where tapping the Forms tab is a wrong turn for the login flow. */
  class WrongTurnApp extends FakeApp {
    restarts = 0
    async tap(element: ScreenElement) {
      if (toSelector(element.locator) === '~Forms') this.screen = 'ios-forms'
      else await super.tap(element)
    }
    async restart() {
      this.restarts++
      this.screen = 'ios-home'
      this.typed = {}
    }
  }

  /** Prefers Forms on the home screen, with Login as the runner-up, and is stuck once there. */
  const wrongTurn = (request: DecisionRequest) => {
    if (request.history.length === 0 && request.actions.some((a) => a.description.includes('"Forms"'))) {
      return { action: find(request, '"Forms"'), probabilities: { [find(request, '"Forms"')]: 0.5, [find(request, 'button "Login" (bottom')]: 0.4 } }
    }
    if (request.screenText.includes('Form components')) return { action: STUCK }
    return happyPath(request)
  }

  it('restarts, replays and takes the runner-up when it dead-ends, and the spec keeps only the final path', async () => {
    const app = new WrongTurnApp()
    const provider = new ScriptedProvider(wrongTurn)
    const trace = await explore(app, criterion, { ...options, provider, restart: () => app.restart() })

    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.equal(app.restarts, 1)
    assert.deepEqual(
      trace.steps.map((s) => [s.index, s.taken?.[0]?.selector, s.undone, s.backtrack?.to, s.retry?.of]),
      [
        [1, '~Forms', true, undefined, undefined],
        [2, undefined, true, 1, undefined],
        [3, '~Login', undefined, undefined, 1],
        [4, '~input-email', undefined, undefined, undefined],
        [5, '~input-password', undefined, undefined, undefined],
        [6, '~button-LOGIN', undefined, undefined, undefined],
        [7, undefined, undefined, undefined, undefined],
      ],
    )
    assert.equal(trace.steps[1].backtrack?.instead, 'Tap the button "Login" (bottom of the screen)')
    // The model is asked about the path the run is on, not the one it abandoned.
    assert.deepEqual(provider.requests[2].history, ['Tap the button "Login" (bottom of the screen)'])
    const spec = generateSpec(trace, criterion)
    assert.ok(!spec.includes('~Forms'), 'the wrong turn is not in the test')
    assert.match(spec, /\$\('~Login'\)\.click\(\)/)
  })

  it('stops at a dead end when nothing can restart the app, or when the runner-up is too unlikely', async () => {
    const stuck = await explore(new WrongTurnApp(), criterion, { ...options, provider: new ScriptedProvider(wrongTurn) })
    assert.equal(stuck.outcome, 'stuck')

    const app = new WrongTurnApp()
    const unlikely = new ScriptedProvider((request) => {
      const choice = wrongTurn(request)
      return 'probabilities' in choice ? { ...choice, probabilities: { [choice.action]: 0.95 } } : choice
    })
    const trace = await explore(app, criterion, { ...options, provider: unlikely, restart: () => app.restart() })
    assert.equal(trace.outcome, 'stuck')
    assert.equal(app.restarts, 0)
  })

  it('stops when another path leads to the same dead end, since the app is the problem then', async () => {
    const app = new WrongTurnApp()
    // Whatever tab it picks first, it ends up on Forms, stuck.
    const provider = new ScriptedProvider((request) => {
      if (request.history.length === 0) {
        return { action: find(request, '"Forms"'), probabilities: { [find(request, '"Forms"')]: 0.4, [find(request, '"Webview"')]: 0.3, [find(request, '"Swipe"')]: 0.2 } }
      }
      if (request.history.length === 1 && !request.screenText.includes('Form components')) return { action: find(request, '"Forms"') }
      return { action: STUCK }
    })
    const trace = await explore(app, criterion, { ...options, provider, restart: () => app.restart(), maxBacktracks: 5 })
    assert.equal(trace.outcome, 'stuck')
    assert.equal(app.restarts, 1)
  })

  it('gives up backtracking after the limit', async () => {
    const app = new WrongTurnApp()
    // Stuck everywhere but on the home screen, with options to spare.
    const provider = new ScriptedProvider((request) =>
      request.history.length === 0
        ? { action: find(request, '"Forms"'), probabilities: { [find(request, '"Forms"')]: 0.4, [find(request, '"Webview"')]: 0.3, [find(request, '"Swipe"')]: 0.2 } }
        : { action: STUCK },
    )
    const trace = await explore(app, criterion, { ...options, provider, restart: () => app.restart(), maxBacktracks: 1 })
    assert.equal(trace.outcome, 'stuck')
    assert.equal(app.restarts, 1)
    assert.equal(trace.steps.filter((s) => s.retry).length, 1)
  })
})

describe('explore with scrolling', () => {
  const catalog: Criterion = {
    id: 'bike-light',
    goal: 'Open the Sauce Labs Bike Light from the catalog.',
    inputs: {},
    expect: [{ text: 'Sauce Labs Bike Light' }],
  }

  /** The shop app's catalog: the bike light is below the fold until the list is scrolled. */
  class Catalog implements Device {
    readonly platform = 'ios' as const
    screen: 'ios-catalog' | 'ios-catalog-scrolled' = 'ios-catalog'
    scrolls: string[] = []
    async pageSource() {
      return fixture(this.screen)
    }
    async tap() {}
    async type() {}
    async scroll(element: ScreenElement, direction: string) {
      this.scrolls.push(`${toSelector(element.locator)} ${direction}`)
      if (direction === 'down') this.screen = 'ios-catalog-scrolled'
    }
    async isDisplayed(locator: Locator) {
      return this.screen === 'ios-catalog-scrolled' && toSelector(locator).includes('Bike Light')
    }
  }

  it('scrolls a list to reach what is below the fold, then offers the way back', async () => {
    const app = new Catalog()
    const provider = new ScriptedProvider((request) => {
      if (request.screenText.includes('Sauce Labs Bike Light')) return { action: STUCK, goalMet: 0.95 }
      return { action: find(request, 'Scroll down in the screen') }
    })
    const trace = await explore(app, catalog, { ...options, provider })

    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.deepEqual(app.scrolls, ['(//XCUIElementTypeCollectionView)[1] down'])
    assert.deepEqual(trace.steps[0].taken, [
      {
        type: 'scroll',
        kind: 'list',
        target: 'screen',
        description: 'Scroll down in the screen to see more of it',
        selector: '(//XCUIElementTypeCollectionView)[1]',
        direction: 'down',
        // Where the list is, for drawing it on the step's frame in the run report.
        frame: { x: 0, y: 195, w: 393, h: 561 },
      },
    ])
    const after = provider.requests[1].actions.map((a) => a.description).filter((d) => d.startsWith('Scroll'))
    assert.deepEqual(after, ['Scroll down in the screen to see more of it', 'Scroll up in the screen to see more of it'])

    const spec = generateSpec(trace, catalog)
    assert.match(spec, /import \{ \$, browser, expect \} from '@wdio\/globals'/)
    assert.match(spec, /await browser\.swipe\(\{ direction: 'up', duration: 1000, percent: 0\.8, scrollableElement: \$\('\(\/\/XCUIElementTypeCollectionView\)\[1\]'\) \}\)/)
  })

  it('offers no scrolling on a device that cannot scroll', async () => {
    const app = new Catalog()
    ;(app as { scroll?: unknown }).scroll = undefined
    const provider = new ScriptedProvider(() => ({ action: STUCK }))
    await explore(app, catalog, { ...options, provider })
    assert.ok(!provider.requests[0].actions.some((a) => a.description.startsWith('Scroll')))
  })
})

describe('explore with a test plan', () => {
  const plan: Criterion = {
    id: 'login-plan',
    title: 'Log in',
    goal: 'Log in. The account exists.',
    steps: ['Open the Login tab', 'Enter qa.demo@example.com as the email and Str0ngPassw0rd as the password', 'Submit the form'],
    inputs: { email: 'qa.demo@example.com', password: 'Str0ngPassw0rd' },
    expect: [{ contains: 'logged in' }],
  }

  /** The demo app, with the plan's `contains` check answered from the success screen. */
  class PlanApp extends FakeApp {
    async isDisplayed(locator: Locator) {
      return this.screen === 'ios-login-success' && toSelector(locator) === '-ios predicate string:label CONTAINS "logged in"'
    }
  }

  /** Judges each step from the screen: the model is asked about the current step only. */
  const followPlan = (request: DecisionRequest) => {
    const { current } = request.plan!
    const onLogin = request.screenText.includes('LOGIN')
    const filled = request.history.length >= 3
    if (current === 1 && onLogin) return { action: STUCK, goalMet: 0.95 }
    if (current === 2 && filled) return { action: STUCK, goalMet: 0.9 }
    if (current === 3 && request.screenText.includes('You are logged in!')) return { action: STUCK, goalMet: 0.97 }
    return happyPath(request)
  }

  it('works through the steps in order, asks about the current one, and checks the expectations at the end', async () => {
    const provider = new ScriptedProvider(followPlan)
    const trace = await explore(new PlanApp(), plan, { ...options, provider })

    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.deepEqual(trace.criterion.steps, ['Open the Login tab', 'Enter {email} as the email and {password} as the password', 'Submit the form'])
    assert.deepEqual(
      trace.steps.map((s) => [s.planStep, s.completed, s.taken?.map((t) => t.selector)]),
      [
        [1, undefined, ['~Login']],
        [1, 1, undefined],
        [2, undefined, ['~input-email']],
        [2, undefined, ['~input-password']],
        [2, 2, undefined],
        [3, undefined, ['~button-LOGIN']],
        [3, undefined, undefined],
      ],
    )
    assert.deepEqual(provider.requests.map((r) => r.plan!.current), [1, 1, 2, 2, 2, 3, 3])
    assert.ok(!JSON.stringify(provider.requests).includes('Str0ngPassw0rd'), 'the plan is redacted before it is sent')
    assert.equal(trace.steps.filter((s) => s.taken).length, 4)
  })

  it("doesn't count moving on to the next step against the step limit", async () => {
    const trace = await explore(new PlanApp(), plan, { ...options, provider: new ScriptedProvider(followPlan), maxSteps: 4 })
    assert.equal(trace.outcome, 'passed', trace.reason)
  })

  it('heads the generated test with the plan steps', async () => {
    const trace = await explore(new PlanApp(), plan, { ...options, provider: new ScriptedProvider(followPlan) })
    const spec = generateSpec(trace, plan)
    assert.match(spec, /it\('Log in', async/, 'the test is named after the plan, not the goal with its context')
    assert.equal(trace.criterion.title, 'Log in')
    // A trace written before plans had titles still generates its test.
    const { title, ...untitled } = trace.criterion
    assert.ok(title)
    assert.match(generateSpec({ ...trace, criterion: untitled }, plan), /it\('Log in', async/)
    assert.match(spec, /\/\/ 1\. Open the Login tab\n\s+await \$\('~Login'\)\.click\(\)\n\s+\/\/ 2\. Enter qa\.demo@example\.com as the email/)
    assert.match(spec, /\/\/ 3\. Submit the form\n\s+await \$\('~button-LOGIN'\)\.click\(\)\n\s+\/\/ Expected\n/)
    assert.match(spec, /label CONTAINS "logged in"/)
  })
})

/** A white screenshot the size of the fixtures' screen, in points (a 1x screen keeps the tests fast). */
const screenshot = sharp({ create: { width: 402, height: 874, channels: 3, background: '#ffffff' } }).png().toBuffer()

/** The login flow, with screenshots. */
class SeeingApp extends FakeApp {
  shots = 0
  async screenshot() {
    this.shots++
    return screenshot
  }
}

/** A provider that also answers with a screenshot in view, following its own script. */
class LookingProvider extends ScriptedProvider {
  readonly visionModel = 'looking-1'
  readonly looks: { request: DecisionRequest; frame: PreparedFrame }[] = []
  private readonly see: (request: DecisionRequest) => Omit<Partial<Look>, 'decision'> & { decision?: Partial<Decision> }
  constructor(pick: ConstructorParameters<typeof ScriptedProvider>[0], see: (request: DecisionRequest) => Omit<Partial<Look>, 'decision'> & { decision?: Partial<Decision> }) {
    super(pick)
    this.see = see
  }

  async look(request: DecisionRequest, frame: PreparedFrame): Promise<Look> {
    this.looks.push({ request: structuredClone(request), frame })
    const answer = this.see(request)
    return {
      targetShown: 0,
      ...answer,
      decision: { action: STUCK, confidence: 0.9, probabilities: {}, goalMet: 0, fills: {}, model: 'looking-1', latencyMs: 2, usage: { inputTokens: 1800, outputTokens: 0 }, ...answer.decision },
    }
  }
}

describe('explore with screenshots', () => {
  // A frame is kept only when the screen is read again after its screenshot, which a zero settle time skips.
  const seeing = { settleTimeoutMs: 2_000 }

  it('keeps a masked frame of the screen each decision saw, handed over once the run is over', async () => {
    const app = new SeeingApp()
    const delivered: { name: string; frame: PreparedFrame }[] = []
    const trace = await explore(app, criterion, {
      ...seeing,
      provider: new ScriptedProvider(happyPath),
      onFrame: (name, frame) => {
        delivered.push({ name, frame })
      },
    })
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.deepEqual(
      delivered.map((d) => d.name),
      trace.steps.map((step) => step.frame),
    )
    assert.deepEqual(delivered.map((d) => d.name), ['01.jpg', '02.jpg', '03.jpg', '04.jpg', '05.jpg'])
    assert.deepEqual([delivered[0].frame.width, delivered[0].frame.height], [402, 874])
    assert.deepEqual(trace.screen, { width: 402, height: 874 })
    // Nothing was looked at: no request carried a screenshot.
    assert.equal(trace.usage.looks, undefined)
  })

  it("takes no screenshots when frames aren't kept and looking is off", async () => {
    const app = new SeeingApp()
    const provider = new LookingProvider(happyPath, () => ({}))
    const trace = await explore(app, criterion, { ...seeing, provider })
    assert.equal(trace.outcome, 'passed')
    assert.equal(app.shots, 0)
    assert.equal(provider.looks.length, 0)
    assert.ok(trace.steps.every((step) => step.frame === undefined))
  })

  it("doesn't look while the answer from text is sure", async () => {
    const provider = new LookingProvider(happyPath, () => ({}))
    const trace = await explore(new SeeingApp(), criterion, { ...seeing, provider, look: true })
    assert.equal(trace.outcome, 'passed')
    assert.equal(provider.looks.length, 0)
  })

  it('looks where text alone sees no way forward, and takes its verdict that the plan step is done', async () => {
    const steps: Criterion = { ...criterion, steps: ['Open the Login tab', 'Log in with the email and password'] }
    // From text alone, the model can't tell the Login tab is open; looking, it can.
    const provider = new LookingProvider(
      (request) => {
        if (request.plan?.current === 1 && request.screenText.includes('Login / Sign up Form')) return { action: STUCK, goalMet: 0.2 }
        if (request.plan?.current === 1) return { action: find(request, 'button "Login" (bottom'), goalMet: 0.05 }
        return happyPath({ ...request, history: ['Tap the button "Login"', ...request.history.slice(1)] })
      },
      () => ({ decision: { goalMet: 0.9 } }),
    )
    const trace = await explore(new SeeingApp(), steps, { ...seeing, provider, look: true })
    assert.equal(trace.outcome, 'passed', trace.reason)
    const looked = trace.steps.filter((step) => step.look)
    assert.equal(looked.length, 1)
    assert.equal(looked[0].look!.why, 'stuck')
    assert.equal(looked[0].look!.used, 'goal')
    assert.equal(looked[0].completed, 1)
    assert.equal(trace.usage.looks, 1)
    assert.deepEqual([provider.looks[0].frame.width, provider.looks[0].frame.height], [402, 874])
  })

  it("doesn't look where text alone would stop when the checks already hold: the run is over", async () => {
    const provider = new LookingProvider(
      (request) => (request.screenText.includes('You are logged in!') ? { action: STUCK, goalMet: 0.3 } : happyPath(request)),
      () => ({ decision: { goalMet: 0.95 } }),
    )
    const trace = await explore(new SeeingApp(), criterion, { ...seeing, provider, look: true })
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.match(trace.reason, /model was unsure/)
    assert.equal(provider.looks.length, 0)
    assert.equal(trace.usage.looks, 0)
  })

  it('takes a clear action from a look where text alone was too unsure to act', async () => {
    const provider = new LookingProvider(
      (request) => (request.history.length === 0 ? { action: find(request, 'button "Login" (bottom'), confidence: 0.1 } : happyPath(request)),
      (request) => ({ decision: { action: find(request, 'button "Login" (bottom'), confidence: 0.9 } }),
    )
    const trace = await explore(new SeeingApp(), criterion, { ...seeing, provider, look: true })
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.equal(trace.steps[0].look?.why, 'unsure')
    assert.equal(trace.steps[0].look?.used, 'action')
    assert.equal(trace.steps[0].taken?.[0].selector, '~Login')
  })

  it('ignores a look that is no surer, and stops the way text alone would', async () => {
    const provider = new LookingProvider(
      (request) => ({ action: find(request, 'button "Login" (bottom'), confidence: 0.1 }),
      (request) => ({ decision: { action: find(request, 'button "Login" (bottom'), confidence: 0.4 } }),
    )
    const trace = await explore(new SeeingApp(), criterion, { ...seeing, provider, look: true })
    assert.equal(trace.outcome, 'escalated')
    assert.equal(trace.steps[0].look?.used, 'none')
  })

  it('ends a run as failed when a look sees the goal but the checks disagree', async () => {
    const app = new SeeingApp()
    app.loginWorks = false
    const provider = new LookingProvider(
      (request) => (request.history.length === 4 ? { action: STUCK, goalMet: 0.2 } : happyPath(request)),
      () => ({ decision: { goalMet: 0.9 } }),
    )
    const trace = await explore(app, criterion, { ...seeing, provider, look: true })
    assert.equal(trace.outcome, 'failed')
    assert.deepEqual(trace.failedExpectations, [{ text: 'You are logged in!' }])
  })

  it('taps a control with no label where the box points, through its selector, and says so in the test', async () => {
    const cart: Criterion = { id: 'cart', goal: 'Open the cart from the cart icon at the top right.', inputs: {}, expect: [{ text: 'Your cart' }] }
    const app = new IconApp()
    const provider = new LookingProvider(
      (request) => (request.screenText.includes('Your cart') ? { action: STUCK, goalMet: 0.95 } : { action: STUCK, goalMet: 0.05 }),
      // Around the icon at x 340-384, y 60-104 on a 402 x 874 screen.
      () => ({ targetShown: 0.9, box: { left: 0.85, right: 0.95, top: 0.07, bottom: 0.12, confidence: 0.4 } }),
    )
    const trace = await explore(app, cart, { ...seeing, provider, look: true })
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.equal(trace.steps[0].look?.used, 'box')
    assert.equal(trace.steps[0].look?.pointedAt, 'Tap an unlabeled button (top of the screen)')
    assert.deepEqual(app.taps, ['(//XCUIElementTypeButton)[2]'])
    const taken = trace.steps[0].taken![0]
    assert.equal(taken.unlabeled, true)
    const spec = generateSpec(trace, cart)
    assert.match(spec, /No label, text or id in the page source: found by looking at the screen, and located by position/)
    assert.match(spec, /await \$\('\(\/\/XCUIElementTypeButton\)\[2\]'\)\.click\(\)/)
    assert.match(spec, /looking with looking-1/)
  })
})

/** A screen whose cart is an icon with no label, after a labelled Help button. */
class IconApp implements Device {
  readonly platform = 'ios' as const
  open = false
  taps: string[] = []
  async pageSource() {
    const body = this.open
      ? '<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Your cart" visible="true" x="20" y="100" width="200" height="30"/>'
      : '<XCUIElementTypeButton type="XCUIElementTypeButton" label="Help" name="help" visible="true" enabled="true" x="20" y="60" width="60" height="44"/>' +
        '<XCUIElementTypeButton type="XCUIElementTypeButton" visible="true" enabled="true" x="340" y="60" width="44" height="44"/>' +
        '<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Products" visible="true" x="20" y="120" width="200" height="30"/>'
    return `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="402" height="874">${body}</XCUIElementTypeApplication></AppiumAUT>`
  }
  async tap({ locator }: ScreenElement) {
    this.taps.push(toSelector(locator))
    if (toSelector(locator) === '(//XCUIElementTypeButton)[2]') this.open = true
  }
  async type() {}
  async isDisplayed(locator: Locator) {
    return this.open && toSelector(locator).includes('Your cart')
  }
  async screenshot() {
    return screenshot
  }
}

describe('useLook and pointedAt', () => {
  const decision = (overrides: Partial<Decision>): Decision => ({ action: STUCK, confidence: 0.9, probabilities: {}, goalMet: 0, fills: {}, model: 'm', latencyMs: 1, ...overrides })
  const xml = `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="400" height="800">
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Cell" visible="true" enabled="true" x="0" y="0" width="200" height="200"/>
    <XCUIElementTypeButton type="XCUIElementTypeButton" visible="true" enabled="true" x="150" y="150" width="40" height="40"/>
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Backdrop" visible="true" enabled="true" x="0" y="300" width="400" height="500"/>
  </XCUIElementTypeApplication></AppiumAUT>`
  const screen = parseScreen(xml, 'ios')
  const box = (x: number, y: number) => ({ left: (x - 5) / 400, right: (x + 5) / 400, top: (y - 5) / 800, bottom: (y + 5) / 800 })

  it('points at the smallest control under the centre, labelled or not, and never at one a quarter of the screen', () => {
    assert.equal(pointedAt(box(170, 170), screen, [])?.element.unlabeled, true)
    assert.equal(pointedAt(box(50, 50), screen, [])?.element.label, 'Cell')
    assert.equal(pointedAt(box(200, 600), screen, []), undefined, 'the backdrop is too big to be the control')
    assert.equal(pointedAt(box(390, 250), screen, []), undefined, 'nothing there')
  })

  it('prefers the goal, then a clear action, then the box only when text would stop', () => {
    const text = decision({ action: 'tap:e1', confidence: 0.3 })
    const context = { doneAt: 0.8, minConfidence: 0.5, textWouldStop: false }
    const look = (d: Partial<Decision>, extra: Partial<Look> = {}): Look => ({ decision: decision(d), targetShown: 0.9, box: { ...box(170, 170), confidence: 0.4 }, ...extra })
    const point = () => pointedAt(box(170, 170), screen, [])
    assert.equal(useLook(text, look({ goalMet: 0.85 }), context, point).used, 'goal')
    assert.equal(useLook(text, look({ action: 'tap:e2', confidence: 0.6 }), context, point).used, 'action')
    assert.equal(useLook(text, look({ action: 'tap:e2', confidence: 0.45 }), context, point).used, 'none', 'not clear enough')
    assert.equal(useLook(text, look({}), context, point).used, 'none', 'text would act, so the box is not needed')
    const stopping = useLook(decision({}), look({}), { ...context, textWouldStop: true }, point)
    assert.equal(stopping.used, 'box')
    assert.equal(stopping.decision.confidence, 0.9)
    assert.equal(useLook(decision({}), look({}, { targetShown: 0.3 }), { ...context, textWouldStop: true }, point).used, 'none', 'not shown')
  })
})


/** A 3x screenshot in one colour, so a mask shows up as grey where the page source says. */
const redShot = sharp({ create: { width: 1206, height: 2622, channels: 3, background: '#d01010' } }).png().toBuffer()

/** The colour at a point of a frame, given in points. */
async function colourAt(frame: PreparedFrame, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(frame.jpeg).raw().toBuffer({ resolveWithObject: true })
  const at = (Math.round(y) * info.width + Math.round(x)) * info.channels
  return [data[at], data[at + 1], data[at + 2]]
}
const isGrey = ([r, g, b]: number[]) => Math.abs(r - g) < 25 && Math.abs(g - b) < 25 && r < 200
const isRed = ([r, g, b]: number[]) => r > 150 && g < 80 && b < 80

/** The login form with an email typed in and the keyboard up, as a 3x screenshot shows it. */
class FilledApp implements Device {
  readonly platform = 'ios' as const
  async pageSource() {
    return fixture('ios-login-filled')
  }
  async tap() {}
  async type() {}
  async isDisplayed() {
    return true
  }
  async screenshot() {
    return redShot
  }
}

describe('explore with screenshots: what a frame shows', () => {
  const seeing = { settleTimeoutMs: 2_000 }
  const filled: Criterion = { ...criterion, inputs: { email: 'qa.demo@example.com', password: 'Str0ngPassw0rd' } }

  it('paints over the typed email, the password and the keyboard in the frames it keeps and the frames it sends', async () => {
    const kept: PreparedFrame[] = []
    const provider = new LookingProvider(() => ({ action: STUCK, goalMet: 0.3 }), () => ({ decision: { goalMet: 0.95 } }))
    const trace = await explore(new FilledApp(), filled, { ...seeing, provider, look: true, onFrame: (_name, frame) => void kept.push(frame) })
    assert.equal(trace.outcome, 'passed', trace.reason)
    for (const frame of [kept[0], provider.looks[0].frame]) {
      assert.deepEqual([frame.width, frame.height], [402, 874])
      assert.ok(isGrey(await colourAt(frame, 80, 231)), 'the email field')
      assert.ok(isGrey(await colourAt(frame, 80, 320)), 'the password field')
      assert.ok(isGrey(await colourAt(frame, 200, 860)), 'the keyboard')
      assert.ok(isRed(await colourAt(frame, 200, 150)), 'what holds no test data is left as it is')
    }
  })
})

describe('explore with screenshots: when to look', () => {
  const seeing = { settleTimeoutMs: 2_000 }

  it("doesn't look at a step the model is unsure of but sure enough to act on, unless it looks at every step", async () => {
    const unsure = (request: DecisionRequest) => ({ ...happyPath(request), confidence: 0.3 })
    const auto = new LookingProvider(unsure, () => ({}))
    assert.equal((await explore(new SeeingApp(), criterion, { ...seeing, provider: auto, look: true })).outcome, 'passed')
    assert.equal(auto.looks.length, 0)

    const always = new LookingProvider(unsure, (request) => ({ decision: { ...happyPath(request), confidence: 0.6 } as Partial<Decision> }))
    const trace = await explore(new SeeingApp(), criterion, { ...seeing, provider: always, look: 'always' })
    assert.equal(trace.outcome, 'passed', trace.reason)
    // Every step but the last, which the model called done from text: the checks decide that one.
    const undecided = trace.steps.filter((step) => step.decision.goalMet < 0.8)
    assert.equal(always.looks.length, undecided.length)
    assert.ok(undecided.every((step) => step.look?.why === 'always'))
    assert.equal(trace.steps.at(-1)?.look, undefined)
  })

  it('looking at every step, takes the look where it is surer than the text answer, and not where it is less sure', async () => {
    const run = async (look: number) => {
      const provider = new LookingProvider(
        (request) => (request.history.length === 0 ? { action: find(request, 'Webview'), confidence: 0.5 } : happyPath(request)),
        (request) => ({ decision: { ...happyPath(request), confidence: request.history.length === 0 ? look : 0.9 } as Partial<Decision> }),
      )
      return explore(new SeeingApp(), criterion, { ...seeing, provider, look: 'always', maxSteps: 1 })
    }
    const surer = await run(0.9)
    assert.equal(surer.steps[0].taken?.[0].selector, '~Login')
    assert.equal(surer.steps[0].look?.used, 'action')
    // A look can be wrong where the text is right: a placeholder in a screenshot looks like a value.
    const lessSure = await run(0.45)
    assert.equal(lessSure.steps[0].taken?.[0].selector, '~Webview')
    assert.equal(lessSure.steps[0].look?.used, 'none')
  })

  it('looks when the same action comes back a third time on an unchanged screen, and takes another clear way forward', async () => {
    const app = new SeeingApp()
    app.loginWorks = true
    let typed = false
    const provider = new LookingProvider(
      (request) => {
        if (request.screenText.includes('You are logged in!')) return { action: STUCK, goalMet: 0.97 }
        if (request.history.length === 0) return { action: find(request, 'button "Login" (bottom') }
        // From text, it keeps tapping LOGIN on the empty form, very sure.
        return { action: find(request, '"LOGIN"'), confidence: 0.95 }
      },
      (request) => {
        typed = true
        return { decision: { action: find(request, 'test data "email" into the field "Email"'), confidence: 0.8, fills: { e4: { input: 'password', confidence: 0.9 } } } }
      },
    )
    const trace = await explore(app, criterion, { ...seeing, provider, look: true })
    assert.ok(typed, 'it looked')
    const looked = trace.steps.find((step) => step.look)!
    assert.equal(looked.look?.why, 'repeating')
    assert.equal(looked.look?.used, 'action')
  })

  it('ignores a look below 0.5 where text alone would stop, and takes one at 0.5', async () => {
    const run = async (confidence: number) => {
      const provider = new LookingProvider(
        (request) => ({ action: find(request, 'button "Login" (bottom'), confidence: 0.1 }),
        (request) => ({ decision: { action: find(request, 'button "Login" (bottom'), confidence } }),
      )
      return explore(new SeeingApp(), criterion, { ...seeing, provider, look: true, maxSteps: 1 })
    }
    assert.equal((await run(0.49)).steps[0].look?.used, 'none')
    assert.equal((await run(0.5)).steps[0].look?.used, 'action')
  })

  it('never offers a control without a label to the model from text', async () => {
    const provider = new LookingProvider(() => ({ action: STUCK, goalMet: 0 }), () => ({}))
    await explore(new IconApp(), { id: 'cart', goal: 'Open the cart.', inputs: {}, expect: [{ text: 'Your cart' }] }, { ...seeing, provider, look: true, maxBacktracks: 0 })
    assert.ok(provider.requests.length > 0)
    for (const request of provider.requests) assert.ok(request.actions.every((action) => !action.description.includes('unlabeled')))
  })
})

describe('explore with screenshots: when a look goes wrong', () => {
  const seeing = { settleTimeoutMs: 2_000 }

  it('lets the text answer stand when the look request fails, and still says a screenshot was sent', async () => {
    class FailingLook extends LookingProvider {
      async look(): Promise<Look> {
        throw new Error('Jev request failed with 503: overloaded')
      }
    }
    const app = new SeeingApp()
    app.loginWorks = false
    const provider = new FailingLook((request) => (request.history.length === 4 ? { action: STUCK, goalMet: 0.3 } : happyPath(request)), () => ({}))
    const trace = await explore(app, criterion, { ...seeing, provider, look: true })
    // As without looking: the run stops, and the checks say what is missing.
    assert.equal(trace.outcome, 'stuck', trace.reason)
    assert.deepEqual(trace.failedExpectations, [{ text: 'You are logged in!' }])
    const failed = trace.steps.find((step) => step.lookError)!
    assert.match(failed.lookError!, /503/)
    assert.equal(trace.usage.looks, 1)
    assert.match(sentLine(trace), /got no answer/)
  })

  it('keeps a looked decision whose choice turns out covered, marked, since its screenshot went out', async () => {
    class CoveringApp extends SeeingApp {
      fingerprint = async () => fingerprintOf(await this.pageSource(), 'ios')
      checks = 0
      async isVisible(locator: Locator) {
        // The Login tab is covered the first time it is checked.
        return !(toSelector(locator) === '~Login' && this.checks++ === 0)
      }
    }
    const loginTab = (request: DecisionRequest) => request.actions.find((a) => a.description.includes('button "Login" (bottom'))?.key
    const provider = new LookingProvider(
      (request) => (request.history.length === 0 ? { action: loginTab(request) ? STUCK : STUCK, goalMet: 0 } : happyPath(request)),
      // Once the covered tab is left out, the look has no Login tab to choose and sees no way forward.
      (request) => ({ decision: loginTab(request) ? { action: loginTab(request)!, confidence: 0.9 } : { action: STUCK } }),
    )
    const trace = await explore(new CoveringApp(), criterion, { ...seeing, provider, look: true })
    const covered = trace.steps.filter((step) => step.covered)
    assert.equal(covered.length, 1)
    assert.ok(covered[0].look, 'the look stays with it')
    assert.ok(trace.steps.every((step) => step.lookError === undefined), 'every look got an answer')
    assert.ok((trace.usage.looks ?? 0) >= 1)
    assert.match(sentLine(trace), new RegExp(`of steps? (\\d+, )*${covered[0].index}\\b`))
  })

  it('replays a tap on a control without a label when it backtracks past it', async () => {
    class ShopApp implements Device {
      readonly platform = 'ios' as const
      screen: 'home' | 'cart' | 'deals' | 'done' = 'home'
      restarts = 0
      async pageSource() {
        const button = (label: string, y: number) =>
          `<XCUIElementTypeButton type="XCUIElementTypeButton" label="${label}" name="${label}" visible="true" enabled="true" x="20" y="${y}" width="200" height="44"/>`
        const body = {
          home: '<XCUIElementTypeButton type="XCUIElementTypeButton" visible="true" enabled="true" x="340" y="60" width="44" height="44"/>',
          cart: button('Deals', 300) + button('Checkout', 400),
          deals: '<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="No deals today" visible="true" x="20" y="100" width="200" height="30"/>',
          done: '<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Order placed" visible="true" x="20" y="100" width="200" height="30"/>',
        }[this.screen]
        return `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="402" height="874">${body}</XCUIElementTypeApplication></AppiumAUT>`
      }
      async tap({ locator }: ScreenElement) {
        const selector = toSelector(locator)
        if (this.screen === 'home' && selector === '(//XCUIElementTypeButton)[1]') this.screen = 'cart'
        else if (this.screen === 'cart' && selector === '~Deals') this.screen = 'deals'
        else if (this.screen === 'cart' && selector === '~Checkout') this.screen = 'done'
      }
      async type() {}
      async isDisplayed(locator: Locator) {
        return this.screen === 'done' && toSelector(locator).includes('Order placed')
      }
      async screenshot() {
        return screenshot
      }
    }
    const app = new ShopApp()
    const provider = new LookingProvider(
      (request) => {
        if (request.screenText.includes('Order placed')) return { action: STUCK, goalMet: 0.95 }
        if (request.screenText.includes('No deals today')) return { action: STUCK, goalMet: 0.05 }
        const deals = request.actions.find((a) => a.description.includes('"Deals"'))
        const checkout = request.actions.find((a) => a.description.includes('"Checkout"'))
        if (deals && checkout) return { action: deals.key, confidence: 0.6, probabilities: { [deals.key]: 0.6, [checkout.key]: 0.35 } }
        return { action: STUCK, goalMet: 0 }
      },
      // On the home screen, the box is around the cart icon at x 340-384, y 60-104.
      () => ({ targetShown: 0.9, box: { left: 0.85, right: 0.95, top: 0.07, bottom: 0.12, confidence: 0.4 } }),
    )
    const trace = await explore(app, { id: 'order', goal: 'Place an order from the cart.', inputs: {}, expect: [{ text: 'Order placed' }] }, {
      ...seeing,
      provider,
      look: true,
      restart: async () => {
        app.screen = 'home'
        app.restarts++
      },
    })
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.equal(app.restarts, 1)
    const spec = generateSpec(trace, { id: 'order', goal: 'Place an order from the cart.', inputs: {}, expect: [{ text: 'Order placed' }] })
    assert.match(spec, /\(\/\/XCUIElementTypeButton\)\[1\]/)
    assert.match(spec, /~Checkout/)
    assert.doesNotMatch(spec, /~Deals/)
  })
})

describe('explore: a tap that may not have landed', () => {
  it("doesn't send a direct tap again when it changed the screen, however little", async () => {
    class SlowApp extends FakeApp {
      readonly input = 'simulator' as const
      resent = 0
      fallBackToAppium() {
        this.resent++
      }
    }
    const app = new SlowApp()
    const trace = await explore(app, criterion, { ...options, provider: new ScriptedProvider(happyPath) })
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.equal(app.resent, 0)
  })

  it('sends a lost direct tap again through Appium once, and every tap after it, on a simulator that takes none', async () => {
    class DeafApp extends FakeApp {
      input: 'simulator' | 'appium' = 'simulator'
      directTaps: string[] = []
      notes: string[] = []
      fallBackToAppium(reason: string) {
        this.input = 'appium'
        this.notes.push(reason)
      }
      drainNotes() {
        return this.notes.splice(0)
      }
      async tap(element: ScreenElement) {
        if (this.input === 'simulator') {
          this.directTaps.push(toSelector(element.locator))
          return
        }
        return super.tap(element)
      }
    }
    const app = new DeafApp()
    const trace = await explore(app, criterion, { ...options, provider: new ScriptedProvider(happyPath) })
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.deepEqual(app.directTaps, ['~Login'])
    assert.equal(app.input, 'appium')
    assert.match(trace.steps[0].notes?.join(' ') ?? '', /sent again through Appium/)
    assert.equal((generateSpec(trace, criterion).match(/\$\('~Login'\)\.click\(\)/g) ?? []).length, 1)
  })

  it('keeps both taps when the first changed the screen, as toggling a switch twice does', async () => {
    class SwitchApp implements Device {
      readonly platform = 'ios' as const
      on = false
      toggles = 0
      async pageSource() {
        return `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="402" height="874"><XCUIElementTypeSwitch type="XCUIElementTypeSwitch" name="wifi" label="Wi-Fi" value="${this.on ? 1 : 0}" visible="true" enabled="true" x="300" y="100" width="51" height="31"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Toggled ${this.toggles > 1 ? 'twice' : 'once or never'}" visible="true" x="20" y="200" width="200" height="30"/></XCUIElementTypeApplication></AppiumAUT>`
      }
      async tap() {
        this.on = !this.on
        this.toggles++
      }
      async type() {}
      async isDisplayed(locator: Locator) {
        return this.toggles === 2 && toSelector(locator).includes('Toggled twice')
      }
    }
    const app = new SwitchApp()
    const twice: Criterion = { id: 'twice', goal: 'Turn Wi-Fi on and off again.', inputs: {}, expect: [{ text: 'Toggled twice' }] }
    const trace = await explore(app, twice, { ...options, provider: new ScriptedProvider((request) =>
      request.screenText.includes('Toggled twice') ? { action: STUCK, goalMet: 0.95 } : { action: find(request, 'Wi-Fi') }) })
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.equal((generateSpec(trace, twice).match(/\.click\(\)/g) ?? []).length, 2)
  })
})

describe('useLook and pointedAt: the edges', () => {
  const decision = (overrides: Partial<Decision>): Decision => ({ action: STUCK, confidence: 0.9, probabilities: {}, goalMet: 0, fills: {}, model: 'm', latencyMs: 1, ...overrides })
  const at = (x: number, y: number) => ({ left: (x - 2) / 400, right: (x + 2) / 400, top: (y - 2) / 800, bottom: (y + 2) / 800 })
  const xml = (w: number, h: number) => `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="400" height="800">
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Big" visible="true" enabled="true" x="0" y="0" width="${w}" height="${h}"/>
    <XCUIElementTypeTextField type="XCUIElementTypeTextField" placeholderValue="Email" visible="true" enabled="true" x="0" y="700" width="400" height="40"/>
  </XCUIElementTypeApplication></AppiumAUT>`

  it('takes a button just under a quarter of the screen, and not one just over', () => {
    // A quarter of 400 x 800 is 80,000 square points.
    assert.equal(pointedAt(at(10, 10), parseScreen(xml(200, 399), 'ios'), [])?.element.label, 'Big')
    assert.equal(pointedAt(at(10, 10), parseScreen(xml(200, 401), 'ios'), []), undefined)
  })

  it('never points at a field', () => {
    assert.equal(pointedAt(at(100, 720), parseScreen(xml(10, 10), 'ios'), []), undefined)
  })

  it('needs the control shown at least as surely as an action must be to act on it', () => {
    const screen = parseScreen(xml(100, 100), 'ios')
    const look: Look = { decision: decision({}), targetShown: 0.6, box: { ...at(50, 50), confidence: 0.3 } }
    const point = (box: Box) => pointedAt(box, screen, [])
    assert.equal(useLook(decision({}), look, { doneAt: 0.8, minConfidence: 0.5, textWouldStop: true }, point).used, 'box')
    assert.equal(useLook(decision({}), look, { doneAt: 0.8, minConfidence: 0.7, textWouldStop: true }, point).used, 'none')
  })

  it('where the text answer would end the run, takes a different clear action even if less sure of it', () => {
    const text = decision({ action: 'tap:e1', confidence: 0.95 })
    const look: Look = { decision: decision({ action: 'type:e2:email', confidence: 0.8 }), targetShown: 0 }
    assert.equal(useLook(text, look, { doneAt: 0.8, minConfidence: 0.5, textWouldStop: true }, () => undefined).used, 'action')
    assert.equal(useLook(text, look, { doneAt: 0.8, minConfidence: 0.5, textWouldStop: false }, () => undefined).used, 'none')
  })
})

describe('explore with screenshots: frames that must not be kept', () => {
  /** The login flow, where every screenshot makes a toast with the email come or go, as if it landed between the read and the shot. */
  class ToastApp extends SeeingApp {
    toast = false
    async pageSource() {
      const source = await super.pageSource()
      return this.toast
        ? source.replace('</XCUIElementTypeApplication>', '<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Signed in as qa.demo@example.com" visible="true" x="10" y="400" width="380" height="30"/></XCUIElementTypeApplication>')
        : source
    }
    async screenshot() {
      this.toast = !this.toast
      return super.screenshot()
    }
  }

  it("keeps no frame, and sends none, when the screen changes around its screenshot", async () => {
    const kept: string[] = []
    const provider = new LookingProvider(() => ({ action: STUCK, goalMet: 0 }), () => ({ decision: { goalMet: 0.95 } }))
    const trace = await explore(new ToastApp(), criterion, {
      settleTimeoutMs: 2_000,
      provider,
      look: true,
      maxBacktracks: 0,
      onFrame: (name) => void kept.push(name),
    })
    assert.deepEqual(kept, [])
    assert.equal(provider.looks.length, 0)
    assert.match(trace.steps[0].notes?.join(' ') ?? '', /the screen changed around its screenshot/)
  })

  it('reads the screen again after a screenshot even when the settle time ran out during it', async () => {
    class SlowToastApp extends ToastApp {
      async screenshot() {
        await new Promise((resolve) => setTimeout(resolve, 80))
        return super.screenshot()
      }
    }
    const kept: string[] = []
    await explore(new SlowToastApp(), criterion, {
      settleTimeoutMs: 20,
      provider: new ScriptedProvider(() => ({ action: STUCK, goalMet: 0 })),
      maxBacktracks: 0,
      onFrame: (name) => void kept.push(name),
    })
    assert.deepEqual(kept, [])
  })

  it('still returns the trace when keeping a frame fails, and says so on the step', async () => {
    const trace = await explore(new SeeingApp(), criterion, {
      settleTimeoutMs: 2_000,
      provider: new ScriptedProvider(happyPath),
      onFrame: () => {
        throw new Error('ENOSPC: no space left on device')
      },
    })
    assert.equal(trace.outcome, 'passed')
    assert.ok(trace.steps.every((step) => step.frame === undefined))
    assert.match(trace.steps[0].notes?.join(' ') ?? '', /couldn't be kept: ENOSPC/)
  })

  it('names the kept frames after the steps that stay, once a covered choice is dropped', async () => {
    class CoveringApp extends SeeingApp {
      fingerprint = async () => fingerprintOf(await this.pageSource(), 'ios')
      checks = 0
      async isVisible(locator: Locator) {
        return !(toSelector(locator) === '~Login' && this.checks++ === 0)
      }
    }
    const names: string[] = []
    // While the Login tab is left out as covered, the model taps something else first.
    const byScreen = (request: DecisionRequest) => {
      if (request.screenText.includes('You are logged in!')) return { action: STUCK, goalMet: 0.97 }
      const loginTab = request.actions.find((a) => a.description.includes('button "Login" (bottom'))
      if (!request.screenText.includes('Login / Sign up Form')) return { action: loginTab ? loginTab.key : request.actions[0].key }
      if (!request.history.some((h) => h.includes('"email"'))) return { action: find(request, 'test data "email" into the field "Email"') }
      if (!request.history.some((h) => h.includes('"password"'))) return { action: find(request, 'test data "password" into the field "Password"') }
      return { action: find(request, '"LOGIN"') }
    }
    const trace = await explore(new CoveringApp(), criterion, {
      settleTimeoutMs: 2_000,
      provider: new ScriptedProvider(byScreen),
      onFrame: (name) => void names.push(name),
    })
    assert.ok(trace.discardedDecisions >= 1, 'a choice was found covered and dropped')
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.deepEqual(names, trace.steps.map((step) => step.frame))
    assert.equal(new Set(names).size, names.length)
    assert.deepEqual(names, trace.steps.map((step) => `${String(step.index).padStart(2, '0')}.jpg`))
  })
})

describe('useLook: the box gate', () => {
  const decision = (overrides: Partial<Decision>): Decision => ({ action: STUCK, confidence: 0.9, probabilities: {}, goalMet: 0, fills: {}, model: 'm', latencyMs: 1, ...overrides })
  const screen = parseScreen(`<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="400" height="800">
    <XCUIElementTypeButton type="XCUIElementTypeButton" label="Go" visible="true" enabled="true" x="0" y="0" width="100" height="100"/>
  </XCUIElementTypeApplication></AppiumAUT>`, 'ios')
  const box = { left: 0.1, right: 0.15, top: 0.05, bottom: 0.07, confidence: 0.3 }
  const point = (b: Box) => pointedAt(b, screen, [])

  it('needs the control shown at least half surely, even when the action bar is lower', () => {
    const context = { doneAt: 0.8, minConfidence: 0.2, textWouldStop: true }
    assert.equal(useLook(decision({}), { decision: decision({}), targetShown: 0.45, box }, context, point).used, 'none')
    assert.equal(useLook(decision({}), { decision: decision({}), targetShown: 0.5, box }, context, point).used, 'box')
  })

  it('never takes the box where the text answer would act, looking at every step or not', () => {
    const text = decision({ action: 'tap:e1', confidence: 0.9 })
    const seen = { decision: decision({}), targetShown: 0.9, box }
    assert.equal(useLook(text, seen, { doneAt: 0.8, minConfidence: 0.5, textWouldStop: false, always: true }, point).used, 'none')
  })

  it('records, for a box, the tap it led to and how surely the control was shown', () => {
    const result = useLook(decision({}), { decision: decision({}), targetShown: 0.7, box }, { doneAt: 0.8, minConfidence: 0.5, textWouldStop: true }, point)
    assert.equal(result.decision.action, result.pointed?.key)
    assert.equal(result.decision.confidence, 0.7)
  })
})


describe('explore: lost taps, once a tap has landed and on screens that change by themselves', () => {
  /** The login flow with direct input, counting the times taps are moved to Appium. */
  class DirectApp extends FakeApp {
    input: 'simulator' | 'appium' = 'simulator'
    resent = 0
    taps: string[] = []
    fallBackToAppium() {
      this.resent++
      this.input = 'appium'
    }
    async tap(element: ScreenElement) {
      this.taps.push(`${this.input}:${toSelector(element.locator)}`)
      return super.tap(element)
    }
  }

  it('never sends a tap again once a direct tap has landed, even one whose effect is slow', async () => {
    class SlowLoginApp extends DirectApp {
      async tap(element: ScreenElement) {
        this.taps.push(`${this.input}:${toSelector(element.locator)}`)
        if (toSelector(element.locator) === '~button-LOGIN') {
          // The server answers after 1.5 s, with nothing on screen meanwhile.
          setTimeout(() => (this.screen = 'ios-login-success'), 1_500)
          return
        }
        return FakeApp.prototype.tap.call(this, element)
      }
      // Like Appium, a check waits for its element.
      async isDisplayed(locator: Locator, timeoutMs = 0) {
        const end = Date.now() + timeoutMs
        for (;;) {
          if (await super.isDisplayed(locator)) return true
          if (Date.now() >= end) return false
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
    }
    const app = new SlowLoginApp()
    const provider = new ScriptedProvider((request) => {
      if (request.screenText.includes('You are logged in!')) return { action: STUCK, goalMet: 0.97 }
      // Once LOGIN is tapped, the model waits, unsure.
      if (request.history.length >= 4) return { action: STUCK, goalMet: 0.4 }
      return happyPath(request)
    })
    const trace = await explore(app, criterion, { ...options, provider })
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.equal(app.resent, 0)
    assert.equal(app.taps.filter((tap) => tap.endsWith('~button-LOGIN')).length, 1)
  })

  it('sends a lost first tap again even with a countdown ticking on screen', async () => {
    class CountdownApp extends DirectApp {
      started = Date.now()
      async pageSource() {
        const left = 60 - Math.floor((Date.now() - this.started) / 100)
        const source = await super.pageSource()
        return source.replace('</XCUIElementTypeApplication>', `<XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Offer ends in ${left}s" visible="true" x="10" y="40" width="200" height="20"/></XCUIElementTypeApplication>`)
      }
      async tap(element: ScreenElement) {
        this.taps.push(`${this.input}:${toSelector(element.locator)}`)
        if (this.input === 'simulator') return
        return FakeApp.prototype.tap.call(this, element)
      }
    }
    const app = new CountdownApp()
    const trace = await explore(app, criterion, { ...options, provider: new ScriptedProvider(happyPath) })
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.equal(app.resent, 1)
    assert.deepEqual(app.taps.slice(0, 2), ['simulator:~Login', 'appium:~Login'])
  })

  it("carries on when the tap sent again finds its element gone: the first one landed after all", async () => {
    class GoneApp extends DirectApp {
      thrown = false
      async tap(element: ScreenElement) {
        this.taps.push(`${this.input}:${toSelector(element.locator)}`)
        if (this.input === 'simulator') return
        if (!this.thrown) {
          // Sent again: the first tap's effect arrives just now, and the element is gone.
          this.thrown = true
          this.screen = 'ios-login'
          throw new Error("Can't call click on element with selector \"~Login\" because element wasn't found")
        }
        return FakeApp.prototype.tap.call(this, element)
      }
    }
    const app = new GoneApp()
    const trace = await explore(app, criterion, { ...options, provider: new ScriptedProvider(happyPath) })
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.equal(trace.steps.filter((step) => step.taken?.[0]?.selector === '~Login').length, 1)
  })

  it('keeps both taps of a switch toggled twice with direct input, and sends neither again', async () => {
    class DirectSwitchApp implements Device {
      readonly platform = 'ios' as const
      input: 'simulator' | 'appium' = 'simulator'
      resent = 0
      on = false
      toggles = 0
      fallBackToAppium() {
        this.resent++
      }
      async pageSource() {
        return `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" visible="true" x="0" y="0" width="402" height="874"><XCUIElementTypeSwitch type="XCUIElementTypeSwitch" name="wifi" label="Wi-Fi" value="${this.on ? 1 : 0}" visible="true" enabled="true" x="300" y="100" width="51" height="31"/><XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="Toggled ${this.toggles > 1 ? 'twice' : 'once or never'}" visible="true" x="20" y="200" width="200" height="30"/></XCUIElementTypeApplication></AppiumAUT>`
      }
      async tap() {
        this.on = !this.on
        this.toggles++
      }
      async type() {}
      async isDisplayed(locator: Locator) {
        return this.toggles === 2 && toSelector(locator).includes('Toggled twice')
      }
    }
    const app = new DirectSwitchApp()
    const twice: Criterion = { id: 'twice', goal: 'Turn Wi-Fi on and off again.', inputs: {}, expect: [{ text: 'Toggled twice' }] }
    const trace = await explore(app, twice, { ...options, provider: new ScriptedProvider((request) =>
      request.screenText.includes('Toggled twice') ? { action: STUCK, goalMet: 0.95 } : { action: find(request, 'Wi-Fi') }) })
    assert.equal(trace.outcome, 'passed', trace.reason)
    assert.equal(app.resent, 0)
    assert.equal((generateSpec(trace, twice).match(/\.click\(\)/g) ?? []).length, 2)
  })
})
