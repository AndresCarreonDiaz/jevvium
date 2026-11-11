import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sessionHint } from '../src/appium.ts'

describe('session hints', () => {
  it('explains causes that trying again will not fix', () => {
    const refused =
      'WebDriverError: Unable to start WebDriverAgent session. Original error: A new session could not be created. Details: Error Domain=XCTDaemonErrorDomain Code=41 "Not authorized for performing UI testing actions."'
    assert.match(sessionHint(refused) ?? '', /unlock it/)
    assert.match(sessionHint('error: Unable to process request - PLA Update available') ?? '', /developer\.apple\.com/)
    assert.match(sessionHint('xcodebuild failed with code 65') ?? '', /--team-id/)
  })

  it('leaves other failures to be tried again', () => {
    assert.equal(sessionHint('socket hang up'), undefined)
  })
})
