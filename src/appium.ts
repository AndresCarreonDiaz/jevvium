import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const require = createRequire(import.meta.url)

/** The Appium drivers jevvium can use, by npm package. The iOS one is always installed with it. */
const DRIVERS = ['appium-xcuitest-driver', 'appium-uiautomator2-driver']

export type AppiumServer = { port: number; stop(): void }

/** Where jevvium keeps what it builds and caches: ~/Library/Caches/jevvium on macOS. */
export function cacheDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library/Caches/jevvium')
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'jevvium')
}

/**
 * The Appium home jevvium runs Appium from, with the drivers installed alongside
 * jevvium linked into it. Appium otherwise loads drivers from ~/.appium or from the
 * project it is started in, which may hold other versions or none. Linking takes
 * under a second and downloads nothing; it happens again only when jevvium moves.
 */
export async function appiumHome(): Promise<string> {
  const drivers = DRIVERS.map((name) => ({ name, dir: packageDir(name) })).filter(
    (driver): driver is { name: string; dir: string } => driver.dir !== undefined,
  )
  if (drivers.length === 0) throw new Error('No Appium driver is installed next to jevvium (expected appium-xcuitest-driver)')
  const key = createHash('sha256')
    .update(drivers.map((driver) => driver.dir).join('\n'))
    .digest('hex')
    .slice(0, 12)
  const home = join(cacheDir(), 'appium', key)
  for (const driver of drivers) {
    const linked = join(home, 'node_modules', driver.name)
    if (existsSync(linked) && realpathSync(linked) === driver.dir) continue
    mkdirSync(home, { recursive: true })
    try {
      await run(process.execPath, [appiumBin(), 'driver', 'install', '--source=local', driver.dir], {
        env: { ...process.env, APPIUM_HOME: home },
        timeout: 120_000,
      })
    } catch (error) {
      const output = (error as { stderr?: string; stdout?: string }).stderr || (error as { stdout?: string }).stdout || String(error)
      throw new Error(`Could not set up Appium's ${driver.name} in ${home}: ${output.trim().split('\n').at(-1)}`, { cause: error })
    }
  }
  return home
}

/**
 * Starts an Appium server from jevvium's own Appium home on a free local port and
 * waits until it accepts sessions. One server creates one session at a time, so
 * sessions that should start together each need their own. `onSpawn` gets the
 * server as soon as its process exists, so a caller that stops early can stop it too.
 */
export async function startAppium(logFile: string, onSpawn?: (server: AppiumServer) => void): Promise<AppiumServer> {
  const home = await appiumHome()
  const port = await freePort()
  const child = spawn(
    process.execPath,
    [appiumBin(), '--address', '127.0.0.1', '--port', String(port), '--log', logFile, '--log-no-colors', '--log-timestamp'],
    { stdio: 'ignore', env: { ...process.env, APPIUM_HOME: home } },
  )
  const server = { port, stop: () => void child.kill() }
  onSpawn?.(server)
  let exited = false
  child.once('exit', () => (exited = true))

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !exited) {
    const ready = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1_000) })
      .then(async (response) => ((await response.json()) as { value?: { ready?: boolean } }).value?.ready === true)
      .catch(() => false)
    if (ready) return server
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  server.stop()
  throw new Error(`The Appium server on port ${port} did not start (see ${logFile})`)
}

/** Whether an Appium server answers at this address. */
export async function isAppiumUp(url: string): Promise<boolean> {
  return fetch(`${url.replace(/\/$/, '')}/status`, { signal: AbortSignal.timeout(3_000) }).then(
    (response) => response.ok,
    () => false,
  )
}

/** The folder of an installed package, resolved the way jevvium itself would import it. */
function packageDir(name: string): string | undefined {
  try {
    return realpathSync(dirname(require.resolve(`${name}/package.json`)))
  } catch {
    return undefined
  }
}

function appiumBin(): string {
  const manifest = require.resolve('appium/package.json')
  const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin: { appium: string } }).bin.appium
  return join(dirname(manifest), bin)
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
