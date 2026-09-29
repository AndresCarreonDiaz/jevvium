import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
 * Simulators to run criteria side by side: `base`, then ones named "jevvium 2",
 * "jevvium 3" and so on, created like `base` the first time and kept for later
 * runs. Each is booted, which takes a while only the first time.
 */
export async function simulatorSet(base: Simulator, count: number): Promise<Simulator[]> {
  const available = await simulators()
  const set = [base]
  for (let lane = 2; lane <= count; lane++) {
    const name = `jevvium ${lane}`
    const existing = available.find((sim) => sim.name === name && sim.runtime === base.runtime)
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

/** Whether Appium's WebDriverAgent runner is already installed on the simulator. */
export async function hasWebDriverAgent(udid: string): Promise<boolean> {
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

export type AppiumServer = { port: number; stop(): void }

/**
 * Starts an Appium server from this project's dependencies on a free local port
 * and waits until it accepts sessions. One server creates one session at a time,
 * so sessions that should start together each need their own.
 */
export async function startAppium(logFile: string): Promise<AppiumServer> {
  const port = await freePort()
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('appium/package.json')
  const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin: { appium: string } }).bin.appium
  const child = spawn(
    process.execPath,
    [join(dirname(manifest), bin), '--address', '127.0.0.1', '--port', String(port), '--log', logFile, '--log-no-colors', '--log-timestamp'],
    { stdio: 'ignore' },
  )
  const server = { port, stop: () => void child.kill() }
  let exited = false
  child.once('exit', () => (exited = true))

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !exited) {
    const ready = await fetch(`http://127.0.0.1:${port}/status`)
      .then(async (response) => ((await response.json()) as { value?: { ready?: boolean } }).value?.ready === true)
      .catch(() => false)
    if (ready) return server
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  server.stop()
  throw new Error(`The Appium server on port ${port} did not start (see ${logFile})`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port'))))
    })
  })
}

function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
