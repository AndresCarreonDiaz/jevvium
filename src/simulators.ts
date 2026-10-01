import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The bundle id Appium's WebDriverAgent runner is installed under. */
const WDA_RUNNER = 'com.facebook.WebDriverAgentRunner.xctrunner'

export type Simulator = { udid: string; name: string; runtime: string; version: string; deviceType: string }

/** Every available iOS simulator, from `simctl list devices`. */
export async function simulators(): Promise<Simulator[]> {
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])
  return parseSimulators(stdout)
}

/** The iOS simulators in `simctl list devices --json` output. */
export function parseSimulators(json: string): Simulator[] {
  type Listed = { udid: string; name: string; isAvailable: boolean; deviceTypeIdentifier: string }
  const { devices } = JSON.parse(json) as { devices: Record<string, Listed[]> }
  return Object.entries(devices).flatMap(([runtime, listed]) => {
    const version = runtime.match(/\.iOS-(\d+)-(\d+)(?:-(\d+))?$/)
    if (!version) return []
    return listed
      .filter((device) => device.isAvailable)
      .map((device) => ({
        udid: device.udid,
        name: device.name,
        runtime,
        version: version.slice(1).filter(Boolean).join('.'),
        deviceType: device.deviceTypeIdentifier,
      }))
  })
}

/** The simulator with this name, on the given iOS version or else the newest one that has it. */
export async function findSimulator(name: string, version?: string): Promise<Simulator> {
  return pickSimulator(await simulators(), name, version)
}

export function pickSimulator(available: Simulator[], name: string, version?: string): Simulator {
  const matching = available
    .filter((sim) => sim.name === name && (!version || sim.version === version || sim.version.startsWith(`${version}.`)))
    .sort((a, b) => compareVersions(b.version, a.version))
  if (matching.length === 0) {
    throw new Error(`No available simulator named "${name}"${version ? ` on iOS ${version}` : ''} (see xcrun simctl list devices available)`)
  }
  return matching[0]
}

/**
 * The simulator to use when none is named: on the given iOS version, or else on the
 * newest runtime, the plain "iPhone N" with the highest N, or else any iPhone.
 */
export function defaultSimulator(available: Simulator[], version?: string): Simulator {
  const iPhones = available.filter(
    (sim) => sim.name.startsWith('iPhone') && (!version || sim.version === version || sim.version.startsWith(`${version}.`)),
  )
  if (iPhones.length === 0) {
    throw new Error(
      `No iPhone simulator${version ? ` on iOS ${version}` : ''}. Add one in Xcode (Window > Devices and Simulators), ` +
        'or name one with --device (see xcrun simctl list devices available).',
    )
  }
  const model = (sim: Simulator) => Number(/^iPhone (\d+)$/.exec(sim.name)?.[1] ?? -1)
  return [...iPhones].sort((a, b) => compareVersions(b.version, a.version) || model(b) - model(a))[0]
}

/**
 * Simulators to run criteria side by side: `base`, then ones named like
 * "jevvium 2 (iPhone 17)", of the same model and iOS version, created the first
 * time and kept for later runs. Each is booted, which takes a while only the first time.
 */
export async function simulatorSet(base: Simulator, count: number): Promise<Simulator[]> {
  const available = await simulators()
  const set = [base]
  for (let lane = 2; lane <= count; lane++) {
    const name = laneName(base, lane)
    const existing = laneSimulator(available, base, lane)
    if (existing) {
      set.push(existing)
      continue
    }
    const { stdout } = await run('xcrun', ['simctl', 'create', name, base.deviceType, base.runtime])
    set.push({ ...base, udid: stdout.trim(), name })
  }
  await Promise.all(set.map((sim) => run('xcrun', ['simctl', 'bootstatus', sim.udid, '-b'], { timeout: 180_000 })))
  return set
}

/** "jevvium 2 (iPhone 17)": the name of lane `lane`'s simulator for runs on `base`. */
export function laneName(base: Simulator, lane: number): string {
  return `jevvium ${lane} (${base.deviceType.replace(/^.*SimDeviceType\./, '').replace(/-/g, ' ')})`
}

/** The simulator kept from an earlier run for this lane: same name, model and iOS version, and not `base` itself. */
export function laneSimulator(available: Simulator[], base: Simulator, lane: number): Simulator | undefined {
  const name = laneName(base, lane)
  return available.find(
    (sim) => sim.name === name && sim.runtime === base.runtime && sim.deviceType === base.deviceType && sim.udid !== base.udid,
  )
}

/** Whether Appium's WebDriverAgent runner is already installed on the simulator. */
export async function hasWebDriverAgent(udid: string): Promise<boolean> {
  // Its folder is there whether or not the simulator is booted; simctl only answers for a booted one.
  const bundles = join(homedir(), 'Library/Developer/CoreSimulator/Devices', udid, 'data/Containers/Bundle/Application')
  if (existsSync(bundles) && readdirSync(bundles).some((dir) => existsSync(join(bundles, dir, 'WebDriverAgentRunner-Runner.app')))) {
    return true
  }
  return run('xcrun', ['simctl', 'get_app_container', udid, WDA_RUNNER]).then(
    () => true,
    () => false,
  )
}

/** The newest WebDriverAgent runner Appium built for simulators, to install on others instead of building it again. */
export function builtWebDriverAgent(): string | undefined {
  const derivedData = join(homedir(), 'Library/Developer/Xcode/DerivedData')
  if (!existsSync(derivedData)) return undefined
  return readdirSync(derivedData)
    .filter((dir) => dir.startsWith('WebDriverAgent-'))
    .map((dir) => join(derivedData, dir, 'Build/Products/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app'))
    .filter((app) => existsSync(app))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
