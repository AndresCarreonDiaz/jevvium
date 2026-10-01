import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultSimulator, laneName, laneSimulator, parseSimulators, pickSimulator, type Simulator } from '../src/simulators.ts'

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

  it('reuses a lane simulator only when it is the same model on the same iOS version', () => {
    const phone: Simulator = { udid: 'A', name: 'iPhone 17', runtime: 'iOS-26-5', version: '26.5', deviceType: 'x.SimDeviceType.iPhone-17' }
    const tablet: Simulator = { ...phone, udid: 'P', name: 'iPad Air', deviceType: 'x.SimDeviceType.iPad-Air-13-inch-M4' }
    const kept: Simulator = { ...phone, udid: 'B', name: 'jevvium 2 (iPhone 17)' }
    assert.equal(laneName(phone, 2), 'jevvium 2 (iPhone 17)')
    assert.equal(laneSimulator([phone, kept], phone, 2)?.udid, 'B')
    assert.equal(laneSimulator([phone, kept, tablet], tablet, 2), undefined, 'an iPhone is not reused for an iPad run')
    assert.equal(laneSimulator([{ ...kept, runtime: 'iOS-27-0' }], phone, 2), undefined, 'nor one on another iOS version')
  })

  it('picks the requested version, or else the newest one with that name', () => {
    const available = parseSimulators(listing)
    assert.equal(pickSimulator(available, 'iPhone 17', '26.5').udid, 'A')
    assert.equal(pickSimulator(available, 'iPhone 17').udid, 'C')
    assert.throws(() => pickSimulator(available, 'iPhone 17 Pro'), /No available simulator named "iPhone 17 Pro"/)
  })

  it('defaults to the plain iPhone with the highest number on the newest runtime, or on the version asked for', () => {
    const sim = (udid: string, name: string, version: string): Simulator => ({ udid, name, runtime: `iOS-${version}`, version, deviceType: name })
    const available = [
      sim('A', 'iPhone 17', '26.5'),
      sim('B', 'iPhone 16e', '27.0'),
      sim('C', 'iPhone 17 Pro', '27.0'),
      sim('D', 'iPhone 18', '27.0'),
      sim('E', 'jevvium 2 (iPhone 17)', '27.0'),
      sim('F', 'iPad Pro', '27.0'),
    ]
    assert.equal(defaultSimulator(available).udid, 'D')
    assert.equal(defaultSimulator(available, '26.5').udid, 'A')
    assert.equal(defaultSimulator([sim('C', 'iPhone 17 Pro', '27.0')]).udid, 'C')
    assert.throws(() => defaultSimulator(available, '25.0'), /No iPhone simulator on iOS 25.0/)
  })
})
