import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { showsTyped } from '../src/device.ts'

describe('showsTyped', () => {
  it('accepts formatting the app adds, and a secure field of the right length', () => {
    assert.equal(showsTyped('qa.demo@example.com', 'qa.demo@example.com'), true)
    assert.equal(showsTyped('(555) 123-4567', '5551234567'), true)
    assert.equal(showsTyped('QA.DEMO@EXAMPLE.COM', 'qa.demo@example.com'), true)
    assert.equal(showsTyped('••••••••••••••', 'Str0ngPassw0rd'), true)
  })

  it('catches keys that went missing or a field left as it was', () => {
    assert.equal(showsTyped('•', 'Str0ngPassw0rd'), false)
    assert.equal(showsTyped('qa.demo@exa', 'qa.demo@example.com'), false)
    assert.equal(showsTyped('Email', 'qa.demo@example.com'), false)
    assert.equal(showsTyped('qademo@example.com', 'qa.demo@example.com'), false)
    assert.equal(showsTyped('1250', '12.50'), false)
    assert.equal(showsTyped('https//example.com/a', 'https://example.com/a'), false)
  })
})
