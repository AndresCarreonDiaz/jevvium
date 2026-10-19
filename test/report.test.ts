import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Step, TakenAction, Trace } from '../src/explorer.ts'
import { stopReport } from '../src/report.ts'
import { modelsLine, redactCode, runReport, sentLine } from '../src/run-report.ts'

const trace = (outcome: Trace['outcome'], screenText: string[], failedExpectations: Trace['failedExpectations']) =>
  ({ outcome, failedExpectations, steps: [{ screenText }] }) as unknown as Trace

describe('stopReport', () => {
  it('says which checks failed and what the last screen showed', () => {
    const lines = stopReport(
      trace('stuck', ['Login / Sign up Form', 'Please enter at least 8 characters'], [{ text: 'You successfully signed up!' }]),
    )
    assert.deepEqual(lines, [
      'missing: text "You successfully signed up!"',
      'last screen: "Login / Sign up Form", "Please enter at least 8 characters"',
    ])
  })

  it('points out text that differs only in case, spacing or punctuation', () => {
    const lines = stopReport(trace('failed', ['You are logged in.'], [{ text: 'You are logged in!' }]))
    assert.match(lines[1], /on screen instead: "You are logged in\."/)
  })

  it('says nothing for a run that passed, and shortens a long screen', () => {
    assert.deepEqual(stopReport(trace('passed', ['x'], [])), [])
    const long = stopReport(trace('stuck', Array.from({ length: 10 }, (_, i) => `text ${i}`), []))
    assert.match(long[0], /"text 7", and 2 more$/)
  })
})

describe('runReport', () => {
  const step = (index: number, overrides: Partial<Step> = {}): Step => ({
    index,
    atMs: index * 1000,
    screenText: ['Login / Sign up Form'],
    actionCount: 4,
    decision: { action: 'tap:e1', confidence: 0.94, probabilities: {}, goalMet: 0.1, fills: {}, model: 'jev-1.13.0', latencyMs: 120 },
    ...overrides,
  })
  const run: Trace = {
    criterion: { id: 'login-plan', title: 'Log in <fast>', goal: 'Log in', steps: ['Open the Login tab', 'Enter {email} as the email'], expect: [{ text: 'You are logged in!' }] },
    platform: 'ios',
    provider: 'jev',
    input: 'appium',
    startedAt: '2026-10-18T10:00:00.000Z',
    durationMs: 6200,
    outcome: 'passed',
    reason: 'Goal reached and all 1 expectations hold.',
    steps: [
      step(1, { frame: '01.jpg', taken: [{ type: 'tap', kind: 'button', target: 'Login', description: 'Tap the button "Login"', selector: '~Login', frame: { x: 115, y: 796, w: 58, h: 42 } }] }),
      step(2, {
        frame: '02.jpg',
        decision: { action: 'STUCK', confidence: 0.4, probabilities: {}, goalMet: 0.3, fills: {}, model: 'jev-1.13.0', latencyMs: 110 },
        look: {
          why: 'stuck',
          decision: { action: 'STUCK', confidence: 0.6, probabilities: {}, goalMet: 0.92, fills: {}, model: 'jev-1.14.0', latencyMs: 230 },
          targetShown: 0.2,
          box: { top: 0.4, bottom: 0.5, left: 0.1, right: 0.9, confidence: 0.3 },
          used: 'goal',
        },
      }),
    ],
    failedExpectations: [],
    discardedDecisions: 0,
    usage: { requests: 3, inputTokens: 4000, outputTokens: 0, looks: 1 },
    screen: { width: 402, height: 874 },
    replay: { outcome: 'passed', reason: 'The generated steps pass with plain Appium.', durationMs: 5100 },
  }

  it('says what was run, what it cost and what left the machine, in Markdown that reads in a pull request', () => {
    const { markdown } = runReport(run, { planFile: 'criteria/login-plan.md', device: 'iPhone 17, iOS 26.5', specFile: 'generated/login-plan.ios.spec.ts' })
    assert.match(markdown, /^# Log in <fast>/)
    assert.match(markdown, /\*\*Passed in 6\.2 s: Goal reached/)
    assert.match(markdown, /Replayed with plain Appium in 5\.1 s: passed/)
    assert.match(markdown, /\| Model \| jev-1\.13\.0, looking with jev-1\.14\.0 \|/)
    assert.match(markdown, /3 requests \(1 with a screenshot\), 4,000 input tokens, about \$0\.0002/)
    assert.match(markdown, /a masked screenshot of step 2, where the model looked/)
    assert.match(markdown, /<img src="01\.jpg" width="220"/)
    assert.match(markdown, /looked at the screen \(stuck\): it sees the goal done \(0\.92\)/)
    assert.match(markdown, /### 2\. Goal reached/)
  })

  it('says no screenshot was sent when the model never looked', () => {
    const plain = { ...run, steps: [run.steps[0]], usage: { requests: 2, inputTokens: 2000, outputTokens: 0 } }
    assert.match(sentLine(plain), /No screenshot was sent/)
    assert.equal(modelsLine(plain), 'jev-1.13.0')
  })

  it('puts the frames inside the HTML, escapes what it shows, and draws the action and the box', () => {
    const frames = new Map([['01.jpg', Buffer.from('jpeg-one')], ['02.jpg', Buffer.from('jpeg-two')]])
    const { html } = runReport(run, { frames, spec: "await $('~Login').click() // <ok>" })
    assert.match(html, /<title>Log in &lt;fast&gt; · jevvium<\/title>/)
    assert.ok(html.includes(`data:image/jpeg;base64,${Buffer.from('jpeg-one').toString('base64')}`))
    assert.match(html, /<rect x="115" y="796" width="58" height="42"/)
    assert.match(html, /stroke-dasharray="6 4"/)
    assert.match(html, /\/\/ &lt;ok&gt;/)
    assert.ok(!html.includes('<fast>'))
  })
})

describe('runReport: what it shows and says', () => {
  const base = {
    criterion: { id: 'login', goal: 'Log in', expect: [{ text: 'You are logged in!' }] },
    platform: 'ios',
    provider: 'jev',
    input: 'appium',
    startedAt: '2026-10-18T10:00:00.000Z',
    durationMs: 1000,
    reason: 'x',
    failedExpectations: [],
    discardedDecisions: 0,
    usage: { requests: 1, inputTokens: 1000, outputTokens: 0 },
  } as const
  const stepOf = (overrides: Partial<Step>): Step => ({
    index: 1,
    atMs: 100,
    screenText: [],
    actionCount: 1,
    decision: { action: 'STUCK', confidence: 0.4, probabilities: {}, goalMet: 0.2, fills: {}, model: 'jev-1.13.0', latencyMs: 100 },
    ...overrides,
  })

  it('shows the test with its test data replaced, never the values', () => {
    const trace = { ...base, outcome: 'passed', steps: [stepOf({})] } as unknown as Trace
    const spec = "await $('~input-email').setValue('qa.demo@example.com')\nawait $('~input-password').setValue('Str0ngPassw0rd')"
    const { html } = runReport(trace, { spec, inputs: { email: 'qa.demo@example.com', password: 'Str0ngPassw0rd' } })
    assert.ok(!html.includes('qa.demo@example.com'))
    assert.ok(!html.includes('Str0ngPassw0rd'))
    assert.match(html, /setValue\(&#39;\{email\}&#39;\)/)
    assert.match(html, /with test data shown as \{name\}/)
  })

  it('says screenshots went out when a look failed, or when only the count says so', () => {
    const failed = { ...base, outcome: 'passed', steps: [stepOf({ lookError: 'Jev request failed with 503' })], usage: { ...base.usage, looks: 1 } } as unknown as Trace
    assert.match(sentLine(failed), /a masked screenshot of step 1, where the model looked \(1 of them got no answer\)/)
    const counted = { ...base, outcome: 'passed', steps: [stepOf({})], usage: { ...base.usage, looks: 2 } } as unknown as Trace
    assert.match(sentLine(counted), /2 masked screenshots, where the model looked/)
  })

  it('heads the last step with how the run ended', () => {
    const ended = (outcome: Trace['outcome'], decision: Partial<Step['decision']> = {}) =>
      runReport({ ...base, outcome, steps: [stepOf({ decision: { ...stepOf({}).decision, ...decision } })] } as unknown as Trace).markdown
    assert.match(ended('gave-up', { action: 'tap:e1', confidence: 0.97 }), /### 1\. Step limit reached/)
    assert.match(ended('escalated', { action: 'tap:e1', confidence: 0.1 }), /### 1\. Too unsure to act/)
    assert.match(ended('failed', { goalMet: 0.9 }), /### 1\. Goal reached, but a check failed/)
    assert.match(ended('stuck'), /### 1\. No way forward/)
    assert.match(ended('passed', { goalMet: 0.7 }), /### 1\. Stopped, and the checks hold/)
  })

  it('says when the action came from looking, so the text answer is not read as the action', () => {
    const scroll: TakenAction = { type: 'scroll', kind: 'list', target: 'screen', description: 'Scroll down in the screen', selector: '(//XCUIElementTypeCollectionView)[1]', direction: 'down' }
    const looked = (text: Partial<Step['decision']>, used: 'action' | 'box', action: string) => {
      const decision = { ...stepOf({}).decision, ...text }
      const look = { why: 'always' as const, decision: { ...decision, action, confidence: 1, model: 'jev-1.14.0' }, targetShown: 0.4, used }
      return runReport({ ...base, outcome: 'stuck', steps: [stepOf({ decision, taken: [scroll], look }), stepOf({ index: 2 })] } as unknown as Trace).markdown
    }
    const another = looked({ action: 'tap:e28', confidence: 0.39 }, 'action', 'scroll:e2:down')
    assert.match(another, /model: 0\.39 sure of another action, goal/)
    assert.match(another, /looked at the screen \(always\): it chose this action instead \(1\.00 sure\)/)
    const same = looked({ action: 'scroll:e2:down', confidence: 0.47 }, 'action', 'scroll:e2:down')
    assert.match(same, /model: 0\.47 sure, goal/)
    assert.match(same, /it confirmed the same action \(1\.00 sure\)/)
    assert.match(looked({ action: 'STUCK', confidence: 0.48 }, 'box', 'tap:e15'), /model: 0\.48 sure there was no way forward, goal/)
  })
})

describe('redactCode', () => {
  it('replaces test data however the generated code escaped it', () => {
    const inputs = { name: "Siobhan O'Brien", boss: 'The "Boss" 42' }
    const code = [
      "await $('~input-name').setValue('Siobhan O\\'Brien')",
      `await expect($('-ios predicate string:label == "The \\\\"Boss\\\\" 42"')).toBeDisplayed()`,
    ].join('\n')
    const redacted = redactCode(code, inputs)
    assert.ok(!redacted.includes('Brien'), redacted)
    assert.ok(!redacted.includes('Boss'), redacted)
    assert.match(redacted, /setValue\('\{name\}'\)/)
    assert.match(redacted, /label == "\{boss\}"/)
  })
})

