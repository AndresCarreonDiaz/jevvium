import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadCriterion, parseCriterion } from '../src/criteria.ts'

describe('criteria', () => {
  it('loads every example in criteria/', () => {
    const dir = new URL('../criteria/', import.meta.url)
    const files = readdirSync(dir, { recursive: true }).map(String).filter((file) => file.endsWith('.yml'))
    assert.ok(files.length > 0)
    for (const file of files) {
      const criterion = loadCriterion(fileURLToPath(new URL(file, dir)))
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

  it('rejects an id that spans lines, and input names that are not plain words', () => {
    assert.throws(() => parseCriterion({ id: 'login\u2028x', goal: 'g' }, 'x'), /single line/)
    assert.throws(() => parseCriterion({ goal: 'g', inputs: { 'e mail': 'x' } }, 'x'), /Input name/)
    assert.throws(() => parseCriterion({ goal: 'g', inputs: { '{email}': 'x' } }, 'x'), /Input name/)
  })
})
