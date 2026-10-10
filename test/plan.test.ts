import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadCriterion } from '../src/criteria.ts'
import { inlineInputs, parsePlan, STARTER_PLAN } from '../src/plan.ts'

const plan = `# Send an asset

The wallet is already funded.

1. From the Home tab, tap Send
2. Pick USDC from the asset list
3. Enter 0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B as the recipient address
4. Enter 10 as the amount and continue
5. Review the details and confirm

Expected: the screen contains "Sent" and shows "10 USDC"
`

describe('parsePlan', () => {
  it('reads the title, the steps, the inline test data and the checks', () => {
    assert.deepEqual(parsePlan(plan, 'send-asset'), {
      id: 'send-asset',
      title: 'Send an asset',
      goal: 'Send an asset. The wallet is already funded.',
      steps: [
        'From the Home tab, tap Send',
        'Pick USDC from the asset list',
        'Enter 0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B as the recipient address',
        'Enter 10 as the amount and continue',
        'Review the details and confirm',
      ],
      inputs: { recipient_address: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B', amount: '10' },
      expect: [{ contains: 'Sent' }, { contains: '10 USDC' }],
    })
  })

  it('takes sections under headings or labels, in any order, and a bare expected line as whole text', () => {
    const criterion = parsePlan(
      [
        'Log in',
        '',
        '## Test data',
        '- email: qa.demo@example.com',
        '- **password**: Str0ngPassw0rd',
        '',
        '## Steps',
        '- Open the Login tab',
        '- Fill in the form and submit it',
        '',
        '## Expected',
        '- You are logged in!',
        '- an element with id "button-OK"',
        '- the text "Success"',
      ].join('\n'),
      'login',
    )
    assert.deepEqual(criterion, {
      id: 'login',
      title: 'Log in',
      goal: 'Log in',
      steps: ['Open the Login tab', 'Fill in the form and submit it'],
      inputs: { email: 'qa.demo@example.com', password: 'Str0ngPassw0rd' },
      expect: [{ text: 'You are logged in!' }, { id: 'button-OK' }, { text: 'Success' }],
    })
  })

  it('works without steps, as a single goal, and joins wrapped step lines, indented or not', () => {
    assert.deepEqual(parsePlan('A user logs in and sees the home screen.\n\nExpected: "Home"', 'x'), {
      id: 'x',
      title: 'A user logs in and sees the home screen.',
      goal: 'A user logs in and sees the home screen.',
      inputs: {},
      expect: [{ text: 'Home' }],
    })
    const wrapped = parsePlan('# T\n\n1. Tap the very long\n   button at the bottom\n2. Done', 'x')
    assert.deepEqual(wrapped.steps, ['Tap the very long button at the bottom', 'Done'])
    // Markdown's lazy continuation: the wrapped line of a step needs no indent, and its test data is still found.
    const lazy = parsePlan('# Log in\n\n1. Enter qa.demo@example.com as the email and\nStr0ngPassw0rd as the password\n2. Tap LOGIN\n\nA note after the list.\n\nExpected: "You are logged in!"', 'x')
    assert.deepEqual(lazy.steps, ['Enter qa.demo@example.com as the email and Str0ngPassw0rd as the password', 'Tap LOGIN'])
    assert.deepEqual(lazy.inputs, { email: 'qa.demo@example.com', password: 'Str0ngPassw0rd' })
    assert.equal(lazy.goal, 'Log in. A note after the list.')
  })

  it('joins a wrapped paragraph into one sentence of context', () => {
    const criterion = parsePlan('# Send\n\nThe wallet is funded\nand unlocked.\n\nThe network is a testnet\n\n1. Tap Send\n\nExpected: "Sent"', 'x')
    assert.equal(criterion.goal, 'Send. The wallet is funded and unlocked. The network is a testnet')
  })

  it('rejects a plan with nothing in it, test data not written as name: value, and conflicting values', () => {
    assert.throws(() => parsePlan('\n\n', 'x'), /needs a title/)
    assert.throws(() => parsePlan('# T\n\nTest data:\n- just words\n', 'x'), /name: value/)
    assert.throws(() => parsePlan('# T\n\n1. Enter 10 as the amount\n2. Enter 20 as the amount\n', 'x'), /"amount" is given twice/)
  })

  it('reads the starter plan, skipping the HTML comment that explains the format', () => {
    const starter = parsePlan(STARTER_PLAN, 'example')
    assert.deepEqual(starter.steps, [
      'Open the Login tab at the bottom of the screen',
      'Enter qa.demo@example.com as the email and Str0ngPassw0rd as the password',
      'Tap LOGIN',
    ])
    assert.deepEqual(starter.inputs, { email: 'qa.demo@example.com', password: 'Str0ngPassw0rd' })
    assert.deepEqual(starter.expect, [{ text: 'You are logged in!' }])
    assert.equal(starter.goal, 'Log in', 'the explanation is in the comment, not in what the model reads')
    assert.equal(starter.title, 'Log in')
  })

  it('loads .md files through loadCriterion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevvium-plan-'))
    try {
      const file = join(dir, 'send-asset.md')
      writeFileSync(file, plan)
      assert.equal(loadCriterion(file).id, 'send-asset')
      assert.deepEqual(loadCriterion(file).expect, [{ contains: 'Sent' }, { contains: '10 USDC' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('inlineInputs', () => {
  it('finds values given "as", "into" and "in", quoted or bare, and names them after the field', () => {
    assert.deepEqual(inlineInputs('Enter 10 as the amount and continue'), [{ name: 'amount', value: '10' }])
    assert.deepEqual(inlineInputs('Type "Jane Tester" as their full name, then tap Next'), [{ name: 'full name', value: 'Jane Tester' }])
    assert.deepEqual(inlineInputs('type qa@example.com into the Email field.'), [{ name: 'Email field', value: 'qa@example.com' }])
    assert.deepEqual(inlineInputs('enter 12345 in the zip code and 4111111111111111 as the card number'), [
      { name: 'zip code', value: '12345' },
      { name: 'card number', value: '4111111111111111' },
    ])
  })

  it('reads a list of values after one verb, with values of several words, and stops at a clause without one', () => {
    assert.deepEqual(
      inlineInputs('Enter Jane Tester as the full name, 42 Example Street as the address line 1 and United States as the country, then go to payment'),
      [
        { name: 'full name', value: 'Jane Tester' },
        { name: 'address line 1', value: '42 Example Street' },
        { name: 'country', value: 'United States' },
      ],
    )
    assert.deepEqual(inlineInputs('Enter "Fish and Chips" as the dish and 2 as the quantity and continue'), [
      { name: 'dish', value: 'Fish and Chips' },
      { name: 'quantity', value: '2' },
    ])
  })

  it('leaves steps without test data alone', () => {
    assert.deepEqual(inlineInputs('Enter the checkout'), [])
    assert.deepEqual(inlineInputs('Tap Send'), [])
  })
})
