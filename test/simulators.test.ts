import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSimulators, pickSimulator } from '../src/simulators.ts'

const listing = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: 'A', name: 'iPhone 17', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
      { udid: 'B', name: 'jevvium 2', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      { udid: 'C', name: 'iPhone 17', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
      { udid: 'D', name: 'iPhone 17 Pro', isAvailable: false, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [
      { udid: 'E', name: 'Apple Watch', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch' },
    ],
  },
})

describe('simulators', () => {
  it('lists available iOS simulators with their version', () => {
    assert.deepEqual(
      parseSimulators(listing).map((sim) => `${sim.udid} ${sim.name} ${sim.version}`),
      ['A iPhone 17 26.5', 'B jevvium 2 26.5', 'C iPhone 17 27.0'],
    )
  })

  it('picks the requested version, or else the newest one with that name', () => {
    const available = parseSimulators(listing)
    assert.equal(pickSimulator(available, 'iPhone 17', '26.5').udid, 'A')
    assert.equal(pickSimulator(available, 'iPhone 17').udid, 'C')
    assert.throws(() => pickSimulator(available, 'iPhone 17 Pro'), /No available simulator named "iPhone 17 Pro"/)
  })
})
