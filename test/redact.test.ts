import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { toSelector } from '../src/locator.ts'
import { placeholderSelector, redactor, restoreSelector } from '../src/redact.ts'

describe('redactor', () => {
  it('replaces values whatever their case', () => {
    const redact = redactor({ email: 'qa.demo@example.com' })
    assert.equal(redact('Signed in as QA.DEMO@EXAMPLE.COM'), 'Signed in as {email}')
  })

  it('matches a number the app shows in groups', () => {
    const redact = redactor({ card: '4111111111111111', expiry: '1230' })
    assert.equal(redact('Card 4111 1111 1111 1111'), 'Card {card}')
    assert.equal(redact('Card 4111-1111-1111-1111'), 'Card {card}')
    assert.equal(redact('Expires 12/30'), 'Expires {expiry}')
  })

  it('replaces a short value only where it stands alone, and only in its exact case', () => {
    const redact = redactor({ pin: '42', state: 'IN' })
    assert.equal(redact('Your PIN 42 is set'), 'Your PIN {pin} is set')
    assert.equal(redact('Order 1420'), 'Order 1420')
    assert.equal(redact('Ship to IN'), 'Ship to {state}')
    assert.equal(redact('You are logged in!'), 'You are logged in!')
  })

  it('finds a value with quotes where a selector in an error message escapes them', () => {
    const redact = redactor({ phrase: 'say "hi"' })
    assert.equal(redact('No element for -ios predicate string:label == "say \\"hi\\""'), 'No element for -ios predicate string:label == "{phrase}"')
  })

  it('replaces in one pass, so a placeholder is never matched again', () => {
    const redact = redactor({ email: 'jane@example.com', provider: 'example' })
    assert.equal(redact('Sent to jane@example.com by example'), 'Sent to {email} by {provider}')
  })

  it('leaves text alone when there is no test data', () => {
    assert.equal(redactor({})('Anything'), 'Anything')
    assert.equal(redactor({ blank: '  ' })('Anything'), 'Anything')
  })
})

describe('selector placeholders', () => {
  it('take exact values out of a selector and put them back', () => {
    const inputs = { email: 'qa.demo@example.com' }
    const selector = '~Continue as qa.demo@example.com'
    const stored = placeholderSelector(selector, inputs)
    assert.equal(stored, '~Continue as {email}')
    assert.equal(restoreSelector(stored, inputs), selector)
  })

  it('only touch the values in a selector, never its syntax or an XPath index', () => {
    const cases: [string, Record<string, string>][] = [
      ['(//XCUIElementTypeCell)[1]', { quantity: '1' }],
      ['~Menu', { size: 'M' }],
      ['-ios predicate string:type == "XCUIElementTypeButton" AND name == "Place Order"', { city: 'Or', kind: 'Button' }],
    ]
    for (const [selector, inputs] of cases) assert.equal(placeholderSelector(selector, inputs), selector)
    const xpath = '//android.widget.TextView[@text="Signed in as qa.demo@example.com"]'
    assert.equal(placeholderSelector(xpath, { email: 'qa.demo@example.com' }), '//android.widget.TextView[@text="Signed in as {email}"]')
  })

  it('keep braces the app itself shows', () => {
    const inputs = { email: 'qa.demo@example.com' }
    const selector = '~Hello {email} qa.demo@example.com'
    const stored = placeholderSelector(selector, inputs)
    assert.equal(stored, '~Hello {{email}} {email}')
    assert.equal(restoreSelector(stored, inputs), selector)
  })

  it('keep a value exactly as an iOS predicate string escapes it', () => {
    const inputs = { name: 'say "hi"' }
    const selector = toSelector({ using: '-ios predicate string', value: 'type == "XCUIElementTypeButton" AND name == "say \\"hi\\""' })
    const stored = placeholderSelector(selector, inputs)
    assert.ok(!stored.includes('hi'), stored)
    assert.equal(restoreSelector(stored, inputs), selector)
  })

  it('refuse to restore a value the criterion does not have', () => {
    assert.throws(() => restoreSelector('~{missing}', {}), /input named "missing"/)
  })
})
