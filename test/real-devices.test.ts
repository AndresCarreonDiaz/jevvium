import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { chooseTeam, parseRealDevices, pickRealDevice, teamsOf, wdaBundleId, type RealDevice } from '../src/real-devices.ts'

const listing = JSON.stringify({
  info: { outcome: 'success' },
  result: {
    devices: [
      {
        hardwareProperties: { udid: '00000000-0000AAAA', reality: 'physical', platform: 'iOS', marketingName: 'iPhone 17 Pro' },
        deviceProperties: { name: 'Test Phone', osVersionNumber: '27.2.1', developerModeStatus: 'enabled' },
        connectionProperties: { pairingState: 'paired' },
      },
      {
        hardwareProperties: { udid: '00000000-0000BBBB', reality: 'physical', platform: 'iOS', deviceType: 'iPad' },
        deviceProperties: { name: 'Test iPad', osVersionNumber: '27.0', developerModeStatus: 'disabled' },
        connectionProperties: { pairingState: 'paired' },
      },
      {
        hardwareProperties: { udid: 'SIM-1', reality: 'simulated', platform: 'iOS', marketingName: 'iPhone 17' },
        deviceProperties: { name: 'iPhone 17', osVersionNumber: '27.0' },
        connectionProperties: { pairingState: 'paired' },
      },
      {
        hardwareProperties: { udid: 'WATCH-1', reality: 'physical', platform: 'watchOS' },
        deviceProperties: { name: 'Test Watch' },
      },
    ],
  },
})

describe('real devices', () => {
  const devices = parseRealDevices(listing)

  it('lists only physical iOS devices', () => {
    assert.deepEqual(
      devices.map((d) => `${d.name} ${d.model} ${d.version}`),
      ['Test Phone iPhone 17 Pro 27.2.1', 'Test iPad iPad 27.0'],
    )
  })

  it('finds a device by udid or by name, in any case', () => {
    assert.equal(pickRealDevice(devices, '00000000-0000aaaa')?.name, 'Test Phone')
    assert.equal(pickRealDevice(devices, 'test phone')?.udid, '00000000-0000AAAA')
    assert.equal(pickRealDevice(devices, 'Nobody'), undefined)
  })

  it('says what to fix on a device that is not ready', () => {
    assert.throws(() => pickRealDevice(devices, 'Test iPad'), /Developer Mode/)
    const unpaired: RealDevice = { ...devices[0], paired: false }
    assert.throws(() => pickRealDevice([unpaired], 'Test Phone'), /isn't paired/)
  })

  it('handles a listing with no devices', () => {
    assert.deepEqual(parseRealDevices(JSON.stringify({ info: {}, result: {} })), [])
  })
})

describe('signing teams', () => {
  const pem = readFileSync(new URL('./fixtures/apple-development-certificates.pem', import.meta.url), 'utf8')

  it('reads the team from each Apple Development certificate', () => {
    assert.deepEqual(teamsOf(pem).sort(), ['ABCDE12345', 'ZYXWV98765'])
  })

  it('skips certificates that have expired', () => {
    const inAWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    assert.deepEqual(teamsOf(pem, inAWeek), ['ABCDE12345'])
  })

  it('ignores text that is not a certificate', () => {
    assert.deepEqual(teamsOf('-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----'), [])
  })

  it('uses the only team, or the one given', () => {
    assert.equal(chooseTeam(undefined, ['ABCDE12345']), 'ABCDE12345')
    assert.equal(chooseTeam('ZYXWV98765', ['ABCDE12345']), 'ZYXWV98765')
  })

  it('asks for a team when there are none or several, or the one given is malformed', () => {
    assert.throws(() => chooseTeam(undefined, []), /no Apple Development certificate/)
    assert.throws(() => chooseTeam(undefined, ['ABCDE12345', 'ZYXWV98765']), /pick one with --team-id/)
    assert.throws(() => chooseTeam('abc', []), /10-character/)
  })

  it('names WebDriverAgent after the team', () => {
    assert.equal(wdaBundleId('ABCDE12345'), 'jevvium.abcde12345.WebDriverAgentRunner')
  })
})
