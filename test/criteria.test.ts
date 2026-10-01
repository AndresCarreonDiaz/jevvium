import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('rejects unknown keys, naming the one it probably meant', () => {
    assert.throws(() => parseCriterion({ goal: 'g', expects: [{ text: 'x' }] }, 'x'), /Unknown key `expects` \(did you mean `expect`\?\)/)
    assert.throws(() => parseCriterion({ goal: 'g', expectations: [] }, 'x'), /did you mean `expect`/)
    assert.throws(() => parseCriterion({ goal: 'g', input: { a: 'b' } }, 'x'), /did you mean `inputs`/)
    assert.throws(() => parseCriterion({ goal: 'g', expect: [{ txt: 'x' }] }, 'x'), /Unknown key `txt` in an `expect` entry \(did you mean `text`\?\)/)
    assert.throws(() => parseCriterion({ goal: 'g', expect: [{ text: 'x', visible: 'false' }] }, 'x'), /Unknown key `visible`/)
    assert.throws(() => parseCriterion({ goal: 'g', expect: [{ id: 'a', text: 'b' }] }, 'x'), /both `id` and `text`/)
  })

  it('keeps test data exactly as typed, and names the file in its errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevvium-criteria-'))
    try {
      const file = join(dir, 'pin.yml')
      writeFileSync(file, 'goal: Enter a PIN\ninputs:\n  pin: 0042\n  card: 41111111111111112\n')
      assert.deepEqual(loadCriterion(file).inputs, { pin: '0042', card: '41111111111111112' })
      writeFileSync(file, 'goal: g\nexpects:\n  - text: x\n')
      assert.throws(() => loadCriterion(file), (error: Error) => error.message.startsWith(`${file}: Unknown key`))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
