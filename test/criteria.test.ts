import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import { loadCriterion, parseCriterion } from '../src/criteria.ts'

describe('criteria', () => {
  it('loads every example in criteria/', () => {
    const dir = new URL('../criteria/', import.meta.url)
    for (const file of readdirSync(dir)) {
      const criterion = loadCriterion(new URL(file, dir).pathname)
      assert.ok(criterion.goal.length > 0)
      assert.ok(criterion.expect.length > 0, `${file} should have expectations`)
    }
  })

  it('defaults the id to the file name and turns numbers into strings', () => {
    assert.deepEqual(parseCriterion({ goal: 'Enter a PIN', inputs: { pin: 1234 } }, 'pin'), {
      id: 'pin',
      goal: 'Enter a PIN',
      inputs: { pin: '1234' },
      expect: [],
    })
  })

  it('rejects a criterion without a goal or with a malformed expectation', () => {
    assert.throws(() => parseCriterion({ inputs: {} }, 'x'), /goal/)
    assert.throws(() => parseCriterion({ goal: 'g', expect: [{ label: 'x' }] }, 'x'), /id.*text/)
  })
})
