import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canTypeDirectly } from '../src/ios-hid.ts'

describe('canTypeDirectly', () => {
  it('accepts what a US hardware keyboard can type', () => {
    assert.equal(canTypeDirectly('qa.demo@example.com'), true)
    assert.equal(canTypeDirectly(String.raw`Str0ng Passw0rd!#$%^&*()_+{}|:"<>?~-=[]\;',./`), true)
  })

  it('leaves the rest to Appium', () => {
    assert.equal(canTypeDirectly('contraseña'), false)
    assert.equal(canTypeDirectly('two\nlines'), false)
    assert.equal(canTypeDirectly('emoji 👍'), false)
  })
})
