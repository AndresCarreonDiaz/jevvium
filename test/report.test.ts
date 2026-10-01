import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Trace } from '../src/explorer.ts'
import { stopReport } from '../src/report.ts'

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
